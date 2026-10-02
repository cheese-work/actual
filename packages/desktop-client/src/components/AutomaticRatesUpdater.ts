import { useCallback, useEffect, useRef } from 'react';

import {
  fetchAutomaticRates,
  getDueAutomaticRateSources,
  getNextAutomaticRateRefreshAt,
} from '@actual-app/core/shared/automatic-rates';
import {
  isAutomaticRateEnabled,
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
  const lastAttemptsByBudget = useRef(new Map<string, Map<string, number>>());
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

    let lastAttempts = lastAttemptsByBudget.current.get(budgetId);
    if (!lastAttempts) {
      lastAttempts = new Map();
      lastAttemptsByBudget.current.set(budgetId, lastAttempts);
    }
    const sourceCodes = getDueAutomaticRateSources(
      currentPrefs,
      mainCurrencyCode,
      Date.now(),
      lastAttempts,
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
          lastAttempts,
        ),
      );
      return;
    }

    inProgress.current.add(budgetId);
    let prefsForNextRefresh = currentPrefs;
    try {
      const rates = await fetchAutomaticRates(sourceCodes, mainCurrencyCode);
      const attemptedAt = Date.now();
      for (const code of sourceCodes) {
        lastAttempts.set(`${mainCurrencyCode}.${code}`, attemptedAt);
      }

      const currentRates = rates.filter(rate => {
        const sourceCode = rate.from === mainCurrencyCode ? rate.to : rate.from;
        return (
          sourceCodes.includes(sourceCode) &&
          isAutomaticRateEnabled(prefsRef.current, sourceCode, mainCurrencyCode)
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
        lastAttempts.set(`${mainCurrencyCode}.${code}`, attemptedAt);
      }
    } finally {
      inProgress.current.delete(budgetId);
      if (mounted.current && budgetIdRef.current === budgetId) {
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
                lastAttempts,
              )
            : null,
        );
      }
    }
  }, [budgetId, scheduleRefresh, setSyncedPrefs]);

  refreshRef.current = refresh;

  const rateModeSignature = Object.entries(prefs)
    .filter(([key]) => key.startsWith('rateMode.'))
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([key, mode]) => {
      const code = key.slice('rateMode.'.length);
      const mainCurrencyCode = prefs.defaultCurrencyCode ?? '';
      return [
        `${key}=${mode}`,
        `${manualRateKey(code, mainCurrencyCode)}=${prefs[manualRateKey(code, mainCurrencyCode)] ?? ''}`,
        `${manualRateKey(mainCurrencyCode, code)}=${prefs[manualRateKey(mainCurrencyCode, code)] ?? ''}`,
      ].join('|');
    })
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
    rateModeSignature,
    automaticRateSignature,
    prefs.defaultCurrencyCode,
    refresh,
  ]);

  return null;
}
