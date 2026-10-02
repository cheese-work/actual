import React from 'react';
import { useTranslation } from 'react-i18next';

import type { CSSProperties } from '@actual-app/components/styles';
import { Text } from '@actual-app/components/text';
import { aggregateAccountAmountsInMainCurrency } from '@actual-app/core/shared/currency-aggregation';
import { getEffectiveAccountCurrency } from '@actual-app/core/shared/currency-setup';
import type { AccountEntity } from '@actual-app/core/types/models';

import { CellValueText } from '#components/spreadsheet/CellValue';
import { useFormat } from '#hooks/useFormat';
import { useSyncedPrefs } from '#hooks/useSyncedPrefs';

type AccountCurrencyBalanceProps = {
  accounts: readonly AccountEntity[] | null;
  balances: Record<string, number | null>;
  style?: CSSProperties;
  testId?: string;
};

export function AccountCurrencyBalance({
  accounts,
  balances,
  style,
  testId,
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

  return (
    <CellValueText<'account', 'balance'>
      name={testId ?? 'sidebar-account-currency-balance'}
      value={result.amount}
      type="financial"
      style={{ textAlign: 'right', ...style }}
      formatter={amount =>
        `${isApproximate ? '~ ' : ''}${format.forCurrency(amount, mainCurrency)}`
      }
    />
  );
}
