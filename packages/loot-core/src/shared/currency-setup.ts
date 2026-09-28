import type { SyncedPrefs } from '#types/prefs';

import { getDecimalPlaces } from './currencies';
import { getNumberFormat, integerToCurrency } from './util';
import type { IntegerAmount } from './util';

export type CurrencySetup = {
  defaultCurrencyCode: string;
  finalized: boolean;
};

// Currencies that display without a fraction even though amounts are
// always stored at the shared two-decimal scale (see CHE-838).
const FRACTIONLESS_DISPLAY_CURRENCIES = new Set(['VND']);

/**
 * Decimal places to *display* for a currency. This is independent of
 * storage scale, which stays fixed at two decimal places for every
 * currency (see currencyToInteger/amountToInteger in shared/util.ts).
 */
export function getDisplayDecimalPlaces(currencyCode: string): number {
  if (FRACTIONLESS_DISPLAY_CURRENCIES.has(currencyCode)) {
    return 0;
  }
  return getDecimalPlaces(currencyCode);
}

/**
 * Formats a stored (scale-100) amount using a currency's *display*
 * precision, without a currency symbol — for un-styled contexts like
 * register cells where the symbol is implied by column context.
 */
export function formatAccountAmount(
  integerAmount: IntegerAmount,
  currencyCode: string,
): string {
  const formatter = getNumberFormat({
    decimalPlaces: getDisplayDecimalPlaces(currencyCode),
  }).formatter;
  return integerToCurrency(integerAmount, formatter, 2);
}

export function getCurrencySetup(prefs: SyncedPrefs): CurrencySetup {
  const finalized =
    prefs.currencySetupFinalized === 'true' && !!prefs.defaultCurrencyCode;

  return {
    defaultCurrencyCode: prefs.defaultCurrencyCode ?? '',
    finalized,
  };
}

export function getEffectiveAccountCurrency(
  accountCurrency: string | null | undefined,
  prefs: SyncedPrefs,
): string {
  return accountCurrency ?? getCurrencySetup(prefs).defaultCurrencyCode;
}

export function finalizeCurrencySetup(
  prefs: SyncedPrefs,
  defaultCurrencyCode: string,
): Partial<SyncedPrefs> {
  if (getCurrencySetup(prefs).finalized) {
    return {};
  }

  return {
    defaultCurrencyCode,
    ...(prefs.currencySetupFinalized !== 'true' && {
      currencySetupFinalized: 'true',
    }),
  };
}
