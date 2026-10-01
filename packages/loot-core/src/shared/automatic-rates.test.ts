import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchAutomaticRates,
  getDueAutomaticRateSources,
} from './automatic-rates';

const now = 1790870400000;

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe('fetchAutomaticRates', () => {
  afterEach(() => vi.unstubAllGlobals());

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
    expect(fetchImpl.mock.calls[0][1]).toBeUndefined();
  });

  it('rejects an unsuccessful provider response', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({}, 503));

    await expect(
      fetchAutomaticRates(['EUR'], 'USD', { fetchImpl, now }),
    ).rejects.toThrow(/exchange rate/i);
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
});
