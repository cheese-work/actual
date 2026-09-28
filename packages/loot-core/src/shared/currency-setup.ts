import type { SyncedPrefs } from '#types/prefs';

export type CurrencySetup = {
  defaultCurrencyCode: string;
  finalized: boolean;
};

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
