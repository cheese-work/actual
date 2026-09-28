import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useFormat } from './useFormat';

let mockPrefs: Record<string, string | undefined> = {
  defaultCurrencyCode: 'VND',
};

vi.mock('./useSyncedPref', () => ({
  useSyncedPref: (id: string) => [mockPrefs[id], vi.fn()],
}));

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

  it('renders a VND account under a USD Main with VND\'s own after-placement', () => {
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

  it('uses the Main currency\'s own user prefs when the code matches Main currency', () => {
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
