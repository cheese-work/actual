import { vi } from 'vitest';

import {
  convert,
  customUnitKey,
  exchangeRatePrefError,
  formatInverseRate,
  formatRateForInput,
  getAutomaticRate,
  getCustomUnits,
  getManualRates,
  isValidRate,
  manualRateKey,
  parseRateInput,
  removeCustomUnitPatch,
  serializeCustomUnit,
  setManualRatePatch,
  validateCustomUnit,
} from './exchange-rates';
import type { CustomUnit } from './exchange-rates';
import { MAX_SAFE_NUMBER } from './util';

// Amounts are stored at scale 100 for every currency: 10000 is 100.00.
const rates = {
  [manualRateKey('USD', 'VND')]: '25400',
  [manualRateKey('X-BANANA', 'VND')]: '3000',
  [manualRateKey('VND', 'EUR')]: '0.000037',
};

const banana: CustomUnit = {
  code: 'X-BANANA',
  name: 'Banana',
  symbol: '🍌',
  decimals: 0,
};

describe('convert', () => {
  it('returns the amount unchanged for the same currency, with no rates', () => {
    expect(convert(12345, 'USD', 'USD', {})).toBe(12345);
  });

  it('applies a direct rate: 1 USD = 25400 VND', () => {
    expect(convert(10000, 'USD', 'VND', rates)).toBe(254000000);
  });

  it('derives the inverse of a rate: 25400 VND -> 1 USD', () => {
    expect(convert(2540000, 'VND', 'USD', rates)).toBe(100);
    expect(convert(254000000, 'VND', 'USD', rates)).toBe(10000);
  });

  it('rounds an inverse result once, to a storage integer', () => {
    // 1000.00 VND / 25400 = 0.03937 USD -> 3.937 at scale 100 -> 4
    expect(convert(100000, 'VND', 'USD', rates)).toBe(4);
  });

  it('converts custom units both ways', () => {
    // 2.00 bananas = 6000.00 VND
    expect(convert(200, 'X-BANANA', 'VND', rates)).toBe(600000);
    expect(convert(600000, 'VND', 'X-BANANA', rates)).toBe(200);
  });

  it('handles a small rate without float error: 12,000,000 VND at 0.000037', () => {
    // 12,000,000.00 VND x 0.000037 = 444.00 EUR
    expect(convert(1200000000, 'VND', 'EUR', rates)).toBe(44400);
  });

  it('keeps the sign of negative amounts', () => {
    expect(convert(-10000, 'USD', 'VND', rates)).toBe(-254000000);
    expect(convert(-254000000, 'VND', 'USD', rates)).toBe(-10000);
  });

  it('rounds exact ties half to even, positive and negative', () => {
    const half = { [manualRateKey('A', 'B')]: '0.5' };
    expect(convert(5, 'A', 'B', half)).toBe(2); // 2.5 -> 2
    expect(convert(7, 'A', 'B', half)).toBe(4); // 3.5 -> 4
    expect(convert(-5, 'A', 'B', half)).toBe(-2);
    expect(convert(-7, 'A', 'B', half)).toBe(-4);
  });

  it('prefers the direct rate when both directions are stored', () => {
    const both = {
      [manualRateKey('USD', 'VND')]: '25000',
      [manualRateKey('VND', 'USD')]: '0.00005',
    };
    expect(convert(10000, 'USD', 'VND', both)).toBe(250000000);
  });

  describe('missing rate', () => {
    it('returns null when no rate connects the pair', () => {
      expect(convert(10000, 'USD', 'EUR', {})).toBeNull();
      expect(convert(10000, 'USD', 'EUR', rates)).toBeNull();
    });

    it('does not chain rates through a third currency', () => {
      // USD -> VND and VND -> EUR exist, but USD -> EUR is not derived
      expect(convert(10000, 'USD', 'EUR', rates)).toBeNull();
    });

    it.each(['0', '0.0', '-5', '1e3', 'abc', ''])(
      'treats the malformed rate %j as missing',
      bad => {
        expect(
          convert(10000, 'USD', 'VND', { [manualRateKey('USD', 'VND')]: bad }),
        ).toBeNull();
      },
    );
  });

  it('rejects a result too large to handle safely', () => {
    const huge = { [manualRateKey('A', 'B')]: '1000000' };
    expect(() => convert(MAX_SAFE_NUMBER, 'A', 'B', huge)).toThrow(
      /safeNumber/,
    );
  });

  it('rejects a non-integer amount', () => {
    expect(() => convert(1.5, 'USD', 'VND', rates)).toThrow(/safeNumber/);
  });
});

describe('automatic rates', () => {
  const automaticPrefs = {
    'rateMode.EUR': 'auto',
    'autoRate.EUR.USD': JSON.stringify({
      rate: '1.08',
      fetchedAt: 1790870400000,
    }),
  };

  it('uses a cached automatic rate only when its source is in auto mode', () => {
    expect(convert(10000, 'EUR', 'USD', automaticPrefs)).toBe(10800);
    expect(getAutomaticRate(automaticPrefs, 'EUR', 'USD')).toEqual({
      from: 'EUR',
      to: 'USD',
      rate: '1.08',
      fetchedAt: 1790870400000,
    });
    expect(
      convert(10000, 'EUR', 'USD', {
        ...automaticPrefs,
        'rateMode.EUR': 'manual',
      }),
    ).toBeNull();
  });

  it('always prefers a manual rate over the cached automatic rate', () => {
    expect(
      convert(10000, 'EUR', 'USD', {
        ...automaticPrefs,
        'manualRate.EUR.USD': '1.2',
      }),
    ).toBe(12000);
  });

  it('uses a cached Main-to-currency rate inversely for an auto currency', () => {
    const prefs = {
      'rateMode.EUR': 'auto',
      'autoRate.USD.EUR': JSON.stringify({
        rate: '1.1',
        fetchedAt: 1790870400000,
      }),
    };

    expect(convert(11000, 'EUR', 'USD', prefs)).toBe(10000);
    expect(getAutomaticRate(prefs, 'EUR', 'USD')).toEqual({
      from: 'USD',
      to: 'EUR',
      rate: '1.1',
      fetchedAt: 1790870400000,
    });
  });

  it('uses the fresher inverse cache after the Main currency flips', () => {
    const fetchedAt = 1790870400000;
    const prefs = {
      'rateMode.USD': 'auto',
      'autoRate.USD.EUR': JSON.stringify({
        rate: '0.9',
        fetchedAt: fetchedAt - 86400000,
      }),
      'autoRate.EUR.USD': JSON.stringify({ rate: '1.1', fetchedAt }),
    };

    expect(getAutomaticRate(prefs, 'USD', 'EUR', fetchedAt)).toEqual({
      from: 'EUR',
      to: 'USD',
      rate: '1.1',
      fetchedAt,
    });
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(fetchedAt);
    try {
      expect(convert(11000, 'USD', 'EUR', prefs)).toBe(10000);
    } finally {
      dateNow.mockRestore();
    }
  });

  it('does not treat a synced future timestamp as newer than a current cache', () => {
    const now = 1790870400000;
    const prefs = {
      'rateMode.EUR': 'auto',
      'autoRate.USD.EUR': JSON.stringify({ rate: '0.9', fetchedAt: now }),
      'autoRate.EUR.USD': JSON.stringify({
        rate: '1.25',
        fetchedAt: now + 30 * 86400000,
      }),
    };

    expect(getAutomaticRate(prefs, 'USD', 'EUR', now)).toEqual({
      from: 'USD',
      to: 'EUR',
      rate: '0.9',
      fetchedAt: now,
    });
  });
});

describe('isValidRate', () => {
  it.each(['1', '25400', '0.000039', '1.5', '999999999999999.123'])(
    'accepts %j',
    rate => {
      expect(isValidRate(rate)).toBe(true);
    },
  );

  it.each([
    '',
    '0',
    '0.00',
    '-1',
    '1e5',
    ' 1',
    '1 ',
    '1,5',
    '.5',
    '5.',
    'abc',
    '1234567890123456', // 16 integer digits
    '1.1234567890123456', // 16 fraction digits
  ])('rejects %j', rate => {
    expect(isValidRate(rate)).toBe(false);
  });
});

describe('formatInverseRate', () => {
  it('shows the inverse to six significant digits', () => {
    expect(formatInverseRate('25400')).toBe('0.0000393701');
    expect(formatInverseRate('4')).toBe('0.25');
    expect(formatInverseRate('3')).toBe('0.333333');
    expect(formatInverseRate('0.000039')).toBe('25641');
  });

  it('returns an empty string for an invalid rate', () => {
    expect(formatInverseRate('0')).toBe('');
    expect(formatInverseRate('nope')).toBe('');
  });
});

describe('validateCustomUnit', () => {
  it('accepts a well-formed unit', () => {
    expect(validateCustomUnit(banana)).toBeNull();
    expect(validateCustomUnit({ ...banana, decimals: 2 })).toBeNull();
  });

  it.each(['USD', 'x-banana', 'X-', 'X-TOOLONGCODE', 'X-BAN ANA', '', 'X_BAN'])(
    'requires an X- prefixed upper-case code: rejects %j',
    code => {
      expect(validateCustomUnit({ ...banana, code })).toBe('code');
    },
  );

  it('requires a non-blank name and symbol', () => {
    expect(validateCustomUnit({ ...banana, name: '  ' })).toBe('name');
    expect(validateCustomUnit({ ...banana, symbol: '' })).toBe('symbol');
    expect(validateCustomUnit({ ...banana, name: 'x'.repeat(41) })).toBe(
      'name',
    );
    expect(validateCustomUnit({ ...banana, symbol: 'x'.repeat(9) })).toBe(
      'symbol',
    );
  });

  it.each([-1, 3, 1.5, NaN, '2'])(
    'limits display decimals to the storage precision (0-2): rejects %j',
    decimals => {
      expect(validateCustomUnit({ ...banana, decimals })).toBe('decimals');
    },
  );
});

describe('getCustomUnits', () => {
  it('reads units from synced prefs, sorted by code', () => {
    const choco: CustomUnit = {
      code: 'X-CHOCO',
      name: 'Chocolate coin',
      symbol: 'CC',
      decimals: 1,
    };
    expect(
      getCustomUnits({
        [customUnitKey('X-CHOCO')]: serializeCustomUnit(choco),
        [customUnitKey('X-BANANA')]: serializeCustomUnit(banana),
        numberFormat: 'comma-dot',
      }),
    ).toEqual([banana, choco]);
  });

  it('round-trips through serializeCustomUnit', () => {
    expect(
      getCustomUnits({
        [customUnitKey(banana.code)]: serializeCustomUnit(banana),
      }),
    ).toEqual([banana]);
  });

  it('ignores garbage synced by another client or version', () => {
    expect(
      getCustomUnits({
        [customUnitKey('X-BANANA')]: 'not json',
        [customUnitKey('X-NULL')]: 'null',
        [customUnitKey('X-BAD')]: JSON.stringify({ name: 'Bad', symbol: 'B' }),
        [customUnitKey('X-DEC')]: JSON.stringify({
          name: 'Dec',
          symbol: 'D',
          decimals: 9,
        }),
        [customUnitKey('USD')]: serializeCustomUnit({ ...banana, code: 'USD' }),
        [customUnitKey('X-GONE')]: '',
      }),
    ).toEqual([]);
  });
});

describe('getManualRates', () => {
  it('lists valid rates from synced prefs, sorted by pair', () => {
    expect(
      getManualRates({
        [manualRateKey('X-BANANA', 'VND')]: '3000',
        [manualRateKey('USD', 'VND')]: '25400',
        numberFormat: 'comma-dot',
      }),
    ).toEqual([
      { from: 'USD', to: 'VND', rate: '25400' },
      { from: 'X-BANANA', to: 'VND', rate: '3000' },
    ]);
  });

  it('ignores removed, malformed and mis-keyed entries', () => {
    expect(
      getManualRates({
        [manualRateKey('USD', 'VND')]: '', // removed
        [manualRateKey('EUR', 'VND')]: '0',
        [manualRateKey('GBP', 'VND')]: 'abc',
        'manualRate.USD': '25400', // no quote
        'manualRate.usd.vnd': '25400', // lower case
        'manualRate.USD.VND.EXTRA': '25400',
        'manualRate.USD.USD': '1', // same currency
        'manualRate.__proto__.VND': '5',
      }),
    ).toEqual([]);
  });
});

describe('parseRateInput', () => {
  it('accepts plain digits with the format decimal mark', () => {
    expect(parseRateInput('25400', 'comma-dot')).toBe('25400');
    expect(parseRateInput(' 0.000039 ', 'comma-dot')).toBe('0.000039');
    expect(parseRateInput('0,000039', 'dot-comma')).toBe('0.000039');
    expect(parseRateInput('0,5', 'space-comma')).toBe('0.5');
    expect(parseRateInput('.5', 'comma-dot')).toBe('0.5');
  });

  it('rejects thousands separators and the other format decimal mark', () => {
    // "1,5" in a dot-decimal format must not silently become 15, and
    // "25.400" in a comma-decimal format must not silently become 25.4
    expect(parseRateInput('1,5', 'comma-dot')).toBeNull();
    expect(parseRateInput('25,400', 'comma-dot')).toBeNull();
    expect(parseRateInput('25.400', 'dot-comma')).toBeNull();
    expect(parseRateInput('25 400', 'space-comma')).toBeNull();
    expect(parseRateInput("25'400", 'apostrophe-dot')).toBeNull();
  });

  it.each(['', '0', '0.00', '-1', 'abc', '1e3'])('rejects %j', input => {
    expect(parseRateInput(input, 'comma-dot')).toBeNull();
  });
});

describe('formatRateForInput', () => {
  it('uses the format decimal mark, round-tripping with parseRateInput', () => {
    expect(formatRateForInput('0.000039', 'dot-comma')).toBe('0,000039');
    expect(formatRateForInput('0.000039', 'comma-dot')).toBe('0.000039');
    expect(
      parseRateInput(formatRateForInput('25400.5', 'dot-comma'), 'dot-comma'),
    ).toBe('25400.5');
  });
});

describe('setManualRatePatch', () => {
  it('writes the rate under its pair key', () => {
    expect(setManualRatePatch({}, 'USD', 'VND', '25400')).toEqual({
      'manualRate.USD.VND': '25400',
    });
  });

  it('clears a stale reverse-direction rate so the two directions never disagree', () => {
    const prefs = { [manualRateKey('VND', 'USD')]: '0.00005' };
    const patch = setManualRatePatch(prefs, 'USD', 'VND', '26000');

    expect(patch).toEqual({
      'manualRate.USD.VND': '26000',
      'manualRate.VND.USD': '',
    });
    // Without the clear, the stale VND->USD rate would win over the new one
    const applied = { ...prefs, ...patch };
    expect(convert(10000, 'VND', 'USD', applied)).toBe(
      convert(10000, 'VND', 'USD', { [manualRateKey('USD', 'VND')]: '26000' }),
    );
  });

  it('removes the rate in both directions when given an empty rate', () => {
    const prefs = {
      [manualRateKey('USD', 'VND')]: '25400',
      [manualRateKey('VND', 'USD')]: '0.00005',
    };
    expect(setManualRatePatch(prefs, 'USD', 'VND', '')).toEqual({
      'manualRate.USD.VND': '',
      'manualRate.VND.USD': '',
    });
  });

  it('does nothing for a currency paired with itself', () => {
    expect(setManualRatePatch({}, 'USD', 'USD', '1')).toEqual({});
  });
});

describe('removeCustomUnitPatch', () => {
  it('clears the unit and every rate that involves it, in either direction', () => {
    const prefs = {
      [customUnitKey('X-BANANA')]: serializeCustomUnit(banana),
      [manualRateKey('X-BANANA', 'VND')]: '3000',
      [manualRateKey('EUR', 'X-BANANA')]: '2',
      [manualRateKey('USD', 'VND')]: '25400',
    };
    expect(removeCustomUnitPatch(prefs, 'X-BANANA')).toEqual({
      'customUnit.X-BANANA': '',
      'manualRate.X-BANANA.VND': '',
      'manualRate.EUR.X-BANANA': '',
    });
  });
});

describe('exchangeRatePrefError', () => {
  it('ignores unrelated prefs', () => {
    expect(exchangeRatePrefError('numberFormat', 'comma-dot')).toBeNull();
    expect(exchangeRatePrefError('manualRateXYZ', 'abc')).toBeNull();
  });

  it('accepts valid rates, valid units and removals', () => {
    expect(exchangeRatePrefError('manualRate.USD.VND', '25400')).toBeNull();
    expect(exchangeRatePrefError('manualRate.USDT.USD', '1')).toBeNull();
    expect(exchangeRatePrefError('manualRate.USD.USDT', '1')).toBeNull();
    expect(exchangeRatePrefError('manualRate.USD.VND', '')).toBeNull();
    expect(
      exchangeRatePrefError('customUnit.X-BANANA', serializeCustomUnit(banana)),
    ).toBeNull();
    expect(exchangeRatePrefError('customUnit.X-BANANA', '')).toBeNull();
    expect(exchangeRatePrefError('rateMode.EUR', 'auto')).toBeNull();
    expect(exchangeRatePrefError('rateMode.USDT', 'auto')).toBeNull();
    expect(
      exchangeRatePrefError(
        'autoRate.EUR.USD',
        JSON.stringify({ rate: '0.92', fetchedAt: 1790870400000 }),
      ),
    ).toBeNull();
    expect(
      exchangeRatePrefError(
        'autoRate.USDT.USD',
        JSON.stringify({ rate: '1', fetchedAt: 1790870400000 }),
      ),
    ).toBeNull();
    expect(exchangeRatePrefError('autoRate.EUR.USD', '')).toBeNull();
  });

  it('rejects invalid automatic modes and cached values', () => {
    expect(exchangeRatePrefError('rateMode.EUR', 'sometimes')).toMatch(/mode/i);
    expect(exchangeRatePrefError('rateMode.X-BANANA', 'auto')).toMatch(
      /currency code/i,
    );
    expect(exchangeRatePrefError('autoRate.USDT.USDT', '1')).toMatch(
      /currency pair/i,
    );
    expect(
      exchangeRatePrefError(
        'autoRate.EUR.USD',
        JSON.stringify({ rate: '1e3', fetchedAt: 1790870400000 }),
      ),
    ).toMatch(/automatic rate/i);
    expect(
      exchangeRatePrefError(
        'autoRate.EUR.USD',
        JSON.stringify({ rate: '0.92', fetchedAt: 'yesterday' }),
      ),
    ).toMatch(/automatic rate/i);
  });

  it.each(['0', '-1', '1e3', 'abc', ' 5', '1,5'])(
    'rejects the rate %j (a rate must be greater than 0)',
    bad => {
      expect(exchangeRatePrefError('manualRate.USD.VND', bad)).toMatch(
        /greater than 0/i,
      );
    },
  );

  it.each([
    'manualRate.USD.USD',
    'manualRate.usd.vnd',
    'manualRate.USD',
    'manualRate.USD.VND.EXTRA',
  ])('rejects the malformed rate key %j', key => {
    expect(exchangeRatePrefError(key, '5')).toMatch(/currency pair/i);
  });

  it('rejects an invalid unit definition', () => {
    expect(exchangeRatePrefError('customUnit.X-BANANA', 'not json')).toMatch(
      /custom unit/i,
    );
    expect(
      exchangeRatePrefError('customUnit.USD', serializeCustomUnit(banana)),
    ).toMatch(/code/i);
    expect(
      exchangeRatePrefError(
        'customUnit.X-BANANA',
        JSON.stringify({ name: 'Banana', symbol: '🍌', decimals: 3 }),
      ),
    ).toMatch(/decimals/i);
  });

  it('requires a string value: an empty string removes, undefined is refused', () => {
    expect(exchangeRatePrefError('manualRate.USD.VND', undefined)).toMatch(
      /empty string/i,
    );
    expect(exchangeRatePrefError('customUnit.X-BANANA', undefined)).toMatch(
      /empty string/i,
    );
  });
});

describe('keys', () => {
  it('namespaces synced prefs', () => {
    expect(manualRateKey('USD', 'VND')).toBe('manualRate.USD.VND');
    expect(customUnitKey('X-BANANA')).toBe('customUnit.X-BANANA');
  });
});
