import type { AccountEntity } from '@actual-app/core/types/models';
import type { SyncedPrefs } from '@actual-app/core/types/prefs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { QueryDataEntity } from '#components/reports/ReportOptions';

import { fetchSpreadsheetQueryData } from './fetchSpreadsheetQueryData';

const { aqlQueryMock, budgetDataMock } = vi.hoisted(() => ({
  aqlQueryMock: vi.fn(),
  budgetDataMock: vi.fn(),
}));
vi.mock('#queries/aqlQuery', () => ({ aqlQuery: aqlQueryMock }));
vi.mock('./budgetDataQuery', () => ({ fetchBudgetData: budgetDataMock }));

function createAccount(id: string, currency: string): AccountEntity {
  return {
    id,
    name: id,
    currency,
    offbudget: 0,
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

function createRow(overrides: Partial<QueryDataEntity>): QueryDataEntity {
  return {
    date: '2026-01',
    category: 'shared-category',
    categoryHidden: false,
    categoryGroup: 'group',
    categoryGroupHidden: false,
    account: 'jpy',
    accountOffBudget: false,
    payee: 'shared-payee',
    transferAccount: '',
    amount: 0,
    ...overrides,
  };
}

const input = {
  balanceTypeOp: 'totalDebts' as const,
  startDate: '2026-01',
  endDate: '2026-01',
  interval: 'Monthly',
  categories: [],
  categoryGroups: [],
  conditions: [],
  conditionsOp: 'and',
  conditionsOpKey: '$and',
  filters: [],
  accounts: [createAccount('jpy', 'JPY'), createAccount('vnd', 'VND')],
  prefs: {
    defaultCurrencyCode: 'USD',
    'manualRate.JPY.USD': '0.0067',
    'manualRate.VND.USD': '0.000041',
  } satisfies Readonly<SyncedPrefs>,
  showOffBudget: false,
  accountsReady: true,
};

describe('fetchSpreadsheetQueryData', () => {
  beforeEach(() => {
    aqlQueryMock.mockReset();
    budgetDataMock.mockReset();
  });

  it('keeps budget-sheet values in Main without querying FX rows', async () => {
    const budgetResult = {
      assets: [createRow({ account: 'jpy', amount: 12_345 })],
      debts: [],
    };
    budgetDataMock.mockResolvedValue(budgetResult);

    await expect(
      fetchSpreadsheetQueryData({
        ...input,
        balanceTypeOp: 'totalBudgeted',
        prefs: { defaultCurrencyCode: 'USD' },
      }),
    ).resolves.toBe(budgetResult);
    expect(aqlQueryMock).not.toHaveBeenCalled();
  });

  it('converts matching categories and payees per account before reducers', async () => {
    aqlQueryMock
      .mockResolvedValueOnce({
        data: [
          createRow({ account: 'jpy', amount: 100_000 }),
          createRow({ account: 'vnd', amount: 1_000_000 }),
        ],
      })
      .mockResolvedValueOnce({ data: [] });

    await expect(fetchSpreadsheetQueryData(input)).resolves.toMatchObject({
      assets: [
        {
          account: 'jpy',
          category: 'shared-category',
          payee: 'shared-payee',
          amount: 670,
        },
        {
          account: 'vnd',
          category: 'shared-category',
          payee: 'shared-payee',
          amount: 41,
        },
      ],
      debts: [],
    });
  });

  it('excludes off-budget rows before requiring a foreign-currency rate', async () => {
    aqlQueryMock
      .mockResolvedValueOnce({
        data: [
          createRow({
            account: 'unknown-account',
            accountOffBudget: true,
            amount: 100,
          }),
        ],
      })
      .mockResolvedValueOnce({ data: [] });

    await expect(fetchSpreadsheetQueryData(input)).resolves.toMatchObject({
      assets: [],
      debts: [],
    });
  });

  it('marks included foreign rows unavailable when their rate is missing', async () => {
    aqlQueryMock
      .mockResolvedValueOnce({
        data: [createRow({ account: 'jpy', amount: 100 })],
      })
      .mockResolvedValueOnce({ data: [] });

    await expect(
      fetchSpreadsheetQueryData({
        ...input,
        prefs: { defaultCurrencyCode: 'USD' },
      }),
    ).resolves.toEqual({ status: 'unavailable' });
  });
});
