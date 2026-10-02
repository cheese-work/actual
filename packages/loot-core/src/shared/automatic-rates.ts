import { currencies } from './currencies';
import {
  getAutomaticRate,
  getAutomaticRateFreshnessTimestamp,
  isAutomaticRateEnabled,
  isValidRate,
  manualRateKey,
} from './exchange-rates';
import type { AutomaticRate } from './exchange-rates';

export const AUTOMATIC_RATE_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const AUTOMATIC_RATE_RETRY_INTERVAL_MS = 15 * 60 * 1000;
export const AUTOMATIC_RATE_REQUEST_TIMEOUT_MS = 15 * 1000;
const CURRENCY_CODES = new Set(
  currencies.map(currency => currency.code).filter(Boolean),
);
const FRANKFURTER_CURRENCY_CODES = new Set(
  'AED ARS AUD BRL BYN CAD CHF CLP CNY COP CRC CZK DKK DOP EGP EUR GBP GTQ HKD HUF IDR ILS INR IRR JMD JPY KRW LKR MDL MKD MXN MYR PEN PHP PKR PLN QAR RON RSD RUB SAR SEK SGD THB TRY TWD UAH USD UYU UZS VND'.split(
    ' ',
  ),
);
const COINGECKO_IDS: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  USDT: 'tether',
};
const COINGECKO_VS_CURRENCIES = new Set(
  'AED ARS AUD BRL CAD CHF CLP CNY CZK DKK EUR GBP HKD HUF IDR ILS INR JPY KRW LKR MXN MYR PHP PKR PLN RUB SAR SEK SGD THB TRY TWD UAH USD VND'.split(
    ' ',
  ),
);

type FetchOptions = {
  fetchImpl?: typeof fetch;
  now?: number;
};

export function isAutomaticRateSourceSupported(
  sourceCode: string,
  mainCurrencyCode: string,
): boolean {
  if (
    sourceCode === mainCurrencyCode ||
    !CURRENCY_CODES.has(mainCurrencyCode)
  ) {
    return false;
  }

  if (COINGECKO_IDS[sourceCode] !== undefined) {
    return COINGECKO_VS_CURRENCIES.has(mainCurrencyCode);
  }

  return (
    FRANKFURTER_CURRENCY_CODES.has(sourceCode) &&
    FRANKFURTER_CURRENCY_CODES.has(mainCurrencyCode)
  );
}

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
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const request = (async () => {
      const response = await fetchImpl(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(
          `Exchange rate request failed with HTTP ${response.status}`,
        );
      }
      return response.json();
    })();
    return await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error('Exchange rate request timed out'));
        }, AUTOMATIC_RATE_REQUEST_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
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
  const fiatCodes = codes.filter(
    code =>
      FRANKFURTER_CURRENCY_CODES.has(code) &&
      FRANKFURTER_CURRENCY_CODES.has(mainCurrencyCode),
  );
  const cryptoCodes = codes.filter(
    code =>
      COINGECKO_IDS[code] !== undefined &&
      COINGECKO_VS_CURRENCIES.has(mainCurrencyCode),
  );
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
  failedAttempts: ReadonlyMap<string, number> = new Map(),
): string[] {
  return getAutomaticRateSourceCandidates(prefs, mainCurrencyCode).filter(
    code => {
      const failedAt = failedAttempts.get(`${mainCurrencyCode}.${code}`);
      if (
        failedAt !== undefined &&
        now - failedAt < AUTOMATIC_RATE_RETRY_INTERVAL_MS
      ) {
        return false;
      }

      const hasManualRate = [
        prefs[manualRateKey(code, mainCurrencyCode)],
        prefs[manualRateKey(mainCurrencyCode, code)],
      ].some(rate => rate !== undefined && rate !== '' && isValidRate(rate));
      if (hasManualRate) {
        return false;
      }

      const cached = getAutomaticRate(
        prefs,
        code,
        mainCurrencyCode,
        now,
        mainCurrencyCode,
      );
      return (
        !cached ||
        now - getAutomaticRateFreshnessTimestamp(cached.fetchedAt, now) >=
          AUTOMATIC_RATE_REFRESH_INTERVAL_MS
      );
    },
  );
}

export function getNextAutomaticRateRefreshAt(
  prefs: Partial<Record<string, string>>,
  mainCurrencyCode: string,
  now = Date.now(),
  failedAttempts: ReadonlyMap<string, number> = new Map(),
): number | null {
  return getAutomaticRateSourceCandidates(prefs, mainCurrencyCode).reduce<
    number | null
  >((nextAt, code) => {
    const hasManualRate = [
      prefs[manualRateKey(code, mainCurrencyCode)],
      prefs[manualRateKey(mainCurrencyCode, code)],
    ].some(rate => rate !== undefined && rate !== '' && isValidRate(rate));
    if (hasManualRate) {
      return nextAt;
    }

    const cached = getAutomaticRate(
      prefs,
      code,
      mainCurrencyCode,
      now,
      mainCurrencyCode,
    );
    const cacheDueAt = cached
      ? getAutomaticRateFreshnessTimestamp(cached.fetchedAt, now) +
        AUTOMATIC_RATE_REFRESH_INTERVAL_MS
      : now;
    const failedAt = failedAttempts.get(`${mainCurrencyCode}.${code}`);
    const retryDueAt =
      failedAt === undefined
        ? now
        : failedAt + AUTOMATIC_RATE_RETRY_INTERVAL_MS;
    const dueAt = Math.max(now, cacheDueAt, retryDueAt);
    return nextAt === null || dueAt < nextAt ? dueAt : nextAt;
  }, null);
}

function getAutomaticRateSourceCandidates(
  prefs: Partial<Record<string, string>>,
  mainCurrencyCode: string,
): string[] {
  const sources = new Set<string>();

  for (const [key, mode] of Object.entries(prefs)) {
    const match = /^rateMode\.([A-Z]{3}|USDT)$/.exec(key);
    if (!match || mode !== 'auto') {
      continue;
    }

    const code = match[1];
    if (code !== mainCurrencyCode) {
      if (isAutomaticRateSourceSupported(code, mainCurrencyCode)) {
        sources.add(code);
      }
      continue;
    }

    for (const sourceCode of CURRENCY_CODES) {
      if (isAutomaticRateSourceSupported(sourceCode, mainCurrencyCode)) {
        sources.add(sourceCode);
      }
    }
  }

  return [...sources]
    .filter(code =>
      isAutomaticRateEnabled(prefs, code, mainCurrencyCode, mainCurrencyCode),
    )
    .sort((a, b) => a.localeCompare(b, 'en'));
}
