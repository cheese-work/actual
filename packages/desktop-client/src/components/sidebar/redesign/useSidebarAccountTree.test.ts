import { createElement } from 'react';

import { generateAccount } from '@actual-app/core/mocks';
import type {
  AccountEntity,
  AccountGroupEntity,
} from '@actual-app/core/types/models';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useOffBudgetAccounts } from '#hooks/useOffBudgetAccounts';
import { useOnBudgetAccounts } from '#hooks/useOnBudgetAccounts';
import {
  configureTestAppStore,
  createTestQueryClient,
  TestProviders,
} from '#mocks';

import {
  buildAccountSide,
  filterSidebarTree,
  getEffectiveGroupId,
  useSidebarAccountTree,
} from './useSidebarAccountTree';
import type { SidebarAccountTree } from './useSidebarAccountTree';

function makeAccount(
  name: string,
  overrides: Partial<AccountEntity> = {},
): AccountEntity {
  return { ...generateAccount(name), ...overrides };
}

function makeGroup(id: string, name: string): AccountGroupEntity {
  return { id, name, sort_order: 0 };
}

describe('getEffectiveGroupId', () => {
  it('returns the group id only when the group is live', () => {
    const liveGroupIds = new Set(['g1']);
    expect(
      getEffectiveGroupId(
        makeAccount('A', { account_group_id: 'g1' }),
        liveGroupIds,
      ),
    ).toBe('g1');
    expect(
      getEffectiveGroupId(
        makeAccount('B', { account_group_id: 'deleted' }),
        liveGroupIds,
      ),
    ).toBeNull();
    expect(
      getEffectiveGroupId(
        makeAccount('C', { account_group_id: null }),
        liveGroupIds,
      ),
    ).toBeNull();
  });
});

describe('buildAccountSide', () => {
  it('buckets ungrouped and dangling-ref accounts first, then groups in order', () => {
    const groups = [makeGroup('g1', 'Savings'), makeGroup('g2', 'Cards')];
    const accounts = [
      makeAccount('Loose'),
      makeAccount('Dangling', { account_group_id: 'deleted' }),
      makeAccount('Saver', { account_group_id: 'g1' }),
      makeAccount('Amex', { account_group_id: 'g2' }),
    ];

    const side = buildAccountSide(accounts, groups);

    expect(side.accountCount).toBe(4);
    expect(side.buckets.map(bucket => bucket.group?.id ?? null)).toEqual([
      null,
      'g1',
      'g2',
    ]);
    expect(side.buckets[0].accounts.map(account => account.name)).toEqual([
      'Loose',
      'Dangling',
    ]);
  });

  it('omits empty buckets and counts failed syncs per bucket', () => {
    const groups = [makeGroup('g1', 'Savings'), makeGroup('g2', 'Empty')];
    const failed = makeAccount('Broken', {
      account_group_id: 'g1',
      bank_sync_status: 'reauth-required',
    });
    const side = buildAccountSide(
      [makeAccount('Fine', { account_group_id: 'g1' }), failed],
      groups,
    );

    expect(side.buckets.map(bucket => bucket.group?.id)).toEqual(['g1']);
    expect(side.buckets[0].failedCount).toBe(1);
    expect(side.failedCount).toBe(1);
  });
});

describe('filterSidebarTree', () => {
  const groups = [makeGroup('g1', 'Savings')];
  const tree: SidebarAccountTree = {
    onBudget: buildAccountSide(
      [
        makeAccount('Checking'),
        makeAccount('Premium Saver', { account_group_id: 'g1' }),
      ],
      groups,
    ),
    offBudget: buildAccountSide([makeAccount('House')], groups),
    closed: [makeAccount('Old Checking', { closed: 1 })],
    accountsLoaded: true,
  };

  it('returns the tree unchanged for an empty query', () => {
    expect(filterSidebarTree(tree, '')).toBe(tree);
  });

  it('filters rows but keeps side counts for the full side', () => {
    const filtered = filterSidebarTree(tree, 'saver');

    expect(
      filtered.onBudget.buckets.flatMap(bucket =>
        bucket.accounts.map(account => account.name),
      ),
    ).toEqual(['Premium Saver']);
    expect(filtered.onBudget.accountCount).toBe(2);
    expect(filtered.offBudget.buckets).toEqual([]);
    expect(filtered.closed).toEqual([]);
  });

  it('matches closed accounts too', () => {
    const filtered = filterSidebarTree(tree, 'old');
    expect(filtered.closed.map(account => account.name)).toEqual([
      'Old Checking',
    ]);
  });

  it('matches every account in a group whose name matches', () => {
    const filtered = filterSidebarTree(tree, 'savings');

    expect(filtered.onBudget.buckets.map(bucket => bucket.group?.id)).toEqual([
      'g1',
    ]);
    expect(filtered.onBudget.buckets[0].accounts.map(a => a.name)).toEqual([
      'Premium Saver',
    ]);
  });

  it('matches a query spanning the group and account names', () => {
    const filtered = filterSidebarTree(tree, 'savings prem');

    expect(filtered.onBudget.buckets[0].accounts.map(a => a.name)).toEqual([
      'Premium Saver',
    ]);
    expect(filterSidebarTree(tree, 'checking prem').onBudget.buckets).toEqual(
      [],
    );
  });
});

describe('useSidebarAccountTree query readiness', () => {
  it('waits for placeholder accounts to resolve before treating an empty list as loaded', async () => {
    const queryClient = createTestQueryClient();
    const store = configureTestAppStore({ queryClient });

    const { result, unmount } = renderHook(
      () => ({
        tree: useSidebarAccountTree(),
        onBudgetQuery: useOnBudgetAccounts(),
        offBudgetQuery: useOffBudgetAccounts(),
      }),
      {
        wrapper: ({ children }) =>
          createElement(TestProviders, { store, queryClient, children }),
      },
    );

    expect(result.current.tree.onBudget.accountCount).toBe(0);
    expect(result.current.tree.accountsLoaded).toBe(false);
    expect(result.current.onBudgetQuery.isPlaceholderData).toBe(true);
    expect(result.current.offBudgetQuery.isPlaceholderData).toBe(true);
    expect(queryClient.getQueryState(['accounts', 'lists'])).toMatchObject({
      status: 'pending',
      fetchStatus: 'fetching',
      data: undefined,
    });

    await act(async () => {
      queryClient.setQueryData(['accounts', 'lists'], []);
    });
    await waitFor(() => expect(result.current.tree.accountsLoaded).toBe(true));
    expect(result.current.onBudgetQuery.isPlaceholderData).toBe(false);
    expect(result.current.tree.onBudget.accountCount).toBe(0);

    unmount();
    queryClient.clear();
  });
});
