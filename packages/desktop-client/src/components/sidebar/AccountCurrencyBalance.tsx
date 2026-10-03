import React from 'react';
import { Trans, useTranslation } from 'react-i18next';

import type { CSSProperties } from '@actual-app/components/styles';
import { Text } from '@actual-app/components/text';
import { View } from '@actual-app/components/view';
import { aggregateAccountAmountsInMainCurrency } from '@actual-app/core/shared/currency-aggregation';
import type { CurrencyAggregationResult } from '@actual-app/core/shared/currency-aggregation';
import {
  getDisplayDecimalPlaces,
  getEffectiveAccountCurrency,
} from '@actual-app/core/shared/currency-setup';
import type { AccountEntity } from '@actual-app/core/types/models';

import { CellValueText } from '#components/spreadsheet/CellValue';
import { useFormat } from '#hooks/useFormat';
import { useSyncedPrefs } from '#hooks/useSyncedPrefs';

type CurrencyFormatter = ReturnType<typeof useFormat>['forCurrency'];

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
): AccountCurrencyAggregation {
  const format = useFormat();
  const [prefs] = useSyncedPrefs();
  const amounts =
    accounts === null ||
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

type AccountCurrencyBalanceProps = {
  aggregation: AccountCurrencyAggregation;
  style?: CSSProperties;
  testId?: string;
};

export function AccountCurrencyBalance({
  aggregation,
  style,
  testId,
}: AccountCurrencyBalanceProps) {
  const { t } = useTranslation();
  const { result, mainCurrency, isApproximate, formatCurrency } = aggregation;

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

  const balanceTestId = testId ?? 'sidebar-account-currency-balance';

  return (
    <View style={{ alignItems: 'flex-end' }}>
      <CellValueText<'account', 'balance'>
        name={balanceTestId}
        value={result.amount}
        type="financial"
        style={{ textAlign: 'right', ...style }}
        formatter={() =>
          `${isApproximate ? '~ ' : ''}${formatCurrency(
            result.displayAmount ?? result.amount,
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
