import type { AccountEntity } from '@actual-app/core/types/models';
import type { SyncedPrefs } from '@actual-app/core/types/prefs';
import { describe, expect, it } from 'vitest';

import type { QueryDataEntity } from '#components/reports/ReportOptions';

import { convertReportQueryRows } from './report-currency';
import {
  convertSankeyCategoryEntries,
  convertTransferPairs,
} from './sankey-spreadsheet';

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

function createRow(overrides: Partial<QueryDataEntity>): QueryDataEntity {
  return {
    date: '2026-01-01',
    category: 'category',
    categoryHidden: false,
    categoryGroup: 'group',
    categoryGroupHidden: false,
    account: 'account',
    accountOffBudget: false,
    payee: 'payee',
    transferAccount: '',
    amount: 0,
    ...overrides,
  };
}

describe('convertReportQueryRows', () => {
  it('converts JPY and VND leaves using the Main rates', () => {
    const rows = convertReportQueryRows(
      [
        createRow({ account: 'jpy', amount: 100_000 }),
        createRow({ account: 'vnd', amount: 1_000_000 }),
      ],
      [createAccount('jpy', 'JPY'), createAccount('vnd', 'VND')],
      {
        defaultCurrencyCode: 'USD',
        'manualRate.JPY.USD': '0.0067',
        'manualRate.VND.USD': '0.000041',
      } satisfies Readonly<SyncedPrefs>,
      true,
      1,
    );

    expect(rows).toEqual([
      createRow({ account: 'jpy', amount: 670 }),
      createRow({ account: 'vnd', amount: 41 }),
    ]);
  });

  it('converts split and refund leaves separately before account totals', () => {
    const rows = convertReportQueryRows(
      [
        createRow({ account: 'jpy', category: 'shared', amount: 100_000 }),
        createRow({ account: 'vnd', category: 'shared', amount: -2_000_000 }),
        createRow({ account: 'jpy', category: 'split', amount: 30_000 }),
      ],
      [createAccount('jpy', 'JPY'), createAccount('vnd', 'VND')],
      {
        defaultCurrencyCode: 'USD',
        'manualRate.JPY.USD': '0.0067',
        'manualRate.VND.USD': '0.000041',
      } satisfies Readonly<SyncedPrefs>,
      true,
      1,
    );

    expect(rows).toEqual([
      createRow({ account: 'jpy', category: 'shared', amount: 670 }),
      createRow({ account: 'vnd', category: 'shared', amount: -82 }),
      createRow({ account: 'jpy', category: 'split', amount: 201 }),
    ]);
  });

  it('returns a completed empty result when Main is configured', () => {
    expect(
      convertReportQueryRows([], [], { defaultCurrencyCode: 'USD' }, false, 1),
    ).toEqual([]);
  });

  it('converts Sankey category and transfer leaves to Main', () => {
    const accounts = [createAccount('jpy', 'JPY'), createAccount('vnd', 'VND')];
    const prefs = {
      defaultCurrencyCode: 'USD',
      'manualRate.JPY.USD': '0.0067',
      'manualRate.VND.USD': '0.000041',
    } satisfies Readonly<SyncedPrefs>;

    expect(
      convertSankeyCategoryEntries(
        [
          {
            categoryGroup: 'Expenses',
            categoryGroupId: 'expenses',
            category: 'Shared',
            categoryId: 'shared-jpy',
            value: 100_000,
            isIncome: false,
            isNegative: true,
            accountName: 'JPY account',
            accountId: 'jpy',
          },
          {
            categoryGroup: 'Expenses',
            categoryGroupId: 'expenses',
            category: 'Shared',
            categoryId: 'shared-vnd',
            value: 2_000_000,
            isIncome: false,
            isNegative: true,
            accountName: 'VND account',
            accountId: 'vnd',
          },
        ],
        accounts,
        prefs,
        1,
      ),
    ).toMatchObject([{ value: 670 }, { value: 82 }]);

    expect(
      convertTransferPairs(
        [
          {
            fromAccountId: 'jpy',
            fromAccountName: 'JPY account',
            toAccountId: 'vnd',
            toAccountName: 'VND account',
            amount: 100_000,
          },
        ],
        accounts,
        prefs,
        1,
      ),
    ).toMatchObject([{ amount: 670 }]);
  });

  it('filters hidden off-budget rows before requiring an exchange rate', () => {
    const rows = [
      createRow({ account: 'unloaded-account', accountOffBudget: true }),
    ];
    const accounts = [createAccount('usd', 'USD')];
    const prefs = {
      defaultCurrencyCode: 'USD',
    } satisfies Readonly<SyncedPrefs>;

    expect(convertReportQueryRows(rows, accounts, prefs, false, 1)).toEqual([]);
    expect(convertReportQueryRows(rows, accounts, prefs, true, 1)).toEqual({
      status: 'unavailable',
    });
  });

  it('marks missing Main, included missing rates, and unsafe sums unavailable', () => {
    expect(convertReportQueryRows([], [], {}, false, 1)).toEqual({
      status: 'unavailable',
    });
    expect(
      convertReportQueryRows(
        [createRow({ account: 'jpy', amount: 100 })],
        [createAccount('jpy', 'JPY')],
        { defaultCurrencyCode: 'USD' },
        true,
        1,
      ),
    ).toEqual({ status: 'unavailable' });
    expect(
      convertReportQueryRows(
        [
          createRow({ amount: Number.MAX_SAFE_INTEGER }),
          createRow({ amount: 1 }),
        ],
        [createAccount('account', 'USD')],
        { defaultCurrencyCode: 'USD' },
        true,
        1,
      ),
    ).toEqual({ status: 'unavailable' });
  });
});
