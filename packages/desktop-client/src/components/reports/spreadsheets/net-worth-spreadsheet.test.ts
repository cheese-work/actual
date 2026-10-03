import {
  clearServer,
  initServer,
} from '@actual-app/core/platform/client/connection';
import type { AccountEntity } from '@actual-app/core/types/models';
import type { SyncedPrefs } from '@actual-app/core/types/prefs';
import { enUS } from 'date-fns/locale';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSpreadsheet } from './net-worth-spreadsheet';

vi.mock(
  '@actual-app/core/platform/client/connection',
  () => import('#mocks/connection'),
);

type SpreadsheetData = Parameters<
  Parameters<ReturnType<typeof createSpreadsheet>>[1]
>[0];

type LinkedTransfer = {
  id: string;
  account: string;
  amount: number;
  date: string;
  transfer_id: string;
};

type AccountQueryResult = number | Array<{ date: string; amount: number }>;

const accounts = [
  createAccount('checking', 'Checking'),
  createAccount('savings', 'Savings'),
] satisfies AccountEntity[];

function createAccount(
  id: string,
  name: string,
  currency: string | null = null,
): AccountEntity {
  return {
    id,
    name,
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

async function runReportResult({
  accounts,
  accountQueryResults,
  linkedTransfers = [],
  prefs = { defaultCurrencyCode: 'USD' },
  start = '2026-07',
  end = '2026-08',
  interval = 'Monthly',
  earliestTransactionDate = '2026-07-01',
}: {
  accounts: AccountEntity[];
  accountQueryResults: AccountQueryResult[];
  linkedTransfers?: LinkedTransfer[];
  prefs?: Readonly<SyncedPrefs>;
  start?: string;
  end?: string;
  interval?: string;
  earliestTransactionDate?: string;
}) {
  const remainingAccountResults = [...accountQueryResults];

  initServer({
    'make-filters-from-conditions': async () => ({ filters: [] }),
    'get-earliest-transaction': async () => ({
      date: earliestTransactionDate,
    }),
    query: async query => {
      if (query.selectExpressions.includes('transfer_id')) {
        const transferFilter = query.filterExpressions.find(
          expression => 'transfer_id' in expression,
        );
        const accountIds = getOneOfValues(transferFilter?.account);
        const transactionIds = getOneOfValues(transferFilter?.id);
        const endDate = getUpperBound(transferFilter?.date);

        return {
          data: linkedTransfers.filter(
            leg =>
              (accountIds.length === 0 || accountIds.includes(leg.account)) &&
              (transactionIds.length === 0 ||
                transactionIds.includes(leg.id)) &&
              (!endDate || leg.date <= endDate),
          ),
          dependencies: [],
        };
      }

      const data = remainingAccountResults.shift();
      if (data === undefined) {
        throw new Error('Unexpected account query');
      }
      return { data, dependencies: [] };
    },
  });

  let report: SpreadsheetData | undefined;
  const spreadsheet = createSpreadsheet(
    start,
    end,
    accounts,
    [],
    'and',
    enUS,
    interval,
    '0',
    value => String(value),
    undefined,
    prefs,
  );

  // The net worth factory does not use its spreadsheet dependency.
  await spreadsheet(undefined as never, data => {
    report = data;
  });

  if (!report) {
    throw new Error('Spreadsheet did not produce report data');
  }
  return report;
}

async function runReport(
  input: Parameters<typeof runReportResult>[0],
): Promise<Extract<SpreadsheetData, { status: 'complete' }>> {
  const report = await runReportResult(input);
  if (report.status !== 'complete') {
    throw new Error('Net worth report was unavailable');
  }
  return report;
}

function getOneOfValues(value: unknown) {
  if (
    typeof value === 'object' &&
    value !== null &&
    '$oneof' in value &&
    Array.isArray(value.$oneof)
  ) {
    return value.$oneof.filter(item => typeof item === 'string');
  }
  return [];
}

function getUpperBound(value: unknown) {
  if (
    typeof value === 'object' &&
    value !== null &&
    '$lte' in value &&
    typeof value.$lte === 'string'
  ) {
    return value.$lte;
  }
  return null;
}

afterEach(async () => {
  await clearServer();
});

describe('net worth transfers', () => {
  it('keeps a linked transfer neutral when its two legs cross months', async () => {
    const report = await runReport({
      accounts,
      accountQueryResults: [
        100_000,
        [{ date: '2026-07', amount: -10_000 }],
        0,
        [{ date: '2026-08', amount: 10_000 }],
      ],
      linkedTransfers: [
        {
          id: 'checking-transfer',
          account: 'checking',
          amount: -10_000,
          date: '2026-07-31',
          transfer_id: 'savings-transfer',
        },
        {
          id: 'savings-transfer',
          account: 'savings',
          amount: 10_000,
          date: '2026-08-01',
          transfer_id: 'checking-transfer',
        },
      ],
    });

    expect(report.graphData.data.map(point => point.y)).toEqual([
      100_000, 100_000,
    ]);
  });

  it('converts opening and interval balances before calculating totals', async () => {
    const report = await runReport({
      accounts: [
        createAccount('usd', 'US dollars', 'USD'),
        createAccount('vnd', 'Vietnamese dong', 'VND'),
      ],
      accountQueryResults: [
        100_000,
        [{ date: '2026-07', amount: -20_000 }],
        -50_000_000,
        [{ date: '2026-07', amount: 25_000_000 }],
      ],
      prefs: {
        defaultCurrencyCode: 'EUR',
        'manualRate.USD.EUR': '0.8',
        'manualRate.VND.EUR': '0.00004',
      },
    });

    expect(report.graphData.data.map(point => point.y)).toEqual([
      63_000, 63_000,
    ]);
    expect(report.graphData.data[0]).toMatchObject({
      assets: '64000',
      debt: '-1000',
      usd: 64_000,
      vnd: -1_000,
    });
    expect(report.netWorth).toBe(63_000);
    expect(report.graphData.data[0].change).toBe('-15000');
    expect(report.totalChange).toBe(0);
  });

  it('does not align transfers across different account currencies', async () => {
    const report = await runReport({
      accounts: [
        createAccount('checking', 'Checking', 'USD'),
        createAccount('savings', 'Savings', 'EUR'),
      ],
      accountQueryResults: [
        100_000,
        [{ date: '2026-07', amount: -10_000 }],
        0,
        [{ date: '2026-08', amount: 10_000 }],
      ],
      linkedTransfers: [
        {
          id: 'checking-transfer',
          account: 'checking',
          amount: -10_000,
          date: '2026-07-31',
          transfer_id: 'savings-transfer',
        },
        {
          id: 'savings-transfer',
          account: 'savings',
          amount: 10_000,
          date: '2026-08-01',
          transfer_id: 'checking-transfer',
        },
      ],
      prefs: {
        defaultCurrencyCode: 'USD',
        'manualRate.EUR.USD': '1',
      },
    });

    expect(report.graphData.data.map(point => point.y)).toEqual([
      90_000, 100_000,
    ]);
  });

  it('uses one cached-rate valuation time for every account and interval leaf', async () => {
    const now = 1_800_000_000_000;
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now);

    await runReport({
      accounts: [
        createAccount('checking', 'Checking', 'USD'),
        createAccount('savings', 'Savings', 'USD'),
      ],
      accountQueryResults: [
        100_000,
        [{ date: '2026-07', amount: -10_000 }],
        20_000,
        [{ date: '2026-08', amount: 10_000 }],
      ],
      prefs: {
        defaultCurrencyCode: 'EUR',
        'rateMode.USD': 'auto',
        'autoRate.USD.EUR': JSON.stringify({ rate: '0.8', fetchedAt: now }),
      },
    });

    expect(dateNow).toHaveBeenCalledTimes(1);
  });

  it('keeps unavailable distinct from a completed empty report', async () => {
    const missingMain = await runReportResult({
      accounts: [],
      accountQueryResults: [],
      prefs: {},
    });
    expect(missingMain).toEqual({ status: 'unavailable' });

    const empty = await runReport({
      accounts: [],
      accountQueryResults: [],
      prefs: { defaultCurrencyCode: 'USD' },
    });
    expect(empty.netWorth).toBe(0);
    expect(empty.graphData.data.map(point => point.y)).toEqual([0, 0]);
  });

  it('does not treat placeholder accounts as a completed empty report', async () => {
    let report: SpreadsheetData | undefined;
    const spreadsheet = createSpreadsheet(
      '2026-07',
      '2026-08',
      [],
      [],
      'and',
      enUS,
      'Monthly',
      '0',
      value => String(value),
      undefined,
      { defaultCurrencyCode: 'USD' },
      false,
    );

    await spreadsheet(undefined as never, data => {
      report = data;
    });

    expect(report).toBeUndefined();
  });

  it('suppresses all report values when an included account lacks a rate', async () => {
    const report = await runReportResult({
      accounts: [createAccount('foreign', 'Foreign', 'VND')],
      accountQueryResults: [0, []],
      prefs: { defaultCurrencyCode: 'USD' },
    });

    expect(report).toEqual({ status: 'unavailable' });
  });

  it('preserves a real expense as a net worth loss', async () => {
    const report = await runReport({
      accounts: [accounts[0]],
      accountQueryResults: [100_000, [{ date: '2026-07', amount: -10_000 }]],
    });

    expect(report.graphData.data.map(point => point.y)).toEqual([
      90_000, 90_000,
    ]);
  });

  it('preserves a transfer out of the selected account set as a loss', async () => {
    const report = await runReport({
      accounts: [accounts[0]],
      accountQueryResults: [100_000, [{ date: '2026-07', amount: -10_000 }]],
      linkedTransfers: [
        {
          id: 'checking-transfer',
          account: 'checking',
          amount: -10_000,
          date: '2026-07-31',
          transfer_id: 'savings-transfer',
        },
        {
          id: 'savings-transfer',
          account: 'savings',
          amount: 10_000,
          date: '2026-08-01',
          transfer_id: 'checking-transfer',
        },
      ],
    });

    expect(report.graphData.data.map(point => point.y)).toEqual([
      90_000, 90_000,
    ]);
  });

  it('keeps funds in the source account until a later counterpart arrives', async () => {
    const report = await runReport({
      accounts,
      accountQueryResults: [
        100_000,
        [{ date: '2026-08', amount: -10_000 }],
        0,
        [],
      ],
      linkedTransfers: [
        {
          id: 'checking-transfer',
          account: 'checking',
          amount: -10_000,
          date: '2026-08-31',
          transfer_id: 'savings-transfer',
        },
        {
          id: 'savings-transfer',
          account: 'savings',
          amount: 10_000,
          date: '2026-09-01',
          transfer_id: 'checking-transfer',
        },
      ],
    });

    expect(report.graphData.data.map(point => point.y)).toEqual([
      100_000, 100_000,
    ]);
    expect(report.graphData.data.at(-1)).toMatchObject({ checking: 100_000 });
  });

  it('keeps a transfer neutral when it spans the entire report range', async () => {
    const report = await runReport({
      accounts,
      accountQueryResults: [90_000, [], 0, []],
      linkedTransfers: [
        {
          id: 'checking-transfer',
          account: 'checking',
          amount: -10_000,
          date: '2026-06-30',
          transfer_id: 'savings-transfer',
        },
        {
          id: 'savings-transfer',
          account: 'savings',
          amount: 10_000,
          date: '2026-09-01',
          transfer_id: 'checking-transfer',
        },
      ],
      start: '2026-08',
      end: '2026-08',
      earliestTransactionDate: '2026-06-30',
    });

    expect(report.graphData.data.map(point => point.y)).toEqual([
      100_000, 100_000,
    ]);
  });

  it.each([
    {
      interval: 'Daily',
      start: '2016-07',
      end: '2016-07',
      earliestTransactionDate: '2016-07-30',
      earlierDate: '2016-07-30',
      laterDate: '2016-07-31',
      earlierBalanceDate: '2016-07-30',
      laterBalanceDate: '2016-07-31',
    },
    {
      interval: 'Weekly',
      start: '2016-07',
      end: '2016-07',
      earliestTransactionDate: '2016-07-30',
      earlierDate: '2016-07-30',
      laterDate: '2016-07-31',
      earlierBalanceDate: '2016-07-30',
      laterBalanceDate: '2016-07-31',
    },
    {
      interval: 'Yearly',
      start: '2016-01',
      end: '2017-01',
      earliestTransactionDate: '2016-12-31',
      earlierDate: '2016-12-31',
      laterDate: '2017-01-01',
      earlierBalanceDate: '2016',
      laterBalanceDate: '2017',
    },
  ])(
    'keeps a linked transfer neutral across $interval intervals',
    async ({
      interval,
      start,
      end,
      earliestTransactionDate,
      earlierDate,
      laterDate,
      earlierBalanceDate,
      laterBalanceDate,
    }) => {
      const report = await runReport({
        accounts,
        accountQueryResults: [
          100_000,
          [{ date: earlierBalanceDate, amount: -10_000 }],
          0,
          [{ date: laterBalanceDate, amount: 10_000 }],
        ],
        linkedTransfers: [
          {
            id: 'checking-transfer',
            account: 'checking',
            amount: -10_000,
            date: earlierDate,
            transfer_id: 'savings-transfer',
          },
          {
            id: 'savings-transfer',
            account: 'savings',
            amount: 10_000,
            date: laterDate,
            transfer_id: 'checking-transfer',
          },
        ],
        start,
        end,
        interval,
        earliestTransactionDate,
      });

      const totals = report.graphData.data.map(point => point.y);
      expect(totals).toEqual(totals.map(() => 100_000));
    },
  );
});
