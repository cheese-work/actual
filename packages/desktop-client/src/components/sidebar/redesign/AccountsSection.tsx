import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { spacing } from '@actual-app/components/tokens';
import { View } from '@actual-app/components/view';

import {
  AccountCurrencyAdjustment,
  useAccountCurrencyAggregation,
} from '#components/sidebar/AccountCurrencyBalance';
import { useAccountBalances } from '#hooks/useAccountBalances';
import * as bindings from '#spreadsheet/bindings';

import { AccountSearchField } from './AccountSearchField';
import { AccountsHeaderRow } from './AccountsHeaderRow';
import { ClosedSection } from './ClosedSection';
import { SideGroup } from './SideGroup';
import {
  filterSidebarTree,
  useSidebarAccountTree,
} from './useSidebarAccountTree';
import { bucketKey, useSidebarCollapseState } from './useSidebarCollapseState';

export function AccountsSection() {
  const { t } = useTranslation();
  const tree = useSidebarAccountTree();
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const trimmedQuery = query.trim().toLowerCase();
  const isSearching = trimmedQuery !== '';

  const collapse = useSidebarCollapseState({ tree, isSearching });

  const onToggleSearch = () => {
    setIsSearchOpen(!isSearchOpen);
    setQuery('');
  };

  const visibleTree = filterSidebarTree(tree, trimmedQuery);
  const trackedAccounts = [
    ...tree.onBudget.buckets.flatMap(bucket => bucket.accounts),
    ...tree.offBudget.buckets.flatMap(bucket => bucket.accounts),
  ];
  const accountBalances = useAccountBalances(
    trackedAccounts.map(account => account.id),
  );
  const allAccounts = tree.accountsLoaded ? trackedAccounts : null;
  const allImmediateChildAccountGroups = [
    ...(tree.onBudget.accountCount > 0
      ? [
          tree.onBudget.buckets.flatMap(bucket =>
            bucket.accounts.map(account => account.id),
          ),
        ]
      : []),
    ...(tree.offBudget.accountCount > 0
      ? [
          tree.offBudget.buckets.flatMap(bucket =>
            bucket.accounts.map(account => account.id),
          ),
        ]
      : []),
  ];
  const allCurrencyAggregation = useAccountCurrencyAggregation(
    allAccounts,
    accountBalances,
    allImmediateChildAccountGroups,
  );

  const showSyncDot = [
    ...tree.onBudget.buckets.map(b => b.accounts).flat(),
    ...tree.offBudget.buckets.map(b => b.accounts).flat(),
  ].reduce((seen, account) => seen || account.bank !== null, false);

  return (
    <View
      style={{
        flexGrow: 1,
        minHeight: 0,
        overflowY: 'auto',
        paddingInline: spacing.sm,
      }}
    >
      <View style={{ flexShrink: 0 }}>
        <AccountsHeaderRow
          allOpen={collapse.allOpen}
          onToggleAll={collapse.toggleAll}
          isToggleAllDisabled={isSearching}
          isSearchOpen={isSearchOpen}
          onToggleSearch={onToggleSearch}
          aggregation={allCurrencyAggregation}
        />
        {isSearchOpen && (
          <AccountSearchField
            value={query}
            onChange={setQuery}
            onClose={onToggleSearch}
          />
        )}
        {tree.onBudget.buckets.length > 0 && (
          <SideGroup
            label={t('On budget')}
            side="on"
            isDragDisabled={isSearching}
            showSyncDot={showSyncDot}
            sideData={visibleTree.onBudget}
            fullSideData={tree.onBudget}
            aggregateBalances={accountBalances}
            isSearching={isSearching}
            totalBinding={bindings.onBudgetAccountBalance()}
            balanceTestId="sidebar-on-budget-balance"
            isOpen={collapse.isOpen('onbudget')}
            onToggle={() => collapse.toggle('onbudget')}
            isBucketOpen={bucket => collapse.isOpen(bucketKey('on', bucket))}
            onToggleBucket={bucket => collapse.toggle(bucketKey('on', bucket))}
          />
        )}
        {tree.offBudget.buckets.length > 0 && (
          <SideGroup
            label={t('Off budget')}
            side="off"
            isDragDisabled={isSearching}
            showSyncDot={showSyncDot}
            sideData={visibleTree.offBudget}
            fullSideData={tree.offBudget}
            aggregateBalances={accountBalances}
            isSearching={isSearching}
            totalBinding={bindings.offBudgetAccountBalance()}
            balanceTestId="sidebar-off-budget-balance"
            isOpen={collapse.isOpen('offbudget')}
            onToggle={() => collapse.toggle('offbudget')}
            isBucketOpen={bucket => collapse.isOpen(bucketKey('off', bucket))}
            onToggleBucket={bucket => collapse.toggle(bucketKey('off', bucket))}
          />
        )}
        <AccountCurrencyAdjustment
          aggregation={allCurrencyAggregation}
          testId="sidebar-all-accounts-balance"
          style={{ paddingInline: spacing.md }}
        />
        <ClosedSection
          accounts={visibleTree.closed}
          isOpen={collapse.isOpen('closed')}
          onToggle={() => collapse.toggle('closed')}
          isDragDisabled={isSearching}
        />
        <View style={{ height: spacing.md }} />
      </View>
    </View>
  );
}
