import {
  clearServer,
  initServer,
} from '@actual-app/core/platform/client/connection';
import type { QueryState } from '@actual-app/core/shared/query';
import type { AccountEntity } from '@actual-app/core/types/models';
import type { ForecastResult } from '@actual-app/core/types/models/forecast';
import type { SyncedPrefs } from '@actual-app/core/types/prefs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { convertForecastToMain } from '#hooks/useMainBalanceForecast';
import type { useSpreadsheet } from '#hooks/useSpreadsheet';

import { createAgeOfMoneySpreadsheet } from './age-of-money-spreadsheet';
import { createBudgetAnalysisSpreadsheet } from './budget-analysis-spreadsheet';
import { createCrossoverSpreadsheet } from './crossover-spreadsheet';
import type { CrossoverData } from './crossover-spreadsheet';
import type { ReportDataStatus } from './report-currency';

vi.mock(
  '@actual-app/core/platform/client/connection',
  () => import('#mocks/connection'),
);

const spreadsheet = undefined as unknown as ReturnType<typeof useSpreadsheet>;

function createAccount(id: string, currency: string | null): AccountEntity {
  return {
    id,
    name: id,
    currency,
    offbudget: 1,
    closed: 0,
    sort_order: 0,
    last_reconciled: null,
    tombstone: 0,
    account_group_id: null,
    account_id: null,
    bank: null,
    bankName: null,
    bankId: null,
    mask: null,
    official_name: null,
    balance_current: null,
    balance_available: null,
    balance_limit: null,
    account_sync_source: null,
    last_sync: null,
    bank_sync_status: null,
  };
}

const prefs: SyncedPrefs = {
  defaultCurrencyCode: 'USD',
  'manualRate.JPY.USD': '0.0067',
};

type AccountHistory = {
  starting: number;
  balances?: Array<{ date: string; amount: number }>;
};

async function runCrossover({
  history,
  accounts,
  prefOverrides = {},
  accountsReady = true,
}: {
  history: Record<string, AccountHistory>;
  accounts: AccountEntity[];
  prefOverrides?: Partial<SyncedPrefs>;
  accountsReady?: boolean;
}) {
  initServer({
    query: async query => {
      const state = query as QueryState;
      const filter = state.filterExpressions[0] as { account: string };
      const accountHistory = history[filter.account];
      return {
        data: state.calculation
          ? accountHistory.starting
          : (accountHistory.balances ?? []),
        dependencies: [],
      };
    },
  });

  let result: CrossoverData | ReportDataStatus | undefined;
  await createCrossoverSpreadsheet({
    start: '2026-01',
    end: '2026-02',
    expenseCategoryIds: [],
    incomeAccountIds: Object.keys(history),
    safeWithdrawalRate: 0.04,
    estimatedReturn: 0.05,
    projectionType: 'median',
    accounts,
    prefs: { ...prefs, ...prefOverrides },
    accountsReady,
  })(spreadsheet, data => {
    result = data;
  });
  return result;
}

afterEach(async () => {
  await clearServer();
});

describe('crossover currency conversion', () => {
  it('converts mixed-currency account balances to Main before summing', async () => {
    const result = await runCrossover({
      accounts: [createAccount('usd', 'USD'), createAccount('jpy', 'JPY')],
      history: {
        usd: { starting: 100_000 },
        jpy: {
          starting: 1_000_000,
          balances: [{ date: '2026-02', amount: 500_000 }],
        },
      },
    });

    expect(result).toMatchObject({
      hasForeignCurrency: true,
      // Jan: 100_000 + 6_700; Feb: 100_000 + 10_050
      lastKnownBalance: 110_050,
    });
    const data = (result as CrossoverData).graphData.data;
    expect(data[0]).toMatchObject({ nestEgg: 106_700 });
    expect(data[1]).toMatchObject({ nestEgg: 110_050 });
  });

  it('rounds once per account balance leaf, not per movement', async () => {
    const result = await runCrossover({
      accounts: [createAccount('jpy', 'JPY')],
      history: {
        // 100 * 0.0067 -> 1 and 100 * 0.0067 -> 1 would sum to 2;
        // the 200 balance converts once to 1.
        jpy: { starting: 100, balances: [{ date: '2026-02', amount: 100 }] },
      },
    });

    expect(result).toMatchObject({ lastKnownBalance: 1 });
  });

  it('keeps Main-only balances unchanged and unlabeled as foreign', async () => {
    const result = await runCrossover({
      accounts: [createAccount('usd', 'USD'), createAccount('legacy', null)],
      history: {
        usd: { starting: 100_000 },
        legacy: {
          starting: 50_001,
          balances: [{ date: '2026-02', amount: 3 }],
        },
      },
    });

    expect(result).toMatchObject({
      hasForeignCurrency: false,
      lastKnownBalance: 150_004,
    });
  });

  it('is unavailable when an included account has no rate', async () => {
    const result = await runCrossover({
      accounts: [createAccount('eur', 'EUR')],
      history: { eur: { starting: 1_000 } },
    });

    expect(result).toEqual({ status: 'unavailable' });
  });

  it('is unavailable for unknown accounts and a missing Main currency', async () => {
    await expect(
      runCrossover({ accounts: [], history: { ghost: { starting: 1 } } }),
    ).resolves.toEqual({ status: 'unavailable' });
    await expect(
      runCrossover({
        accounts: [createAccount('usd', 'USD')],
        history: { usd: { starting: 1 } },
        prefOverrides: { defaultCurrencyCode: undefined },
      }),
    ).resolves.toEqual({ status: 'unavailable' });
  });

  it('loads until accounts are ready', async () => {
    await expect(
      runCrossover({
        accounts: [],
        history: { usd: { starting: 1 } },
        accountsReady: false,
      }),
    ).resolves.toEqual({ status: 'loading' });
  });
});

describe('balance forecast currency conversion', () => {
  const forecast: ForecastResult = {
    dataPoints: [
      {
        date: '2026-01-31',
        balance: 100_000,
        accountId: 'usd',
        accountName: 'usd',
        transactions: [],
      },
      {
        date: '2026-01-31',
        balance: 1_000_000,
        accountId: 'jpy',
        accountName: 'jpy',
        transactions: [],
      },
      {
        date: '2026-01-31',
        balance: 2_500,
        accountId: '__unassigned_schedule__',
        accountName: '',
        transactions: [],
      },
    ],
    lowestBalance: {
      date: '2026-01-31',
      balance: 1_000_000,
      accountId: 'jpy',
      accountName: 'jpy',
    },
    forecastStartDate: '2026-01-01',
    forecastEndDate: '2026-01-31',
  };
  const accounts = [createAccount('usd', 'USD'), createAccount('jpy', 'JPY')];

  it('converts each account balance and keeps accountless schedules in Main', () => {
    const converted = convertForecastToMain(forecast, accounts, prefs, 0);

    expect(converted?.dataPoints.map(point => point.balance)).toEqual([
      100_000, 6_700, 2_500,
    ]);
    expect(converted?.lowestBalance.balance).toBe(6_700);
  });

  it('is unavailable when any included account lacks a rate or is unknown', () => {
    expect(
      convertForecastToMain(
        forecast,
        accounts,
        { defaultCurrencyCode: 'USD' },
        0,
      ),
    ).toBeNull();
    expect(convertForecastToMain(forecast, [accounts[0]], prefs, 0)).toBeNull();
    expect(convertForecastToMain(forecast, accounts, {}, 0)).toBeNull();
  });

  it('treats an empty completed forecast as a genuine zero without rates', () => {
    const empty: ForecastResult = {
      ...forecast,
      dataPoints: [],
      lowestBalance: { date: '', balance: 0, accountId: '', accountName: '' },
    };

    expect(
      convertForecastToMain(empty, [], { defaultCurrencyCode: 'USD' }, 0),
    ).toEqual(empty);
  });
});

describe('Main-only widgets keep existing values', () => {
  it('age of money reads on-budget transactions only and never converts', async () => {
    const queries: QueryState[] = [];
    initServer({
      'make-filters-from-conditions': async () => ({ filters: [] }),
      query: async query => {
        const state = query as QueryState;
        queries.push(state);
        const filter = state.filterExpressions[1] as {
          amount: { $gt?: number };
        };
        return {
          data:
            filter.amount.$gt !== undefined
              ? [{ id: 'i', date: '2026-01-01', amount: 100_000 }]
              : [{ id: 'e', date: '2026-01-11', amount: -50_000 }],
          dependencies: [],
        };
      },
    });

    let currentAge: number | null | undefined;
    await createAgeOfMoneySpreadsheet({ start: '2026-01', end: '2026-01' })(
      spreadsheet,
      data => {
        currentAge = data.currentAge;
      },
    );

    expect(currentAge).toBe(10);
    expect(queries).toHaveLength(2);
    for (const state of queries) {
      expect(state.filterExpressions[1]).toMatchObject({
        'account.offbudget': false,
      });
    }
  });

  it('budget analysis sums budget cells without conversion', async () => {
    const cells = (budget: number, spent: number, leftover: number) => [
      { name: 'budget-c1', value: budget },
      { name: 'sum-amount-c1', value: spent },
      { name: 'leftover-c1', value: leftover },
    ];
    initServer({
      'get-categories': async () => ({
        list: [
          {
            id: 'c1',
            name: 'Food',
            is_income: false,
            hidden: false,
            group: 'g',
          },
        ],
        grouped: [],
      }),
      'envelope-budget-month': async ({ month }: { month: string }) =>
        month === '2026-01' ? cells(30_001, -12_345, 17_656) : cells(0, 0, 0),
    });

    let result: { totalBudgeted: number; totalSpent: number } | undefined;
    await createBudgetAnalysisSpreadsheet({
      startDate: '2026-01',
      endDate: '2026-01',
    })(spreadsheet, data => {
      result = data;
    });

    expect(result).toMatchObject({
      totalBudgeted: 30_001,
      totalSpent: -12_345,
    });
  });
});
