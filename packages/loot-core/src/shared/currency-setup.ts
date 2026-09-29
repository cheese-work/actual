import type { SyncedPrefs } from '#types/prefs';

import { getCurrency } from './currencies';
import {
  amountToCurrencyInteger,
  currencyToAmount,
  getNumberFormat,
  integerToCurrency,
} from './util';
import type { IntegerAmount, NumberFormats } from './util';

export type CurrencySetup = {
  defaultCurrencyCode: string;
  finalized: boolean;
};

/** The user's number format prefs, as parsed by parseNumberFormat. */
export type AmountFormat = {
  format: NumberFormats;
  hideFraction: boolean;
};

/**
 * Decimal places to *display* for a currency. This is independent of
 * storage scale, which stays fixed at two decimal places for every
 * currency (see currencyToInteger/amountToInteger in shared/util.ts).
 */
export function getDisplayDecimalPlaces(currencyCode: string): number {
  const currency = getCurrency(currencyCode);
  return currency.displayDecimalPlaces ?? currency.decimalPlaces;
}

/**
 * Formats a stored (scale-100) amount using a currency's *display*
 * precision and the user's number format, without a currency symbol.
 */
export function formatAccountAmount(
  integerAmount: IntegerAmount,
  currencyCode: string,
  { format, hideFraction }: AmountFormat,
): string {
  const formatter = getNumberFormat({
    format,
    decimalPlaces: hideFraction ? 0 : getDisplayDecimalPlaces(currencyCode),
  }).formatter;
  return integerToCurrency(integerAmount, formatter, 2);
}

/**
 * Re-formats a typed register amount (debit/credit input) at the
 * account currency's display precision. Empty input stays empty.
 */
export function reformatAccountAmountInput(
  value: string,
  currencyCode: string,
  amountFormat: AmountFormat,
): string {
  if (!value) {
    return '';
  }
  return formatAccountAmount(
    amountToCurrencyInteger(currencyToAmount(value) || 0, currencyCode),
    currencyCode,
    amountFormat,
  );
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
