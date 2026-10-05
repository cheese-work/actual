import * as monthUtils from '@actual-app/core/shared/months';
import { q } from '@actual-app/core/shared/query';
import type { AccountEntity } from '@actual-app/core/types/models';
import type { SyncedPrefs } from '@actual-app/core/types/prefs';
import * as d from 'date-fns';

import type { useSpreadsheet } from '#hooks/useSpreadsheet';
import { aqlQuery } from '#queries/aqlQuery';

import { convertAccountAmount, sumConvertedLeaves } from './report-currency';
import type { ReportDataStatus } from './report-currency';

type MonthlyAgg = { date: string; amount: number };

// Utility functions for Hampel identifier
function calculateMedian(values: number[]): number {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0];

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function calculateMean(values: number[]): number {
  if (values.length === 0) return 0;
  const sum = values.reduce((acc, val) => acc + val, 0);
  return sum / values.length;
}

function calculateMAD(values: number[], median: number): number {
  const deviations = values.map(v => Math.abs(v - median));
  return calculateMedian(deviations);
}

function calculateHampelFilteredMedian(expenses: number[]): number {
  if (expenses.length === 0) return 0;
  if (expenses.length === 1) return expenses[0];

  const median = calculateMedian(expenses);
  const mad = calculateMAD(expenses, median);
  const threshold = 3; // Standard threshold for outlier detection

  const filteredExpenses = expenses.filter(expense => {
    const lowerBound = median - 1.4826 * mad * threshold;
    const upperBound = median + 1.4826 * mad * threshold;
    return expense >= lowerBound && expense <= upperBound;
  });

  return calculateMedian(filteredExpenses);
}

// Type for the return value of the recalculate function
export type CrossoverData = {
  graphData: {
    data: Array<{
      x: string;
      investmentIncome: number;
      expenses: number;
      nestEgg: number;
      adjustedExpenses?: number;
      isProjection?: boolean;
    }>;
    start: string;
    end: string;
    crossoverXLabel: string | null;
  };
  hasForeignCurrency: boolean;
  lastKnownBalance: number;
  lastKnownMonthlyIncome: number;
  lastKnownMonthlyExpenses: number;
  historicalReturn: number | null;
  yearsToRetire: number | null;
  targetMonthlyIncome: number | null;
  targetNestEgg: number | null;
};

export type CrossoverParams = {
  start: string;
  end: string;
  expenseCategoryIds: string[]; // which categories count as expenses
  incomeAccountIds: AccountEntity['id'][]; // selected accounts for both historical returns and projections
  safeWithdrawalRate: number; // annual percent, e.g. 0.04 for 4%
  estimatedReturn?: number | null; // optional annual return to project future balances
  expectedContribution?: number | null; // optional monthly contribution to project future balances
  projectionType: 'hampel' | 'median' | 'mean'; // expense projection method
  expenseAdjustmentFactor?: number; // multiplier for expenses (default 1.0)
  accounts: AccountEntity[];
  prefs: Readonly<SyncedPrefs>;
  accountsReady: boolean;
};

type HistoricalAccount = {
  accountId: string;
  starting: number;
  balances: MonthlyAgg[];
};

/**
 * Month-end balance per selected account, converted to Main once per
 * (account, month) leaf and then safe-summed. Null when any leaf is
 * unavailable.
 */
function sumHistoricalBalancesInMain(
  months: string[],
  historicalAccounts: HistoricalAccount[],
  accounts: AccountEntity[],
  prefs: Readonly<SyncedPrefs>,
  valuationTime: number,
): number[] | null {
  const accountsById = new Map(accounts.map(a => [a.id, a]));
  const totals = months.map(() => 0);

  for (const acct of historicalAccounts) {
    const account = accountsById.get(acct.accountId);
    const byMonth = new Map(acct.balances.map(b => [b.date, b.amount]));
    let runningBalance = acct.starting;
    for (let i = 0; i < months.length; i++) {
      runningBalance += byMonth.get(months[i]) ?? 0;
      const converted = sumConvertedLeaves([
        totals[i],
        convertAccountAmount(runningBalance, account, prefs, valuationTime),
      ]);
      if (converted === null) {
        return null;
      }
      totals[i] = converted;
    }
  }
  return totals;
}

export function createCrossoverSpreadsheet({
  start,
  end,
  expenseCategoryIds,
  incomeAccountIds,
  safeWithdrawalRate,
  estimatedReturn,
  expectedContribution,
  projectionType,
  expenseAdjustmentFactor,
  accounts,
  prefs,
  accountsReady,
}: CrossoverParams) {
  return async (
    _spreadsheet: ReturnType<typeof useSpreadsheet>,
    setData: (data: CrossoverData | ReportDataStatus) => void,
  ) => {
    // Missing Main is unavailable even for empty input; unfinished input loads.
    if (!prefs.defaultCurrencyCode) {
      setData({ status: 'unavailable' });
      return;
    }
    if (!accountsReady) {
      setData({ status: 'loading' });
      return;
    }
    if (!start || !end || incomeAccountIds.length === 0) {
      setData({
        graphData: {
          data: [],
          start: start || '',
          end: end || '',
          crossoverXLabel: null,
        },
        hasForeignCurrency: false,
        lastKnownBalance: 0,
        lastKnownMonthlyIncome: 0,
        lastKnownMonthlyExpenses: 0,
        historicalReturn: null,
        yearsToRetire: null,
        targetMonthlyIncome: null,
        targetNestEgg: null,
      });
      return;
    }

    // Aggregate monthly expenses for selected categories (expenses are negative amounts)
    const expensesPromise = (async () => {
      if (!expenseCategoryIds.length) {
        return monthUtils
          .rangeInclusive(start, end)
          .map(date => ({ date, amount: 0 }));
      }

      const query = q('transactions')
        .filter({
          $and: [
            { $or: expenseCategoryIds.map(id => ({ category: id })) },
            { date: { $gte: monthUtils.firstDayOfMonth(start) } },
            { date: { $lte: monthUtils.lastDayOfMonth(end) } },
          ],
        })
        .groupBy({ $month: '$date' })
        .select([
          { date: { $month: '$date' } },
          { amount: { $sum: '$amount' } },
        ]);

      const { data } = await aqlQuery(query);
      return data as MonthlyAgg[];
    })();

    // Compute monthly balances for selected accounts (historical returns)
    const historicalBalancesPromise = Promise.all(
      incomeAccountIds.map(async accountId => {
        // Get the account balance at the end of the first month (start month)
        const startingBalance = await aqlQuery(
          q('transactions')
            .filter({ account: accountId })
            .filter({
              date: { $lte: monthUtils.lastDayOfMonth(start) },
            })
            .calculate({ $sum: '$amount' }),
        ).then(({ data }) => (typeof data === 'number' ? data : 0));
        // Get all transactions from the start month onwards for balance calculations
        // We need to exclude the first month since we already have its ending balance as starting
        // Instead of adding months (which can cause invalid month strings), we'll filter out the first month later
        const balances = await aqlQuery(
          q('transactions')
            .filter({
              account: accountId,
              date: { $gte: monthUtils.firstDayOfMonth(start) },
            })
            .filter({
              $and: [{ date: { $lte: monthUtils.lastDayOfMonth(end) } }],
            })
            .groupBy({ $month: '$date' })
            .select([
              { date: { $month: '$date' } },
              { amount: { $sum: '$amount' } },
            ]),
        ).then(({ data }) => data as MonthlyAgg[]);

        // Filter out the first month since we already have its ending balance as starting
        const filteredBalances = balances.filter(b => b.date !== start);

        return {
          accountId,
          starting: startingBalance,
          balances: filteredBalances,
        };
      }),
    );

    const [expenses, historicalBalances] = await Promise.all([
      expensesPromise,
      historicalBalancesPromise,
    ]);

    const valuationTime = Date.now();
    const historicalBalancesInMain = sumHistoricalBalancesInMain(
      monthUtils.rangeInclusive(start, end),
      historicalBalances,
      accounts,
      prefs,
      valuationTime,
    );
    if (historicalBalancesInMain === null) {
      setData({ status: 'unavailable' });
      return;
    }
    const accountsById = new Map(accounts.map(a => [a.id, a]));
    const hasForeignCurrency = incomeAccountIds.some(id => {
      const currency = accountsById.get(id)?.currency;
      return currency != null && currency !== prefs.defaultCurrencyCode;
    });

    setData({
      ...recalculate(
        {
          start,
          end,
          expenseCategoryIds,
          incomeAccountIds,
          safeWithdrawalRate,
          estimatedReturn,
          expectedContribution,
          projectionType,
          expenseAdjustmentFactor,
        },
        expenses,
        historicalBalancesInMain,
      ),
      hasForeignCurrency,
    });
  };
}

function recalculate(
  params: Pick<
    CrossoverParams,
    | 'start'
    | 'end'
    | 'expenseCategoryIds'
    | 'incomeAccountIds'
    | 'safeWithdrawalRate'
    | 'estimatedReturn'
    | 'expectedContribution'
    | 'projectionType'
    | 'expenseAdjustmentFactor'
  >,
  expenses: MonthlyAgg[],
  historicalBalances: number[],
) {
  const months = monthUtils.rangeInclusive(params.start, params.end);

  // Build total expenses per month (positive number for visualization)
  const expenseMap = new Map<string, number>();
  for (const e of expenses) {
    // amounts for expenses are negative; flip sign to positive monthly spend
    expenseMap.set(e.date, (expenseMap.get(e.date) || 0) + -e.amount);
  }

  // Determine historical monthly investment income using safe withdrawal rate: annual rate -> monthly
  const monthlySWR = params.safeWithdrawalRate / 12; // e.g. 0.04 / 12

  // Prepare historical data points and compute last known month data for projection seeds
  const data: Array<{
    x: string;
    investmentIncome: number;
    expenses: number;
    nestEgg: number;
    adjustedExpenses?: number;
    isProjection?: boolean;
  }> = [];

  let lastBalance = 0;
  let lastExpense = 0;
  let crossoverIndex: number | null = null;
  const adjustmentFactor = params.expenseAdjustmentFactor ?? 1.0;

  months.forEach((month, idx) => {
    const balance = historicalBalances[idx]; // Use historical balances for data generation
    const monthlyIncome = balance * monthlySWR;
    const spend = expenseMap.get(month) || 0;
    data.push({
      x: d.format(d.parseISO(month + '-01'), 'MMM yyyy'),
      investmentIncome: Math.round(monthlyIncome),
      expenses: spend,
      nestEgg: balance,
    });
    lastBalance = balance;
    lastExpense = spend;

    // Note: We don't check for crossover in historical data to avoid triggering
    // a crossover detection when expenses drop below the investment income for
    // a short time. Crossover is determined based on projected expenses, not
    // actual historical expenses.
  });

  // If estimatedReturn provided, project future months until investment income exceeds expenses
  // Use either provided estimatedReturn or simple trailing growth from balances
  // Determine default return from historical balances if not provided
  const annualReturn = params.estimatedReturn ?? null; // e.g. 0.05
  let monthlyReturn =
    annualReturn != null ? Math.pow(1 + annualReturn, 1 / 12) - 1 : null;

  // Always calculate the default return for display purposes
  let defaultMonthlyReturn: number | null = null;
  if (historicalBalances.length >= 2) {
    // Use the starting balance (end of first month) and final balance (end of last month) for CAGR calculation
    // The starting balance represents the account balance at the end of the first month
    let startingBalance = historicalBalances[0];
    const finalBalance = historicalBalances[historicalBalances.length - 1];
    const n = historicalBalances.length - 1; // Number of months between start and end

    if (startingBalance === 0) {
      for (let i = 1; i < historicalBalances.length; i++) {
        if (historicalBalances[i] !== 0) {
          startingBalance = historicalBalances[i];
          break;
        }
      }
    }

    if (startingBalance > 0 && finalBalance > 0 && n > 0) {
      // Calculate monthly CAGR: (final/starting)^(1/n) - 1
      const cagrMonthly = Math.pow(finalBalance / startingBalance, 1 / n) - 1;

      if (isFinite(cagrMonthly) && !isNaN(cagrMonthly)) {
        defaultMonthlyReturn = cagrMonthly;
      } else {
        defaultMonthlyReturn = 0;
      }
    } else {
      defaultMonthlyReturn = 0;
    }
  }

  // Use user-provided contribution, or default to 0
  // (We don't use historical contribution as default because the historical
  // return calculation already includes contributions)
  const monthlyContribution = params.expectedContribution ?? 0;

  if (months.length > 0) {
    // If no explicit return provided, use the calculated default
    if (monthlyReturn == null) {
      // not quite right.  Need a better approximation
      monthlyReturn = defaultMonthlyReturn;
    }
    // Project up to 600 months max to avoid infinite loops (50 years)
    const maxProjectionMonths = 600;
    let projectedBalance = lastBalance;
    let monthCursor = d.parseISO(months[months.length - 1] + '-01');
    let flatExpense = 0;

    const y: number[] = months.map(m => expenseMap.get(m) || 0);

    if (params.projectionType === 'hampel') {
      // Hampel filtered median calculation
      flatExpense = calculateHampelFilteredMedian(y);
    } else if (params.projectionType === 'median') {
      // Plain median calculation without filtering
      flatExpense = calculateMedian(y);
    } else if (params.projectionType === 'mean') {
      // Mean (average) calculation
      flatExpense = calculateMean(y);
    }

    for (let i = 1; i <= maxProjectionMonths; i++) {
      monthCursor = d.addMonths(monthCursor, 1);

      // Add contribution BEFORE applying growth
      projectedBalance = projectedBalance + monthlyContribution;

      // Then grow balance
      if (monthlyReturn != null) {
        projectedBalance = projectedBalance * (1 + monthlyReturn);
      }

      const projectedIncome = projectedBalance * monthlySWR;

      const projectedExpenses = Math.max(0, flatExpense);

      // Calculate adjusted expenses
      const adjustedProjectedExpenses = projectedExpenses * adjustmentFactor;

      data.push({
        x: d.format(monthCursor, 'MMM yyyy'),
        investmentIncome: Math.round(projectedIncome),
        expenses: Math.round(projectedExpenses),
        nestEgg: Math.round(projectedBalance),
        adjustedExpenses: Math.round(adjustedProjectedExpenses),
        isProjection: true,
      });

      // Check crossover against ADJUSTED expenses
      if (
        crossoverIndex == null &&
        Math.round(projectedIncome) >= Math.round(adjustedProjectedExpenses)
      ) {
        crossoverIndex = months.length + (i - 1);
        break;
      }
    }
  }
  // Calculate years to retire based on crossover point
  let yearsToRetire: number | null = null;
  let targetMonthlyIncome: number | null = null;
  let targetNestEgg: number | null = null;

  if (crossoverIndex != null && crossoverIndex < data.length) {
    const crossoverData = data[crossoverIndex];
    if (crossoverData) {
      const currentDate = new Date();
      const crossoverDate = d.parse(crossoverData.x, 'MMM yyyy', currentDate);
      const monthsDiff = d.differenceInMonths(crossoverDate, currentDate);
      yearsToRetire = monthsDiff > 0 ? monthsDiff / 12 : 0;
      targetMonthlyIncome = crossoverData.adjustedExpenses ?? null;
      // Calculate target nest egg: target monthly income / monthly safe withdrawal rate
      targetNestEgg =
        targetMonthlyIncome != null
          ? Math.round(targetMonthlyIncome / monthlySWR)
          : null;
    }
  }

  return {
    graphData: {
      data,
      start: params.start,
      end: params.end,
      crossoverXLabel:
        crossoverIndex != null ? (data[crossoverIndex]?.x ?? null) : null,
    },
    // Provide some summary numbers
    lastKnownBalance: historicalBalances[historicalBalances.length - 1] || 0,
    lastKnownMonthlyIncome: Math.round(
      (historicalBalances[historicalBalances.length - 1] || 0) * monthlySWR,
    ),
    lastKnownMonthlyExpenses: lastExpense,
    // Return the calculated default return for display purposes
    historicalReturn:
      defaultMonthlyReturn != null
        ? Math.pow(1 + defaultMonthlyReturn, 12) - 1
        : null,
    // Years to retire calculation
    yearsToRetire,
    // Target monthly income at crossover point
    targetMonthlyIncome,
    // Target nest egg at crossover point
    targetNestEgg,
  };
}
