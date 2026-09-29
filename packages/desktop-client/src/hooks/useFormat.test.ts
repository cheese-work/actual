import { formatAccountAmount } from '@actual-app/core/shared/currency-setup';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useFormat } from './useFormat';

let mockPrefs: Record<string, string | undefined> = {
  defaultCurrencyCode: 'VND',
};

vi.mock('./useSyncedPref', () => ({
  useSyncedPref: (id: string) => [mockPrefs[id], vi.fn()],
}));

vi.mock('@actual-app/core/shared/currency-setup', async importOriginal => {
  const actual =
    await importOriginal<
      typeof import('@actual-app/core/shared/currency-setup')
    >();
  return {
    ...actual,
    formatAccountAmount: vi.fn(actual.formatAccountAmount),
  };
});

describe('useFormat VND storage scale', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrefs = { defaultCurrencyCode: 'VND' };
  });

  it('keeps VND amounts at the shared two-decimal storage scale', () => {
    const { result } = renderHook(() => useFormat());

    expect(result.current.fromEdit('50000')).toBe(5000000);
    expect(result.current.forEdit(5000000)).toBe('50,000.00');
    expect(result.current(5000000, 'financial')).toContain('50,000.00');
  });
});

describe('useFormat.forCurrency: effective account currency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a USD account row with its own symbol/placement when Main currency is VND', () => {
    // Main=VND puts the symbol after with a space (see Currency.tsx's
    // symbolFirst mapping) — a USD account must not inherit that.
    mockPrefs = {
      defaultCurrencyCode: 'VND',
      currencySymbolPosition: 'after',
      currencySpaceBetweenAmountAndSymbol: 'true',
    };
    const { result } = renderHook(() => useFormat());

    // 1234 stored (scale 100) is $12.34, symbol-before with no space (USD's
    // own symbolFirst convention), wrapped in directional isolation marks —
    // NOT after-with-space, which is what Main=VND's prefs would produce.
    expect(result.current.forCurrency(1234, 'USD')).toBe('‪$‬12.34');
  });

  it("renders a VND account under a USD Main with VND's own after-placement", () => {
    // Main=USD puts the symbol before with no space — a VND account must
    // not inherit that either.
    mockPrefs = {
      defaultCurrencyCode: 'USD',
      currencySymbolPosition: 'before',
      currencySpaceBetweenAmountAndSymbol: 'false',
    };
    const { result } = renderHook(() => useFormat());

    // 5,000,000 stored (scale 100) is 50,000 VND, displayed fractionlessly.
    expect(result.current.forCurrency(5000000, 'VND')).toBe('50,000 ₫');
  });

  it("uses the Main currency's own user prefs when the code matches Main currency", () => {
    mockPrefs = {
      defaultCurrencyCode: 'VND',
      currencySymbolPosition: 'after',
      currencySpaceBetweenAmountAndSymbol: 'true',
    };
    const { result } = renderHook(() => useFormat());

    // Symbol placement/spacing follow the user's Main-currency prefs
    // (after, with a space); decimal display is still fractionless for
    // VND regardless of the account/Main distinction.
    expect(result.current.forCurrency(5000000, 'VND')).toBe('50,000 ₫');
  });

  it('falls back to the Main currency formatter when no currency code is given', () => {
    mockPrefs = { defaultCurrencyCode: 'VND' };
    const { result } = renderHook(() => useFormat());

    expect(result.current.forCurrency(5000000, null)).toBe(
      result.current(5000000, 'financial'),
    );
    expect(result.current.forCurrency(5000000, undefined)).toBe(
      result.current(5000000, 'financial'),
    );
  });
});

// Prefs as Settings > Currency writes them when each Main currency is picked.
const usdMain = {
  defaultCurrencyCode: 'USD',
  numberFormat: 'comma-dot',
  hideFraction: 'false',
  currencySymbolPosition: 'before',
  currencySpaceBetweenAmountAndSymbol: 'false',
};
const vndMain = {
  defaultCurrencyCode: 'VND',
  numberFormat: 'comma-dot',
  hideFraction: 'false',
  currencySymbolPosition: 'after',
  currencySpaceBetweenAmountAndSymbol: 'true',
};

describe('useFormat.forCurrency: exact strings per Main currency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['USD', 'USD', 1234, '\u202A$\u202C12.34', usdMain],
    ['USD', 'CHF', 123456, '\u202AFr.\u202C\u202F1,234.56', usdMain],
    ['USD', 'VND', 5000000, '50,000\u202F₫', usdMain],
    ['VND', 'USD', 1234, '\u202A$\u202C12.34', vndMain],
    ['VND', 'CHF', 123456, '\u202AFr.\u202C\u202F1,234.56', vndMain],
    ['VND', 'VND', 5000000, '50,000\u202F₫', vndMain],
  ])('Main %s: %s %d renders as %j', (_main, code, value, expected, prefs) => {
    mockPrefs = prefs;
    const { result } = renderHook(() => useFormat());

    expect(result.current.forCurrency(value, code)).toBe(expected);
  });

  it("formats other currencies with the user's number format", () => {
    mockPrefs = { ...vndMain, numberFormat: 'dot-comma' };
    const { result } = renderHook(() => useFormat());

    expect(result.current.forCurrency(123456, 'USD')).toBe(
      '\u202A$\u202C1.234,56',
    );
  });

  it('delegates number formatting to the shared formatAccountAmount', () => {
    mockPrefs = { ...usdMain, numberFormat: 'dot-comma', hideFraction: 'true' };
    const { result } = renderHook(() => useFormat());

    result.current.forCurrency(123456, 'CHF');

    expect(formatAccountAmount).toHaveBeenCalledWith(123456, 'CHF', {
      format: 'dot-comma',
      hideFraction: true,
    });
  });
});
