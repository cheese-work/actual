import { useCallback, useEffect, useRef } from 'react';

import {
  AUTOMATIC_RATE_REFRESH_INTERVAL_MS,
  fetchAutomaticRates,
  getDueAutomaticRateSources,
} from '@actual-app/core/shared/automatic-rates';
import {
  manualRateKey,
  setAutomaticRatePatch,
} from '@actual-app/core/shared/exchange-rates';

import { useOnVisible } from '#hooks/useOnVisible';
import { useSyncedPrefs } from '#hooks/useSyncedPrefs';

type InProgressRefresh = {
  mainCurrencyCode: string;
  sourceCodes: string[];
};

export function AutomaticRatesUpdater({ budgetId }: { budgetId: string }) {
  const [prefs, setSyncedPrefs] = useSyncedPrefs();
  const prefsRef = useRef(prefs);
  const budgetIdRef = useRef(budgetId);
  const inProgress = useRef(new Map<string, InProgressRefresh>());
  const pendingRefresh = useRef(new Set<string>());
  const failedAttemptsByBudget = useRef(new Map<string, Map<string, number>>());
  const refreshRef = useRef<(() => Promise<void>) | null>(null);
  prefsRef.current = prefs;
  budgetIdRef.current = budgetId;

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
    const activeRefresh = inProgress.current.get(budgetId);
    if (activeRefresh) {
      if (
        activeRefresh.mainCurrencyCode !== mainCurrencyCode ||
        activeRefresh.sourceCodes.join('|') !== sourceCodes.join('|')
      ) {
        pendingRefresh.current.add(budgetId);
      }
      return;
    }
    if (sourceCodes.length === 0) {
      return;
    }

    inProgress.current.set(budgetId, { mainCurrencyCode, sourceCodes });
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
        return prefsRef.current[`rateMode.${sourceCode}`] === 'auto';
      });
      if (
        budgetIdRef.current === budgetId &&
        prefsRef.current.defaultCurrencyCode === mainCurrencyCode &&
        currentRates.length > 0
      ) {
        setSyncedPrefs(
          Object.assign({}, ...currentRates.map(setAutomaticRatePatch)),
        );
      }
    } catch {
      const attemptedAt = Date.now();
      for (const code of sourceCodes) {
        failedAttempts.set(`${mainCurrencyCode}.${code}`, attemptedAt);
      }
    } finally {
      inProgress.current.delete(budgetId);
      if (pendingRefresh.current.delete(budgetId)) {
        setTimeout(() => void refreshRef.current?.(), 0);
      }
    }
  }, [budgetId, setSyncedPrefs]);

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

  useOnVisible(refresh);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(
      () => void refresh(),
      AUTOMATIC_RATE_REFRESH_INTERVAL_MS,
    );
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [autoModeSignature, prefs.defaultCurrencyCode, refresh]);

  return null;
}
