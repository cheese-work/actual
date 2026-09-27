import type { SyncedPrefs } from '#types/prefs';

import {
  finalizeCurrencySetup,
  getCurrencySetup,
  getEffectiveAccountCurrency,
} from './currency-setup';

describe('currency setup', () => {
  it('keeps denomination and display currency independent', () => {
    const prefs = {
      budgetCurrencyCode: 'USD',
      displayCurrencyCode: 'VND',
      currencySetupFinalized: 'true',
    };

    expect(getCurrencySetup(prefs)).toEqual({
      budgetCurrencyCode: 'USD',
      displayCurrencyCode: 'VND',
      finalized: true,
    });
  });

  it('uses the legacy currency before finalization', () => {
    expect(getCurrencySetup({ defaultCurrencyCode: 'USD' })).toEqual({
      budgetCurrencyCode: 'USD',
      displayCurrencyCode: 'USD',
      finalized: false,
    });
  });

  it('inherits the budget denomination only for unset accounts', () => {
    const prefs = { budgetCurrencyCode: 'USD' };

    expect(getEffectiveAccountCurrency(null, prefs)).toBe('USD');
    expect(getEffectiveAccountCurrency('VND', prefs)).toBe('VND');
  });

  it('finalizes once without changing a later display selection', () => {
    const finalized = finalizeCurrencySetup({}, 'USD', 'VND');

    expect(finalized).toEqual({
      budgetCurrencyCode: 'USD',
      displayCurrencyCode: 'VND',
      currencySetupFinalized: 'true',
    });
    expect(finalizeCurrencySetup(finalized, 'USD', 'EUR')).toEqual({});
  });

  it.each<[SyncedPrefs]>([
    [{ budgetCurrencyCode: 'JPY' }],
    [{ displayCurrencyCode: 'EUR' }],
    [{ currencySetupFinalized: 'true' }],
    [{ budgetCurrencyCode: 'JPY', displayCurrencyCode: 'EUR' }],
    [{ budgetCurrencyCode: 'JPY', currencySetupFinalized: 'true' }],
    [{ displayCurrencyCode: 'EUR', currencySetupFinalized: 'true' }],
  ])(
    'repairs partial setup without replacing persisted selections: %o',
    prefs => {
      const changes = finalizeCurrencySetup(prefs, 'USD', 'VND');
      const completed = { ...prefs, ...changes };

      expect(getCurrencySetup(completed)).toEqual({
        budgetCurrencyCode: prefs.budgetCurrencyCode ?? 'USD',
        displayCurrencyCode: prefs.displayCurrencyCode ?? 'VND',
        finalized: true,
      });
    },
  );
});
