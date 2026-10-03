import { send } from '@actual-app/core/platform/client/connection';
import { getEffectiveAccountCurrency } from '@actual-app/core/shared/currency-setup';
import { convert } from '@actual-app/core/shared/exchange-rates';
import * as monthUtils from '@actual-app/core/shared/months';
import { q } from '@actual-app/core/shared/query';
import type {
  AccountEntity,
  RuleConditionEntity,
  TransactionEntity,
} from '@actual-app/core/types/models';
import type { SyncedPrefs } from '@actual-app/core/types/prefs';
import * as d from 'date-fns';
import type { Locale } from 'date-fns';
import { keyBy } from 'es-toolkit';

import { getIntervalFormat } from '#components/reports/ReportOptions';
import type { FormatType } from '#hooks/useFormat';
import type { useSpreadsheet } from '#hooks/useSpreadsheet';
import { aqlQuery } from '#queries/aqlQuery';

type Balance = {
  date: string;
  amount: number;
};

type AccountBalanceData = {
  id: string;
  name: string;
  balances: Record<string, Balance>;
  starting: number;
  hasUnsafeAmount: boolean;
};

type TransferLeg = Pick<
  TransactionEntity,
  'id' | 'account' | 'amount' | 'date'
> & {
  transfer_id: string;
};

type IntervalRange = {
  startDate: string;
  endDate: string;
  interval: string;
  firstDayOfWeekIdx: string;
};

export function createSpreadsheet(
  start: string,
  end: string,
  accounts: AccountEntity[],
  conditions: RuleConditionEntity[] = [],
  conditionsOp: 'and' | 'or' = 'and',
  locale: Locale,
  interval: string = 'Monthly',
  firstDayOfWeekIdx: string = '0',
  format: (value: unknown, type?: FormatType) => string,
  dateFormat?: string,
  prefs: Readonly<SyncedPrefs> = {},
  accountsReady = true,
) {
  return async (
    spreadsheet: ReturnType<typeof useSpreadsheet>,
    setData: (data: ReturnType<typeof recalculate>) => void,
  ) => {
    if (!accountsReady) {
      return;
    }
    if (!prefs.defaultCurrencyCode) {
      setData({ status: 'unavailable' });
      return;
    }

    const { filters } = await send('make-filters-from-conditions', {
      conditions: conditions.filter(cond => !cond.customName),
    });
    const conditionsOpKey = conditionsOp === 'or' ? '$or' : '$and';

    // Go back exactly one interval before the selected range start
    // to get the correct starting balance for the first period
    const rangeStart = d.parseISO(monthUtils.firstDayOfMonth(start));
    let startDate: string;
    if (interval === 'Daily') {
      startDate = monthUtils.dayFromDate(d.subDays(rangeStart, 1));
    } else if (interval === 'Weekly') {
      startDate = monthUtils.weekFromDate(
        d.subDays(rangeStart, 1),
        firstDayOfWeekIdx,
      );
    } else {
      // Monthly or yearly
      startDate = monthUtils.firstDayOfMonth(monthUtils.prevMonth(start));
    }

    // If the earliest transaction is on or after the first day of the start
    // month, the prior period lookback would be empty (all zeros). Skip it to
    // avoid rendering an empty data point.
    const earliestTransaction = await send('get-earliest-transaction');
    if (
      earliestTransaction &&
      earliestTransaction.date >= monthUtils.firstDayOfMonth(start)
    ) {
      if (interval === 'Daily') {
        startDate = earliestTransaction.date;
      } else if (interval === 'Weekly') {
        startDate = monthUtils.weekFromDate(
          earliestTransaction.date,
          firstDayOfWeekIdx,
        );
      } else {
        // Monthly or Yearly
        startDate = monthUtils.firstDayOfMonth(start);
      }
    }

    // Start with the provided end-of-month date, then adjust for current context
    let endDate = monthUtils.lastDayOfMonth(end);

    if (interval === 'Daily') {
      const today = monthUtils.currentDay();
      if (monthUtils.isAfter(endDate, today)) {
        endDate = today;
      }
    } else if (interval === 'Weekly') {
      // Include the ongoing (current) week up to today instead of clamping to the
      // start of the current week. This ensures the current week appears in the
      // report even if the week hasn't finished yet.
      const today = monthUtils.currentDay();
      if (monthUtils.isAfter(endDate, today)) {
        endDate = today;
      }
    }

    const accountIds = accounts.map(account => account.id);
    const transferLegsPromise =
      accountIds.length === 0
        ? Promise.resolve<TransferLeg[]>([])
        : aqlQuery(
            q('transactions')
              .filter({
                [conditionsOpKey]: filters,
              })
              .filter({
                account: { $oneof: accountIds },
                transfer_id: { $ne: null },
                date: { $lte: endDate },
              })
              .select(['id', 'account', 'amount', 'date', 'transfer_id']),
          ).then(({ data }: { data: TransferLeg[] }) => data);

    const accountDataPromise = Promise.all(
      accounts.map(async acct => {
        const [starting, balances]: [number, Balance[]] = await Promise.all([
          aqlQuery(
            q('transactions')
              .filter({
                [conditionsOpKey]: filters,
                account: acct.id,
                date: { $lt: startDate },
              })
              .calculate({ $sum: '$amount' }),
          ).then(({ data }) => data),

          aqlQuery(
            q('transactions')
              .filter({
                [conditionsOpKey]: filters,
              })
              .filter({
                account: acct.id,
                $and: [
                  { date: { $gte: startDate } },
                  { date: { $lte: endDate } },
                ],
              })
              .groupBy(
                interval === 'Yearly'
                  ? { $year: '$date' }
                  : interval === 'Daily' || interval === 'Weekly'
                    ? 'date'
                    : { $month: '$date' },
              )
              .select([
                {
                  date:
                    interval === 'Yearly'
                      ? { $year: '$date' }
                      : interval === 'Daily' || interval === 'Weekly'
                        ? 'date'
                        : { $month: '$date' },
                },
                { amount: { $sum: '$amount' } },
              ]),
          ).then(({ data }) => data),
        ]);

        // For weekly intervals, transform dates to week format and properly aggregate
        let processedBalances: Record<string, Balance>;
        let hasUnsafeBalance = false;
        if (interval === 'Weekly') {
          // Group transactions by week and sum their amounts
          const weeklyBalances = new Map<string, bigint>();
          balances.forEach(b => {
            if (!Number.isSafeInteger(b.amount)) {
              hasUnsafeBalance = true;
              return;
            }
            const weekDate = monthUtils.weekFromDate(b.date, firstDayOfWeekIdx);
            weeklyBalances.set(
              weekDate,
              (weeklyBalances.get(weekDate) ?? 0n) + BigInt(b.amount),
            );
          });

          // Convert back to Balance format
          processedBalances = {};
          weeklyBalances.forEach((amount, date) => {
            const safeAmount = safeNumberFromBigInt(amount);
            if (safeAmount === null) {
              hasUnsafeBalance = true;
              return;
            }
            processedBalances[date] = { date, amount: safeAmount };
          });
        } else {
          processedBalances = keyBy(balances, b => b.date);
        }

        return {
          id: acct.id,
          name: acct.name,
          balances: processedBalances,
          starting,
          hasUnsafeAmount: hasUnsafeBalance,
        };
      }),
    );
    const [data, transferLegs] = await Promise.all([
      accountDataPromise,
      transferLegsPromise,
    ]);

    const loadedTransferIds = new Set(transferLegs.map(leg => leg.id));
    const missingCounterpartIds = [
      ...new Set(
        transferLegs
          .map(leg => leg.transfer_id)
          .filter(id => !loadedTransferIds.has(id)),
      ),
    ];

    let allTransferLegs = transferLegs;
    if (missingCounterpartIds.length > 0) {
      const counterpartLegs: TransferLeg[] = await aqlQuery(
        q('transactions')
          .filter({
            [conditionsOpKey]: filters,
          })
          .filter({
            id: { $oneof: missingCounterpartIds },
            account: { $oneof: accountIds },
            transfer_id: { $ne: null },
          })
          .select(['id', 'account', 'amount', 'date', 'transfer_id']),
      ).then(({ data }: { data: TransferLeg[] }) => data);
      allTransferLegs = [...transferLegs, ...counterpartLegs];
    }

    // Prevent paired internal transfers from changing net worth between their
    // two posting dates.
    alignInternalTransferDates(data, allTransferLegs, accounts, prefs, {
      startDate,
      endDate,
      interval,
      firstDayOfWeekIdx,
    });

    const convertedData = convertAccountBalances(data, accounts, prefs);
    if (convertedData === null) {
      setData({ status: 'unavailable' });
      return;
    }

    setData(
      recalculate(
        convertedData,
        startDate,
        endDate,
        locale,
        interval,
        firstDayOfWeekIdx,
        format,
        dateFormat,
      ),
    );
  };
}

function alignInternalTransferDates(
  data: AccountBalanceData[],
  transferLegs: TransferLeg[],
  accounts: AccountEntity[],
  prefs: Readonly<SyncedPrefs>,
  range: IntervalRange,
) {
  const accountsById = new Map(data.map(account => [account.id, account]));
  const accountEntitiesById = new Map(
    accounts.map(account => [account.id, account]),
  );
  const transfersById = new Map(transferLegs.map(leg => [leg.id, leg]));
  const processed = new Set<string>();

  transferLegs.forEach(leg => {
    if (processed.has(leg.id)) {
      return;
    }

    const counterpart = transfersById.get(leg.transfer_id);
    if (
      !counterpart ||
      counterpart.transfer_id !== leg.id ||
      counterpart.account === leg.account ||
      counterpart.amount !== -leg.amount ||
      !accountsById.has(leg.account) ||
      !accountsById.has(counterpart.account) ||
      getEffectiveAccountCurrency(
        accountEntitiesById.get(leg.account)?.currency,
        prefs,
      ) !==
        getEffectiveAccountCurrency(
          accountEntitiesById.get(counterpart.account)?.currency,
          prefs,
        )
    ) {
      return;
    }

    processed.add(leg.id);
    processed.add(counterpart.id);

    if (leg.date === counterpart.date) {
      return;
    }

    const [earlier, later] =
      leg.date < counterpart.date ? [leg, counterpart] : [counterpart, leg];

    const account = accountsById.get(earlier.account);
    if (account) {
      moveTransferLeg(account, earlier, later.date, range);
    }
  });
}

function convertAccountBalances(
  data: AccountBalanceData[],
  accounts: AccountEntity[],
  prefs: Readonly<SyncedPrefs>,
): AccountBalanceData[] | null {
  const mainCurrency = prefs.defaultCurrencyCode;
  if (!mainCurrency) {
    return null;
  }

  const accountsById = new Map(accounts.map(account => [account.id, account]));
  const valuationTime = Date.now();
  const convertedData: AccountBalanceData[] = [];

  for (const accountData of data) {
    const account = accountsById.get(accountData.id);
    if (!account || accountData.hasUnsafeAmount) {
      return null;
    }

    const accountCurrency = getEffectiveAccountCurrency(
      account.currency,
      prefs,
    );
    if (!accountCurrency) {
      return null;
    }

    const convertAmount = (amount: number) => {
      if (!Number.isSafeInteger(amount)) {
        return null;
      }
      try {
        return convert(
          amount,
          accountCurrency,
          mainCurrency,
          prefs,
          valuationTime,
        );
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('safeNumber:')) {
          return null;
        }
        throw error;
      }
    };

    const starting = convertAmount(accountData.starting);
    if (starting === null) {
      return null;
    }

    const balances: Record<string, Balance> = {};
    for (const [date, balance] of Object.entries(accountData.balances)) {
      const amount = convertAmount(balance.amount);
      if (amount === null) {
        return null;
      }
      balances[date] = { date, amount };
    }

    convertedData.push({ ...accountData, starting, balances });
  }

  return convertedData;
}

function safeNumberFromBigInt(value: bigint): number | null {
  const maximum = BigInt(Number.MAX_SAFE_INTEGER);
  return value >= -maximum && value <= maximum ? Number(value) : null;
}

function safeSum(values: readonly number[]): number | null {
  let sum = 0n;
  for (const value of values) {
    if (!Number.isSafeInteger(value)) {
      return null;
    }
    sum += BigInt(value);
  }
  return safeNumberFromBigInt(sum);
}

function safeAdd(left: number, right: number): number | null {
  return safeSum([left, right]);
}

function safeSubtract(left: number, right: number): number | null {
  return safeSum([left, -right]);
}

function moveTransferLeg(
  account: AccountBalanceData,
  leg: TransferLeg,
  laterDate: string,
  range: IntervalRange,
) {
  const { startDate, endDate, interval, firstDayOfWeekIdx } = range;
  if (laterDate < startDate) {
    return;
  }

  if (leg.date < startDate) {
    account.starting -= leg.amount;
  } else {
    if (leg.date > endDate) {
      return;
    }
    const originalKey = getIntervalKey(leg.date, interval, firstDayOfWeekIdx);
    const originalBalance = account.balances[originalKey];
    if (!originalBalance) {
      return;
    }
    originalBalance.amount -= leg.amount;
  }

  if (laterDate > endDate) {
    return;
  }

  const intervalKey = getIntervalKey(laterDate, interval, firstDayOfWeekIdx);
  const balance = account.balances[intervalKey];
  if (balance) {
    balance.amount += leg.amount;
  } else {
    account.balances[intervalKey] = { date: intervalKey, amount: leg.amount };
  }
}

function getIntervalKey(
  date: string,
  interval: string,
  firstDayOfWeekIdx: string,
) {
  if (interval === 'Daily') {
    return date;
  }
  if (interval === 'Weekly') {
    return monthUtils.weekFromDate(date, firstDayOfWeekIdx);
  }
  if (interval === 'Yearly') {
    return date.slice(0, 4);
  }
  return monthUtils.getMonth(date);
}

function recalculate(
  data: AccountBalanceData[],
  startDate: string,
  endDate: string,
  locale: Locale,
  interval: string = 'Monthly',
  firstDayOfWeekIdx: string = '0',
  format: (value: unknown, type?: FormatType) => string,
  dateFormat?: string,
):
  | { status: 'unavailable' }
  | {
      status: 'complete';
      graphData: {
        data: Array<
          {
            x: string;
            y: number;
            assets: string;
            debt: string;
            change: string;
            networth: string;
            date: string;
          } & Record<string, string | number>
        >;
        hasNegative: boolean;
        start: string;
        end: string;
      };
      netWorth: number;
      totalChange: number;
      lowestNetWorth: number | null;
      highestNetWorth: number | null;
      accounts: Array<{ id: string; name: string }>;
    } {
  // Get intervals using the same pattern as other working spreadsheets
  const intervals =
    interval === 'Weekly'
      ? monthUtils.weekRangeInclusive(startDate, endDate, firstDayOfWeekIdx)
      : interval === 'Daily'
        ? monthUtils.dayRangeInclusive(startDate, endDate)
        : interval === 'Yearly'
          ? monthUtils.yearRangeInclusive(startDate, endDate)
          : monthUtils.rangeInclusive(
              monthUtils.getMonth(startDate),
              monthUtils.getMonth(endDate),
            );

  const accountBalances: number[][] = [];
  for (const account of data) {
    let balance = account.starting;
    const balances = [];
    for (const intervalItem of intervals) {
      if (account.balances[intervalItem]) {
        const nextBalance = safeAdd(
          balance,
          account.balances[intervalItem].amount,
        );
        if (nextBalance === null) {
          return { status: 'unavailable' as const };
        }
        balance = nextBalance;
      }
      balances.push(balance);
    }
    accountBalances.push(balances);
  }

  const priorPeriodNetWorth = safeSum(data.map(account => account.starting));
  if (priorPeriodNetWorth === null) {
    return { status: 'unavailable' };
  }

  let hasNegative = false;
  let startNetWorth = 0;
  let endNetWorth = 0;
  let lowestNetWorth: number | null = null;
  let highestNetWorth: number | null = null;

  const graphData: Array<
    {
      x: string;
      y: number;
      assets: string;
      debt: string;
      change: string;
      networth: string;
      date: string;
    } & Record<string, string | number>
  > = [];
  for (let idx = 0; idx < intervals.length; idx++) {
    const intervalItem = intervals[idx];
    const values = accountBalances.map(accountBalances => accountBalances[idx]);
    const assets = safeSum(values.filter(value => value >= 0));
    const debt = safeSum(
      values.filter(value => value < 0).map(value => -value),
    );
    const total = safeSum(values);
    const last =
      graphData.length === 0 ? null : graphData[graphData.length - 1];
    if (assets === null || debt === null || total === null) {
      return { status: 'unavailable' };
    }

    const balances: Record<string, number> = {};
    data.forEach((account, accountIndex) => {
      balances[account.id] = values[accountIndex];
    });

    if (total < 0) {
      hasNegative = true;
    }

    // Parse dates based on interval type - following the working pattern
    let x: Date;
    if (interval === 'Daily' || interval === 'Weekly') {
      x = d.parseISO(intervalItem);
    } else if (interval === 'Yearly') {
      x = d.parseISO(intervalItem + '-01-01');
    } else {
      x = d.parseISO(intervalItem + '-01');
    }

    const change = safeSubtract(total, last ? last.y : priorPeriodNetWorth);
    if (change === null) {
      return { status: 'unavailable' };
    }

    if (graphData.length === 0) {
      startNetWorth = total;
    }
    endNetWorth = total;

    // Use standardized format from ReportOptions, following the user's date
    // format preference for the day-level intervals.
    const displayFormat = getIntervalFormat(interval, dateFormat) || "MMM ''yy";

    const tooltipFormat =
      interval === 'Daily'
        ? 'MMMM d, yyyy'
        : interval === 'Weekly'
          ? 'MMM d, yyyy'
          : interval === 'Yearly'
            ? 'yyyy'
            : 'MMMM yyyy';

    const graphPoint = {
      x: d.format(x, displayFormat, { locale }),
      y: total,
      assets: format(assets, 'financial'),
      debt: `-${format(debt, 'financial')}`,
      change: format(change, 'financial'),
      networth: format(total, 'financial'),
      date: d.format(x, tooltipFormat, { locale }),
      ...balances,
    };

    graphData.push(graphPoint);

    // Track min/max for the current point only
    if (lowestNetWorth === null || graphPoint.y < lowestNetWorth) {
      lowestNetWorth = graphPoint.y;
    }
    if (highestNetWorth === null || graphPoint.y > highestNetWorth) {
      highestNetWorth = graphPoint.y;
    }
  }

  const hasBalance = accountBalances.map(balances =>
    balances.some(b => b !== 0),
  );

  const totalChange = safeSubtract(endNetWorth, startNetWorth);
  if (totalChange === null) {
    return { status: 'unavailable' };
  }

  return {
    status: 'complete',
    graphData: {
      data: graphData,
      hasNegative,
      start: startDate,
      end: endDate,
    },
    netWorth: endNetWorth,
    totalChange,
    lowestNetWorth,
    highestNetWorth,
    accounts: data
      .filter((_, i) => hasBalance[i])
      .map(d => ({ id: d.id, name: d.name })),
  };
}
