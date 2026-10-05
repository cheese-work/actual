import type { AccountEntity } from '@actual-app/core/types/models';
import type { SyncedPrefs } from '@actual-app/core/types/prefs';

import type { MonteCarloConfig } from '#components/reports/reports/monte-carlo/monteCarloSimulation';
import { convertAccountAmount } from '#components/reports/spreadsheets/report-currency';

/**
 * Linked pots hold native account balances (scale-100 integers in the
 * account's own currency), and the persisted startingBalance of a linked
 * pot is in those same native units. Nothing new is persisted: the native
 * value is converted to Main only when a simulation or the pot table reads it.
 */
export type MonteCarloMainConversion =
  | {
      status: 'complete';
      /** The config with every linked pot valued in Main */
      config: MonteCarloConfig;
      /** Main-valued balance of each linked pot, by pot id */
      linkedBalances: Record<string, number | null>;
    }
  | {
      /** A linked account or its rate is missing: never run on partial data */
      status: 'unavailable';
      config: null;
      /** Null marks the pots that could not be converted */
      linkedBalances: Record<string, number | null>;
    }
  | {
      /** Accounts have not loaded, so currencies are not known yet */
      status: 'loading';
      config: null;
      linkedBalances: Record<string, number | null>;
    };

/**
 * A linked pot takes its account's live native balance (floored at zero),
 * keeping the stored native starting balance until the live value arrives.
 * The result is what gets persisted, so it stays in native units.
 */
export function applyLiveBalances(
  config: MonteCarloConfig,
  accountBalances: Record<string, number | null>,
): MonteCarloConfig {
  if (!config.pots.some(pot => pot.accountId != null)) {
    return config;
  }
  return {
    ...config,
    pots: config.pots.map(pot => {
      const balance =
        pot.accountId != null ? accountBalances[pot.accountId] : null;
      return balance != null
        ? { ...pot, startingBalance: Math.max(0, balance) }
        : pot;
    }),
  };
}

/**
 * Values every linked pot in Main, converting each native balance before
 * the simulation combines them. Manual pots are already entered in Main. With
 * no Main currency configured there is nothing to convert to, so the config
 * passes through unchanged.
 */
export function convertMonteCarloConfigToMain(
  nativeConfig: MonteCarloConfig,
  accounts: AccountEntity[],
  prefs: Readonly<SyncedPrefs>,
  valuationTime: number,
): MonteCarloMainConversion {
  if (!prefs.defaultCurrencyCode) {
    return { status: 'complete', config: nativeConfig, linkedBalances: {} };
  }

  const accountsById = new Map(accounts.map(account => [account.id, account]));
  const linkedBalances: Record<string, number | null> = {};
  let unavailable = false;
  const pots = nativeConfig.pots.map(pot => {
    if (pot.accountId == null) {
      return pot;
    }
    const startingBalance = convertAccountAmount(
      pot.startingBalance,
      accountsById.get(pot.accountId),
      prefs,
      valuationTime,
    );
    linkedBalances[pot.id] = startingBalance;
    if (startingBalance === null) {
      unavailable = true;
      return pot;
    }
    return { ...pot, startingBalance };
  });

  return unavailable
    ? { status: 'unavailable', config: null, linkedBalances }
    : {
        status: 'complete',
        config: { ...nativeConfig, pots },
        linkedBalances,
      };
}
