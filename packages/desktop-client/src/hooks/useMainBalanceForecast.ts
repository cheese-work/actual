import { useMemo } from 'react';

import type { AccountEntity } from '@actual-app/core/types/models';
import type { ForecastResult } from '@actual-app/core/types/models/forecast';
import type { SyncedPrefs } from '@actual-app/core/types/prefs';

import {
  convertAccountAmount,
  hasForeignAccount,
  sumConvertedLeaves,
} from '#components/reports/spreadsheets/report-currency';

import { useAccounts } from './useAccounts';
import { useBalanceForecast } from './useBalanceForecast';
import { useSyncedPrefs } from './useSyncedPrefs';

// Mirror FORECAST_UNASSIGNED_ACCOUNT_ID (forecast-schedules.ts) and
// TRACKING_BUDGET_FORECAST_ACCOUNT_ID (forecast-tracking-budget.ts) in loot-core.
// Accountless schedules and the tracking-budget series are not accounts with a
// currency of their own, so they stay in Main.
const MAIN_ONLY_ACCOUNT_IDS = new Set([
  '__unassigned_schedule__',
  'tracking-budget',
]);

/**
 * Converts each (account, date) balance to Main once; combined totals are
 * built from these converted leaves. Null when any leaf is unavailable.
 */
export function convertForecastToMain(
  forecast: ForecastResult,
  accounts: AccountEntity[],
  prefs: Readonly<SyncedPrefs>,
  valuationTime: number,
): ForecastResult | null {
  const accountsById = new Map(accounts.map(a => [a.id, a]));
  const convertBalance = (accountId: string, balance: number) =>
    convertAccountAmount(
      balance,
      MAIN_ONLY_ACCOUNT_IDS.has(accountId)
        ? { currency: prefs.defaultCurrencyCode }
        : accountsById.get(accountId),
      prefs,
      valuationTime,
    );

  const dataPoints: ForecastResult['dataPoints'] = [];
  for (const point of forecast.dataPoints) {
    const balance = convertBalance(point.accountId, point.balance);
    if (balance === null) {
      return null;
    }
    dataPoints.push({ ...point, balance });
  }

  if (dataPoints.length === 0) {
    return { ...forecast, dataPoints };
  }

  // The core reports the lowest *combined* balance (accountId ''), so
  // recompute it from the converted per-account leaves, safe-summed by date.
  const combinedByDate = new Map<string, number>();
  for (const point of dataPoints) {
    const combined = sumConvertedLeaves([
      combinedByDate.get(point.date) ?? 0,
      point.balance,
    ]);
    if (combined === null) {
      return null;
    }
    combinedByDate.set(point.date, combined);
  }
  let lowestBalance = { ...forecast.lowestBalance, balance: Infinity };
  for (const [date, balance] of combinedByDate) {
    if (balance < lowestBalance.balance) {
      lowestBalance = { ...lowestBalance, date, balance };
    }
  }

  return { ...forecast, dataPoints, lowestBalance };
}

/**
 * useBalanceForecast with balances valued in the Main currency. `data` is
 * undefined while accounts or the forecast load; `unavailable` is true when
 * Main is unset or an included account has no usable rate.
 */
export function useMainBalanceForecast(
  params: Parameters<typeof useBalanceForecast>[0],
) {
  const query = useBalanceForecast(params);
  const [prefs] = useSyncedPrefs();
  const {
    data: accounts = [],
    isLoading: accountsLoading,
    isPlaceholderData: accountsPlaceholderData,
  } = useAccounts();
  const accountsReady = !accountsLoading && !accountsPlaceholderData;
  const { data: native } = query;

  const converted = useMemo(() => {
    if (!native || !accountsReady || !prefs.defaultCurrencyCode) {
      return null;
    }
    // One current valuation time per calculation, so a rate fetched after the
    // forecast loaded is not treated as future-dated.
    return convertForecastToMain(native, accounts, prefs, Date.now());
  }, [native, accounts, accountsReady, prefs]);

  const unavailable =
    !prefs.defaultCurrencyCode || (!!native && accountsReady && !converted);

  return {
    ...query,
    data: converted ?? undefined,
    isPending: query.isPending || (!!native && !accountsReady),
    unavailable,
    hasForeignCurrency:
      !!converted &&
      hasForeignAccount(
        accounts.filter(a =>
          converted.dataPoints.some(point => point.accountId === a.id),
        ),
        prefs,
      ),
  };
}
