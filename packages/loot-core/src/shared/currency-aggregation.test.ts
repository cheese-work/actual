import { aggregateAccountAmountsInMainCurrency } from './currency-aggregation';
import type { CurrencyAccount } from './currency-aggregation';
import { automaticRateKey, manualRateKey } from './exchange-rates';
import { MAX_SAFE_NUMBER } from './util';

const accounts = [
  { id: 'vnd', currency: null },
  { id: 'usd', currency: 'USD' },
  { id: 'banana', currency: 'X-BANANA' },
] satisfies readonly CurrencyAccount[];

describe('aggregateAccountAmountsInMainCurrency', () => {
  it('converts each account and custom unit into Main before totaling', () => {
    const result = aggregateAccountAmountsInMainCurrency(
      [
        { accountId: 'vnd', amount: 100_000_000 },
        { accountId: 'usd', amount: 40_000 },
        { accountId: 'banana', amount: 300 },
      ],
      accounts,
      {
        defaultCurrencyCode: 'VND',
        [manualRateKey('USD', 'VND')]: '25000',
        [manualRateKey('X-BANANA', 'VND')]: '5000',
      },
    );

    expect(result).toEqual({ status: 'complete', amount: 1_101_500_000 });
  });

  it('returns unavailable before loading or empty checks when Main is missing', () => {
    expect(aggregateAccountAmountsInMainCurrency(null, [], {})).toEqual({
      status: 'unavailable',
    });
    expect(aggregateAccountAmountsInMainCurrency([], [], {})).toEqual({
      status: 'unavailable',
    });
  });

  it('distinguishes loading from a genuine empty zero', () => {
    const prefs = { defaultCurrencyCode: 'VND' };

    expect(aggregateAccountAmountsInMainCurrency(null, [], prefs)).toEqual({
      status: 'loading',
    });
    expect(aggregateAccountAmountsInMainCurrency([], [], prefs)).toEqual({
      status: 'complete',
      amount: 0,
    });
  });

  it('converts negative amounts using an inverse-only rate', () => {
    const result = aggregateAccountAmountsInMainCurrency(
      [{ accountId: 'usd', amount: -40_000 }],
      accounts,
      {
        defaultCurrencyCode: 'VND',
        [manualRateKey('VND', 'USD')]: '0.00004',
      },
    );

    expect(result).toEqual({ status: 'complete', amount: -1_000_000_000 });
  });

  it('uses cached automatic rates only when the source currency is in auto mode', () => {
    const result = aggregateAccountAmountsInMainCurrency(
      [{ accountId: 'usd', amount: 20_000 }],
      accounts,
      {
        defaultCurrencyCode: 'VND',
        'rateMode.USD': 'auto',
        [automaticRateKey('USD', 'VND')]: JSON.stringify({
          rate: '25000',
          fetchedAt: Date.now(),
        }),
      },
    );

    expect(result).toEqual({ status: 'complete', amount: 500_000_000 });
  });

  it('sums native amounts per account and bucket before half-even conversion', () => {
    const prefs = {
      defaultCurrencyCode: 'EUR',
      [manualRateKey('USD', 'EUR')]: '0.5',
    };
    const entries = [
      { accountId: 'usd', bucketId: '2026-01', amount: 1 },
      { accountId: 'usd', bucketId: '2026-01', amount: 2 },
    ];

    expect(
      aggregateAccountAmountsInMainCurrency(entries, accounts, prefs),
    ).toEqual({ status: 'complete', amount: 2 });
    expect(
      aggregateAccountAmountsInMainCurrency(
        [...entries].reverse(),
        accounts,
        prefs,
      ),
    ).toEqual({ status: 'complete', amount: 2 });
    expect(
      aggregateAccountAmountsInMainCurrency(
        [
          { accountId: 'usd', bucketId: '2026-01', amount: -1 },
          { accountId: 'usd', bucketId: '2026-01', amount: -2 },
        ],
        accounts,
        prefs,
      ),
    ).toEqual({ status: 'complete', amount: -2 });
  });

  it('rounds separately at each account-and-bucket leaf', () => {
    const result = aggregateAccountAmountsInMainCurrency(
      [
        { accountId: 'usd', bucketId: '2026-01', amount: 1 },
        { accountId: 'usd', bucketId: '2026-02', amount: 1 },
      ],
      accounts,
      {
        defaultCurrencyCode: 'EUR',
        [manualRateKey('USD', 'EUR')]: '0.5',
      },
    );

    expect(result).toEqual({ status: 'complete', amount: 0 });
  });

  it('returns one signed display-only rounding adjustment without changing the total', () => {
    const prefs = { defaultCurrencyCode: 'VND' };
    const display = {
      displayDecimalPlaces: 0,
      immediateChildAmounts: [49, 49],
    };

    expect(
      aggregateAccountAmountsInMainCurrency(
        [{ accountId: 'vnd', amount: 98 }],
        accounts,
        prefs,
        display,
      ),
    ).toEqual({
      status: 'complete',
      amount: 98,
      presentationAdjustment: {
        label: 'Rounding adjustment',
        amount: 100,
        displayOnly: true,
        placement: 'last-child',
      },
    });

    expect(
      aggregateAccountAmountsInMainCurrency(
        [{ accountId: 'vnd', amount: -98 }],
        accounts,
        prefs,
        { ...display, immediateChildAmounts: [-49, -49] },
      ),
    ).toEqual({
      status: 'complete',
      amount: -98,
      presentationAdjustment: {
        label: 'Rounding adjustment',
        amount: -100,
        displayOnly: true,
        placement: 'last-child',
      },
    });
  });

  it('returns unavailable for missing rates, unknown accounts, unsafe inputs, and overflow', () => {
    const prefs = { defaultCurrencyCode: 'VND' };

    expect(
      aggregateAccountAmountsInMainCurrency(
        [{ accountId: 'usd', amount: 100 }],
        accounts,
        prefs,
      ),
    ).toEqual({ status: 'unavailable' });
    expect(
      aggregateAccountAmountsInMainCurrency(
        [{ accountId: 'missing', amount: 100 }],
        accounts,
        prefs,
      ),
    ).toEqual({ status: 'unavailable' });
    expect(
      aggregateAccountAmountsInMainCurrency(
        [{ accountId: 'vnd', amount: MAX_SAFE_NUMBER + 1 }],
        accounts,
        prefs,
      ),
    ).toEqual({ status: 'unavailable' });
    expect(
      aggregateAccountAmountsInMainCurrency(
        [
          { accountId: 'vnd', amount: MAX_SAFE_NUMBER },
          { accountId: 'usd', amount: MAX_SAFE_NUMBER },
        ],
        accounts,
        { defaultCurrencyCode: 'VND', [manualRateKey('USD', 'VND')]: '1' },
      ),
    ).toEqual({ status: 'unavailable' });
  });
});
