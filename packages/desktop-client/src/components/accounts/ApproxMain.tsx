import React from 'react';
import { useTranslation } from 'react-i18next';

import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { getEffectiveAccountCurrency } from '@actual-app/core/shared/currency-setup';
import { convert } from '@actual-app/core/shared/exchange-rates';

import { FinancialText } from '#components/FinancialText';
import { PrivacyFilter } from '#components/PrivacyFilter';
import { useFormat } from '#hooks/useFormat';
import { useSyncedPrefs } from '#hooks/useSyncedPrefs';

type ApproxMainProps = {
  /** Stored (scale-100) balance, in the account's own currency. */
  value: number;
  /** The account's own currency, if set. */
  currency: string | null | undefined;
};

/**
 * "(~12,000,000 ₫)" next to a non-Main account's balance, using the manual
 * rate. Without a rate it says so instead of guessing. Nothing for Main
 * currency accounts. Display only: budgets and reports are unaffected.
 */
export function ApproxMain({ value, currency }: ApproxMainProps) {
  const { t } = useTranslation();
  const format = useFormat();
  const [prefs] = useSyncedPrefs();
  const main = prefs.defaultCurrencyCode;
  const from = getEffectiveAccountCurrency(currency, prefs);

  if (!main || from === main) {
    return null;
  }

  let converted: number | null = null;
  try {
    converted = convert(value, from, main, prefs);
  } catch {
    // an amount too large to convert safely: same as having no rate
  }

  return (
    <Text style={{ marginLeft: 4, color: theme.pageTextSubdued }}>
      {converted === null ? (
        t('no rate')
      ) : (
        <PrivacyFilter>
          <FinancialText>
            ({'~ ' + format.forCurrency(converted, main)})
          </FinancialText>
        </PrivacyFilter>
      )}
    </Text>
  );
}
