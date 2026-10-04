import {
  clearServer,
  initServer,
} from '@actual-app/core/platform/client/connection';
import type { QueryState } from '@actual-app/core/shared/query';
import type { AccountEntity } from '@actual-app/core/types/models';
import { enUS } from 'date-fns/locale';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { useSpreadsheet } from '#hooks/useSpreadsheet';

import {
  cashFlowByDate,
  hasOnlyMainCurrencyAccounts,
  simpleCashFlow,
} from './cash-flow-spreadsheet';

vi.mock(
  '@actual-app/core/platform/client/connection',
  () => import('#mocks/connection'),
);

const account = (
  currency: string | null,
  offbudget: 0 | 1 = 0,
): AccountEntity => ({
  id: `${currency ?? 'default'}-${offbudget}`,
  name: 'Test account',
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
});

async function runReport<T>(
  factory: (
    spreadsheet: ReturnType<typeof useSpreadsheet>,
    setData: (data: T) => void,
  ) => Promise<void>,
) {
  let result: T | undefined;
  await factory(undefined as never, data => {
    result = data;
  });
  return result;
}

afterEach(async () => {
  await clearServer();
});

describe('cash flow currency and readiness', () => {
  it('rejects a foreign on-budget account but ignores a foreign off-budget account', () => {
    expect(
      hasOnlyMainCurrencyAccounts([account('USD'), account('EUR')], {
        defaultCurrencyCode: 'USD',
      }),
    ).toBe(false);
    expect(
      hasOnlyMainCurrencyAccounts([account('USD'), account('EUR', 1)], {
        defaultCurrencyCode: 'USD',
      }),
    ).toBe(true);
  });

  it('re-evaluates the on-budget invariant when Main changes', () => {
    const accounts = [account('EUR')];

    expect(
      hasOnlyMainCurrencyAccounts(accounts, { defaultCurrencyCode: 'USD' }),
    ).toBe(false);
    expect(
      hasOnlyMainCurrencyAccounts(accounts, { defaultCurrencyCode: 'EUR' }),
    ).toBe(true);
  });

  it('keeps both layouts pending until account data is ready', async () => {
    const summarySetData = vi.fn();
    const dailySetData = vi.fn();
    const accounts = [account('USD')];

    await simpleCashFlow(
      '2026-10',
      '2026-10',
      accounts,
      {
        defaultCurrencyCode: 'USD',
      },
      false,
    )(undefined as never, summarySetData);
    await cashFlowByDate(
      '2026-10',
      '2026-10',
      accounts,
      { defaultCurrencyCode: 'USD' },
      false,
      false,
      [],
      'and',
      enUS,
      String,
    )(undefined as never, dailySetData);

    expect(summarySetData).not.toHaveBeenCalled();
    expect(dailySetData).not.toHaveBeenCalled();
  });

  it('reports unavailable without Main, even with no accounts', async () => {
    const summary = await runReport(
      simpleCashFlow('2026-10', '2026-10', [], {}, true),
    );
    const daily = await runReport(
      cashFlowByDate(
        '2026-10',
        '2026-10',
        [],
        {},
        true,
        false,
        [],
        'and',
        enUS,
        String,
      ),
    );

    expect(summary).toEqual({ status: 'unavailable' });
    expect(daily).toEqual({ status: 'unavailable' });
  });

  it('keeps a completed empty report as zero', async () => {
    const queries: QueryState[] = [];
    const queryResults: unknown[] = [0, 0, 0, [], [], 0, [], [], 0, [], []];
    initServer({
      'make-filters-from-conditions': async () => ({ filters: [] }),
      query: async args => {
        queries.push(args as QueryState);
        return { data: queryResults.shift(), dependencies: [] };
      },
    });
    const summary = await runReport(
      simpleCashFlow(
        '2026-10',
        '2026-10',
        [],
        {
          defaultCurrencyCode: 'USD',
        },
        true,
      ),
    );
    const daily = await runReport(
      cashFlowByDate(
        '2026-10',
        '2026-10',
        [],
        { defaultCurrencyCode: 'USD' },
        true,
        false,
        [],
        'and',
        enUS,
        String,
      ),
    );
    const concise = await runReport(
      cashFlowByDate(
        '2026-10',
        '2026-10',
        [],
        { defaultCurrencyCode: 'USD' },
        true,
        true,
        [],
        'and',
        enUS,
        String,
      ),
    );

    expect(summary).toMatchObject({
      status: 'complete',
      graphData: { income: 0, expense: 0 },
    });
    expect(daily).toMatchObject({ status: 'complete', totalIncome: 0 });
    expect(concise).toMatchObject({ status: 'complete', totalIncome: 0 });
    expect(queries).toHaveLength(8);
    for (const query of queries) {
      expect(query.filterExpressions).toContainEqual(
        expect.objectContaining({ 'account.offbudget': false }),
      );
    }
    expect(queries[0].filterExpressions).toContainEqual(
      expect.objectContaining({ 'payee.transfer_acct': null }),
    );
    expect(queries[2].filterExpressions).toContainEqual(
      expect.objectContaining({
        'account.offbudget': false,
        date: { $transform: '$month', $lt: '2026-10-01' },
      }),
    );
    expect(queries[3].groupExpressions).toContain('date');
    expect(queries[6].groupExpressions).toContainEqual({
      $month: '$date',
    });
  });
});
