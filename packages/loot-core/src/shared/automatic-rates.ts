import { currencies } from './currencies';
import { getAutomaticRate, isValidRate, manualRateKey } from './exchange-rates';
import type { AutomaticRate } from './exchange-rates';

export const AUTOMATIC_RATE_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CURRENCY_CODES = new Set(
  currencies.map(currency => currency.code).filter(Boolean),
);
const COINGECKO_IDS: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  USDT: 'tether',
};

type FetchOptions = {
  fetchImpl?: typeof fetch;
  now?: number;
};

function normalizeRate(value: unknown): string | null {
  const numericValue =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return null;
  }

  let rate = numericValue.toFixed(15);
  if (rate.includes('.')) {
    rate = rate.replace(/0+$/, '').replace(/\.$/, '');
  }
  return isValidRate(rate) ? rate : null;
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
): Promise<unknown> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(
      `Exchange rate request failed with HTTP ${response.status}`,
    );
  }
  return response.json();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function fetchFiatRates(
  codes: string[],
  mainCurrencyCode: string,
  fetchImpl: typeof fetch,
  fetchedAt: number,
): Promise<AutomaticRate[]> {
  const query = new URLSearchParams({
    base: mainCurrencyCode,
    quotes: codes.join(','),
  });
  const body = await fetchJson(
    fetchImpl,
    `https://api.frankfurter.dev/v2/rates?${query.toString()}`,
  );
  if (!Array.isArray(body)) {
    throw new Error('Exchange rate response was invalid');
  }

  const requestedCodes = new Set(codes);
  return body.flatMap(row => {
    if (
      !isRecord(row) ||
      row.base !== mainCurrencyCode ||
      typeof row.quote !== 'string' ||
      !requestedCodes.has(row.quote)
    ) {
      return [];
    }
    const rate = normalizeRate(row.rate);
    return rate
      ? [{ from: mainCurrencyCode, to: row.quote, rate, fetchedAt }]
      : [];
  });
}

async function fetchCryptoRates(
  codes: string[],
  mainCurrencyCode: string,
  fetchImpl: typeof fetch,
  fetchedAt: number,
): Promise<AutomaticRate[]> {
  const query = new URLSearchParams({
    ids: codes.map(code => COINGECKO_IDS[code]).join(','),
    vs_currencies: mainCurrencyCode.toLowerCase(),
  });
  const body = await fetchJson(
    fetchImpl,
    `https://api.coingecko.com/api/v3/simple/price?${query.toString()}`,
  );
  if (!isRecord(body)) {
    throw new Error('Exchange rate response was invalid');
  }

  return codes.flatMap(code => {
    const coin = body[COINGECKO_IDS[code]];
    if (!isRecord(coin)) {
      return [];
    }
    const rate = normalizeRate(coin[mainCurrencyCode.toLowerCase()]);
    return rate ? [{ from: code, to: mainCurrencyCode, rate, fetchedAt }] : [];
  });
}

export async function fetchAutomaticRates(
  sourceCodes: string[],
  mainCurrencyCode: string,
  options: FetchOptions = {},
): Promise<AutomaticRate[]> {
  if (!CURRENCY_CODES.has(mainCurrencyCode)) {
    throw new Error(`Unsupported main currency: ${mainCurrencyCode}`);
  }

  const codes = [...new Set(sourceCodes)].filter(
    code => code !== mainCurrencyCode,
  );
  const fiatCodes = codes.filter(code => CURRENCY_CODES.has(code));
  const cryptoCodes = codes.filter(code => COINGECKO_IDS[code]);
  if (fiatCodes.length === 0 && cryptoCodes.length === 0) {
    throw new Error('No supported automatic exchange rate source');
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const fetchedAt = options.now ?? Date.now();
  const requests = [
    ...(fiatCodes.length
      ? [fetchFiatRates(fiatCodes, mainCurrencyCode, fetchImpl, fetchedAt)]
      : []),
    ...(cryptoCodes.length
      ? [fetchCryptoRates(cryptoCodes, mainCurrencyCode, fetchImpl, fetchedAt)]
      : []),
  ];
  const results = await Promise.allSettled(requests);
  const rates = results.flatMap(result =>
    result.status === 'fulfilled' ? result.value : [],
  );
  if (rates.length === 0) {
    const failure = results.find(result => result.status === 'rejected');
    throw failure?.status === 'rejected'
      ? failure.reason
      : new Error('No automatic exchange rates were returned');
  }
  return rates;
}

export function getDueAutomaticRateSources(
  prefs: Partial<Record<string, string>>,
  mainCurrencyCode: string,
  now = Date.now(),
): string[] {
  return Object.entries(prefs)
    .flatMap(([key, mode]) => {
      const match = /^rateMode\.([A-Z]{3}|USDT)$/.exec(key);
      if (!match || mode !== 'auto') {
        return [];
      }

      const code = match[1];
      const hasManualRate = [
        prefs[manualRateKey(code, mainCurrencyCode)],
        prefs[manualRateKey(mainCurrencyCode, code)],
      ].some(rate => rate !== undefined && rate !== '' && isValidRate(rate));
      if (hasManualRate) {
        return [];
      }

      const cached = getAutomaticRate(prefs, code, mainCurrencyCode);
      return !cached ||
        now - cached.fetchedAt >= AUTOMATIC_RATE_REFRESH_INTERVAL_MS
        ? [code]
        : [];
    })
    .sort((a, b) => a.localeCompare(b, 'en'));
}
