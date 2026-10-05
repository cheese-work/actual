import { useMemo } from 'react';

import type { AccountEntity } from '@actual-app/core/types/models';
import type { ForecastResult } from '@actual-app/core/types/models/forecast';
import type { SyncedPrefs } from '@actual-app/core/types/prefs';

import {
  convertAccountAmount,
  hasForeignAccount,
} from '#components/reports/spreadsheets/report-currency';

import { useAccounts } from './useAccounts';
import { useBalanceForecast } from './useBalanceForecast';
import { useSyncedPrefs } from './useSyncedPrefs';

// Mirrors FORECAST_UNASSIGNED_ACCOUNT_ID in loot-core's forecast-schedules.ts.
// Accountless schedules carry no currency, so they stay in Main.
const UNASSIGNED_ACCOUNT_ID = '__unassigned_schedule__';

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
      accountId === UNASSIGNED_ACCOUNT_ID
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

  const lowest = forecast.lowestBalance;
  const lowestBalance = convertBalance(lowest.accountId, lowest.balance);
  if (lowestBalance === null) {
    return null;
  }

  return {
    ...forecast,
    dataPoints,
    lowestBalance: { ...lowest, balance: lowestBalance },
  };
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
  const { data: native, dataUpdatedAt } = query;

  const converted = useMemo(() => {
    if (!native || !accountsReady || !prefs.defaultCurrencyCode) {
      return null;
    }
    return convertForecastToMain(native, accounts, prefs, dataUpdatedAt);
  }, [native, accounts, accountsReady, prefs, dataUpdatedAt]);

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
