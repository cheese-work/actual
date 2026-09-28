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

  it('writes the confirmed currency even when defaultCurrencyCode already exists', () => {
    const changes = finalizeCurrencySetup(
      { defaultCurrencyCode: 'USD' },
      'VND',
    );

    expect(changes).toEqual({
      defaultCurrencyCode: 'VND',
      currencySetupFinalized: 'true',
    });
  });

  it('treats an empty defaultCurrencyCode as unset, not finalized', () => {
    const changes = finalizeCurrencySetup({ defaultCurrencyCode: '' }, 'VND');
    const completed = { defaultCurrencyCode: '', ...changes };

    expect(changes.defaultCurrencyCode).toBe('VND');
    expect(getCurrencySetup(completed)).toEqual({
      defaultCurrencyCode: 'VND',
      finalized: true,
    });
  });

  it.each<[SyncedPrefs]>([
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
