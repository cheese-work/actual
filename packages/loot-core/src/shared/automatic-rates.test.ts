import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AUTOMATIC_RATE_REFRESH_INTERVAL_MS,
  AUTOMATIC_RATE_REQUEST_TIMEOUT_MS,
  AUTOMATIC_RATE_RETRY_INTERVAL_MS,
  fetchAutomaticRates,
  getDueAutomaticRateSources,
  getNextAutomaticRateRefreshAt,
  isAutomaticRateSourceSupported,
} from './automatic-rates';
import {
  convert,
  getAutomaticRate,
  setAutomaticRatePatch,
} from './exchange-rates';

const now = 1790870400000;

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe('fetchAutomaticRates', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('fetches fiat rates in one request and records the cache time', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      response([
        { base: 'USD', quote: 'EUR', rate: 0.91 },
        { base: 'USD', quote: 'GBP', rate: 0.78 },
      ]),
    );

    await expect(
      fetchAutomaticRates(['EUR', 'GBP'], 'USD', { fetchImpl, now }),
    ).resolves.toEqual([
      { from: 'USD', to: 'EUR', rate: '0.91', fetchedAt: now },
      { from: 'USD', to: 'GBP', rate: '0.78', fetchedAt: now },
    ]);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(String(fetchImpl.mock.calls[0][0])).toContain(
      'api.frankfurter.dev/v2/rates?base=USD&quotes=EUR%2CGBP',
    );
  });

  it('uses CoinGecko for deferred crypto without changing the picker list', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        bitcoin: { usd: 65000 },
        ethereum: { usd: 3000 },
        tether: { usd: 1 },
      }),
    );

    await expect(
      fetchAutomaticRates(['BTC', 'ETH', 'USDT'], 'USD', { fetchImpl, now }),
    ).resolves.toEqual([
      { from: 'BTC', to: 'USD', rate: '65000', fetchedAt: now },
      { from: 'ETH', to: 'USD', rate: '3000', fetchedAt: now },
      { from: 'USDT', to: 'USD', rate: '1', fetchedAt: now },
    ]);
    expect(String(fetchImpl.mock.calls[0][0])).toContain(
      'api.coingecko.com/api/v3/simple/price?ids=bitcoin%2Cethereum%2Ctether&vs_currencies=usd',
    );
    expect(fetchImpl.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('skips unsupported CoinGecko targets in a mixed source batch', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response([{ base: 'BYN', quote: 'EUR', rate: 3.5 }]));

    await expect(
      fetchAutomaticRates(['EUR', 'BTC', 'ABC'], 'BYN', {
        fetchImpl,
        now,
      }),
    ).resolves.toEqual([
      { from: 'BYN', to: 'EUR', rate: '3.5', fetchedAt: now },
    ]);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(String(fetchImpl.mock.calls[0][0])).toContain(
      'api.frankfurter.dev/v2/rates?base=BYN&quotes=EUR',
    );
  });

  it('does not request a provider for an unsupported-only source batch', async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      fetchAutomaticRates(['BTC'], 'BYN', { fetchImpl, now }),
    ).rejects.toThrow(/no supported automatic/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an unsuccessful provider response', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({}, 503));

    await expect(
      fetchAutomaticRates(['EUR'], 'USD', { fetchImpl, now }),
    ).rejects.toThrow(/exchange rate/i);
  });

  it('aborts provider requests that exceed the timeout', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation((_input, init) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
      });

    const request = fetchAutomaticRates(['EUR'], 'USD', { fetchImpl, now });
    const rejection = expect(request).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(AUTOMATIC_RATE_REQUEST_TIMEOUT_MS);

    await rejection;
    expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
});

describe('isAutomaticRateSourceSupported', () => {
  it('allows supported fiat and deferred crypto sources only', () => {
    expect(isAutomaticRateSourceSupported('EUR', 'USD')).toBe(true);
    expect(isAutomaticRateSourceSupported('BTC', 'USD')).toBe(true);
    expect(isAutomaticRateSourceSupported('USDT', 'USD')).toBe(true);
    expect(isAutomaticRateSourceSupported('EUR', 'BYN')).toBe(true);
    expect(isAutomaticRateSourceSupported('BTC', 'BYN')).toBe(false);
    expect(isAutomaticRateSourceSupported('X-BANANA', 'USD')).toBe(false);
    expect(isAutomaticRateSourceSupported('ABC', 'USD')).toBe(false);
    expect(isAutomaticRateSourceSupported('EUR', 'X-BANANA')).toBe(false);
  });
});

describe('getDueAutomaticRateSources', () => {
  it('refreshes stale auto rates, but not manual modes or manual overrides', () => {
    const stale = JSON.stringify({ rate: '0.9', fetchedAt: now - 90000000 });

    expect(
      getDueAutomaticRateSources(
        {
          'rateMode.EUR': 'auto',
          'rateMode.GBP': 'auto',
          'rateMode.USDT': 'auto',
          'rateMode.CAD': 'manual',
          'autoRate.USD.EUR': stale,
          'autoRate.USD.GBP': JSON.stringify({
            rate: '0.8',
            fetchedAt: now - 60000,
          }),
          'autoRate.USD.USDT': stale,
          'manualRate.CAD.USD': '1.2',
        },
        'USD',
        now,
      ),
    ).toEqual(['EUR', 'USDT']);
  });

  it('does not refresh a cached rate before its daily interval expires', () => {
    expect(
      getDueAutomaticRateSources(
        {
          'rateMode.EUR': 'auto',
          'autoRate.USD.EUR': JSON.stringify({
            rate: '0.9',
            fetchedAt: now - 60000,
          }),
        },
        'USD',
        now,
      ),
    ).toEqual([]);
  });

  it('backs off failed attempts without changing successful cache age', () => {
    const fetchedAt = now - 2 * AUTOMATIC_RATE_REFRESH_INTERVAL_MS;
    const failedAt = now - 60_000;
    const prefs = {
      'rateMode.EUR': 'auto',
      'autoRate.USD.EUR': JSON.stringify({ rate: '0.9', fetchedAt }),
    };
    const failedAttempts = new Map([['USD.EUR', failedAt]]);

    expect(
      getDueAutomaticRateSources(prefs, 'USD', now, failedAttempts),
    ).toEqual([]);
    expect(
      getDueAutomaticRateSources(
        prefs,
        'USD',
        failedAt + AUTOMATIC_RATE_RETRY_INTERVAL_MS,
        failedAttempts,
      ),
    ).toEqual(['EUR']);
    expect(JSON.parse(prefs['autoRate.USD.EUR']).fetchedAt).toBe(fetchedAt);
  });

  it('treats a Main-to-currency cache as fresh for an auto-mode currency', () => {
    expect(
      getDueAutomaticRateSources(
        {
          'rateMode.EUR': 'auto',
          'autoRate.USD.EUR': JSON.stringify({
            rate: '1.1',
            fetchedAt: now - 60000,
          }),
        },
        'USD',
        now,
      ),
    ).toEqual([]);
  });

  it('uses the newer inverse cache for due checks after a Main currency flip', () => {
    const freshAt = now - 60000;
    const prefs = {
      'rateMode.USD': 'auto',
      'autoRate.USD.EUR': JSON.stringify({
        rate: '0.9',
        fetchedAt: freshAt - AUTOMATIC_RATE_REFRESH_INTERVAL_MS,
      }),
      'autoRate.EUR.USD': JSON.stringify({ rate: '1.1', fetchedAt: freshAt }),
    };

    expect(getDueAutomaticRateSources(prefs, 'EUR', now)).toEqual([]);
    expect(getNextAutomaticRateRefreshAt(prefs, 'EUR', now)).toBe(
      freshAt + AUTOMATIC_RATE_REFRESH_INTERVAL_MS,
    );
  });

  it('lets explicit manual mode override an automatic Main cache', () => {
    const prefs = {
      'rateMode.EUR': 'auto',
      'rateMode.USD': 'manual',
      'autoRate.USD.EUR': JSON.stringify({
        rate: '0.9',
        fetchedAt: now - 2 * AUTOMATIC_RATE_REFRESH_INTERVAL_MS,
      }),
    };

    expect(getAutomaticRate(prefs, 'USD', 'EUR', now)).toBeNull();
    expect(getDueAutomaticRateSources(prefs, 'EUR', now)).toEqual([]);
    expect(getNextAutomaticRateRefreshAt(prefs, 'EUR', now)).toBeNull();
    expect(convert(10000, 'USD', 'EUR', prefs)).toBeNull();
  });

  it('backs off alternating-clock sync after a successful attempt', () => {
    const slowClock = now;
    const fastClock = now + AUTOMATIC_RATE_REFRESH_INTERVAL_MS + 60_000;
    const fastPeerCache = {
      'rateMode.EUR': 'auto',
      'autoRate.USD.EUR': JSON.stringify({
        rate: '0.8',
        fetchedAt: fastClock,
      }),
    };
    const slowPeerAttempts = new Map([['EUR.USD', slowClock]]);

    expect(
      getDueAutomaticRateSources(
        fastPeerCache,
        'EUR',
        slowClock,
        slowPeerAttempts,
      ),
    ).toEqual([]);
    expect(
      getNextAutomaticRateRefreshAt(
        fastPeerCache,
        'EUR',
        slowClock,
        slowPeerAttempts,
      ),
    ).toBe(slowClock + AUTOMATIC_RATE_RETRY_INTERVAL_MS);

    const fastPeerAttempts = new Map([['EUR.USD', fastClock]]);
    expect(
      getDueAutomaticRateSources(
        {
          'rateMode.EUR': 'auto',
          'autoRate.USD.EUR': JSON.stringify({
            rate: '0.9',
            fetchedAt: slowClock,
          }),
        },
        'EUR',
        fastClock,
        fastPeerAttempts,
      ),
    ).toEqual([]);
  });

  it('refreshes a cached auto currency after it becomes Main', async () => {
    const fetchedAt = now - 2 * AUTOMATIC_RATE_REFRESH_INTERVAL_MS;
    const prefs = {
      'rateMode.EUR': 'auto',
      'autoRate.USD.EUR': JSON.stringify({ rate: '0.9', fetchedAt }),
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response([{ base: 'EUR', quote: 'USD', rate: 1.25 }]));

    expect(getDueAutomaticRateSources(prefs, 'EUR', now)).toEqual(['USD']);
    expect(convert(10000, 'USD', 'EUR', prefs)).toBe(9000);
    expect(JSON.parse(prefs['autoRate.USD.EUR']).fetchedAt).toBe(fetchedAt);

    const refreshed = await fetchAutomaticRates(['USD'], 'EUR', {
      fetchImpl,
      now,
    });
    Object.assign(prefs, ...refreshed.map(setAutomaticRatePatch));

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(getAutomaticRate(prefs, 'USD', 'EUR', now)).toEqual({
      from: 'EUR',
      to: 'USD',
      rate: '1.25',
      fetchedAt: now,
    });
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      expect(convert(10000, 'USD', 'EUR', prefs)).toBe(8000);
    } finally {
      dateNow.mockRestore();
    }
    expect(getDueAutomaticRateSources(prefs, 'EUR', now)).toEqual([]);
    expect(getNextAutomaticRateRefreshAt(prefs, 'EUR', now)).toBe(
      now + AUTOMATIC_RATE_REFRESH_INTERVAL_MS,
    );
    expect(prefs['autoRate.USD.EUR']).toBe(
      JSON.stringify({ rate: '0.9', fetchedAt }),
    );

    const manualPrefs = { ...prefs, 'manualRate.USD.EUR': '0.75' };
    expect(getDueAutomaticRateSources(manualPrefs, 'EUR', now)).toEqual([]);
    expect(convert(10000, 'USD', 'EUR', manualPrefs)).toBe(7500);
  });
});

describe('getNextAutomaticRateRefreshAt', () => {
  it('schedules the next refresh for cache expiry', () => {
    const fetchedAt = now - 60_000;
    expect(
      getNextAutomaticRateRefreshAt(
        {
          'rateMode.EUR': 'auto',
          'autoRate.USD.EUR': JSON.stringify({ rate: '0.9', fetchedAt }),
        },
        'USD',
        now,
      ),
    ).toBe(fetchedAt + AUTOMATIC_RATE_REFRESH_INTERVAL_MS);
  });

  it('refreshes a future synced timestamp once then schedules normally', async () => {
    const fetchedAt = now + 30 * AUTOMATIC_RATE_REFRESH_INTERVAL_MS;
    const prefs = {
      'rateMode.EUR': 'auto',
      'autoRate.USD.EUR': JSON.stringify({ rate: '0.9', fetchedAt }),
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response([{ base: 'USD', quote: 'EUR', rate: 0.8 }]));

    expect(getDueAutomaticRateSources(prefs, 'USD', now)).toEqual(['EUR']);
    expect(getNextAutomaticRateRefreshAt(prefs, 'USD', now)).toBe(now);
    expect(JSON.parse(prefs['autoRate.USD.EUR']).fetchedAt).toBe(fetchedAt);

    const refreshed = await fetchAutomaticRates(['EUR'], 'USD', {
      fetchImpl,
      now,
    });
    Object.assign(prefs, ...refreshed.map(setAutomaticRatePatch));

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(getDueAutomaticRateSources(prefs, 'USD', now)).toEqual([]);
    expect(getNextAutomaticRateRefreshAt(prefs, 'USD', now)).toBe(
      now + AUTOMATIC_RATE_REFRESH_INTERVAL_MS,
    );
  });

  it('schedules retries after cooldown and no earlier than cache expiry', () => {
    const failedAt = now - 60_000;
    const failedAttempts = new Map([['USD.EUR', failedAt]]);
    const staleCache = {
      'rateMode.EUR': 'auto',
      'autoRate.USD.EUR': JSON.stringify({
        rate: '0.9',
        fetchedAt: now - 2 * AUTOMATIC_RATE_REFRESH_INTERVAL_MS,
      }),
    };

    expect(
      getNextAutomaticRateRefreshAt(staleCache, 'USD', now, failedAttempts),
    ).toBe(failedAt + AUTOMATIC_RATE_RETRY_INTERVAL_MS);
    expect(
      getNextAutomaticRateRefreshAt(
        {
          'rateMode.EUR': 'auto',
          'autoRate.USD.EUR': JSON.stringify({ rate: '0.9', fetchedAt: now }),
        },
        'USD',
        now,
        failedAttempts,
      ),
    ).toBe(now + AUTOMATIC_RATE_REFRESH_INTERVAL_MS);
  });

  it('does not schedule unsupported, manual, or manually overridden sources', () => {
    expect(
      getNextAutomaticRateRefreshAt(
        {
          'rateMode.XYZ': 'auto',
          'rateMode.CAD': 'manual',
          'rateMode.EUR': 'auto',
          'manualRate.EUR.USD': '1.2',
        },
        'USD',
        now,
      ),
    ).toBeNull();
  });
});
