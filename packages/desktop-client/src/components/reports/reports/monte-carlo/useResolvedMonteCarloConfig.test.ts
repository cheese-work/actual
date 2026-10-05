import type { SyncedPrefs } from '@actual-app/core/types/prefs';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createMonteCarloPot,
  monteCarloConfigFromMeta,
} from './monteCarloSimulation';
import { useResolvedMonteCarloConfig } from './useResolvedMonteCarloConfig';

const mocks = vi.hoisted(() => ({
  accounts: {
    data: undefined as unknown[] | undefined,
    isLoading: false,
    isPlaceholderData: false,
  },
  prefs: {} as Record<string, string>,
  balances: {} as Record<string, number | null>,
}));

vi.mock('#hooks/useAccounts', () => ({ useAccounts: () => mocks.accounts }));
vi.mock('#hooks/useSyncedPrefs', () => ({
  useSyncedPrefs: () => [mocks.prefs as SyncedPrefs],
}));
vi.mock('#hooks/useAccountBalances', () => ({
  useAccountBalances: () => mocks.balances,
}));

const jpy = { id: 'jpy-acct', currency: 'JPY' };
const config = {
  ...monteCarloConfigFromMeta({}),
  pots: [
    {
      ...createMonteCarloPot('p'),
      startingBalance: 1,
      accountId: 'jpy-acct',
    },
  ],
};

describe('useResolvedMonteCarloConfig', () => {
  beforeEach(() => {
    mocks.accounts = {
      data: [jpy],
      isLoading: false,
      isPlaceholderData: false,
    };
    mocks.prefs = {
      defaultCurrencyCode: 'USD',
      'manualRate.JPY.USD': '0.0067',
    };
    mocks.balances = { 'jpy-acct': 1_000_000 };
  });

  it('values linked pots in Main while keeping the persistable config native', () => {
    const { result } = renderHook(() => useResolvedMonteCarloConfig(config));

    expect(result.current.nativeConfig.pots[0].startingBalance).toBe(1_000_000);
    expect(result.current.main.status).toBe('complete');
    expect(result.current.main.config?.pots[0].startingBalance).toBe(6_700);
  });

  it('stays loading while accounts load or are placeholder data', () => {
    mocks.accounts = {
      data: undefined,
      isLoading: true,
      isPlaceholderData: false,
    };
    const loading = renderHook(() => useResolvedMonteCarloConfig(config));
    expect(loading.result.current.main.status).toBe('loading');

    mocks.accounts = { data: [jpy], isLoading: false, isPlaceholderData: true };
    const placeholder = renderHook(() => useResolvedMonteCarloConfig(config));
    expect(placeholder.result.current.main.status).toBe('loading');
  });

  it('is unavailable when the rate is missing', () => {
    mocks.prefs = { defaultCurrencyCode: 'EUR' };
    const { result } = renderHook(() => useResolvedMonteCarloConfig(config));

    expect(result.current.main.status).toBe('unavailable');
    expect(result.current.main.config).toBeNull();
  });

  it('does not wait for accounts when there is nothing to convert', () => {
    mocks.accounts = {
      data: undefined,
      isLoading: true,
      isPlaceholderData: false,
    };
    const manual = {
      ...config,
      pots: [{ ...config.pots[0], accountId: null }],
    };

    const { result } = renderHook(() => useResolvedMonteCarloConfig(manual));

    expect(result.current.main.status).toBe('complete');
    expect(result.current.main.config?.pots[0].startingBalance).toBe(1);
  });
});
