import type { AccountEntity } from '@actual-app/core/types/models';
import type { SyncedPrefs } from '@actual-app/core/types/prefs';
import { describe, expect, it } from 'vitest';

import {
  applyLiveBalances,
  convertMonteCarloConfigToMain,
} from './monteCarloCurrency';
import {
  createMonteCarloPot,
  monteCarloConfigFromMeta,
} from './monteCarloSimulation';

function createAccount(id: string, currency: string | null): AccountEntity {
  return {
    id,
    name: id,
    currency,
    offbudget: 1,
    closed: 0,
    sort_order: 0,
    last_reconciled: null,
    tombstone: 0,
    account_group_id: null,
    account_id: null,
    bank: null,
    bankName: null,
    bankId: null,
    mask: null,
    official_name: null,
    balance_current: null,
    balance_available: null,
    balance_limit: null,
    account_sync_source: null,
    last_sync: null,
    bank_sync_status: null,
  };
}

const usd = createAccount('usd-acct', null);
const jpy = createAccount('jpy-acct', 'JPY');
const eur = createAccount('eur-acct', 'EUR');
const accounts = [usd, jpy, eur];

const prefs: SyncedPrefs = {
  defaultCurrencyCode: 'USD',
  'manualRate.JPY.USD': '0.0067',
};

function pot(id: string, startingBalance: number, accountId: string | null) {
  return { ...createMonteCarloPot(id), startingBalance, accountId };
}

describe('convertMonteCarloConfigToMain', () => {
  it('converts each linked pot from its own account currency', () => {
    const config = {
      ...monteCarloConfigFromMeta({}),
      pots: [
        pot('main', 100_00, 'usd-acct'),
        pot('foreign', 1_000_000, 'jpy-acct'),
        pot('manual', 5_00, null),
      ],
    };

    const result = convertMonteCarloConfigToMain(config, accounts, prefs, 0);

    expect(result.status).toBe('complete');
    expect(result.config?.pots.map(p => p.startingBalance)).toEqual([
      100_00, 6_700, 5_00,
    ]);
    expect(result.linkedBalances).toEqual({
      main: 100_00,
      foreign: 6_700,
    });
    // Only linked-pot balances change; everything else is untouched
    expect(result.config?.pots[1]).toEqual({
      ...config.pots[1],
      startingBalance: 6_700,
    });
    expect(result.config?.withdrawalRule).toBe(config.withdrawalRule);
    // The native config is never mutated
    expect(config.pots[1].startingBalance).toBe(1_000_000);
  });

  it('is unavailable, never zero or partial, when one linked pot has no rate', () => {
    const config = {
      ...monteCarloConfigFromMeta({}),
      pots: [
        pot('foreign', 1_000_000, 'jpy-acct'),
        pot('euro', 50_00, 'eur-acct'),
      ],
    };

    const result = convertMonteCarloConfigToMain(config, accounts, prefs, 0);

    expect(result.status).toBe('unavailable');
    expect(result.config).toBeNull();
    expect(result.linkedBalances).toEqual({ foreign: 6_700, euro: null });
  });

  it('is unavailable when a linked account is missing or the balance is unsafe', () => {
    const missing = convertMonteCarloConfigToMain(
      {
        ...monteCarloConfigFromMeta({}),
        pots: [pot('gone', 10_00, 'deleted')],
      },
      accounts,
      prefs,
      0,
    );
    expect(missing.status).toBe('unavailable');

    const unsafe = convertMonteCarloConfigToMain(
      {
        ...monteCarloConfigFromMeta({}),
        pots: [pot('big', Number.MAX_SAFE_INTEGER + 2, 'jpy-acct')],
      },
      accounts,
      prefs,
      0,
    );
    expect(unsafe.status).toBe('unavailable');
  });

  it('keeps Main-only configs identical', () => {
    const config = {
      ...monteCarloConfigFromMeta({}),
      pots: [pot('a', 123_45, 'usd-acct'), pot('b', 9_00, null)],
    };

    const result = convertMonteCarloConfigToMain(config, accounts, prefs, 0);

    expect(result.status).toBe('complete');
    expect(result.config?.pots).toEqual(config.pots);
  });

  it('passes native values through when no Main currency is set', () => {
    const config = {
      ...monteCarloConfigFromMeta({}),
      pots: [pot('a', 123_45, 'jpy-acct')],
    };

    const result = convertMonteCarloConfigToMain(config, accounts, {}, 0);

    expect(result.status).toBe('complete');
    expect(result.config).toBe(config);
  });

  it('converts a stored balance used while the live balance loads', () => {
    const saved = monteCarloConfigFromMeta({
      pots: [{ id: 'p', startingBalance: 2_000_000, accountId: 'jpy-acct' }],
    });
    const resolved = applyLiveBalances(saved, {});

    expect(resolved).toEqual(saved);
    expect(
      convertMonteCarloConfigToMain(resolved, accounts, prefs, 0).config
        ?.pots[0].startingBalance,
    ).toBe(13_400);
  });
});

describe('applyLiveBalances', () => {
  it('uses the live native balance, clamped at zero, for linked pots only', () => {
    const config = {
      ...monteCarloConfigFromMeta({}),
      pots: [
        pot('live', 1, 'jpy-acct'),
        pot('negative', 1, 'usd-acct'),
        pot('pending', 7, 'eur-acct'),
        pot('manual', 9, null),
      ],
    };

    const resolved = applyLiveBalances(config, {
      'jpy-acct': 3_000_000,
      'usd-acct': -50_00,
      'eur-acct': null,
    });

    expect(resolved.pots.map(p => p.startingBalance)).toEqual([
      3_000_000, 0, 7, 9,
    ]);
  });

  it('round-trips a saved legacy config without changing persisted values', () => {
    const legacyMeta = {
      pots: [
        { id: 'p1', startingBalance: 1_000_000, accountId: 'jpy-acct' },
        { id: 'p2', startingBalance: 500_00 },
      ],
    };

    const loaded = monteCarloConfigFromMeta(legacyMeta);
    // Save persists the native-resolved config (live balance not yet
    // loaded, so the stored native value stays)
    const saved = { ...legacyMeta, ...applyLiveBalances(loaded, {}) };
    const reloaded = monteCarloConfigFromMeta(saved);

    expect(reloaded.pots.map(p => p.startingBalance)).toEqual([
      1_000_000, 500_00,
    ]);
    expect(reloaded.pots.map(p => p.accountId)).toEqual(['jpy-acct', null]);

    // Display conversion on both loads gives the same Main value
    const mainOf = (config: typeof loaded) =>
      convertMonteCarloConfigToMain(config, accounts, prefs, 0).config?.pots[0]
        .startingBalance;
    expect(mainOf(loaded)).toBe(6_700);
    expect(mainOf(reloaded)).toBe(6_700);
  });
});
