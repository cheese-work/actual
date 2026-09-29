import type { SyncedPrefs } from '#types/prefs';

import {
  finalizeCurrencySetup,
  formatAccountAmount,
  getCurrencySetup,
  getDisplayDecimalPlaces,
  getEffectiveAccountCurrency,
} from './currency-setup';
import { setNumberFormat } from './util';

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

describe('display decimal places', () => {
  it('displays VND fractionlessly despite its shared 2dp storage scale', () => {
    expect(getDisplayDecimalPlaces('VND')).toBe(0);
  });

  it('keeps 2dp display for standard currencies', () => {
    expect(getDisplayDecimalPlaces('USD')).toBe(2);
  });

  it('keeps 0dp display for already-fractionless currencies', () => {
    expect(getDisplayDecimalPlaces('JPY')).toBe(0);
  });
});

describe('formatAccountAmount', () => {
  beforeEach(() => {
    setNumberFormat({ format: 'comma-dot', hideFraction: false });
  });

  it('formats VND fractionlessly while amounts stay stored at scale 100', () => {
    // 50,000 VND stored at the shared 2dp scale is 5,000,000.
    expect(formatAccountAmount(5000000, 'VND')).toBe('50,000');
  });

  it('formats USD rows with their usual 2dp precision', () => {
    expect(formatAccountAmount(1234, 'USD')).toBe('12.34');
  });

  it('is not affected by the Main currency, only the given currency code', () => {
    expect(formatAccountAmount(1234, 'USD')).toBe('12.34');
    expect(formatAccountAmount(5000000, 'VND')).toBe('50,000');
  });
});
