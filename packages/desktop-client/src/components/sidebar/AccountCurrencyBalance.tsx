import React from 'react';
import { Trans, useTranslation } from 'react-i18next';

import type { CSSProperties } from '@actual-app/components/styles';
import { Text } from '@actual-app/components/text';
import { View } from '@actual-app/components/view';
import { aggregateAccountAmountsInMainCurrency } from '@actual-app/core/shared/currency-aggregation';
import {
  getDisplayDecimalPlaces,
  getEffectiveAccountCurrency,
} from '@actual-app/core/shared/currency-setup';
import type { AccountEntity } from '@actual-app/core/types/models';

import { CellValueText } from '#components/spreadsheet/CellValue';
import { useFormat } from '#hooks/useFormat';
import { useSyncedPrefs } from '#hooks/useSyncedPrefs';

type AccountCurrencyBalanceProps = {
  accounts: readonly AccountEntity[] | null;
  balances: Record<string, number | null>;
  style?: CSSProperties;
  testId?: string;
  immediateChildAccountGroups?: readonly (readonly string[])[] | null;
};

export function AccountCurrencyBalance({
  accounts,
  balances,
  style,
  testId,
  immediateChildAccountGroups,
}: AccountCurrencyBalanceProps) {
  const { t } = useTranslation();
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
    immediateChildAccountGroups != null && prefs.defaultCurrencyCode
      ? {
          displayDecimalPlaces: format.numberFormat.hideFraction
            ? 0
            : getDisplayDecimalPlaces(prefs.defaultCurrencyCode),
          immediateChildAccountGroups,
        }
      : undefined,
  );
  const mainCurrency = prefs.defaultCurrencyCode;

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

  const isApproximate =
    accounts?.some(
      account =>
        getEffectiveAccountCurrency(account.currency, prefs) !== mainCurrency,
    ) ?? false;

  const balanceTestId = testId ?? 'sidebar-account-currency-balance';

  return (
    <View style={{ alignItems: 'flex-end' }}>
      <CellValueText<'account', 'balance'>
        name={balanceTestId}
        value={result.amount}
        type="financial"
        style={{ textAlign: 'right', ...style }}
        formatter={amount =>
          `${isApproximate ? '~ ' : ''}${format.forCurrency(amount, mainCurrency)}`
        }
      />
      {result.presentationAdjustment && (
        <View
          data-testid={`${balanceTestId}-adjustment`}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
        >
          <Text style={{ fontSize: 10 }}>
            <Trans>Rounding adjustment</Trans>
          </Text>
          <CellValueText<'account', 'balance'>
            name={`${balanceTestId}-adjustment-value`}
            value={result.presentationAdjustment.amount}
            type="financial-with-sign"
            style={{ fontSize: 10, textAlign: 'right' }}
            formatter={amount =>
              `${isApproximate ? '~ ' : ''}${format.forCurrency(
                amount,
                mainCurrency,
                'financial-with-sign',
              )}`
            }
          />
        </View>
      )}
    </View>
  );
}
