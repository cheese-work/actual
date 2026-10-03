import React, { useRef } from 'react';
import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { SvgArrowButtonRight1 } from '@actual-app/components/icons/v2';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { aggregateAccountAmountsInMainCurrency } from '@actual-app/core/shared/currency-aggregation';
import type { AccountAmount } from '@actual-app/core/shared/currency-aggregation';
import { getEffectiveAccountCurrency } from '@actual-app/core/shared/currency-setup';
import { q } from '@actual-app/core/shared/query';
import type { Query } from '@actual-app/core/shared/query';
import { getScheduledAmount } from '@actual-app/core/shared/schedules';
import { isPreviewId } from '@actual-app/core/shared/transactions';
import type { AccountEntity } from '@actual-app/core/types/models';
import { useHover } from 'usehooks-ts';

import { FinancialText } from '#components/FinancialText';
import { PrivacyFilter } from '#components/PrivacyFilter';
import { AccountCurrencyBalance } from '#components/sidebar/AccountCurrencyBalance';
import { CellValue, CellValueText } from '#components/spreadsheet/CellValue';
import { useCachedSchedules } from '#hooks/useCachedSchedules';
import { useEffectiveAccountCurrency } from '#hooks/useEffectiveAccountCurrency';
import { useFormat } from '#hooks/useFormat';
import { useSelectedItems } from '#hooks/useSelected';
import { useSheetValue } from '#hooks/useSheetValue';
import { useSyncedPrefs } from '#hooks/useSyncedPrefs';
import type { Binding } from '#spreadsheet';

import { ApproxMain } from './ApproxMain';

type DetailedBalanceProps = {
  name: string;
  balance: number | null;
  message?: string;
  isExactBalance?: boolean;
  currency?: string | null;
};

function DetailedBalance({
  name,
  balance,
  message,
  isExactBalance = true,
  currency,
}: DetailedBalanceProps) {
  const { t } = useTranslation();
  const format = useFormat();
  return (
    <Text
      role={message ? 'status' : undefined}
      style={{
        borderRadius: 4,
        padding: '4px 6px',
        color: theme.pillText,
        backgroundColor: theme.pillBackground,
      }}
    >
      {name}{' '}
      <PrivacyFilter>
        <FinancialText style={{ fontWeight: 600 }}>
          {message ?? (
            <>
              {balance !== null && !isExactBalance && '~ '}
              {balance === null
                ? t('N/A')
                : format.forCurrency(balance, currency)}
            </>
          )}
        </FinancialText>
      </PrivacyFilter>
    </Text>
  );
}

function AggregateDetailedBalance({
  name,
  accounts,
  amounts,
  isExactBalance = true,
}: {
  name: string;
  accounts: readonly AccountEntity[];
  amounts: readonly AccountAmount[] | null;
  isExactBalance?: boolean;
}) {
  const { t } = useTranslation();
  const [prefs] = useSyncedPrefs();
  const result = aggregateAccountAmountsInMainCurrency(
    amounts,
    accounts,
    prefs,
  );

  if (result.status === 'loading') {
    return (
      <DetailedBalance name={name} balance={null} message={t('Loading...')} />
    );
  }
  if (result.status === 'unavailable') {
    return (
      <DetailedBalance
        name={name}
        balance={null}
        message={
          result.unavailableCurrency
            ? `(${t('no rate')}: ${result.unavailableCurrency})`
            : t('N/A')
        }
      />
    );
  }

  const mainCurrency = prefs.defaultCurrencyCode;
  const isApproximate = accounts.some(
    account =>
      getEffectiveAccountCurrency(account.currency, prefs) !== mainCurrency,
  );

  return (
    <DetailedBalance
      name={name}
      balance={result.amount}
      isExactBalance={isExactBalance && !isApproximate}
      currency={mainCurrency}
    />
  );
}

function toAccountAmounts(
  rows: readonly { account: string; amount: number }[] | null,
): AccountAmount[] | null {
  return (
    rows?.map(({ account, amount }) => ({
      accountId: account,
      amount,
    })) ?? null
  );
}

type SelectedBalanceProps = {
  selectedItems: Set<string>;
  account?: AccountEntity;
  accounts?: readonly AccountEntity[];
  currency?: string | null;
};

export function SelectedBalance(props: SelectedBalanceProps) {
  return props.accounts ? (
    <AggregateSelectedBalance
      selectedItems={props.selectedItems}
      accounts={props.accounts}
    />
  ) : (
    <NativeSelectedBalance
      selectedItems={props.selectedItems}
      account={props.account}
      currency={props.currency}
    />
  );
}

function AggregateSelectedBalance({
  selectedItems,
  accounts,
}: {
  selectedItems: Set<string>;
  accounts: readonly AccountEntity[];
}) {
  const { t } = useTranslation();

  const name = `selected-balance-${[...selectedItems].join('-')}`;

  const rows = useSheetValue<'balance', `selected-transactions-${string}`>({
    name: name as `selected-transactions-${string}`,
    query: q('transactions')
      .filter({
        id: { $oneof: [...selectedItems] },
        parent_id: { $oneof: [...selectedItems] },
      })
      .select('id'),
  });
  const ids = new Set((rows || []).map((r: { id: string }) => r.id));

  const finalIds = [...selectedItems].filter(id => !ids.has(id));
  const selectedAmounts = useSheetValue<'balance', `account-amounts-${string}`>(
    {
      name: `${name}-amounts` as `account-amounts-${string}`,
      query: q('transactions')
        .filter({ id: { $oneof: finalIds } })
        .options({ splits: 'all' })
        .select(['account', 'amount']),
    },
  );

  const scheduleAmounts: AccountAmount[] = [];
  const { isLoading, schedules = [] } = useCachedSchedules();

  if (isLoading || selectedAmounts === null) {
    return (
      <AggregateDetailedBalance
        name={t('Selected balance:')}
        accounts={accounts}
        amounts={null}
      />
    );
  }

  let isExactBalance = true;

  for (const id of [...selectedItems].filter(isPreviewId)) {
    // Preview IDs are in the format `preview/<schedule_id>/<date>`
    const scheduleId = id.slice(8).split('/')[0];
    const schedule = schedules.find(s => s.id === scheduleId);
    if (schedule) {
      // If a schedule is `between X and Y` then we calculate the average
      if (schedule._amountOp === 'isbetween') {
        isExactBalance = false;
      }

      if (
        accounts.some(({ id: accountId }) => accountId === schedule._account)
      ) {
        scheduleAmounts.push({
          accountId: schedule._account,
          amount: getScheduledAmount(schedule._amount),
        });
      }
    }
  }

  const accountIds = new Set(accounts.map(({ id }) => id));
  return (
    <AggregateDetailedBalance
      name={t('Selected balance:')}
      accounts={accounts}
      amounts={[
        ...(toAccountAmounts(selectedAmounts)?.filter(({ accountId }) =>
          accountIds.has(accountId),
        ) ?? []),
        ...scheduleAmounts,
      ]}
      isExactBalance={isExactBalance}
    />
  );
}

function NativeSelectedBalance({
  selectedItems,
  account,
  currency,
}: Pick<SelectedBalanceProps, 'selectedItems' | 'account' | 'currency'>) {
  const { t } = useTranslation();
  const name = `selected-balance-${[...selectedItems].join('-')}`;
  const rows = useSheetValue<'balance', `selected-transactions-${string}`>({
    name: name as `selected-transactions-${string}`,
    query: q('transactions')
      .filter({
        id: { $oneof: [...selectedItems] },
        parent_id: { $oneof: [...selectedItems] },
      })
      .select('id'),
  });
  const ids = new Set((rows || []).map((r: { id: string }) => r.id));
  const finalIds = [...selectedItems].filter(id => !ids.has(id));
  let balance = useSheetValue<'balance', `selected-balance-${string}`>({
    name: (name + '-sum') as `selected-balance-${string}`,
    query: q('transactions')
      .filter({ id: { $oneof: finalIds } })
      .options({ splits: 'all' })
      .calculate({ $sum: '$amount' }),
  });

  let scheduleBalance = 0;
  const { isLoading, schedules = [] } = useCachedSchedules();

  if (isLoading) {
    return null;
  }

  let isExactBalance = true;

  for (const id of [...selectedItems].filter(isPreviewId)) {
    const scheduleId = id.slice(8).split('/')[0];
    const schedule = schedules.find(s => s.id === scheduleId);
    if (schedule) {
      if (schedule._amountOp === 'isbetween') {
        isExactBalance = false;
      }

      if (!account || account.id === schedule._account) {
        scheduleBalance += getScheduledAmount(schedule._amount);
      } else {
        scheduleBalance -= getScheduledAmount(schedule._amount);
      }
    }
  }

  if (typeof balance !== 'number' && !scheduleBalance) {
    return null;
  } else {
    balance = (balance ?? 0) + scheduleBalance;
  }

  return (
    <DetailedBalance
      name={t('Selected balance:')}
      balance={balance}
      isExactBalance={isExactBalance}
      currency={currency}
    />
  );
}

type FilteredBalanceProps = {
  filteredAmount?: number | AccountAmount[] | null;
  accounts?: readonly AccountEntity[];
  currency?: string | null;
};

function FilteredBalance({
  filteredAmount,
  accounts,
  currency,
}: FilteredBalanceProps) {
  const { t } = useTranslation();

  if (accounts) {
    return (
      <AggregateDetailedBalance
        name={t('Filtered balance:')}
        accounts={accounts}
        amounts={Array.isArray(filteredAmount) ? filteredAmount : null}
      />
    );
  }

  return (
    <DetailedBalance
      name={t('Filtered balance:')}
      balance={typeof filteredAmount === 'number' ? filteredAmount : 0}
      isExactBalance
      currency={currency}
    />
  );
}

type MoreBalancesProps = {
  balanceQuery: { name: `balance-query-${string}`; query: Query };
  accounts?: readonly AccountEntity[];
  currency?: string | null;
};

function MoreBalances({ balanceQuery, accounts, currency }: MoreBalancesProps) {
  if (accounts) {
    return (
      <AggregateMoreBalances balanceQuery={balanceQuery} accounts={accounts} />
    );
  }

  return <NativeMoreBalances balanceQuery={balanceQuery} currency={currency} />;
}

function NativeMoreBalances({
  balanceQuery,
  currency,
}: Omit<MoreBalancesProps, 'accounts'>) {
  const { t } = useTranslation();

  const cleared = useSheetValue<'balance', `balance-query-${string}-cleared`>({
    name: (balanceQuery.name + '-cleared') as `balance-query-${string}-cleared`,
    query: balanceQuery.query.filter({ cleared: true }),
  });
  const uncleared = useSheetValue<
    'balance',
    `balance-query-${string}-uncleared`
  >({
    name: (balanceQuery.name +
      '-uncleared') as `balance-query-${string}-uncleared`,
    query: balanceQuery.query.filter({ cleared: false }),
  });

  return (
    <>
      <DetailedBalance
        name={t('Cleared total:')}
        balance={cleared ?? 0}
        currency={currency}
      />
      <DetailedBalance
        name={t('Uncleared total:')}
        balance={uncleared ?? 0}
        currency={currency}
      />
    </>
  );
}

function AggregateMoreBalances({
  balanceQuery,
  accounts,
}: Required<Pick<MoreBalancesProps, 'balanceQuery' | 'accounts'>>) {
  const { t } = useTranslation();
  const cleared = useSheetValue<'balance', `account-amounts-${string}`>({
    name: `${balanceQuery.name}-cleared-amounts` as `account-amounts-${string}`,
    query: balanceQuery.query
      .filter({ cleared: true })
      .select(['account', 'amount']),
  });
  const uncleared = useSheetValue<'balance', `account-amounts-${string}`>({
    name: `${balanceQuery.name}-uncleared-amounts` as `account-amounts-${string}`,
    query: balanceQuery.query
      .filter({ cleared: false })
      .select(['account', 'amount']),
  });

  return (
    <>
      <AggregateDetailedBalance
        name={t('Cleared total:')}
        accounts={accounts}
        amounts={toAccountAmounts(cleared)}
      />
      <AggregateDetailedBalance
        name={t('Uncleared total:')}
        accounts={accounts}
        amounts={toAccountAmounts(uncleared)}
      />
    </>
  );
}

type BalancesProps = {
  balanceQuery: { name: `balance-query-${string}`; query: Query };
  accountAmountsQuery: Query;
  aggregateAccounts?: AccountEntity[];
  showExtraBalances: boolean;
  onToggleExtraBalances: () => void;
  account?: AccountEntity;
  isFiltered: boolean;
  filteredAmount?: number | AccountAmount[] | null;
};

function AggregateBalanceValue({
  balanceQuery,
  accountAmountsQuery,
  accounts,
}: {
  balanceQuery: BalancesProps['balanceQuery'];
  accountAmountsQuery: Query;
  accounts: AccountEntity[];
}) {
  const accountAmounts = useSheetValue<'balance', `account-amounts-${string}`>({
    name: `${balanceQuery.name}-amounts` as `account-amounts-${string}`,
    query: accountAmountsQuery.select(['account', 'amount']),
  });

  return (
    <AccountCurrencyBalance
      accounts={accounts}
      balances={{}}
      amounts={toAccountAmounts(accountAmounts)}
      testId="account-balance"
      highlightSign
      style={{ fontSize: 22, fontWeight: 400 }}
    />
  );
}

export function Balances({
  balanceQuery,
  accountAmountsQuery,
  aggregateAccounts,
  showExtraBalances,
  onToggleExtraBalances,
  account,
  isFiltered,
  filteredAmount,
}: BalancesProps) {
  const selectedItems = useSelectedItems();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const isButtonHovered = useHover(buttonRef as RefObject<HTMLButtonElement>);
  const accountCurrency = useEffectiveAccountCurrency(account?.currency);

  return (
    <View
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        marginTop: -5,
        marginLeft: -5,
        gap: 10,
      }}
    >
      <Button
        ref={buttonRef}
        data-testid="account-balance"
        variant="bare"
        onPress={onToggleExtraBalances}
        style={{
          paddingTop: 1,
          paddingBottom: 1,
        }}
      >
        {aggregateAccounts ? (
          <AggregateBalanceValue
            balanceQuery={balanceQuery}
            accountAmountsQuery={accountAmountsQuery}
            accounts={aggregateAccounts}
          />
        ) : (
          <CellValue
            binding={
              { ...balanceQuery, value: 0 } as Binding<
                'balance',
                `balance-query-${string}`
              >
            }
            type="financial"
          >
            {props => (
              <>
                <CellValueText
                  {...props}
                  currency={accountCurrency}
                  style={{
                    fontSize: 22,
                    fontWeight: 400,
                    color:
                      props.value < 0
                        ? theme.numberNegative
                        : props.value > 0
                          ? theme.numberPositive
                          : theme.pageTextSubdued,
                  }}
                />
                <ApproxMain value={props.value} currency={account?.currency} />
              </>
            )}
          </CellValue>
        )}

        <SvgArrowButtonRight1
          style={{
            width: 10,
            height: 10,
            marginLeft: 10,
            color: theme.pillText,
            transform: showExtraBalances ? 'rotateZ(180deg)' : 'rotateZ(0)',
            opacity:
              isButtonHovered || selectedItems.size > 0 || showExtraBalances
                ? 1
                : 0,
          }}
        />
      </Button>

      {showExtraBalances && (
        <MoreBalances
          balanceQuery={balanceQuery}
          accounts={aggregateAccounts}
          currency={accountCurrency}
        />
      )}

      {selectedItems.size > 0 && (
        <SelectedBalance
          selectedItems={selectedItems}
          account={account}
          accounts={aggregateAccounts}
          currency={accountCurrency}
        />
      )}
      {isFiltered && (
        <FilteredBalance
          filteredAmount={filteredAmount}
          accounts={aggregateAccounts}
          currency={accountCurrency}
        />
      )}
    </View>
  );
}
