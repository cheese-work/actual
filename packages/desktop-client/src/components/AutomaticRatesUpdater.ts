import { useCallback, useEffect, useRef } from 'react';

import {
  fetchAutomaticRates,
  getDueAutomaticRateSources,
  getNextAutomaticRateRefreshAt,
} from '@actual-app/core/shared/automatic-rates';
import {
  manualRateKey,
  setAutomaticRatePatch,
} from '@actual-app/core/shared/exchange-rates';

import { useOnVisible } from '#hooks/useOnVisible';
import { useSyncedPrefs } from '#hooks/useSyncedPrefs';

export function AutomaticRatesUpdater({ budgetId }: { budgetId: string }) {
  const [prefs, setSyncedPrefs] = useSyncedPrefs();
  const prefsRef = useRef(prefs);
  const budgetIdRef = useRef(budgetId);
  const mounted = useRef(false);
  const inProgress = useRef(new Set<string>());
  const failedAttemptsByBudget = useRef(new Map<string, Map<string, number>>());
  const refreshRef = useRef<(() => Promise<void>) | null>(null);
  const refreshTimer = useRef<number | null>(null);
  prefsRef.current = prefs;
  budgetIdRef.current = budgetId;

  const scheduleRefresh = useCallback((nextAt: number | null) => {
    if (refreshTimer.current !== null) {
      clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
    }
    if (!mounted.current || nextAt === null) {
      return;
    }
    refreshTimer.current = window.setTimeout(
      () => {
        refreshTimer.current = null;
        if (mounted.current) {
          void refreshRef.current?.();
        }
      },
      Math.max(0, nextAt - Date.now()),
    );
  }, []);

  const refresh = useCallback(async () => {
    const currentPrefs = prefsRef.current;
    const mainCurrencyCode = currentPrefs.defaultCurrencyCode;
    if (!mainCurrencyCode) {
      return;
    }

    let failedAttempts = failedAttemptsByBudget.current.get(budgetId);
    if (!failedAttempts) {
      failedAttempts = new Map();
      failedAttemptsByBudget.current.set(budgetId, failedAttempts);
    }
    const sourceCodes = getDueAutomaticRateSources(
      currentPrefs,
      mainCurrencyCode,
      Date.now(),
      failedAttempts,
    );
    if (inProgress.current.has(budgetId)) {
      return;
    }
    if (sourceCodes.length === 0) {
      scheduleRefresh(
        getNextAutomaticRateRefreshAt(
          currentPrefs,
          mainCurrencyCode,
          Date.now(),
          failedAttempts,
        ),
      );
      return;
    }

    inProgress.current.add(budgetId);
    let prefsForNextRefresh = currentPrefs;
    try {
      const rates = await fetchAutomaticRates(sourceCodes, mainCurrencyCode);
      const receivedCodes = new Set(
        rates.map(rate =>
          rate.from === mainCurrencyCode ? rate.to : rate.from,
        ),
      );
      const attemptedAt = Date.now();
      for (const code of sourceCodes) {
        const failureKey = `${mainCurrencyCode}.${code}`;
        if (receivedCodes.has(code)) {
          failedAttempts.delete(failureKey);
        } else {
          failedAttempts.set(failureKey, attemptedAt);
        }
      }

      const currentRates = rates.filter(rate => {
        const sourceCode = rate.from === mainCurrencyCode ? rate.to : rate.from;
        return (
          sourceCodes.includes(sourceCode) &&
          prefsRef.current[`rateMode.${sourceCode}`] === 'auto'
        );
      });
      if (
        mounted.current &&
        budgetIdRef.current === budgetId &&
        prefsRef.current.defaultCurrencyCode === mainCurrencyCode &&
        currentRates.length > 0
      ) {
        const patch = Object.assign(
          {},
          ...currentRates.map(setAutomaticRatePatch),
        );
        setSyncedPrefs(patch);
        prefsForNextRefresh = { ...prefsRef.current, ...patch };
      }
    } catch {
      const attemptedAt = Date.now();
      for (const code of sourceCodes) {
        failedAttempts.set(`${mainCurrencyCode}.${code}`, attemptedAt);
      }
    } finally {
      inProgress.current.delete(budgetId);
      if (mounted.current) {
        const nextPrefs =
          prefsRef.current.defaultCurrencyCode === mainCurrencyCode
            ? prefsForNextRefresh
            : prefsRef.current;
        const nextMainCurrencyCode = nextPrefs.defaultCurrencyCode;
        scheduleRefresh(
          nextMainCurrencyCode
            ? getNextAutomaticRateRefreshAt(
                nextPrefs,
                nextMainCurrencyCode,
                Date.now(),
                failedAttempts,
              )
            : null,
        );
      }
    }
  }, [budgetId, scheduleRefresh, setSyncedPrefs]);

  refreshRef.current = refresh;

  const autoModeSignature = Object.entries(prefs)
    .filter(([key, mode]) => key.startsWith('rateMode.') && mode === 'auto')
    .map(([key]) => key.slice('rateMode.'.length))
    .sort()
    .map(code =>
      [
        `rateMode.${code}=${prefs[`rateMode.${code}`]}`,
        `${manualRateKey(code, prefs.defaultCurrencyCode ?? '')}=${prefs[manualRateKey(code, prefs.defaultCurrencyCode ?? '')] ?? ''}`,
        `${manualRateKey(prefs.defaultCurrencyCode ?? '', code)}=${prefs[manualRateKey(prefs.defaultCurrencyCode ?? '', code)] ?? ''}`,
      ].join('|'),
    )
    .join('|');
  const automaticRateSignature = Object.entries(prefs)
    .filter(([key]) => key.startsWith('autoRate.'))
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([key, value]) => `${key}=${value}`)
    .join('|');

  useOnVisible(refresh);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      if (refreshTimer.current !== null) {
        clearTimeout(refreshTimer.current);
        refreshTimer.current = null;
      }
    };
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [
    autoModeSignature,
    automaticRateSignature,
    prefs.defaultCurrencyCode,
    refresh,
  ]);

  return null;
}
