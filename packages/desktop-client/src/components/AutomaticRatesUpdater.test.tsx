import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AutomaticRatesUpdater } from './AutomaticRatesUpdater';

const mocks = vi.hoisted(() => ({
  prefs: {
    defaultCurrencyCode: 'USD',
    'rateMode.EUR': 'auto',
  } as Record<string, string>,
  save: vi.fn(),
  fetchAutomaticRates: vi.fn<
    (
      sourceCodes: string[],
      mainCurrencyCode: string,
    ) => Promise<
      Array<{
        from: string;
        to: string;
        rate: string;
        fetchedAt: number;
      }>
    >
  >(),
  onVisible: null as null | (() => void | Promise<void>),
}));

vi.mock('#hooks/useSyncedPrefs', () => ({
  useSyncedPrefs: () => [mocks.prefs, mocks.save],
}));

vi.mock('#hooks/useOnVisible', () => ({
  useOnVisible: (callback: () => void | Promise<void>) => {
    mocks.onVisible = callback;
  },
}));

vi.mock('@actual-app/core/shared/automatic-rates', async () => {
  const actual = await vi.importActual(
    '@actual-app/core/shared/automatic-rates',
  );
  return { ...actual, fetchAutomaticRates: mocks.fetchAutomaticRates };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('AutomaticRatesUpdater', () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocks.prefs = {
      defaultCurrencyCode: 'USD',
      'rateMode.EUR': 'auto',
    };
    mocks.save.mockReset();
    mocks.fetchAutomaticRates.mockReset();
    mocks.onVisible = null;
  });

  it('runs the latest refresh after currency and mode change in flight', async () => {
    const firstRequest =
      deferred<
        Array<{ from: string; to: string; rate: string; fetchedAt: number }>
      >();
    mocks.fetchAutomaticRates
      .mockReturnValueOnce(firstRequest.promise)
      .mockResolvedValueOnce([
        { from: 'GBP', to: 'JPY', rate: '190', fetchedAt: Date.now() },
      ]);
    const { rerender } = render(<AutomaticRatesUpdater budgetId="budget" />);

    await waitFor(() =>
      expect(mocks.fetchAutomaticRates).toHaveBeenCalledOnce(),
    );
    mocks.prefs = {
      defaultCurrencyCode: 'GBP',
      'rateMode.JPY': 'auto',
    };
    rerender(<AutomaticRatesUpdater budgetId="budget" />);

    await act(async () => {
      firstRequest.resolve([
        { from: 'USD', to: 'EUR', rate: '0.9', fetchedAt: Date.now() },
      ]);
      await firstRequest.promise;
    });

    await waitFor(() =>
      expect(mocks.fetchAutomaticRates).toHaveBeenCalledTimes(2),
    );
    expect(mocks.fetchAutomaticRates).toHaveBeenLastCalledWith(['JPY'], 'GBP');
    expect(mocks.save).toHaveBeenCalledWith({
      'autoRate.GBP.JPY': expect.any(String),
    });
    expect(mocks.save).not.toHaveBeenCalledWith({
      'autoRate.USD.EUR': expect.any(String),
    });
  });

  it('backs off failed background attempts while allowing retry after cooldown', async () => {
    vi.useFakeTimers();
    mocks.fetchAutomaticRates.mockRejectedValue(new Error('offline'));
    render(<AutomaticRatesUpdater budgetId="budget" />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.fetchAutomaticRates).toHaveBeenCalledOnce();

    await act(async () => {
      await mocks.onVisible?.();
    });
    expect(mocks.fetchAutomaticRates).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
      await mocks.onVisible?.();
    });
    expect(mocks.fetchAutomaticRates).toHaveBeenCalledTimes(2);
  });
});
