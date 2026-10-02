import {
  AUTOMATIC_RATE_REFRESH_INTERVAL_MS,
  AUTOMATIC_RATE_RETRY_INTERVAL_MS,
} from '@actual-app/core/shared/automatic-rates';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
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

  it('keeps an old budget finalizer from replacing the new budget retry timer', async () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(window, 'setTimeout');
    const oldBudgetRequest =
      deferred<
        Array<{ from: string; to: string; rate: string; fetchedAt: number }>
      >();
    mocks.fetchAutomaticRates
      .mockReturnValueOnce(oldBudgetRequest.promise)
      .mockRejectedValueOnce(new Error('offline'));
    const { rerender } = render(
      <AutomaticRatesUpdater budgetId="old-budget" />,
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.fetchAutomaticRates).toHaveBeenCalledOnce();

    mocks.prefs = {
      defaultCurrencyCode: 'GBP',
      'rateMode.JPY': 'auto',
    };
    rerender(<AutomaticRatesUpdater budgetId="new-budget" />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.fetchAutomaticRates).toHaveBeenCalledTimes(2);
    expect(timeoutSpy.mock.calls.at(-1)?.[1]).toBe(15 * 60 * 1000);
    timeoutSpy.mockClear();

    await act(async () => {
      oldBudgetRequest.resolve([
        { from: 'USD', to: 'EUR', rate: '0.9', fetchedAt: Date.now() },
      ]);
      await oldBudgetRequest.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(timeoutSpy).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000 - 1);
    });
    expect(mocks.fetchAutomaticRates).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.fetchAutomaticRates).toHaveBeenCalledTimes(3);
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
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000 - 1);
    });
    expect(mocks.fetchAutomaticRates).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.fetchAutomaticRates).toHaveBeenCalledTimes(2);
  });

  it('schedules stale-cache refreshes at expiry without earlier provider calls', async () => {
    vi.useFakeTimers();
    mocks.fetchAutomaticRates.mockImplementation(async () => [
      {
        from: 'USD',
        to: 'EUR',
        rate: '0.9',
        fetchedAt: Date.now(),
      },
    ]);
    render(<AutomaticRatesUpdater budgetId="budget" />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.fetchAutomaticRates).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOMATIC_RATE_REFRESH_INTERVAL_MS - 1);
    });
    expect(mocks.fetchAutomaticRates).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.fetchAutomaticRates).toHaveBeenCalledTimes(2);
  });

  it('does not refetch a stale direct pair when the inverse pair is fresher', async () => {
    vi.useFakeTimers();
    const fetchedAt = Date.now() - 60000;
    mocks.prefs = {
      defaultCurrencyCode: 'EUR',
      'rateMode.USD': 'auto',
      'autoRate.USD.EUR': JSON.stringify({
        rate: '0.9',
        fetchedAt: fetchedAt - AUTOMATIC_RATE_REFRESH_INTERVAL_MS,
      }),
      'autoRate.EUR.USD': JSON.stringify({ rate: '1.1', fetchedAt }),
    };
    render(<AutomaticRatesUpdater budgetId="budget" />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.fetchAutomaticRates).not.toHaveBeenCalled();

    const untilExpiry = AUTOMATIC_RATE_REFRESH_INTERVAL_MS - 60000;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(untilExpiry - 1);
    });
    expect(mocks.fetchAutomaticRates).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.fetchAutomaticRates).toHaveBeenCalledOnce();
  });

  it('writes and schedules refreshed cached pairs when Main retains auto mode', async () => {
    vi.useFakeTimers();
    const fetchedAt = Date.now();
    mocks.prefs = {
      defaultCurrencyCode: 'EUR',
      'rateMode.EUR': 'auto',
      'autoRate.USD.EUR': JSON.stringify({
        rate: '0.9',
        fetchedAt: fetchedAt - 2 * AUTOMATIC_RATE_REFRESH_INTERVAL_MS,
      }),
    };
    mocks.fetchAutomaticRates.mockResolvedValue([
      { from: 'EUR', to: 'USD', rate: '1.25', fetchedAt },
    ]);
    render(<AutomaticRatesUpdater budgetId="budget" />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.fetchAutomaticRates).toHaveBeenCalledOnce();
    expect(mocks.save).toHaveBeenCalledWith({
      'autoRate.EUR.USD': JSON.stringify({ rate: '1.25', fetchedAt }),
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.fetchAutomaticRates).toHaveBeenCalledOnce();
  });

  it('cold-starts Main Auto, writes rates, and waits for daily expiry', async () => {
    vi.useFakeTimers();
    mocks.prefs = {
      defaultCurrencyCode: 'EUR',
      'rateMode.EUR': 'auto',
    };
    mocks.fetchAutomaticRates.mockImplementation(
      async (sourceCodes, mainCurrencyCode) =>
        sourceCodes.map(to => ({
          from: mainCurrencyCode,
          to,
          rate: '1',
          fetchedAt: Date.now(),
        })),
    );
    render(<AutomaticRatesUpdater budgetId="budget" />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.fetchAutomaticRates).toHaveBeenCalledOnce();
    expect(mocks.fetchAutomaticRates.mock.calls[0][0]).toContain('USD');
    expect(mocks.fetchAutomaticRates.mock.calls[0][1]).toBe('EUR');
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        'autoRate.EUR.USD': JSON.stringify({
          rate: '1',
          fetchedAt: Date.now(),
        }),
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.fetchAutomaticRates).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOMATIC_RATE_REFRESH_INTERVAL_MS - 1);
    });
    expect(mocks.fetchAutomaticRates).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.fetchAutomaticRates).toHaveBeenCalledTimes(2);
  });

  it('backs off a failed Main Auto cold start until retry cooldown', async () => {
    vi.useFakeTimers();
    mocks.prefs = {
      defaultCurrencyCode: 'EUR',
      'rateMode.EUR': 'auto',
    };
    mocks.fetchAutomaticRates.mockRejectedValue(new Error('offline'));
    render(<AutomaticRatesUpdater budgetId="budget" />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.fetchAutomaticRates).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOMATIC_RATE_RETRY_INTERVAL_MS - 1);
    });
    expect(mocks.fetchAutomaticRates).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.fetchAutomaticRates).toHaveBeenCalledTimes(2);
  });

  it('writes and schedules an auto counterpart when Main retains a manual row mode', async () => {
    vi.useFakeTimers();
    const fetchedAt = Date.now();
    mocks.prefs = {
      defaultCurrencyCode: 'EUR',
      'rateMode.EUR': 'manual',
      'rateMode.USD': 'auto',
      'autoRate.EUR.USD': JSON.stringify({
        rate: '0.9',
        fetchedAt: fetchedAt - 2 * AUTOMATIC_RATE_REFRESH_INTERVAL_MS,
      }),
    };
    mocks.fetchAutomaticRates.mockResolvedValue([
      { from: 'EUR', to: 'USD', rate: '1.25', fetchedAt },
    ]);
    render(<AutomaticRatesUpdater budgetId="budget" />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.fetchAutomaticRates).toHaveBeenCalledWith(['USD'], 'EUR');
    expect(mocks.fetchAutomaticRates).toHaveBeenCalledOnce();
    expect(mocks.save).toHaveBeenCalledWith({
      'autoRate.EUR.USD': JSON.stringify({ rate: '1.25', fetchedAt }),
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.fetchAutomaticRates).toHaveBeenCalledOnce();
  });

  it('backs off a successful refresh after a future timestamp sync', async () => {
    vi.useFakeTimers();
    const attemptedAt = Date.now();
    const futureTimestamp =
      attemptedAt + AUTOMATIC_RATE_REFRESH_INTERVAL_MS + 60_000;
    mocks.prefs = {
      defaultCurrencyCode: 'USD',
      'rateMode.EUR': 'auto',
      'autoRate.USD.EUR': JSON.stringify({
        rate: '0.9',
        fetchedAt: futureTimestamp,
      }),
    };
    mocks.fetchAutomaticRates
      .mockResolvedValueOnce([
        { from: 'USD', to: 'EUR', rate: '0.91', fetchedAt: attemptedAt },
      ])
      .mockRejectedValueOnce(new Error('offline'));
    const { rerender } = render(<AutomaticRatesUpdater budgetId="budget" />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.fetchAutomaticRates).toHaveBeenCalledOnce();

    mocks.prefs = {
      ...mocks.prefs,
      'autoRate.USD.EUR': JSON.stringify({
        rate: '0.8',
        fetchedAt: futureTimestamp,
      }),
    };
    rerender(<AutomaticRatesUpdater budgetId="budget" />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.fetchAutomaticRates).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOMATIC_RATE_RETRY_INTERVAL_MS - 1);
    });
    expect(mocks.fetchAutomaticRates).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.fetchAutomaticRates).toHaveBeenCalledTimes(2);
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.prefs['autoRate.USD.EUR']).toContain(String(futureTimestamp));
  });

  it('does not save or schedule a refresh after unmount', async () => {
    const request =
      deferred<
        Array<{ from: string; to: string; rate: string; fetchedAt: number }>
      >();
    mocks.fetchAutomaticRates.mockReturnValue(request.promise);
    const { unmount } = render(<AutomaticRatesUpdater budgetId="budget" />);

    await waitFor(() =>
      expect(mocks.fetchAutomaticRates).toHaveBeenCalledOnce(),
    );
    unmount();

    await act(async () => {
      request.resolve([
        { from: 'USD', to: 'EUR', rate: '0.9', fetchedAt: Date.now() },
      ]);
      await request.promise;
    });

    expect(mocks.save).not.toHaveBeenCalled();
  });
});
