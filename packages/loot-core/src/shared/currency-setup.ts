import type { SyncedPrefs } from '#types/prefs';

export type CurrencySetup = {
  budgetCurrencyCode: string;
  displayCurrencyCode: string;
  finalized: boolean;
};

export function getCurrencySetup(prefs: SyncedPrefs): CurrencySetup {
  const legacyCurrencyCode = prefs.defaultCurrencyCode ?? '';

  return {
    budgetCurrencyCode: prefs.budgetCurrencyCode ?? legacyCurrencyCode,
    displayCurrencyCode: prefs.displayCurrencyCode ?? legacyCurrencyCode,
    finalized: prefs.currencySetupFinalized === 'true',
  };
}

export function getEffectiveAccountCurrency(
  accountCurrency: string | null | undefined,
  prefs: SyncedPrefs,
): string {
  return accountCurrency ?? getCurrencySetup(prefs).budgetCurrencyCode;
}

export function finalizeCurrencySetup(
  prefs: SyncedPrefs,
  budgetCurrencyCode: string,
  displayCurrencyCode: string,
): Partial<SyncedPrefs> {
  if (getCurrencySetup(prefs).finalized) {
    return {};
  }

  return {
    budgetCurrencyCode,
    displayCurrencyCode,
    currencySetupFinalized: 'true',
  };
}
