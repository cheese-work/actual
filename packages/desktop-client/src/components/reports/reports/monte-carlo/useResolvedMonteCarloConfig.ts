import { useMemo } from 'react';

import {
  applyLiveBalances,
  convertMonteCarloConfigToMain,
} from '#components/reports/reports/monte-carlo/monteCarloCurrency';
import type { MonteCarloMainConversion } from '#components/reports/reports/monte-carlo/monteCarloCurrency';
import type { MonteCarloConfig } from '#components/reports/reports/monte-carlo/monteCarloSimulation';
import { useAccountBalances } from '#hooks/useAccountBalances';
import { useAccounts } from '#hooks/useAccounts';
import { useSyncedPrefs } from '#hooks/useSyncedPrefs';

const NO_CONVERSION_YET: MonteCarloMainConversion = {
  status: 'loading',
  config: null,
  linkedBalances: {},
};

/**
 * Resolves account-linked pots to their live balances: a linked pot takes
 * the account's current balance, falling back to its stored starting
 * balance until the live value arrives. Shared by the report page and the
 * dashboard card so both simulate the same portfolio.
 *
 * `nativeConfig` keeps linked balances in their account currency and is the
 * only shape that may be persisted or edited. `main` values the same pots in
 * the Main currency for display and simulation, from one prefs/account
 * snapshot, and is loading until accounts (and so their currencies) are known.
 */
export function useResolvedMonteCarloConfig(config: MonteCarloConfig): {
  nativeConfig: MonteCarloConfig;
  main: MonteCarloMainConversion;
} {
  const accountBalances = useAccountBalances(
    config.pots
      .map(pot => pot.accountId)
      .filter((id): id is string => id != null),
  );
  const [prefs] = useSyncedPrefs();
  const {
    data: accounts,
    isLoading: accountsLoading,
    isPlaceholderData: accountsPlaceholderData,
  } = useAccounts();
  const accountsReady = !accountsLoading && !accountsPlaceholderData;

  // Memoized by hand: this plain .ts file sits outside the React
  // Compiler's include (.tsx only), and the compiled consumers key their
  // auto-memoized simulation runs on this object's identity - a fresh
  // object every render would re-simulate on every unrelated re-render
  const nativeConfig = useMemo(
    () => applyLiveBalances(config, accountBalances),
    [config, accountBalances],
  );

  // Currencies only matter for linked pots when Main is configured
  const needsAccounts =
    !!prefs.defaultCurrencyCode &&
    nativeConfig.pots.some(pot => pot.accountId != null);

  const main = useMemo(() => {
    if (needsAccounts && (!accountsReady || !accounts)) {
      return NO_CONVERSION_YET;
    }
    // One valuation time per calculation, so a rate fetched after the
    // config loaded is not treated as future-dated
    return convertMonteCarloConfigToMain(
      nativeConfig,
      accounts ?? [],
      prefs,
      Date.now(),
    );
  }, [nativeConfig, accounts, accountsReady, needsAccounts, prefs]);

  return useMemo(() => ({ nativeConfig, main }), [nativeConfig, main]);
}
