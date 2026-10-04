import React from 'react';
import { useTranslation } from 'react-i18next';

import { Text } from '@actual-app/components/text';
import { roundToDisplayPrecision } from '@actual-app/core/shared/currency-aggregation';
import {
  getDisplayDecimalPlaces,
  getEffectiveAccountCurrency,
} from '@actual-app/core/shared/currency-setup';
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
  halfEvenDisplay?: boolean;
};

/**
 * "(~12,000,000 ₫)" next to a non-Main account's balance, using the manual
 * rate. Without a rate it says so instead of guessing. Nothing for Main
 * currency accounts. Display only: budgets and reports are unaffected.
 */
export function ApproxMain({
  value,
  currency,
  halfEvenDisplay = false,
}: ApproxMainProps) {
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

  const displayAmount =
    converted !== null && halfEvenDisplay
      ? (roundToDisplayPrecision(
          converted,
          format.numberFormat.hideFraction ? 0 : getDisplayDecimalPlaces(main),
        ) ?? converted)
      : converted;

  return (
    <Text
      style={{
        marginLeft: 4,
        whiteSpace: 'nowrap',
      }}
    >
      {converted === null ? (
        `(${t('no rate')})`
      ) : (
        <PrivacyFilter>
          <FinancialText>
            ({'~ ' + format.forCurrency(displayAmount ?? converted, main)})
          </FinancialText>
        </PrivacyFilter>
      )}
    </Text>
  );
}
