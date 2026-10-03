import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import type { AccountEntity } from '@actual-app/core/types/models';

import { useMoveAccountMutation } from '#accounts';
import { isAccountFailedSync } from '#accounts/syncStatus';
import { useAccountBalances } from '#hooks/useAccountBalances';
import { useAccounts } from '#hooks/useAccounts';
import { useClosedAccounts } from '#hooks/useClosedAccounts';
import { useLocalPref } from '#hooks/useLocalPref';
import { useOffBudgetAccounts } from '#hooks/useOffBudgetAccounts';
import { useOnBudgetAccounts } from '#hooks/useOnBudgetAccounts';
import { useUpdatedAccounts } from '#hooks/useUpdatedAccounts';
import { useSelector } from '#redux';
import * as bindings from '#spreadsheet/bindings';

import { Account } from './Account';
import {
  AccountCurrencyAdjustment,
  useAccountCurrencyAggregation,
} from './AccountCurrencyBalance';
import { SecondaryItem } from './SecondaryItem';

const fontWeight = 600;

export function Accounts() {
  const { t } = useTranslation();
  const [isDragging, setIsDragging] = useState(false);
  const { data: accounts = [] } = useAccounts();
  const updatedAccounts = useUpdatedAccounts();
  const offBudgetAccountsQuery = useOffBudgetAccounts();
  const onBudgetAccountsQuery = useOnBudgetAccounts();
  const offbudgetAccounts = offBudgetAccountsQuery.data ?? [];
  const onBudgetAccounts = onBudgetAccountsQuery.data ?? [];
  const aggregateAccounts =
    offBudgetAccountsQuery.data === undefined ||
    offBudgetAccountsQuery.isPlaceholderData ||
    onBudgetAccountsQuery.data === undefined ||
    onBudgetAccountsQuery.isPlaceholderData
      ? null
      : [...onBudgetAccountsQuery.data, ...offBudgetAccountsQuery.data];
  const accountBalances = useAccountBalances(
    [...onBudgetAccounts, ...offbudgetAccounts].map(account => account.id),
  );
  const allImmediateChildAccountGroups = [
    ...(onBudgetAccounts.length > 0
      ? [onBudgetAccounts.map(account => account.id)]
      : []),
    ...(offbudgetAccounts.length > 0
      ? [offbudgetAccounts.map(account => account.id)]
      : []),
  ];
  const allCurrencyAggregation = useAccountCurrencyAggregation(
    aggregateAccounts,
    accountBalances,
    allImmediateChildAccountGroups,
  );
  const onBudgetCurrencyAggregation = useAccountCurrencyAggregation(
    onBudgetAccountsQuery.isPlaceholderData
      ? null
      : (onBudgetAccountsQuery.data ?? null),
    accountBalances,
    onBudgetAccounts.map(account => [account.id]),
  );
  const offBudgetCurrencyAggregation = useAccountCurrencyAggregation(
    offBudgetAccountsQuery.isPlaceholderData
      ? null
      : (offBudgetAccountsQuery.data ?? null),
    accountBalances,
    offbudgetAccounts.map(account => [account.id]),
  );
  const { data: closedAccounts = [] } = useClosedAccounts();
  const syncingAccountIds = useSelector(state => state.account.accountsSyncing);

  const getAccountPath = (account: AccountEntity) => `/accounts/${account.id}`;

  const [showClosedAccounts, setShowClosedAccountsPref] = useLocalPref(
    'ui.showClosedAccounts',
  );

  function onDragChange(drag: { state: string }) {
    setIsDragging(drag.state === 'start');
  }

  const moveAccount = useMoveAccountMutation();

  const makeDropPadding = (i: number) => {
    if (i === 0) {
      return {
        paddingTop: isDragging ? 15 : 0,
        marginTop: isDragging ? -15 : 0,
      };
    }
    return undefined;
  };

  async function onReorder(
    id: string,
    dropPos: 'top' | 'bottom' | null,
    targetId: string,
  ) {
    let targetIdToMove: string | null = targetId;
    if (dropPos === 'bottom') {
      const idx = accounts.findIndex(a => a.id === targetId) + 1;
      targetIdToMove = idx < accounts.length ? accounts[idx].id : null;
    }

    moveAccount.mutate({ id, targetId: targetIdToMove });
  }

  const onToggleClosedAccounts = () => {
    setShowClosedAccountsPref(!showClosedAccounts);
  };

  return (
    <View
      style={{
        flexGrow: 1,
        '@media screen and (max-height: 480px)': {
          minHeight: 'auto',
        },
      }}
    >
      <View
        style={{
          height: 1,
          backgroundColor: theme.sidebarItemBackgroundHover,
          marginTop: 15,
          flexShrink: 0,
        }}
      />

      <View style={{ overflow: 'auto' }}>
        <Account
          name={t('All accounts')}
          to="/accounts"
          query={bindings.allAccountBalance()}
          style={{ fontWeight, marginTop: 15 }}
          isExactPathMatch
          balanceTestId="sidebar-all-accounts-balance"
          currencyAggregation={allCurrencyAggregation}
        />

        {onBudgetAccounts.length > 0 && (
          <Account
            name={t('On budget')}
            to="/accounts/onbudget"
            query={bindings.onBudgetAccountBalance()}
            style={{
              fontWeight,
              marginTop: 13,
              marginBottom: 5,
            }}
            titleAccount
            balanceTestId="sidebar-on-budget-balance"
            currencyAggregation={onBudgetCurrencyAggregation}
          />
        )}

        {onBudgetAccounts.map((account, i) => (
          <Account
            key={account.id}
            name={account.name}
            account={account}
            connected={!!account.bank}
            pending={syncingAccountIds.includes(account.id)}
            failed={isAccountFailedSync(account)}
            updated={updatedAccounts.includes(account.id)}
            to={getAccountPath(account)}
            query={bindings.accountBalance(account.id)}
            onDragChange={onDragChange}
            onDrop={onReorder}
            outerStyle={makeDropPadding(i)}
          />
        ))}
        <AccountCurrencyAdjustment
          aggregation={onBudgetCurrencyAggregation}
          testId="sidebar-on-budget-balance"
          style={{ paddingLeft: 35, paddingRight: 8 }}
        />

        {offbudgetAccounts.length > 0 && (
          <Account
            name={t('Off budget')}
            to="/accounts/offbudget"
            query={bindings.offBudgetAccountBalance()}
            style={{
              fontWeight,
              marginTop: 13,
              marginBottom: 5,
            }}
            titleAccount
            balanceTestId="sidebar-off-budget-balance"
            currencyAggregation={offBudgetCurrencyAggregation}
          />
        )}

        {offbudgetAccounts.map((account, i) => (
          <Account
            key={account.id}
            name={account.name}
            account={account}
            connected={!!account.bank}
            pending={syncingAccountIds.includes(account.id)}
            failed={isAccountFailedSync(account)}
            updated={updatedAccounts.includes(account.id)}
            to={getAccountPath(account)}
            query={bindings.accountBalance(account.id)}
            onDragChange={onDragChange}
            onDrop={onReorder}
            outerStyle={makeDropPadding(i)}
          />
        ))}
        <AccountCurrencyAdjustment
          aggregation={offBudgetCurrencyAggregation}
          testId="sidebar-off-budget-balance"
          style={{ paddingLeft: 35, paddingRight: 8 }}
        />
        <AccountCurrencyAdjustment
          aggregation={allCurrencyAggregation}
          testId="sidebar-all-accounts-balance"
          style={{ paddingLeft: 35, paddingRight: 8 }}
        />

        {closedAccounts.length > 0 && (
          <SecondaryItem
            style={{ marginTop: 15 }}
            title={
              showClosedAccounts
                ? t('Closed accounts')
                : t('Closed accounts...')
            }
            onClick={onToggleClosedAccounts}
            bold
          />
        )}

        {showClosedAccounts &&
          closedAccounts.map(account => (
            <Account
              key={account.id}
              name={account.name}
              account={account}
              to={getAccountPath(account)}
              query={bindings.accountBalance(account.id)}
              onDragChange={onDragChange}
              onDrop={onReorder}
            />
          ))}
      </View>
    </View>
  );
}
