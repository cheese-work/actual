import {
  clearServer,
  initServer,
} from '@actual-app/core/platform/client/connection';
import type {
  AccountEntity,
  SummaryContent,
} from '@actual-app/core/types/models';
import type { SyncedPrefs } from '@actual-app/core/types/prefs';
import { enUS } from 'date-fns/locale';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { summarySpreadsheet } from './summary-spreadsheet';

vi.mock(
  '@actual-app/core/platform/client/connection',
  () => import('#mocks/connection'),
);

type SummaryRow = {
  account: string;
  amount: number;
  count: number;
};

type SummaryResult = Parameters<
  Parameters<ReturnType<typeof summarySpreadsheet>>[1]
>[0];

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

async function runSummary({
  rows = [],
  divisorRows = [],
  accounts = [],
  prefs = { defaultCurrencyCode: 'USD' },
  content = { type: 'sum' },
  accountsReady = true,
}: {
  rows?: SummaryRow[];
  divisorRows?: SummaryRow[];
  accounts?: AccountEntity[];
  prefs?: Readonly<SyncedPrefs>;
  content?: SummaryContent;
  accountsReady?: boolean;
} = {}) {
  const results = [rows, divisorRows];
  initServer({
    'make-filters-from-conditions': async () => ({ filters: [] }),
    query: async () => ({ data: results.shift() ?? [], dependencies: [] }),
  });

  let report: SummaryResult | undefined;
  const spreadsheet = summarySpreadsheet(
    '2016-08',
    '2016-08',
    [],
    'and',
    content,
    enUS,
    accounts,
    prefs,
    accountsReady,
  );
  await spreadsheet(undefined as never, data => {
    report = data;
  });
  return report;
}

afterEach(async () => {
  await clearServer();
});

describe('summarySpreadsheet', () => {
  it('converts each account sum before total and per-transaction average', async () => {
    const accounts = [createAccount('usd', 'USD'), createAccount('eur', 'EUR')];
    const rows = [
      { account: 'usd', amount: 10_000, count: 2 },
      { account: 'eur', amount: 5_000, count: 1 },
    ];
    const prefs = {
      defaultCurrencyCode: 'USD',
      'manualRate.EUR.USD': '2',
    } satisfies SyncedPrefs;

    await expect(runSummary({ rows, accounts, prefs })).resolves.toMatchObject({
      total: 20_000,
      dividend: 20_000,
      divisor: 0,
      hasForeignCurrency: true,
    });
    await expect(
      runSummary({
        rows,
        accounts,
        prefs,
        content: { type: 'avgPerTransact' },
      }),
    ).resolves.toMatchObject({
      total: 20_000 / 3,
      dividend: 20_000,
      divisor: 3,
      hasForeignCurrency: true,
    });
  });

  it('uses period divisors for monthly and yearly averages', async () => {
    const result = await runSummary({
      accounts: [createAccount('usd', 'USD')],
      rows: [{ account: 'usd', amount: 31_000, count: 31 }],
      content: { type: 'avgPerMonth' },
    });
    expect(result).toMatchObject({
      total: 31_000,
      dividend: 31_000,
      divisor: 1,
    });

    const yearResult = await runSummary({
      accounts: [createAccount('usd', 'USD')],
      rows: [{ account: 'usd', amount: 31_000, count: 31 }],
      content: { type: 'avgPerYear' },
    });
    expect(yearResult).toMatchObject({
      total: 31_000 / (31 / 365.25),
      dividend: 31_000,
      divisor: 31 / 365.25,
    });
  });

  it('converts both sides of percentage summaries into Main before division', async () => {
    const result = await runSummary({
      accounts: [createAccount('usd', 'USD'), createAccount('eur', 'EUR')],
      rows: [{ account: 'eur', amount: 10_000, count: 1 }],
      divisorRows: [
        { account: 'usd', amount: 40_000, count: 1 },
        { account: 'eur', amount: 10_000, count: 1 },
      ],
      prefs: {
        defaultCurrencyCode: 'USD',
        'manualRate.EUR.USD': '2',
      },
      content: {
        type: 'percentage',
        divisorConditions: [],
        divisorConditionsOp: 'and',
      },
    });

    expect(result).toMatchObject({
      total: 33.33,
      dividend: 20_000,
      divisor: 60_000,
      hasForeignCurrency: true,
    });
  });

  it('returns unavailable for missing rates and a zero ratio denominator', async () => {
    await expect(
      runSummary({
        accounts: [createAccount('eur', 'EUR')],
        rows: [{ account: 'eur', amount: 100, count: 1 }],
      }),
    ).resolves.toEqual({ status: 'unavailable' });

    await expect(
      runSummary({
        accounts: [createAccount('usd', 'USD')],
        rows: [{ account: 'usd', amount: 100, count: 1 }],
        divisorRows: [{ account: 'usd', amount: 0, count: 1 }],
        content: {
          type: 'percentage',
          divisorConditions: [],
          divisorConditionsOp: 'and',
        },
      }),
    ).resolves.toMatchObject({ total: 0, dividend: 100, divisor: 0 });
  });

  it('distinguishes completed empty, missing-Main, and loading results', async () => {
    await expect(runSummary()).resolves.toMatchObject({
      total: 0,
      dividend: 0,
      divisor: 0,
      hasForeignCurrency: false,
    });
    await expect(runSummary({ prefs: {} })).resolves.toEqual({
      status: 'unavailable',
    });
    await expect(runSummary({ accountsReady: false })).resolves.toBeUndefined();
  });

  it('recalculates saved Main-only summaries when exchange rates change', async () => {
    const result = await runSummary({
      accounts: [createAccount('usd', 'USD')],
      rows: [{ account: 'usd', amount: 10_000, count: 1 }],
      content: { type: 'sum' },
    });

    expect(result).toMatchObject({
      total: 10_000,
      dividend: 10_000,
      hasForeignCurrency: false,
    });
  });

  it('updates saved summaries when Main or a rate changes or a rate is removed', async () => {
    const accounts = [createAccount('eur', 'EUR')];
    const rows = [{ account: 'eur', amount: 10_000, count: 1 }];
    const content: SummaryContent = { type: 'sum' };
    const first = await runSummary({
      accounts,
      rows,
      content,
      prefs: {
        defaultCurrencyCode: 'USD',
        'manualRate.EUR.USD': '2',
      },
    });
    const afterRateChange = await runSummary({
      accounts,
      rows,
      content,
      prefs: {
        defaultCurrencyCode: 'USD',
        'manualRate.EUR.USD': '3',
      },
    });
    const afterMainChange = await runSummary({
      accounts,
      rows,
      content,
      prefs: { defaultCurrencyCode: 'EUR' },
    });
    const afterRateRemoval = await runSummary({
      accounts,
      rows,
      content,
      prefs: { defaultCurrencyCode: 'USD' },
    });

    expect(first).toMatchObject({ total: 20_000 });
    expect(afterRateChange).toMatchObject({ total: 30_000 });
    expect(afterMainChange).toMatchObject({
      total: 10_000,
      hasForeignCurrency: false,
    });
    expect(afterRateRemoval).toEqual({ status: 'unavailable' });
  });
});
