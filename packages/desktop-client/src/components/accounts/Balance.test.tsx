import React from 'react';

import { generateAccount } from '@actual-app/core/mocks';
import type { ScheduleEntity } from '@actual-app/core/types/models';
import { render, screen } from '@testing-library/react';

import { useCachedSchedules } from '#hooks/useCachedSchedules';
import { useSelectedItems } from '#hooks/useSelected';
import { useSheetValue } from '#hooks/useSheetValue';
import { useSyncedPref } from '#hooks/useSyncedPref';
import { TestProviders } from '#mocks';

import { SelectedBalance } from './Balance';

vi.mock('#hooks/useSelected', () => ({
  useSelectedItems: vi.fn(),
}));

vi.mock('#hooks/useSheetValue', () => ({
  useSheetValue: vi.fn(),
}));

vi.mock('#hooks/useCachedSchedules', () => ({
  useCachedSchedules: vi.fn(),
}));

vi.mock('#hooks/useSyncedPref', () => ({
  useSyncedPref: vi.fn(),
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
    vi.mocked(useSyncedPref).mockReturnValue([undefined, vi.fn()]);
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

  test('uses the account currency instead of Main currency', () => {
    vi.mocked(useSyncedPref).mockReturnValue(['VND', vi.fn()]);
    vi.mocked(useSheetValue)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(1234);

    render(
      <TestProviders>
        <SelectedBalance
          selectedItems={new Set(['tx-123'])}
          account={{ ...generateAccount('USD'), currency: 'USD' }}
        />
      </TestProviders>,
    );

    expect(screen.getByText('$12.34')).toBeInTheDocument();
  });

  test('inherits Main currency for an empty account currency', () => {
    vi.mocked(useSyncedPref).mockReturnValue(['VND', vi.fn()]);
    vi.mocked(useSheetValue)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(5000000);

    render(
      <TestProviders>
        <SelectedBalance
          selectedItems={new Set(['tx-123'])}
          account={{ ...generateAccount('Inherited'), currency: '' }}
        />
      </TestProviders>,
    );

    expect(screen.getByText('50,000 ₫')).toBeInTheDocument();
  });
});

describe('SelectedBalance – preview (scheduled) transactions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useSheetValue).mockReturnValue(null);
    vi.mocked(useSyncedPref).mockReturnValue([undefined, vi.fn()]);
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
});
