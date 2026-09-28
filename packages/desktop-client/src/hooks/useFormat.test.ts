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
