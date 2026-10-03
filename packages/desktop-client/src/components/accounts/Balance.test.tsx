import React from 'react';

import { generateAccount } from '@actual-app/core/mocks';
import { q } from '@actual-app/core/shared/query';
import type {
  AccountEntity,
  ScheduleEntity,
} from '@actual-app/core/types/models';
import { render, screen } from '@testing-library/react';

import { useCachedSchedules } from '#hooks/useCachedSchedules';
import { useSelectedItems } from '#hooks/useSelected';
import { useSheetValue } from '#hooks/useSheetValue';
import { TestProviders } from '#mocks';

import { Balances, SelectedBalance } from './Balance';

vi.mock('#hooks/useSelected', () => ({
  useSelectedItems: vi.fn(),
}));

vi.mock('#hooks/useSheetValue', () => ({
  useSheetValue: vi.fn(),
}));

vi.mock('#hooks/useCachedSchedules', () => ({
  useCachedSchedules: vi.fn(),
}));

const prefs = vi.hoisted(() => ({
  defaultCurrencyCode: 'VND',
  'manualRate.USD.VND': '25400',
}));

vi.mock('#hooks/useSyncedPrefs', () => ({
  useSyncedPrefs: () => [prefs, vi.fn()],
}));

function makeSchedule(
  id: string,
  amount: number,
  accountId: string,
): ScheduleEntity {
  return {
    id,
    rule: 'rule-1',
    next_date: '2026-03-24',
    completed: false,
    posts_transaction: false,
    tombstone: false,
    _payee: 'payee-1',
    _account: accountId,
    _amount: amount,
    _amountOp: 'is',
    _date: '2026-03-24',
    _conditions: [],
    _actions: [],
  } satisfies ScheduleEntity;
}

function mockedSchedules(schedules: ScheduleEntity[]) {
  return {
    isLoading: false,
    schedules,
    statuses: new Map(),
    statusLabels: new Map(),
  };
}

describe('SelectedBalance – normal transactions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useCachedSchedules).mockReturnValue(mockedSchedules([]));
  });

  test('shows balance for selected normal transactions', () => {
    vi.mocked(useSheetValue)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(-5000);

    render(
      <TestProviders>
        <SelectedBalance selectedItems={new Set(['tx-123'])} />
      </TestProviders>,
    );

    expect(screen.getByText('Selected balance:')).toBeInTheDocument();
    expect(screen.getByText('-50.00')).toBeInTheDocument();
  });

  test('shows balance when balance is falsy', () => {
    vi.mocked(useSheetValue).mockReturnValueOnce(null).mockReturnValueOnce(0);

    render(
      <TestProviders>
        <SelectedBalance selectedItems={new Set(['tx-123'])} />
      </TestProviders>,
    );

    expect(screen.getByText('Selected balance:')).toBeInTheDocument();
  });

  test('converts selected USD and VND amounts before totaling', () => {
    const usd = {
      ...generateAccount('USD savings'),
      currency: 'USD',
    } satisfies AccountEntity;
    const vnd = {
      ...generateAccount('VND cash'),
      currency: 'VND',
    } satisfies AccountEntity;
    const selectedAmounts = [
      { account: usd.id, amount: 40_000 },
      { account: vnd.id, amount: 10_000 },
    ];
    vi.mocked(useSheetValue)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(selectedAmounts as never);

    render(
      <TestProviders>
        <SelectedBalance
          selectedItems={new Set(['tx-usd', 'tx-vnd'])}
          accounts={[usd, vnd]}
        />
      </TestProviders>,
    );

    expect(screen.getByText('Selected balance:')).toBeInTheDocument();
    expect(screen.getByText(/10,160,100/)).toBeInTheDocument();
  });

  test('selected aggregates include only accounts in the current view', () => {
    const usd = {
      ...generateAccount('USD savings'),
      currency: 'USD',
    } satisfies AccountEntity;
    const vnd = {
      ...generateAccount('VND cash'),
      currency: 'VND',
    } satisfies AccountEntity;
    const selectedAmounts = [
      { account: usd.id, amount: 40_000 },
      { account: vnd.id, amount: 10_000 },
    ];
    vi.mocked(useSheetValue)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(selectedAmounts as never);

    render(
      <TestProviders>
        <SelectedBalance
          selectedItems={new Set(['tx-usd', 'tx-vnd'])}
          accounts={[vnd]}
        />
      </TestProviders>,
    );

    const selectedBalance = screen.getByText('Selected balance:').parentElement;
    expect(selectedBalance?.textContent).toMatch(/Selected balance:\s*100/u);
    expect(selectedBalance?.textContent).not.toContain('10,160,100');
  });
});

describe('SelectedBalance – preview (scheduled) transactions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useSheetValue).mockReturnValue(null);
  });

  test('includes the schedule amount when a preview transaction is selected', () => {
    const scheduleId = 'schedule-abc';

    vi.mocked(useSelectedItems).mockReturnValue(
      new Set([`preview/${scheduleId}/2026-03-24`]),
    );
    vi.mocked(useCachedSchedules).mockReturnValue(
      mockedSchedules([makeSchedule(scheduleId, -5000, 'account-1')]),
    );

    render(
      <TestProviders>
        <SelectedBalance
          selectedItems={new Set([`preview/${scheduleId}/2026-03-24`])}
        />
      </TestProviders>,
    );

    expect(screen.getByText('Selected balance:')).toBeInTheDocument();
  });

  test('counts each selected occurrence of the same schedule independently', () => {
    const scheduleId = 'schedule-abc';
    const previewId1 = `preview/${scheduleId}/2026-03-24`;
    const previewId2 = `preview/${scheduleId}/2026-04-24`;
    const selectedItems = new Set([previewId1, previewId2]);

    vi.mocked(useSelectedItems).mockReturnValue(selectedItems);
    vi.mocked(useCachedSchedules).mockReturnValue(
      mockedSchedules([makeSchedule(scheduleId, -5000, 'account-1')]),
    );

    render(
      <TestProviders>
        <SelectedBalance selectedItems={selectedItems} />
      </TestProviders>,
    );

    expect(screen.getByText('-100.00')).toBeInTheDocument();
  });

  test('converts scheduled selections in a multi-account view', () => {
    const vnd = {
      ...generateAccount('VND cash'),
      currency: 'VND',
    } satisfies AccountEntity;
    const scheduleId = 'schedule-abc';
    const previewId = `preview/${scheduleId}/2026-03-24`;
    const selectedItems = new Set([previewId]);

    vi.mocked(useSelectedItems).mockReturnValue(selectedItems);
    vi.mocked(useSheetValue)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce([] as never);
    vi.mocked(useCachedSchedules).mockReturnValue(
      mockedSchedules([makeSchedule(scheduleId, -5000, vnd.id)]),
    );

    render(
      <TestProviders>
        <SelectedBalance selectedItems={selectedItems} accounts={[vnd]} />
      </TestProviders>,
    );

    expect(screen.getByText('Selected balance:')).toBeInTheDocument();
    expect(screen.getByText(/-50/)).toBeInTheDocument();
  });
});

describe('Balances – aggregate account totals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prefs.defaultCurrencyCode = '';
    vi.mocked(useCachedSchedules).mockReturnValue(mockedSchedules([]));
    vi.mocked(useSelectedItems).mockReturnValue(new Set());
    vi.mocked(useSheetValue).mockReturnValue([] as never);
  });

  test('keeps inline split rows and one selector when Main is unavailable', () => {
    const account = {
      ...generateAccount('USD savings'),
      currency: 'USD',
    } satisfies AccountEntity;
    const groupedQuery = q('transactions').options({ splits: 'grouped' });
    const props = {
      balanceQuery: {
        name: 'balance-query-all' as const,
        query: groupedQuery,
      },
      accountAmountsQuery: groupedQuery,
      aggregateAccounts: [account],
      showExtraBalances: true,
      onToggleExtraBalances: vi.fn(),
      isFiltered: false,
    };

    render(
      <TestProviders>
        <Balances {...props} />
      </TestProviders>,
    );

    expect(screen.getByTestId('account-balance')).toHaveTextContent('N/A');
    expect(screen.getAllByTestId('account-balance')).toHaveLength(1);
    expect(
      vi
        .mocked(useSheetValue)
        .mock.calls.map(([binding]) =>
          typeof binding === 'string'
            ? undefined
            : binding.query?.state.tableOptions.splits,
        ),
    ).toEqual(['inline', 'inline', 'inline']);
  });

  test('shows loaded-empty aggregate amounts as zero with a valid Main currency', () => {
    prefs.defaultCurrencyCode = 'VND';
    const account = {
      ...generateAccount('VND cash'),
      currency: 'VND',
    } satisfies AccountEntity;
    const groupedQuery = q('transactions').options({ splits: 'grouped' });

    render(
      <TestProviders>
        <Balances
          balanceQuery={{ name: 'balance-query-all', query: groupedQuery }}
          accountAmountsQuery={groupedQuery}
          aggregateAccounts={[account]}
          showExtraBalances={false}
          onToggleExtraBalances={vi.fn()}
          isFiltered={false}
        />
      </TestProviders>,
    );

    expect(screen.getByTestId('account-balance')).toHaveTextContent('0');
    expect(screen.getAllByTestId('account-balance')).toHaveLength(1);
  });
});
