import type { SyncedPrefs } from '#types/prefs';

import {
  finalizeCurrencySetup,
  getCurrencySetup,
  getEffectiveAccountCurrency,
} from './currency-setup';

describe('currency setup', () => {
  it('reads the finalized main currency', () => {
    const prefs = {
      defaultCurrencyCode: 'USD',
      currencySetupFinalized: 'true',
    };

    expect(getCurrencySetup(prefs)).toEqual({
      defaultCurrencyCode: 'USD',
      finalized: true,
    });
  });

  it('uses the legacy currency before finalization', () => {
    expect(getCurrencySetup({ defaultCurrencyCode: 'USD' })).toEqual({
      defaultCurrencyCode: 'USD',
      finalized: false,
    });
  });

  it('inherits the main currency only for unset accounts', () => {
    const prefs = { defaultCurrencyCode: 'USD' };

    expect(getEffectiveAccountCurrency(null, prefs)).toBe('USD');
    expect(getEffectiveAccountCurrency('VND', prefs)).toBe('VND');
  });

  it('finalizes once without changing a later selection', () => {
    const finalized = finalizeCurrencySetup({}, 'USD');

    expect(finalized).toEqual({
      defaultCurrencyCode: 'USD',
      currencySetupFinalized: 'true',
    });
    expect(finalizeCurrencySetup(finalized, 'EUR')).toEqual({});
  });

  it.each<[SyncedPrefs]>([
    [{ defaultCurrencyCode: 'JPY' }],
    [{ currencySetupFinalized: 'true' }],
    [{ defaultCurrencyCode: 'JPY', currencySetupFinalized: 'true' }],
  ])(
    'repairs partial setup without replacing a persisted selection: %o',
    prefs => {
      const changes = finalizeCurrencySetup(prefs, 'USD');
      const completed = { ...prefs, ...changes };

      expect(getCurrencySetup(completed)).toEqual({
        defaultCurrencyCode: prefs.defaultCurrencyCode ?? 'USD',
        finalized: true,
      });
    },
  );
});
