import type { SyncedPrefs } from '#types/prefs';

import {
  finalizeCurrencySetup,
  formatAccountAmount,
  getCurrencySetup,
  getDisplayDecimalPlaces,
  getEffectiveAccountCurrency,
  reformatAccountAmountInput,
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

const commaDot = { format: 'comma-dot', hideFraction: false } as const;

describe('formatAccountAmount', () => {
  beforeEach(() => {
    setNumberFormat({ format: 'comma-dot', hideFraction: false });
  });

  it('formats VND fractionlessly while amounts stay stored at scale 100', () => {
    // 50,000 VND stored at the shared 2dp scale is 5,000,000.
    expect(formatAccountAmount(5000000, 'VND', commaDot)).toBe('50,000');
  });

  it('formats USD rows with their usual 2dp precision', () => {
    expect(formatAccountAmount(1234, 'USD', commaDot)).toBe('12.34');
  });

  it('is not affected by the Main currency, only the given currency code', () => {
    expect(formatAccountAmount(1234, 'USD', commaDot)).toBe('12.34');
    expect(formatAccountAmount(5000000, 'VND', commaDot)).toBe('50,000');
  });

  it('uses the given number format, not the global one useFormat syncs a render late', () => {
    // The global config is still comma-dot (see beforeEach).
    expect(
      formatAccountAmount(123456, 'USD', {
        format: 'dot-comma',
        hideFraction: false,
      }),
    ).toBe('1.234,56');
  });

  it('hides the fraction when asked, like forCurrency', () => {
    expect(
      formatAccountAmount(123456, 'USD', {
        format: 'comma-dot',
        hideFraction: true,
      }),
    ).toBe('1,235');
  });
});

describe('reformatAccountAmountInput', () => {
  beforeEach(() => {
    setNumberFormat({ format: 'comma-dot', hideFraction: false });
  });

  it("reformats a typed amount at the account currency's display precision", () => {
    expect(reformatAccountAmountInput('50000', 'VND', commaDot)).toBe('50,000');
    expect(reformatAccountAmountInput('12.3', 'USD', commaDot)).toBe('12.30');
  });

  it('keeps an empty input empty', () => {
    expect(reformatAccountAmountInput('', 'USD', commaDot)).toBe('');
  });
});
