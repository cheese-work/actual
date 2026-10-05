import { send } from '@actual-app/core/platform/client/connection';
import type { AccountEntity } from '@actual-app/core/types/models';
import * as monthUtils from '@actual-app/core/shared/months';
import { q } from '@actual-app/core/shared/query';
import type { RuleConditionEntity } from '@actual-app/core/types/models';
import type { SyncedPrefs } from '@actual-app/core/types/prefs';
import * as d from 'date-fns';

import type { ReportDataStatus } from '#components/reports/spreadsheets/report-currency';
import { convertReportQueryRows } from '#components/reports/spreadsheets/report-currency';
import type { useSpreadsheet } from '#hooks/useSpreadsheet';
import { aqlQuery } from '#queries/aqlQuery';

export type CalendarDataType = {
  date: Date;
  incomeValue: number;
  expenseValue: number;
  incomeSize: number;
  expenseSize: number;
};

export type CalendarSpreadsheetResult =
  | {
      calendarData: {
        start: Date;
        end: Date;
        data: CalendarDataType[];
        totalExpense: number;
        totalIncome: number;
      }[];
      hasForeignCurrency: boolean;
    }
  | ReportDataStatus;

type CalendarQueryRow = {
  account: string;
  date: string;
  amount: number;
};

export function calendarSpreadsheet(
  start: string,
  end: string,
  conditions: RuleConditionEntity[] = [],
  conditionsOp: 'and' | 'or' = 'and',
  firstDayOfWeekIdx: SyncedPrefs['firstDayOfWeekIdx'],
  accounts: AccountEntity[],
  prefs: Readonly<SyncedPrefs>,
  accountsReady: boolean,
) {
  return async (
    spreadsheet: ReturnType<typeof useSpreadsheet>,
    setData: (data: CalendarSpreadsheetResult) => void,
  ) => {
    if (!accountsReady) {
      setData({ status: 'loading' });
      return;
    }
    if (!prefs.defaultCurrencyCode) {
      setData({ status: 'unavailable' });
      return;
    }

    let filters: unknown[];

    try {
      const { filters: filtersLocal } = await send(
        'make-filters-from-conditions',
        {
          conditions: conditions.filter(cond => !cond.customName),
        },
      );
      filters = filtersLocal;
    } catch (error) {
      console.error('Failed to make filters from conditions:', error);
      setData({ status: 'unavailable' });
      return;
    }
    const conditionsOpKey = conditionsOp === 'or' ? '$or' : '$and';

    let startDay: Date;
    try {
      startDay = d.parse(
        monthUtils.firstDayOfMonth(start),
        'yyyy-MM-dd',
        new Date(),
      );
    } catch (error) {
      console.error('Failed to parse start date:', error);
      throw new Error('Invalid start date format');
    }

    let endDay: Date;
    try {
      endDay = d.parse(
        monthUtils.lastDayOfMonth(end),
        'yyyy-MM-dd',
        new Date(),
      );
    } catch (error) {
      console.error('Failed to parse end date:', error);
      throw new Error('Invalid end date format');
    }

    const makeRootQuery = () =>
      q('transactions')
        .filter({
          $and: [
            { date: { $gte: d.format(startDay, 'yyyy-MM-dd') } },
            { date: { $lte: d.format(endDay, 'yyyy-MM-dd') } },
          ],
        })
        .filter({
          [conditionsOpKey]: filters,
        })
        .groupBy(['account', 'date'])
        .select(['account', 'date', { amount: { $sum: '$amount' } }]);

    let expenseData: { data: CalendarQueryRow[] };
    let incomeData: { data: CalendarQueryRow[] };
    try {
      [expenseData, incomeData] = await Promise.all([
        aqlQuery(
          makeRootQuery().filter({
            $and: { amount: { $lt: 0 } },
          }),
        ),
        aqlQuery(
          makeRootQuery().filter({
            $and: { amount: { $gt: 0 } },
          }),
        ),
      ]);
    } catch (error) {
      console.error('Failed to fetch calendar data:', error);
      setData({ status: 'unavailable' });
      return;
    }

    const valuationTime = Date.now();
    const accountsById = new Map(accounts.map(account => [account.id, account]));
    const convertRows = (rows: CalendarQueryRow[]) =>
      convertReportQueryRows(
        rows.map(row => ({
          ...row,
          accountOffBudget: Boolean(accountsById.get(row.account)?.offbudget),
        })),
        accounts,
        prefs,
        true,
        valuationTime,
      );
    const convertedExpenseRows = convertRows(expenseData.data);
    const convertedIncomeRows = convertRows(incomeData.data);
    if (!Array.isArray(convertedExpenseRows)) {
      setData(convertedExpenseRows);
      return;
    }
    if (!Array.isArray(convertedIncomeRows)) {
      setData(convertedIncomeRows);
      return;
    }
    const expenseByDate = sumRowsByDate(convertedExpenseRows);
    const incomeByDate = sumRowsByDate(convertedIncomeRows);
    if (!Array.isArray(expenseByDate)) {
      setData(expenseByDate);
      return;
    }
    if (!Array.isArray(incomeByDate)) {
      setData(incomeByDate);
      return;
    }
    const hasForeignCurrency = [
      ...convertedExpenseRows,
      ...convertedIncomeRows,
    ].some(row => {
      const currency = accountsById.get(row.account)?.currency;
      return currency != null && currency !== prefs.defaultCurrencyCode;
    });

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

    setData(
      recalculate(
        incomeByDate,
        expenseByDate,
        getOneDatePerMonth(startDay, endDay),
        start,
        firstDayOfWeekIdx,
        hasForeignCurrency,
      ),
    );
  };
}

function sumRowsByDate(rows: Array<{ date: string; amount: number }>) {
  const amounts = new Map<string, number>();
  for (const row of rows) {
    const amount = (amounts.get(row.date) ?? 0) + row.amount;
    if (!Number.isSafeInteger(amount)) {
      return { status: 'unavailable' } as const;
    }
    amounts.set(row.date, amount);
  }
  return Array.from(amounts, ([date, amount]) => ({ date, amount }));
}

function recalculate(
  incomeData: Array<{
    date: string;
    amount: number;
  }>,
  expenseData: Array<{
    date: string;
    amount: number;
  }>,
  months: Date[],
  start: string,
  firstDayOfWeekIdx?: SyncedPrefs['firstDayOfWeekIdx'],
  hasForeignCurrency = false,
) {
  const incomeDataMap = new Map<string, number>();
  incomeData.forEach(item => {
    incomeDataMap.set(item.date, item.amount);
  });

  const expenseDataMap = new Map<string, number>();
  expenseData.forEach(item => {
    expenseDataMap.set(item.date, item.amount);
  });

  const parseAndCacheDate = (() => {
    const cache = new Map<string, Date>();
    return (dateStr: string) => {
      if (!cache.has(dateStr)) {
        cache.set(dateStr, d.parse(dateStr, 'yyyy-MM-dd', new Date()));
      }
      return cache.get(dateStr)!;
    };
  })();

  const getDaysArray = (month: Date) => {
    const expenseValues = expenseData
      .filter(f => d.isSameMonth(parseAndCacheDate(f.date), month))
      .map(m => Math.abs(m.amount));
    const incomeValues = incomeData
      .filter(f => d.isSameMonth(parseAndCacheDate(f.date), month))
      .map(m => Math.abs(m.amount));

    const totalExpenseValue = expenseValues.length
      ? expenseValues.reduce((acc, val) => acc + val, 0)
      : null;

    const totalIncomeValue = incomeValues.length
      ? incomeValues.reduce((acc, val) => acc + val, 0)
      : null;

    const getBarLength = (value: number) => {
      if (
        value < 0 &&
        typeof totalExpenseValue === 'number' &&
        totalExpenseValue > 0
      ) {
        const result = (Math.abs(value) / totalExpenseValue) * 100;
        return Number.isFinite(result) ? result : 0;
      } else if (
        value > 0 &&
        typeof totalIncomeValue === 'number' &&
        totalIncomeValue > 0
      ) {
        const result = (value / totalIncomeValue) * 100;
        return Number.isFinite(result) ? result : 0;
      } else {
        return 0;
      }
    };

    const firstDay = d.startOfMonth(month);
    const beginDay = d.startOfWeek(firstDay, {
      weekStartsOn:
        firstDayOfWeekIdx !== undefined &&
        !Number.isNaN(parseInt(firstDayOfWeekIdx)) &&
        parseInt(firstDayOfWeekIdx) >= 0 &&
        parseInt(firstDayOfWeekIdx) <= 6
          ? (parseInt(firstDayOfWeekIdx) as 0 | 1 | 2 | 3 | 4 | 5 | 6)
          : 0,
    });
    let totalDays =
      d.differenceInDays(firstDay, beginDay) + d.getDaysInMonth(firstDay);
    if (totalDays % 7 !== 0) {
      totalDays += 7 - (totalDays % 7);
    }
    const daysArray = [];

    for (let i = 0; i < totalDays; i++) {
      const currentDate = d.addDays(beginDay, i);
      if (!d.isSameMonth(currentDate, firstDay)) {
        daysArray.push({
          date: currentDate,
          incomeValue: 0,
          expenseValue: 0,
          incomeSize: 0,
          expenseSize: 0,
        });
      } else {
        const dateKey = d.format(currentDate, 'yyyy-MM-dd');
        const currentIncome = incomeDataMap.get(dateKey) ?? 0;
        const currentExpense = expenseDataMap.get(dateKey) ?? 0;

        daysArray.push({
          date: currentDate,
          incomeSize: getBarLength(currentIncome),
          incomeValue: Math.abs(currentIncome),
          expenseSize: getBarLength(currentExpense),
          expenseValue: Math.abs(currentExpense),
        });
      }
    }

    return {
      data: daysArray as CalendarDataType[],
      totalExpense: totalExpenseValue ?? 0,
      totalIncome: totalIncomeValue ?? 0,
    };
  };

  return {
    hasForeignCurrency,
    calendarData: months.map(m => {
      return {
        ...getDaysArray(m),
        start: d.startOfMonth(m),
        end: d.endOfMonth(m),
      };
    }),
  };
}
