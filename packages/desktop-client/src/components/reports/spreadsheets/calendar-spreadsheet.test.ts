import {
  clearServer,
  initServer,
} from '@actual-app/core/platform/client/connection';
import type { QueryState } from '@actual-app/core/shared/query';
import type { AccountEntity } from '@actual-app/core/types/models';
import type { SyncedPrefs } from '@actual-app/core/types/prefs';
import { format as formatDate } from 'date-fns';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { useSpreadsheet } from '#hooks/useSpreadsheet';

import {
  calendarSpreadsheet,
  type CalendarSpreadsheetResult,
} from './calendar-spreadsheet';

vi.mock(
  '@actual-app/core/platform/client/connection',
  () => import('#mocks/connection'),
);

type CalendarQueryRow = { account: string; date: string; amount: number };

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

async function runCalendar({
  accounts,
  prefs,
  expenseRows = [],
  incomeRows = [],
  accountsReady = true,
  start = '2026-01',
  end = '2026-02',
  firstDayOfWeekIdx = '1',
}: {
  accounts: AccountEntity[];
  prefs: Readonly<SyncedPrefs>;
  expenseRows?: CalendarQueryRow[];
  incomeRows?: CalendarQueryRow[];
  accountsReady?: boolean;
  start?: string;
  end?: string;
  firstDayOfWeekIdx?: string;
}) {
  const queries: QueryState[] = [];
  const queryResults = [expenseRows, incomeRows];
  initServer({
    'make-filters-from-conditions': async () => ({ filters: [] }),
    query: async query => {
      queries.push(query as QueryState);
      return { data: queryResults.shift() ?? [], dependencies: [] };
    },
  });

  let result: CalendarSpreadsheetResult | undefined;
  await calendarSpreadsheet(
    start,
    end,
    [],
    'and',
    firstDayOfWeekIdx,
    accounts,
    prefs,
    accountsReady,
  )(undefined as ReturnType<typeof useSpreadsheet>, data => {
    result = data;
  });
  return { result, queries };
}

async function runResult<T>(
  factory: (
    spreadsheet: ReturnType<typeof useSpreadsheet>,
    setData: (data: T) => void,
  ) => Promise<void>,
) {
  let result: T | undefined;
  await factory(undefined as ReturnType<typeof useSpreadsheet>, data => {
    result = data;
  });
  return result;
}

afterEach(async () => {
  await clearServer();
});

describe('calendar spreadsheet currency conversion', () => {
  it('converts account-day leaves before daily totals and heatmap scaling', async () => {
    const { result, queries } = await runCalendar({
      accounts: [createAccount('jpy', 'JPY'), createAccount('vnd', 'VND')],
      prefs: {
        defaultCurrencyCode: 'USD',
        'manualRate.JPY.USD': '0.0067',
        'manualRate.VND.USD': '0.000041',
      },
      expenseRows: [
        { account: 'jpy', date: '2026-01-31', amount: -100_000 },
        { account: 'vnd', date: '2026-01-31', amount: -1_000_000 },
      ],
      incomeRows: [
        { account: 'jpy', date: '2026-02-01', amount: 100_000 },
        { account: 'vnd', date: '2026-02-01', amount: 1_000_000 },
        { account: 'jpy', date: '2026-02-02', amount: 100_000 },
      ],
    });

    expect(result).toMatchObject({
      calendarData: [
        { totalExpense: 711, totalIncome: 0 },
        { totalExpense: 0, totalIncome: 1381 },
      ],
      hasForeignCurrency: true,
    });
    expect(
      queries.map(query => query.groupExpressions).every(group =>
        group.includes('account'),
      ),
    ).toBe(true);

    if (!result || 'status' in result) {
      throw new Error('Expected calendar data');
    }
    const januaryExpense = result.calendarData[0].data.find(
      day => formatDate(day.date, 'yyyy-MM-dd') === '2026-01-31',
    );
    const februaryIncome = result.calendarData[1].data.find(
      day => formatDate(day.date, 'yyyy-MM-dd') === '2026-02-01',
    );
    const februaryNextIncome = result.calendarData[1].data.find(
      day => formatDate(day.date, 'yyyy-MM-dd') === '2026-02-02',
    );

    expect(januaryExpense).toMatchObject({ expenseValue: 711, expenseSize: 100 });
    expect(februaryIncome?.incomeValue).toBe(711);
    expect(februaryNextIncome?.incomeValue).toBe(670);
    expect(februaryIncome?.incomeSize).toBeCloseTo((711 / 1381) * 100);
    expect(februaryNextIncome?.incomeSize).toBeCloseTo((670 / 1381) * 100);
  });

  it('recalculates rate edits and converts custom units to Main', async () => {
    const jpy = createAccount('jpy', 'JPY');
    const rateBefore = await runCalendar({
      accounts: [jpy],
      prefs: {
        defaultCurrencyCode: 'USD',
        'manualRate.JPY.USD': '0.0067',
      },
      incomeRows: [{ account: 'jpy', date: '2026-02-01', amount: 100_000 }],
    });
    const rateAfter = await runCalendar({
      accounts: [jpy],
      prefs: {
        defaultCurrencyCode: 'USD',
        'manualRate.JPY.USD': '0.01',
      },
      incomeRows: [{ account: 'jpy', date: '2026-02-01', amount: 100_000 }],
    });
    const custom = await runCalendar({
      accounts: [createAccount('tokens', 'X-TOKEN')],
      prefs: {
        defaultCurrencyCode: 'USD',
        'customUnit.X-TOKEN': JSON.stringify({
          name: 'Token',
          symbol: 'T',
          decimals: 2,
        }),
        'manualRate.X-TOKEN.USD': '2',
      },
      incomeRows: [{ account: 'tokens', date: '2026-02-01', amount: 125 }],
    });

    expect(rateBefore.result).toMatchObject({
      calendarData: [{}, { totalIncome: 670 }],
    });
    expect(rateAfter.result).toMatchObject({
      calendarData: [{}, { totalIncome: 1000 }],
    });
    expect(custom.result).toMatchObject({
      calendarData: [{}, { totalIncome: 250 }],
    });
  });

  it('holds for accounts until data is complete and marks missing rates unavailable', async () => {
    const pending = await runCalendar({
      accounts: [],
      prefs: { defaultCurrencyCode: 'USD' },
      accountsReady: false,
    });
    const missingRate = await runCalendar({
      accounts: [createAccount('jpy', 'JPY')],
      prefs: { defaultCurrencyCode: 'USD' },
      incomeRows: [{ account: 'jpy', date: '2026-02-01', amount: 100 }],
    });
    const missingMain = await runResult(
      calendarSpreadsheet('2026-01', '2026-02', [], 'and', '1', [], {}, true),
    );
    const empty = await runCalendar({
      accounts: [],
      prefs: { defaultCurrencyCode: 'USD' },
    });

    expect(pending.result).toEqual({ status: 'loading' });
    expect(pending.queries).toHaveLength(0);
    expect(missingRate.result).toEqual({ status: 'unavailable' });
    expect(missingMain).toEqual({ status: 'unavailable' });
    expect(empty.result).toMatchObject({
      calendarData: [
        { totalExpense: 0, totalIncome: 0 },
        { totalExpense: 0, totalIncome: 0 },
      ],
    });
  });
});
