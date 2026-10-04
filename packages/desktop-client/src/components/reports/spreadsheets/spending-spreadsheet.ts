import { send } from '@actual-app/core/platform/client/connection';
import { getEffectiveAccountCurrency } from '@actual-app/core/shared/currency-setup';
import { convert } from '@actual-app/core/shared/exchange-rates';
import * as monthUtils from '@actual-app/core/shared/months';
import { q } from '@actual-app/core/shared/query';
import type {
  AccountEntity,
  CategoryEntity,
  CategoryGroupEntity,
  RuleConditionEntity,
  SpendingAverageRange,
  SpendingEntity,
  SpendingMonthEntity,
} from '@actual-app/core/types/models';
import type { SyncedPrefs } from '@actual-app/core/types/prefs';
// @ts-strict-ignore
import { keyBy } from 'es-toolkit';

import { resolveSpendingAverageRange } from '#components/reports/spendingAverageRange';
import { fromDateRepr } from '#components/reports/util';
import type { useSpreadsheet } from '#hooks/useSpreadsheet';
import { aqlQuery } from '#queries/aqlQuery';

import {
  filterCategoriesByConditions,
  isSupportedCategoryCondition,
} from './budgetDataQuery';
import { makeQuery } from './makeQuery';

type createSpendingSpreadsheetProps = {
  accounts: AccountEntity[];
  prefs: Readonly<SyncedPrefs>;
  accountsReady: boolean;
  conditions?: RuleConditionEntity[];
  conditionsOp?: 'and' | 'or';
  compare?: string;
  compareTo?: string;
  averageRange?: SpendingAverageRange;
  budgetType?: 'envelope' | 'tracking';
};

type SpendingReportData =
  | (SpendingEntity & { hasForeignCurrency: boolean })
  | { status: 'unavailable' };

type SpendingQueryRow = {
  account?: string | null;
  accountOffBudget?: boolean | number;
  categoryIncome?: boolean | number;
  date: string;
  amount: number;
};

type SpendingDateTotals = {
  perIntervalAssets: number;
  perIntervalDebts: number;
};

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

function getConvertedSpendingTotals(
  assets: SpendingQueryRow[],
  debts: SpendingQueryRow[],
  accounts: AccountEntity[],
  prefs: Readonly<SyncedPrefs>,
  valuationTime: number,
): {
  totalsByDate: Map<string, SpendingDateTotals>;
  hasForeignCurrency: boolean;
} | null {
  const mainCurrency = prefs.defaultCurrencyCode;
  if (!mainCurrency) {
    return null;
  }

  const accountsById = new Map(accounts.map(account => [account.id, account]));
  const amountsByAccountAndDate = new Map<
    string,
    {
      accountId: string;
      date: string;
      type: 'assets' | 'debts';
      amount: bigint;
    }
  >();

  for (const [type, rows] of [
    ['assets', assets],
    ['debts', debts],
  ] as const) {
    for (const row of rows) {
      if (row.categoryIncome || row.accountOffBudget) {
        continue;
      }

      if (!row.account || !accountsById.has(row.account)) {
        return null;
      }
      if (!Number.isSafeInteger(row.amount)) {
        return null;
      }

      const key = `${type}\u0000${row.account}\u0000${row.date}`;
      const existing = amountsByAccountAndDate.get(key);
      amountsByAccountAndDate.set(key, {
        accountId: row.account,
        date: row.date,
        type,
        amount: (existing?.amount ?? 0n) + BigInt(row.amount),
      });
    }
  }

  const totalsByDate = new Map<string, SpendingDateTotals>();
  let hasForeignCurrency = false;

  for (const leaf of amountsByAccountAndDate.values()) {
    const amount = safeNumberFromBigInt(leaf.amount);
    const account = accountsById.get(leaf.accountId);
    if (amount === null || !account) {
      return null;
    }

    const accountCurrency = getEffectiveAccountCurrency(
      account.currency,
      prefs,
    );
    if (!accountCurrency) {
      return null;
    }

    let convertedAmount: number | null;
    try {
      convertedAmount = convert(
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
    if (convertedAmount === null) {
      return null;
    }

    const totals = totalsByDate.get(leaf.date) ?? {
      perIntervalAssets: 0,
      perIntervalDebts: 0,
    };
    const field =
      leaf.type === 'assets' ? 'perIntervalAssets' : 'perIntervalDebts';
    const nextTotal = safeAdd(totals[field], convertedAmount);
    if (nextTotal === null) {
      return null;
    }
    totals[field] = nextTotal;
    totalsByDate.set(leaf.date, totals);
    hasForeignCurrency ||= accountCurrency !== mainCurrency;
  }

  return { totalsByDate, hasForeignCurrency };
}

export function getSpendingBudgetFilters({
  categories,
  categoryGroups,
  conditions,
  conditionsOp,
}: {
  categories: CategoryEntity[];
  categoryGroups: CategoryGroupEntity[];
  conditions: RuleConditionEntity[];
  conditionsOp?: 'and' | 'or';
}) {
  const budgetConditions = conditions.filter(
    cond =>
      !cond.customName &&
      (cond.field === 'category' || cond.field === 'category_group'),
  );

  if (budgetConditions.length === 0) {
    return [];
  }

  if (!budgetConditions.every(isSupportedCategoryCondition)) {
    return [];
  }

  const matchingCategoryIds = filterCategoriesByConditions(
    categories,
    categoryGroups,
    budgetConditions,
    conditionsOp ?? 'and',
  ).map(category => category.id);

  return [{ category: { $oneof: matchingCategoryIds } }];
}

export function createSpendingSpreadsheet({
  accounts,
  prefs,
  accountsReady,
  conditions = [],
  conditionsOp,
  compare,
  compareTo,
  averageRange,
  budgetType = 'envelope',
}: createSpendingSpreadsheetProps) {
  const compareMonth = compare ?? monthUtils.currentMonth();
  const compareToMonth = compareTo ?? monthUtils.subMonths(compareMonth, 1);
  const endDate = monthUtils.getMonthEnd(compareMonth + '-01');
  const startDateTo = compareToMonth + '-01';
  const endDateTo = monthUtils.getMonthEnd(compareToMonth + '-01');
  const interval = 'Daily';
  const compareInterval = monthUtils.dayRangeInclusive(
    compareMonth + '-01',
    endDate,
  );

  return async (
    spreadsheet: ReturnType<typeof useSpreadsheet>,
    setData: (data: SpendingReportData) => void,
  ) => {
    if (!accountsReady) {
      return;
    }
    if (!prefs.defaultCurrencyCode) {
      setData({ status: 'unavailable' });
      return;
    }

    const earliestTrans =
      averageRange?.mode === 'all-time'
        ? await send('get-earliest-transaction')
        : null;
    const earliestMonth = earliestTrans
      ? monthUtils.monthFromDate(fromDateRepr(earliestTrans.date))
      : null;
    const resolvedAverageRange = resolveSpendingAverageRange({
      averageRange,
      compare: compareMonth,
      earliestMonth,
    });
    const averageMonths = new Set(resolvedAverageRange.months);
    const startDate = (resolvedAverageRange.startMonth ?? compareMonth) + '-01';

    const { filters } = await send('make-filters-from-conditions', {
      conditions: conditions.filter(cond => !cond.customName),
    });

    const conditionsOpKey = conditionsOp === 'or' ? '$or' : '$and';

    const [assets, debts] = await Promise.all([
      aqlQuery(
        makeQuery(
          'assets',
          startDate,
          endDate,
          interval,
          conditionsOpKey,
          filters,
        ),
      ).then(({ data }) => data),
      aqlQuery(
        makeQuery(
          'debts',
          startDate,
          endDate,
          interval,
          conditionsOpKey,
          filters,
        ),
      ).then(({ data }) => data),
    ]);

    const [assetsTo, debtsTo] = await Promise.all([
      aqlQuery(
        makeQuery(
          'assets',
          startDateTo,
          endDateTo,
          interval,
          conditionsOpKey,
          filters,
        ),
      ).then(({ data }) => data),
      aqlQuery(
        makeQuery(
          'debts',
          startDateTo,
          endDateTo,
          interval,
          conditionsOpKey,
          filters,
        ),
      ).then(({ data }) => data),
    ]);

    const overlapAssets =
      endDateTo < startDate || startDateTo > endDate ? assetsTo : [];
    const overlapDebts =
      endDateTo < startDate || startDateTo > endDate ? debtsTo : [];

    const combineAssets = [...assets, ...overlapAssets];
    const combineDebts = [...debts, ...overlapDebts];
    const convertedSpending = getConvertedSpendingTotals(
      combineAssets,
      combineDebts,
      accounts,
      prefs,
      Date.now(),
    );
    if (!convertedSpending) {
      setData({ status: 'unavailable' });
      return;
    }
    const { totalsByDate, hasForeignCurrency } = convertedSpending;

    const budgetMonth = parseInt(compareMonth.replace('-', ''));
    const budgetTable =
      budgetType === 'tracking' ? 'reflect_budgets' : 'zero_budgets';
    const hasBudgetConditions = conditions.some(
      cond =>
        !cond.customName &&
        (cond.field === 'category' || cond.field === 'category_group'),
    );
    const budgetFilters = hasBudgetConditions
      ? await send('get-categories').then(({ list, grouped }) =>
          getSpendingBudgetFilters({
            categories: list,
            categoryGroups: grouped,
            conditions,
            conditionsOp,
          }),
        )
      : [];
    const [budgets] = await Promise.all([
      aqlQuery(
        q(budgetTable)
          .filter({
            $and: [{ month: { $eq: budgetMonth } }, ...budgetFilters],
          })
          .groupBy([{ $id: '$category' }])
          .select([
            { category: { $id: '$category' } },
            { amount: { $sum: '$amount' } },
          ]),
      ).then(({ data }) => data),
    ]);

    const budgetTotal = safeSum((budgets ?? []).map(value => value.amount));
    if (budgetTotal === null) {
      setData({ status: 'unavailable' });
      return;
    }
    const compareIntervalLength = BigInt(compareInterval.length);

    const intervals = monthUtils.dayRangeInclusive(startDate, endDate);
    if (endDateTo < startDate || startDateTo > endDate) {
      intervals.push(...monthUtils.dayRangeInclusive(startDateTo, endDateTo));
    }

    const days = [...Array(29).keys()]
      .filter(f => f > 0)
      .map(n => n.toString().padStart(2, '0'));

    let totalAssets = 0;
    let totalDebts = 0;
    let totalBudget = 0;
    let budgetDaysElapsed = 0;
    let totalsAreSafe = true;

    const addOrZero = (left: number, right: number) => {
      const total = safeAdd(left, right);
      if (total === null) {
        totalsAreSafe = false;
        return 0;
      }
      return total;
    };

    const months = monthUtils.rangeInclusive(startDate, endDate).map(month => {
      return { month, perMonthAssets: 0, perMonthDebts: 0 };
    });

    if (endDateTo < startDate || startDateTo > endDate) {
      months.unshift({
        month: compareToMonth,
        perMonthAssets: 0,
        perMonthDebts: 0,
      });
    }

    const intervalData = days.map(day => {
      let averageSum = 0;
      let monthCount = 0;
      const dayData = months.map(month => {
        const data = intervals.reduce((arr, intervalItem) => {
          const offsetDay =
            Number(intervalItem.substring(8, 10)) >= 28
              ? '28'
              : intervalItem.substring(8, 10);
          let perIntervalAssets = 0;
          let perIntervalDebts = 0;

          if (
            month.month === monthUtils.getMonth(intervalItem) &&
            day === offsetDay
          ) {
            const totals = totalsByDate.get(intervalItem);
            perIntervalAssets += totals?.perIntervalAssets ?? 0;
            perIntervalDebts += totals?.perIntervalDebts ?? 0;

            totalAssets = addOrZero(totalAssets, perIntervalAssets);
            totalDebts = addOrZero(totalDebts, perIntervalDebts);

            let cumulativeAssets = 0;
            let cumulativeDebts = 0;

            if (month.month === compareMonth) {
              budgetDaysElapsed += 1;
              const allocatedBudget = safeNumberFromBigInt(
                (BigInt(budgetTotal) * BigInt(budgetDaysElapsed)) /
                  compareIntervalLength,
              );
              if (allocatedBudget === null) {
                totalsAreSafe = false;
                totalBudget = 0;
              } else {
                totalBudget = -allocatedBudget;
              }
            }

            months.map(m => {
              if (m.month === month.month) {
                m.perMonthAssets = addOrZero(
                  m.perMonthAssets,
                  perIntervalAssets,
                );
                m.perMonthDebts = addOrZero(m.perMonthDebts, perIntervalDebts);
                cumulativeAssets = m.perMonthAssets;
                cumulativeDebts = m.perMonthDebts;
              }
              return null;
            });

            const cumulative = addOrZero(cumulativeAssets, cumulativeDebts);

            if (averageMonths.has(month.month)) {
              if (day === '28') {
                if (monthUtils.getMonthEnd(intervalItem) === intervalItem) {
                  averageSum = addOrZero(averageSum, cumulative);
                  monthCount += 1;
                }
              } else {
                averageSum = addOrZero(averageSum, cumulative);
                monthCount += 1;
              }
            }

            const totalInterval = addOrZero(
              perIntervalDebts,
              perIntervalAssets,
            );

            arr.push({
              date: intervalItem,
              totalDebts: perIntervalDebts,
              totalAssets: perIntervalAssets,
              totalTotals: totalInterval,
              cumulative:
                intervalItem <= monthUtils.currentDay() ? cumulative : null,
            });
          }

          return arr;
        }, []);
        const maxCumulative = data.reduce((a, b) =>
          b.cumulative === null ? a : b,
        ).cumulative;

        const totalDaily = safeSum(data.map(value => value.totalTotals));
        if (totalDaily === null) {
          totalsAreSafe = false;
        }

        return {
          date: data[0].date,
          cumulative: maxCumulative,
          daily: totalDaily ?? 0,
          month: month.month,
        };
      });
      const indexedData: SpendingMonthEntity = keyBy(dayData, d => d.month);
      return {
        months: indexedData,
        day,
        average: monthCount === 0 ? 0 : Math.round(averageSum / monthCount),
        compare: dayData.filter(c => c.month === compareMonth)[0].cumulative,
        compareTo: dayData.filter(c => c.month === compareToMonth)[0]
          .cumulative,
        budget: totalBudget,
      };
    });

    const totalTotals = safeSum([totalAssets, totalDebts]);
    if (!totalsAreSafe || totalTotals === null) {
      setData({ status: 'unavailable' });
      return;
    }

    setData({
      intervalData,
      averageRange: resolvedAverageRange,
      startDate,
      endDate,
      totalDebts,
      totalAssets,
      totalTotals,
      hasForeignCurrency,
    });
  };
}
