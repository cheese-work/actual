import { getNumberFormat, safeNumber, STORAGE_DECIMAL_PLACES } from './util';
import type { IntegerAmount, NumberFormats } from './util';

// Manual exchange rates and custom units live in synced preferences, one key
// per pair or unit, so two devices editing different pairs never overwrite
// each other (sync merges per key). Rates are decimal strings and never
// floats: convert() does exact integer math on them.
//
//   manualRate.<FROM>.<TO>  "25400"          1 FROM = 25400 TO
//   customUnit.<CODE>       '{"name":...}'   a user-defined unit
//
// An empty value means "removed" (a synced pref cannot be deleted).

export type CustomUnit = {
  code: string;
  name: string;
  symbol: string;
  decimals: number;
};

export type ManualRate = { from: string; to: string; rate: string };

export type AutomaticRate = {
  from: string;
  to: string;
  rate: string;
  fetchedAt: number;
};

type Prefs = Partial<Record<string, string>>;

export type ExchangeRatePrefs = Partial<
  Record<
    | `manualRate.${string}.${string}`
    | `customUnit.${string}`
    | `rateMode.${string}`
    | `autoRate.${string}.${string}`,
    string
  >
>;

const RATE_PREFIX = 'manualRate.';
const UNIT_PREFIX = 'customUnit.';
const RATE_MODE_PREFIX = 'rateMode.';
const AUTOMATIC_RATE_PREFIX = 'autoRate.';

// A currency in a rate key: an ISO-style code, USDT, or a custom unit code.
const CURRENCY_CODE = '(?:[A-Z]{3}|USDT|X-[A-Z0-9]{1,10})';
const RATE_KEY = new RegExp(
  `^manualRate\\.(${CURRENCY_CODE})\\.(${CURRENCY_CODE})$`,
);
const AUTOMATIC_CURRENCY_CODE = '(?:[A-Z]{3}|USDT)';
const RATE_MODE_KEY = new RegExp(`^rateMode\\.(${AUTOMATIC_CURRENCY_CODE})$`);
const AUTOMATIC_RATE_KEY = new RegExp(
  `^autoRate\\.(${AUTOMATIC_CURRENCY_CODE})\\.(${AUTOMATIC_CURRENCY_CODE})$`,
);
// The X- prefix keeps custom units from colliding with any ISO code.
const UNIT_CODE = /^X-[A-Z0-9]{1,10}$/;
// At most 15 digits on each side of the point keeps rates exact in BigInt
// and far below MAX_SAFE_NUMBER once multiplied by a stored amount.
const RATE = /^(\d{1,15})(?:\.(\d{1,15}))?$/;

export function manualRateKey(from: string, to: string) {
  return `${RATE_PREFIX}${from}.${to}` as const;
}

export function customUnitKey(code: string) {
  return `${UNIT_PREFIX}${code}` as const;
}

export function rateModeKey(code: string) {
  return `${RATE_MODE_PREFIX}${code}` as const;
}

export function automaticRateKey(from: string, to: string) {
  return `${AUTOMATIC_RATE_PREFIX}${from}.${to}` as const;
}

/** The unit code of a `customUnit.<CODE>` pref id, or null for any other id. */
export function customUnitCode(id: string): string | null {
  return id.startsWith(UNIT_PREFIX) ? id.slice(UNIT_PREFIX.length) : null;
}

function parseRateKey(key: string) {
  const match = RATE_KEY.exec(key);
  return match && match[1] !== match[2]
    ? { from: match[1], to: match[2] }
    : null;
}

/** A rate is a plain decimal string greater than 0: no sign, exponent or spaces. */
export function isValidRate(rate: string): boolean {
  return RATE.test(rate) && /[1-9]/.test(rate);
}

function toFraction(rate: string) {
  const [whole, fraction = ''] = rate.split('.');
  return {
    numerator: BigInt(whole + fraction),
    denominator: 10n ** BigInt(fraction.length),
  };
}

// n / d rounded to the nearest integer, exact ties to the even one.
function divideHalfEven(n: bigint, d: bigint): bigint {
  const quotient = n / d; // truncates toward zero
  const remainder = n % d;
  const twice = (remainder < 0n ? -remainder : remainder) * 2n;
  if (twice < d) {
    return quotient;
  }
  const awayFromZero = n < 0n ? quotient - 1n : quotient + 1n;
  return twice > d || quotient % 2n !== 0n ? awayFromZero : quotient;
}

/**
 * Converts a stored amount (scale 100) between two currencies or units with
 * a manual rate. Uses the direct rate `from -> to` when set, otherwise the
 * inverse of `to -> from`. Returns null when neither exists (or is valid):
 * rates are never chained through a third currency. Rounds once, half to
 * even, to a stored integer; throws (safeNumber) if the amount or result is
 * not a safe integer.
 */
export function convert(
  amount: IntegerAmount,
  from: string,
  to: string,
  rates: Prefs,
): IntegerAmount | null {
  safeNumber(amount);
  if (from === to) {
    return amount;
  }

  const direct = rates[manualRateKey(from, to)];
  if (direct !== undefined && isValidRate(direct)) {
    const { numerator, denominator } = toFraction(direct);
    return safeNumber(
      Number(divideHalfEven(BigInt(amount) * numerator, denominator)),
    );
  }

  const inverse = rates[manualRateKey(to, from)];
  if (inverse !== undefined && isValidRate(inverse)) {
    const { numerator, denominator } = toFraction(inverse);
    return safeNumber(
      Number(divideHalfEven(BigInt(amount) * denominator, numerator)),
    );
  }

  const automatic = getAutomaticRate(rates, from, to);
  if (automatic) {
    const { numerator, denominator } = toFraction(automatic.rate);
    const [multiplier, divisor] =
      automatic.from === from
        ? [numerator, denominator]
        : [denominator, numerator];
    return safeNumber(
      Number(divideHalfEven(BigInt(amount) * multiplier, divisor)),
    );
  }

  return null;
}

// Intl never switches to exponent notation here, unlike toPrecision.
const inverseFormat = new Intl.NumberFormat('en-US', {
  maximumSignificantDigits: 6,
  useGrouping: false,
});

/** The read-only inverse shown next to a rate, to 6 significant digits. */
export function formatInverseRate(rate: string): string {
  return isValidRate(rate) ? inverseFormat.format(1 / Number(rate)) : '';
}

/**
 * Reads a typed rate using the user's number format decimal mark. Strict on
 * purpose: a thousands separator or the other format's mark is rejected
 * rather than guessed at, so "1,5" can never silently become 15.
 */
export function parseRateInput(
  input: string,
  format: NumberFormats,
): string | null {
  const { decimalSeparator } = getNumberFormat({ format });
  const [whole = '', fraction, ...rest] = input.trim().split(decimalSeparator);
  if (
    rest.length > 0 ||
    !/^\d*$/.test(whole) ||
    (fraction !== undefined && !/^\d+$/.test(fraction))
  ) {
    return null;
  }

  const rate = fraction === undefined ? whole : `${whole || '0'}.${fraction}`;
  return isValidRate(rate) ? rate : null;
}

/** A stored rate written with the user's number format decimal mark. */
export function formatRateForInput(rate: string, format: NumberFormats) {
  return rate.replace('.', getNumberFormat({ format }).decimalSeparator);
}

function isShortText(value: unknown, maxLength: number) {
  return (
    typeof value === 'string' &&
    value.trim() !== '' &&
    [...value.trim()].length <= maxLength
  );
}

/** The first invalid field of a custom unit, or null when it is valid. */
export function validateCustomUnit(
  unit: Record<keyof CustomUnit, unknown>,
): keyof CustomUnit | null {
  const { code, name, symbol, decimals } = unit;
  if (typeof code !== 'string' || !UNIT_CODE.test(code)) {
    return 'code';
  }
  if (!isShortText(name, 40)) {
    return 'name';
  }
  if (!isShortText(symbol, 8)) {
    return 'symbol';
  }
  // Display decimals can never exceed the storage precision.
  if (
    typeof decimals !== 'number' ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > STORAGE_DECIMAL_PLACES
  ) {
    return 'decimals';
  }
  return null;
}

const isCustomUnit = (
  unit: Record<keyof CustomUnit, unknown>,
): unit is CustomUnit => validateCustomUnit(unit) === null;

/** The synced pref value for a unit. The code is in the key, not the value. */
export function serializeCustomUnit({ name, symbol, decimals }: CustomUnit) {
  return JSON.stringify({ name: name.trim(), symbol: symbol.trim(), decimals });
}

function readUnitFields(json: string) {
  try {
    const body: unknown = JSON.parse(json);
    if (
      typeof body === 'object' &&
      body !== null &&
      'name' in body &&
      'symbol' in body &&
      'decimals' in body
    ) {
      return { name: body.name, symbol: body.symbol, decimals: body.decimals };
    }
  } catch {
    // not JSON: handled as an invalid unit
  }
  return null;
}

/** Custom units in synced prefs, by code. Ignores anything invalid or removed. */
export function getCustomUnits(prefs: Prefs): CustomUnit[] {
  const units: CustomUnit[] = [];
  for (const [key, value] of Object.entries(prefs)) {
    const code = customUnitCode(key);
    const fields = code && value ? readUnitFields(value) : null;
    const candidate = code && fields ? { code, ...fields } : null;
    if (candidate && isCustomUnit(candidate)) {
      units.push(candidate);
    }
  }
  return units.sort((a, b) => a.code.localeCompare(b.code, 'en'));
}

/** Valid manual rates in synced prefs, sorted by pair. Ignores anything else. */
export function getManualRates(prefs: Prefs): ManualRate[] {
  const rates: ManualRate[] = [];
  for (const [key, rate] of Object.entries(prefs)) {
    const pair = parseRateKey(key);
    if (pair && rate !== undefined && isValidRate(rate)) {
      rates.push({ ...pair, rate });
    }
  }
  return rates.sort(
    (a, b) =>
      a.from.localeCompare(b.from, 'en') || a.to.localeCompare(b.to, 'en'),
  );
}

export function getRateMode(prefs: Prefs, code: string): 'manual' | 'auto' {
  return prefs[rateModeKey(code)] === 'auto' ? 'auto' : 'manual';
}

export function getEffectiveRateMode(
  prefs: Prefs,
  code: string,
  mainCurrencyCode: string,
): 'manual' | 'auto' {
  const mode = prefs[rateModeKey(code)];
  if (mode === 'manual' || mode === 'auto') {
    return mode;
  }

  return code !== mainCurrencyCode &&
    prefs[rateModeKey(mainCurrencyCode)] === 'auto'
    ? 'auto'
    : 'manual';
}

export function isAutomaticRateEnabled(
  prefs: Prefs,
  from: string,
  to: string,
  mainCurrencyCode = prefs.defaultCurrencyCode ?? to,
): boolean {
  const sourceCode =
    from === mainCurrencyCode ? to : to === mainCurrencyCode ? from : null;
  return (
    sourceCode !== null &&
    sourceCode !== mainCurrencyCode &&
    getEffectiveRateMode(prefs, sourceCode, mainCurrencyCode) === 'auto'
  );
}

function readAutomaticRate(value: string | undefined) {
  if (!value) {
    return null;
  }
  try {
    const body: unknown = JSON.parse(value);
    if (
      typeof body === 'object' &&
      body !== null &&
      'rate' in body &&
      typeof body.rate === 'string' &&
      isValidRate(body.rate) &&
      'fetchedAt' in body &&
      typeof body.fetchedAt === 'number' &&
      Number.isSafeInteger(body.fetchedAt) &&
      body.fetchedAt > 0
    ) {
      return { rate: body.rate, fetchedAt: body.fetchedAt };
    }
  } catch {
    return null;
  }
  return null;
}

export function getAutomaticRate(
  prefs: Prefs,
  from: string,
  to: string,
  now = Date.now(),
  mainCurrencyCode = prefs.defaultCurrencyCode ?? to,
): AutomaticRate | null {
  if (!isAutomaticRateEnabled(prefs, from, to, mainCurrencyCode)) {
    return null;
  }

  const direct = readAutomaticRate(prefs[automaticRateKey(from, to)]);
  const inverse = readAutomaticRate(prefs[automaticRateKey(to, from)]);
  if (
    !inverse ||
    (direct &&
      getAutomaticRateFreshnessTimestamp(direct.fetchedAt, now) >=
        getAutomaticRateFreshnessTimestamp(inverse.fetchedAt, now))
  ) {
    return direct ? { from, to, ...direct } : null;
  }

  return { from: to, to: from, ...inverse };
}

export function getAutomaticRateFreshnessTimestamp(
  fetchedAt: number,
  now = Date.now(),
): number {
  return fetchedAt > now ? 0 : fetchedAt;
}

export function setAutomaticRatePatch(rate: AutomaticRate): ExchangeRatePrefs {
  return {
    [automaticRateKey(rate.from, rate.to)]: JSON.stringify({
      rate: rate.rate,
      fetchedAt: rate.fetchedAt,
    }),
  };
}

const UNIT_HINTS: Record<keyof CustomUnit, string> = {
  code: 'use X- followed by 1 to 10 capital letters or digits, like X-BANANA',
  name: 'required, at most 40 characters',
  symbol: 'required, at most 8 characters',
  decimals: 'must be 0, 1 or 2',
};

/**
 * Why a write to a manual-rate or custom-unit pref must be refused, or null
 * to allow it. The trust boundary for the API and any client: rates must be
 * greater than 0 and units well formed. An empty string removes.
 */
export function exchangeRatePrefError(
  id: string,
  value: string | undefined,
): string | null {
  if (id.startsWith(RATE_PREFIX)) {
    if (!parseRateKey(id)) {
      return `Invalid currency pair in "${id}": use manualRate.<FROM>.<TO> with two different currency codes`;
    }
    if (value === undefined) {
      return 'An exchange rate must be a string: use an empty string to remove it';
    }
    if (value !== '' && !isValidRate(value)) {
      return 'An exchange rate must be greater than 0, written as a plain number like 25400 or 0.000039';
    }
    return null;
  }

  if (id.startsWith(RATE_MODE_PREFIX)) {
    if (!RATE_MODE_KEY.test(id)) {
      return `Invalid currency code in "${id}": use rateMode.<CODE>`;
    }
    if (value !== '' && value !== 'manual' && value !== 'auto') {
      return 'An exchange-rate mode must be manual or auto';
    }
    return null;
  }

  if (id.startsWith(AUTOMATIC_RATE_PREFIX)) {
    const match = AUTOMATIC_RATE_KEY.exec(id);
    if (!match || match[1] === match[2]) {
      return `Invalid currency pair in "${id}": use autoRate.<FROM>.<TO> with two different currency codes`;
    }
    if (value === undefined) {
      return 'An automatic exchange rate must be a string: use an empty string to remove it';
    }
    if (value === '') {
      return null;
    }
    if (!readAutomaticRate(value)) {
      return 'An automatic rate must contain a positive rate and a valid fetched timestamp';
    }
    return null;
  }

  const code = customUnitCode(id);
  if (code === null) {
    return null;
  }
  if (value === undefined) {
    return 'A custom unit must be a string: use an empty string to remove it';
  }
  if (value === '') {
    return null;
  }
  const fields = readUnitFields(value);
  if (!fields) {
    return 'Invalid custom unit: expected JSON like {"name":"Banana","symbol":"🍌","decimals":0}';
  }
  const invalid = validateCustomUnit({ code, ...fields });
  return invalid
    ? `Invalid custom unit ${invalid}: ${UNIT_HINTS[invalid]}`
    : null;
}

/**
 * The prefs to write to set (or, with an empty rate, remove) a manual rate.
 * Also clears the opposite direction: convert() prefers a direct rate, so a
 * stale reverse rate would otherwise win and the pair would disagree.
 */
export function setManualRatePatch(
  prefs: Prefs,
  from: string,
  to: string,
  rate: string,
): ExchangeRatePrefs {
  if (from === to) {
    return {};
  }
  const reverse = manualRateKey(to, from);
  return {
    [manualRateKey(from, to)]: rate,
    ...(prefs[reverse] && { [reverse]: '' }),
  };
}

/** The prefs to write to remove a custom unit and every rate that uses it. */
export function removeCustomUnitPatch(
  prefs: Prefs,
  code: string,
): ExchangeRatePrefs {
  const patch: ExchangeRatePrefs = { [customUnitKey(code)]: '' };
  for (const [key, value] of Object.entries(prefs)) {
    const pair = parseRateKey(key);
    if (value && pair && (pair.from === code || pair.to === code)) {
      patch[manualRateKey(pair.from, pair.to)] = '';
    }
  }
  return patch;
}
