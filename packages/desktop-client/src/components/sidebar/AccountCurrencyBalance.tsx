import React from 'react';
import { Trans, useTranslation } from 'react-i18next';

import type { CSSProperties } from '@actual-app/components/styles';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import {
  aggregateAccountAmountsInMainCurrency,
  roundToDisplayPrecision,
} from '@actual-app/core/shared/currency-aggregation';
import type {
  AccountAmount,
  CurrencyAggregationResult,
} from '@actual-app/core/shared/currency-aggregation';
import {
  getDisplayDecimalPlaces,
  getEffectiveAccountCurrency,
} from '@actual-app/core/shared/currency-setup';
import type { AccountEntity } from '@actual-app/core/types/models';

import { ApproxMain } from '#components/accounts/ApproxMain';
import { CellValue, CellValueText } from '#components/spreadsheet/CellValue';
import { useFormat } from '#hooks/useFormat';
import { useSyncedPrefs } from '#hooks/useSyncedPrefs';
import type { Binding, SheetFields } from '#spreadsheet';

type CurrencyFormatter = ReturnType<typeof useFormat>['forCurrency'];

type SidebarAccountBalanceProps<FieldName extends SheetFields<'account'>> = {
  binding: Binding<'account', FieldName>;
  currency?: string | null;
  approxCurrency?: string | null;
  style?: CSSProperties;
  testId?: string;
};

export function SidebarAccountBalance<
  FieldName extends SheetFields<'account'>,
>({
  binding,
  currency,
  approxCurrency,
  style,
  testId,
}: SidebarAccountBalanceProps<FieldName>) {
  const format = useFormat();
  const [prefs] = useSyncedPrefs();
  const mainCurrency = prefs.defaultCurrencyCode;
  const displayDecimalPlaces =
    prefs.hideFraction === 'true'
      ? 0
      : mainCurrency
        ? getDisplayDecimalPlaces(mainCurrency)
        : 0;

  return (
    <CellValue<'account', FieldName> binding={binding} type="financial">
      {props => {
        const displayAmount =
          typeof props.value === 'number' &&
          !!mainCurrency &&
          currency === mainCurrency
            ? roundToDisplayPrecision(props.value, displayDecimalPlaces)
            : null;
        const balance = (
          <CellValueText<'account', FieldName>
            {...props}
            currency={currency}
            {...(displayAmount !== null && {
              formatter: () =>
                format.forCurrency(displayAmount, currency, 'financial'),
            })}
            data-testid={testId ?? props.name}
            style={{ textAlign: 'right', ...style }}
          />
        );

        if (approxCurrency === undefined || typeof props.value !== 'number') {
          return balance;
        }
        return (
          <View style={{ alignItems: 'flex-end' }}>
            {balance}
            <ApproxMain
              value={props.value}
              currency={approxCurrency}
              halfEvenDisplay
            />
          </View>
        );
      }}
    </CellValue>
  );
}

export type AccountCurrencyAggregation = {
  result: CurrencyAggregationResult;
  mainCurrency: string | undefined;
  isApproximate: boolean;
  formatCurrency: CurrencyFormatter;
};

export function useAccountCurrencyAggregation(
  accounts: readonly AccountEntity[] | null,
  balances: Record<string, number | null>,
  immediateChildAccountGroups?: readonly (readonly string[])[] | null,
  amountRows?: readonly AccountAmount[] | null,
): AccountCurrencyAggregation {
  const format = useFormat();
  const [prefs] = useSyncedPrefs();
  const amounts =
    amountRows !== undefined
      ? amountRows
      : accounts === null ||
          accounts.some(account => typeof balances[account.id] !== 'number')
        ? null
        : accounts.map(account => ({
            accountId: account.id,
            amount: balances[account.id] as number,
          }));
  const result = aggregateAccountAmountsInMainCurrency(
    amounts,
    accounts ?? [],
    prefs,
    prefs.defaultCurrencyCode
      ? {
          displayDecimalPlaces: format.numberFormat.hideFraction
            ? 0
            : getDisplayDecimalPlaces(prefs.defaultCurrencyCode),
          ...(immediateChildAccountGroups != null && {
            immediateChildAccountGroups,
          }),
        }
      : undefined,
  );
  const mainCurrency = prefs.defaultCurrencyCode;

  return {
    result,
    mainCurrency,
    isApproximate:
      accounts?.some(
        account =>
          getEffectiveAccountCurrency(account.currency, prefs) !== mainCurrency,
      ) ?? false,
    formatCurrency: format.forCurrency,
  };
}

type AccountCurrencyBalanceProps =
  | {
      aggregation: AccountCurrencyAggregation;
      accounts?: never;
      balances?: never;
      amounts?: never;
      immediateChildAccountGroups?: never;
      style?: CSSProperties;
      testId?: string;
      highlightSign?: boolean;
    }
  | {
      aggregation?: never;
      accounts: readonly AccountEntity[] | null;
      balances: Record<string, number | null>;
      amounts?: readonly AccountAmount[] | null;
      immediateChildAccountGroups?: readonly (readonly string[])[] | null;
      style?: CSSProperties;
      testId?: string;
      highlightSign?: boolean;
    };

export function AccountCurrencyBalance(props: AccountCurrencyBalanceProps) {
  const computedAggregation = useAccountCurrencyAggregation(
    'aggregation' in props ? null : props.accounts,
    'aggregation' in props ? {} : props.balances,
    'aggregation' in props ? undefined : props.immediateChildAccountGroups,
    'aggregation' in props ? undefined : props.amounts,
  );
  const aggregation =
    'aggregation' in props ? props.aggregation : computedAggregation;
  const { t } = useTranslation();
  const { result, mainCurrency, isApproximate, formatCurrency } = aggregation;
  const { style, testId } = props;
  const highlightSign = props.highlightSign ?? false;

  if (result.status === 'loading') {
    return (
      <Text
        role="status"
        aria-label={t('Loading...')}
        data-testid={testId}
        style={{ textAlign: 'right', ...style }}
      >
        {t('Loading...')}
      </Text>
    );
  }

  if (result.status === 'unavailable' || !mainCurrency) {
    return (
      <Text
        role="status"
        data-testid={testId}
        style={{ textAlign: 'right', ...style }}
      >
        {result.status === 'unavailable' && result.unavailableCurrency
          ? `(${t('no rate')}: ${result.unavailableCurrency})`
          : t('N/A')}
      </Text>
    );
  }

  const balanceColor =
    result.amount < 0
      ? theme.numberNegative
      : result.amount > 0
        ? theme.numberPositive
        : theme.pageTextSubdued;

  const balanceTestId = testId ?? 'sidebar-account-currency-balance';

  return (
    <View style={{ alignItems: 'flex-end' }}>
      <CellValueText<'account', 'balance'>
        name={balanceTestId}
        value={result.amount}
        type="financial"
        style={{
          textAlign: 'right',
          ...(highlightSign && { color: balanceColor }),
          ...style,
        }}
        formatter={amount =>
          `${isApproximate ? '~ ' : ''}${formatCurrency(
            result.displayAmount ?? amount,
            mainCurrency,
          )}`
        }
      />
    </View>
  );
}

type AccountCurrencyAdjustmentProps = {
  aggregation: AccountCurrencyAggregation;
  testId: string;
  style?: CSSProperties;
};

export function AccountCurrencyAdjustment({
  aggregation,
  testId,
  style,
}: AccountCurrencyAdjustmentProps) {
  const { t } = useTranslation();
  const { result, mainCurrency, isApproximate, formatCurrency } = aggregation;
  if (
    result.status !== 'complete' ||
    !result.presentationAdjustment ||
    !mainCurrency
  ) {
    return null;
  }

  const adjustment = result.presentationAdjustment;
  const amount = formatCurrency(
    adjustment.amount,
    mainCurrency,
    'financial-with-sign',
  );

  return (
    <View
      role="status"
      aria-label={t('Rounding adjustment')}
      data-testid={`${testId}-adjustment`}
      style={{
        flexDirection: 'row',
        justifyContent: 'flex-end',
        alignItems: 'center',
        gap: 4,
        ...style,
      }}
    >
      <Text style={{ fontSize: 10 }}>
        <Trans>Rounding adjustment</Trans>
      </Text>
      <CellValueText<'account', 'balance'>
        name={`${testId}-adjustment-value`}
        value={adjustment.amount}
        type="financial-with-sign"
        style={{ fontSize: 10, textAlign: 'right' }}
        formatter={() => `${isApproximate ? '~ ' : ''}${amount}`}
      />
    </View>
  );
}
