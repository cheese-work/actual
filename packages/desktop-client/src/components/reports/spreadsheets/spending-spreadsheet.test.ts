import {
  clearServer,
  initServer,
} from '@actual-app/core/platform/client/connection';
import type {
  AccountEntity,
  CategoryEntity,
  CategoryGroupEntity,
  RuleConditionEntity,
  SpendingAverageRange,
} from '@actual-app/core/types/models';
import type { SyncedPrefs } from '@actual-app/core/types/prefs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createSpendingSpreadsheet,
  getSpendingBudgetFilters,
} from './spending-spreadsheet';

vi.mock(
  '@actual-app/core/platform/client/connection',
  () => import('#mocks/connection'),
);

type SpendingRow = {
  account: string;
  accountOffBudget?: boolean;
  categoryIncome?: boolean;
  date: string;
  amount: number;
};

type SpendingReportData = Parameters<
  Parameters<ReturnType<typeof createSpendingSpreadsheet>>[1]
>[0];

function createAccount(
  id: string,
  currency: string | null = null,
  offbudget: 0 | 1 = 0,
): AccountEntity {
  return {
    id,
    name: id,
    currency,
    offbudget,
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

async function runSpendingReport({
  accounts,
  assets = [],
  debts = [],
  budgets = [],
  prefs = { defaultCurrencyCode: 'USD' },
  accountsReady = true,
  averageRange = { mode: 'last-n-months', months: 3 },
}: {
  accounts: AccountEntity[];
  assets?: SpendingRow[];
  debts?: SpendingRow[];
  budgets?: Array<{ amount: number }>;
  prefs?: Readonly<SyncedPrefs>;
  accountsReady?: boolean;
  averageRange?: SpendingAverageRange;
}) {
  const queryResults = [assets, debts, [], [], budgets];
  initServer({
    'make-filters-from-conditions': async () => ({ filters: [] }),
    query: async () => ({ data: queryResults.shift(), dependencies: [] }),
  });

  let report: SpendingReportData | undefined;
  const spreadsheet = createSpendingSpreadsheet({
    accounts,
    prefs,
    accountsReady,
    compare: '2016-08',
    compareTo: '2016-07',
    averageRange,
  });
  await spreadsheet(undefined as never, data => {
    report = data;
  });
  return report;
}

afterEach(async () => {
  await clearServer();
});

const categoryGroups = [
  { id: 'group-bills', name: 'Bills' },
  { id: 'group-fun', name: 'Fun Money' },
] satisfies CategoryGroupEntity[];

const categories = [
  { id: 'cat-rent', name: 'Rent', group: 'group-bills' },
  { id: 'cat-electric', name: 'Electric', group: 'group-bills' },
  { id: 'cat-dining', name: 'Dining Out', group: 'group-fun' },
] satisfies CategoryEntity[];

describe('getSpendingBudgetFilters', () => {
  it('filters budget categories by category group', () => {
    const result = getSpendingBudgetFilters({
      categories,
      categoryGroups,
      conditions: [
        {
          field: 'category_group',
          op: 'is',
          value: 'group-bills',
        },
      ] satisfies RuleConditionEntity[],
    });

    expect(result).toEqual([
      { category: { $oneof: ['cat-rent', 'cat-electric'] } },
    ]);
  });

  it('does not filter budgets when no category condition is present', () => {
    const result = getSpendingBudgetFilters({
      categories,
      categoryGroups,
      conditions: [
        {
          field: 'account',
          op: 'is',
          value: 'account-checking',
        },
      ] satisfies RuleConditionEntity[],
    });

    expect(result).toEqual([]);
  });

  it('filters budget categories by direct category IDs', () => {
    const result = getSpendingBudgetFilters({
      categories,
      categoryGroups,
      conditions: [
        {
          field: 'category',
          op: 'oneOf',
          value: ['cat-rent', 'cat-dining'],
        },
      ] satisfies RuleConditionEntity[],
    });

    expect(result).toEqual([
      { category: { $oneof: ['cat-rent', 'cat-dining'] } },
    ]);
  });
});

describe('createSpendingSpreadsheet', () => {
  it('converts account/day leaves before comparisons and averages', async () => {
    const report = await runSpendingReport({
      accounts: [
        createAccount('usd', 'USD'),
        createAccount('eur', 'EUR'),
        createAccount('jpy', 'JPY'),
      ],
      prefs: {
        defaultCurrencyCode: 'USD',
        'manualRate.EUR.USD': '2',
      },
      debts: [
        { account: 'eur', date: '2016-05-28', amount: -10_000 },
        { account: 'usd', date: '2016-06-15', amount: -30_000 },
        { account: 'eur', date: '2016-07-28', amount: -40_000 },
        { account: 'usd', date: '2016-07-28', amount: -10_000 },
        { account: 'usd', date: '2016-08-15', amount: -50_000 },
        {
          account: 'jpy',
          date: '2016-08-15',
          amount: -99_999,
          accountOffBudget: true,
        },
        {
          account: 'jpy',
          date: '2016-08-15',
          amount: -88_888,
          categoryIncome: true,
        },
      ],
      budgets: [{ amount: 120_000 }],
    });

    expect(report).toMatchObject({
      totalDebts: -190_000,
      hasForeignCurrency: true,
    });
    if (!report || 'status' in report) {
      throw new Error('Expected a complete spending report');
    }
    expect(report.intervalData.find(day => day.day === '28')).toMatchObject({
      compare: -50_000,
      compareTo: -90_000,
      average: -46_667,
      budget: -120_000,
    });
  });

  it('converts JPY and VND with their configured Main rates', async () => {
    const report = await runSpendingReport({
      accounts: [createAccount('jpy', 'JPY'), createAccount('vnd', 'VND')],
      prefs: {
        defaultCurrencyCode: 'USD',
        'manualRate.JPY.USD': '0.0067',
        'manualRate.VND.USD': '0.000041',
      },
      debts: [
        { account: 'jpy', date: '2016-08-10', amount: -100_000 },
        { account: 'vnd', date: '2016-08-11', amount: -1_000_000 },
      ],
    });

    expect(report).toMatchObject({
      totalDebts: -711,
      hasForeignCurrency: true,
    });
  });

  it('marks missing rates, unknown accounts, and unsafe values unavailable', async () => {
    const missingRate = await runSpendingReport({
      accounts: [createAccount('jpy', 'JPY')],
      debts: [{ account: 'jpy', date: '2016-08-10', amount: -100 }],
    });
    expect(missingRate).toEqual({ status: 'unavailable' });

    const unknownAccount = await runSpendingReport({
      accounts: [createAccount('usd', 'USD')],
      debts: [{ account: 'deleted', date: '2016-08-10', amount: -100 }],
    });
    expect(unknownAccount).toEqual({ status: 'unavailable' });

    const unsafeValue = await runSpendingReport({
      accounts: [createAccount('usd', 'USD')],
      debts: [
        {
          account: 'usd',
          date: '2016-08-10',
          amount: Number.MAX_SAFE_INTEGER + 1,
        },
      ],
    });
    expect(unsafeValue).toEqual({ status: 'unavailable' });
  });

  it('keeps empty valid-Main reports at zero and missing-Main reports unavailable', async () => {
    const empty = await runSpendingReport({ accounts: [] });
    expect(empty).toMatchObject({
      totalAssets: 0,
      totalDebts: 0,
      totalTotals: 0,
    });

    const missingMain = await runSpendingReport({
      accounts: [],
      prefs: {},
    });
    expect(missingMain).toEqual({ status: 'unavailable' });
  });

  it('waits for resolved account data instead of presenting an empty report', async () => {
    const report = await runSpendingReport({
      accounts: [],
      accountsReady: false,
    });
    expect(report).toBeUndefined();
  });
});
