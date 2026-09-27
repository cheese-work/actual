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
});
