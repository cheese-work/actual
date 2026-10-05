import { send } from '@actual-app/core/platform/client/connection';
import { getEffectiveAccountCurrency } from '@actual-app/core/shared/currency-setup';
import { convert } from '@actual-app/core/shared/exchange-rates';
import * as monthUtils from '@actual-app/core/shared/months';
import { q } from '@actual-app/core/shared/query';
import type {
  AccountEntity,
  RuleConditionEntity,
  SummaryContent,
} from '@actual-app/core/types/models';
import type { SyncedPrefs } from '@actual-app/core/types/prefs';
import * as d from 'date-fns';
import type { Locale } from 'date-fns';

import type { useSpreadsheet } from '#hooks/useSpreadsheet';
import { aqlQuery } from '#queries/aqlQuery';

type SummaryQueryRow = {
  account: string | null;
  amount: number;
  count: number;
};

type ConvertedSummaryRow = {
  account: string;
  amount: number;
  count: number;
};

type SummaryData = {
  total: number;
  divisor: number;
  dividend: number;
  fromRange: string;
  toRange: string;
  hasForeignCurrency: boolean;
};

type SummaryResult = SummaryData | { status: 'unavailable' };

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

function convertSummaryRows(
  rows: SummaryQueryRow[],
  accounts: AccountEntity[],
  prefs: Readonly<SyncedPrefs>,
  valuationTime: number,
): { rows: ConvertedSummaryRow[]; hasForeignCurrency: boolean } | null {
  const mainCurrency = prefs.defaultCurrencyCode;
  if (!mainCurrency) {
    return null;
  }

  const accountsById = new Map(accounts.map(account => [account.id, account]));
  const amountsByAccount = new Map<string, bigint>();
  const countsByAccount = new Map<string, bigint>();

  for (const row of rows) {
    if (
      !row.account ||
      !Number.isSafeInteger(row.amount) ||
      !Number.isSafeInteger(row.count) ||
      row.count < 0 ||
      !accountsById.has(row.account)
    ) {
      return null;
    }

    amountsByAccount.set(
      row.account,
      (amountsByAccount.get(row.account) ?? 0n) + BigInt(row.amount),
    );
    countsByAccount.set(
      row.account,
      (countsByAccount.get(row.account) ?? 0n) + BigInt(row.count),
    );
  }

  const convertedRows: ConvertedSummaryRow[] = [];
  let hasForeignCurrency = false;
  for (const [accountId, nativeAmount] of amountsByAccount) {
    const amount = safeNumberFromBigInt(nativeAmount);
    const count = safeNumberFromBigInt(countsByAccount.get(accountId) ?? 0n);
    const account = accountsById.get(accountId);
    if (amount === null || count === null || !account) {
      return null;
    }

    const accountCurrency = getEffectiveAccountCurrency(
      account.currency,
      prefs,
    );
    if (!accountCurrency) {
      return null;
    }

    let mainAmount: number | null;
    try {
      mainAmount = convert(
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
    if (mainAmount === null || !Number.isSafeInteger(mainAmount)) {
      return null;
    }

    hasForeignCurrency ||= accountCurrency !== mainCurrency;
    convertedRows.push({ account: accountId, amount: mainAmount, count });
  }

  return { rows: convertedRows, hasForeignCurrency };
}

function sumSummaryAmounts(rows: ConvertedSummaryRow[]): number | null {
  return safeSum(rows.map(row => row.amount));
}

export function summarySpreadsheet(
  start: string,
  end: string,
  conditions: RuleConditionEntity[] = [],
  conditionsOp: 'and' | 'or' = 'and',
  summaryContent: SummaryContent,
  locale: Locale,
  accounts: AccountEntity[],
  prefs: Readonly<SyncedPrefs>,
  accountsReady: boolean,
) {
  return async (
    spreadsheet: ReturnType<typeof useSpreadsheet>,
    setData: (data: SummaryResult) => void,
  ) => {
    const prefsSnapshot: Readonly<SyncedPrefs> = { ...prefs };
    if (!prefsSnapshot.defaultCurrencyCode) {
      setData({ status: 'unavailable' });
      return;
    }
    if (!accountsReady) {
      return;
    }

    let filters: unknown[] = [];
    try {
      const response = await send('make-filters-from-conditions', {
        conditions: conditions.filter(cond => !cond.customName),
      });
      filters = response.filters;
    } catch (error) {
      console.error('Error fetching filters:', error);
    }
    const conditionsOpKey = conditionsOp === 'or' ? '$or' : '$and';

    let startDay: Date;
    let endDay: Date;
    try {
      startDay = d.parse(
        monthUtils.firstDayOfMonth(start),
        'yyyy-MM-dd',
        new Date(),
      );

      endDay = d.parse(
        monthUtils.getMonth(end) ===
          monthUtils.getMonth(monthUtils.currentDay())
          ? monthUtils.currentDay()
          : monthUtils.lastDayOfMonth(end),
        'yyyy-MM-dd',
        new Date(),
      );
    } catch (error) {
      console.error('Error parsing dates:', error);
      throw new Error('Invalid date format provided');
    }

    if (!d.isValid(startDay) || !d.isValid(endDay)) {
      throw new Error('Invalid date values provided');
    }

    if (d.isAfter(startDay, endDay)) {
      throw new Error('Start date must be before or equal to end date.');
    }

    const getOneDatePerMonth = (start: Date, end: Date) => {
      const months = [];
      let currentDate = d.startOfMonth(start);

      while (!d.isSameMonth(currentDate, end)) {
        months.push(currentDate);
        currentDate = d.addMonths(currentDate, 1);
      }
      months.push(end);

      return months;
    };

    const makeRootQuery = () =>
      q('transactions')
        .filter({
          $and: [
            {
              date: {
                $gte: d.format(startDay, 'yyyy-MM-dd'),
              },
            },
            {
              date: {
                $lte: d.format(endDay, 'yyyy-MM-dd'),
              },
            },
          ],
        })
        .filter({
          [conditionsOpKey]: filters,
        })
        .groupBy('account')
        .select([
          'account',
          { amount: { $sum: '$amount' } },
          { count: { $count: '*' } },
        ]);

    let data;
    try {
      data = await aqlQuery(makeRootQuery());
    } catch (error) {
      console.error('Error executing query:', error);
      return;
    }

    const dateRanges = {
      fromRange: d.format(startDay, 'MMM yy', { locale }),
      toRange: d.format(endDay, 'MMM yy', { locale }),
    };

    const valuationTime = Date.now();
    const converted = convertSummaryRows(
      data.data,
      accounts,
      prefsSnapshot,
      valuationTime,
    );
    if (!converted) {
      setData({ status: 'unavailable' });
      return;
    }
    const totalAmount = sumSummaryAmounts(converted.rows);
    if (totalAmount === null) {
      setData({ status: 'unavailable' });
      return;
    }

    switch (summaryContent.type) {
      case 'sum':
        setData({
          ...dateRanges,
          total: totalAmount,
          dividend: totalAmount,
          divisor: 0,
          hasForeignCurrency: converted.hasForeignCurrency,
        });
        break;

      case 'avgPerTransact': {
        const transactionCount = safeSum(converted.rows.map(row => row.count));
        if (transactionCount === null) {
          setData({ status: 'unavailable' });
          return;
        }
        setData({
          ...dateRanges,
          total: transactionCount ? totalAmount / transactionCount : 0,
          dividend: totalAmount,
          divisor: transactionCount,
          hasForeignCurrency: converted.hasForeignCurrency,
        });
        break;
      }

      case 'avgPerMonth': {
        const months = getOneDatePerMonth(startDay, endDay);
        const average = calculatePerMonth(converted.rows, months);
        if (!average) {
          setData({ status: 'unavailable' });
          return;
        }
        setData({
          ...dateRanges,
          ...average,
          hasForeignCurrency: converted.hasForeignCurrency,
        });
        break;
      }

      case 'avgPerYear': {
        const average = calculatePerYear(converted.rows, startDay, endDay);
        if (!average) {
          setData({ status: 'unavailable' });
          return;
        }
        setData({
          ...dateRanges,
          ...average,
          hasForeignCurrency: converted.hasForeignCurrency,
        });
        break;
      }

      case 'percentage': {
        const percentage = await calculatePercentage(
          converted.rows,
          summaryContent,
          startDay,
          endDay,
          accounts,
          prefsSnapshot,
          valuationTime,
        );
        if ('status' in percentage) {
          setData({ status: 'unavailable' });
          return;
        }
        setData({
          ...dateRanges,
          ...percentage,
          hasForeignCurrency:
            converted.hasForeignCurrency || percentage.hasForeignCurrency,
        });
        break;
      }

      default:
        throw new Error(`Unsupported summary type`);
    }
  };
}

function calculatePerMonth(
  data: ConvertedSummaryRow[],
  months: Date[],
): Pick<SummaryData, 'total' | 'dividend' | 'divisor'> | null {
  if (!data.length || !months.length) {
    return { total: 0, dividend: 0, divisor: 0 };
  }

  const lastMonth = months.at(-1)!;
  const dayOfMonth = lastMonth.getDate();
  const daysInMonth = monthUtils.getDay(monthUtils.lastDayOfMonth(lastMonth));
  const numMonths = months.length - 1 + dayOfMonth / daysInMonth;

  const totalAmount = sumSummaryAmounts(data);
  if (totalAmount === null) {
    return null;
  }
  const averageAmountPerMonth = totalAmount / numMonths;

  return {
    total: averageAmountPerMonth,
    dividend: totalAmount,
    divisor: numMonths,
  };
}

function calculatePerYear(
  data: ConvertedSummaryRow[],
  startDate: Date,
  endDate: Date,
): Pick<SummaryData, 'total' | 'dividend' | 'divisor'> | null {
  if (!data.length) {
    return { total: 0, dividend: 0, divisor: 0 };
  }

  const totalAmount = sumSummaryAmounts(data);
  if (totalAmount === null) {
    return null;
  }
  const totalDays = d.differenceInDays(endDate, startDate) + 1;
  const numYears = totalDays / 365.25;

  const averageAmountPerYear = totalAmount / numYears;

  return {
    total: averageAmountPerYear,
    dividend: totalAmount,
    divisor: numYears,
  };
}

async function calculatePercentage(
  data: ConvertedSummaryRow[],
  summaryContent: Extract<SummaryContent, { type: 'percentage' }>,
  startDay: Date,
  endDay: Date,
  accounts: AccountEntity[],
  prefs: Readonly<SyncedPrefs>,
  valuationTime: number,
) {
  const conditionsOpKey =
    summaryContent.divisorConditionsOp === 'or' ? '$or' : '$and';
  let filters = [];
  try {
    const response = await send('make-filters-from-conditions', {
      conditions: summaryContent?.divisorConditions?.filter(
        cond => !cond.customName,
      ),
    });
    filters = response.filters;
  } catch (error) {
    console.error('Error creating filters:', error);
    return {
      total: 0,
      dividend: 0,
      divisor: 0,
      hasForeignCurrency: false,
    };
  }

  const makeDivisorQuery = () =>
    q('transactions')
      .filter({
        [conditionsOpKey]: filters,
      })
      .groupBy('account')
      .select([
        'account',
        { amount: { $sum: '$amount' } },
        { count: { $count: '*' } },
      ]);

  let query = makeDivisorQuery();

  if (!(summaryContent.divisorAllTimeDateRange ?? false)) {
    query = query.filter({
      $and: [
        {
          date: {
            $gte: d.format(startDay, 'yyyy-MM-dd'),
          },
        },
        {
          date: {
            $lte: d.format(endDay, 'yyyy-MM-dd'),
          },
        },
      ],
    });
  }

  let divisorData;
  try {
    divisorData = (await aqlQuery(query)) as { data: SummaryQueryRow[] };
  } catch (error) {
    console.error('Error executing divisor query:', error);
    return {
      total: 0,
      dividend: 0,
      divisor: 0,
      hasForeignCurrency: false,
    };
  }

  const convertedDivisor = convertSummaryRows(
    divisorData?.data ?? [],
    accounts,
    prefs,
    valuationTime,
  );
  if (!convertedDivisor) {
    return { status: 'unavailable' as const };
  }
  const divisorValue = sumSummaryAmounts(convertedDivisor.rows);
  const dividend = sumSummaryAmounts(data);
  if (divisorValue === null || dividend === null) {
    return { status: 'unavailable' as const };
  }
  return {
    total:
      divisorValue === 0
        ? 0
        : Math.round((dividend / divisorValue) * 10000) / 100,
    divisor: divisorValue,
    dividend,
    hasForeignCurrency: convertedDivisor.hasForeignCurrency,
  };
}
