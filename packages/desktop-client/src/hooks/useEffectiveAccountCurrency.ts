import { getEffectiveAccountCurrency } from '@actual-app/core/shared/currency-setup';

import { useSyncedPref } from './useSyncedPref';

/**
 * Resolves the currency an account's amounts should render in: the
 * account's own currency once set, otherwise the Main currency (including
 * before an account's pre-finalize currency is confirmed).
 */
export function useEffectiveAccountCurrency(
  accountCurrency: string | null | undefined,
): string {
  const [defaultCurrencyCode] = useSyncedPref('defaultCurrencyCode');
  return getEffectiveAccountCurrency(accountCurrency, {
    defaultCurrencyCode,
  });
}
