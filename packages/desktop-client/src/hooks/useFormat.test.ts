import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useFormat } from './useFormat';

vi.mock('./useSyncedPref', () => ({
  useSyncedPref: (id: string) => [
    id === 'defaultCurrencyCode' ? 'VND' : undefined,
    vi.fn(),
  ],
}));

describe('useFormat VND storage scale', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('renders a USD account row with its own symbol when Main currency is VND', () => {
    const { result } = renderHook(() => useFormat());

    // 1234 stored (scale 100) is $12.34.
    const formatted = result.current.forCurrency(1234, 'USD');
    expect(formatted).toContain('$');
    expect(formatted).toContain('12.34');
  });

  it('renders a VND row fractionlessly while storage stays at scale 100', () => {
    const { result } = renderHook(() => useFormat());

    // 5,000,000 stored (scale 100) is 50,000 VND, displayed with no fraction.
    expect(result.current.forCurrency(5000000, 'VND')).toContain('50,000');
    expect(result.current.forCurrency(5000000, 'VND')).not.toContain('.');
  });

  it('falls back to the Main currency formatter when no currency code is given', () => {
    const { result } = renderHook(() => useFormat());

    expect(result.current.forCurrency(5000000, null)).toBe(
      result.current(5000000, 'financial'),
    );
    expect(result.current.forCurrency(5000000, undefined)).toBe(
      result.current(5000000, 'financial'),
    );
  });
});
