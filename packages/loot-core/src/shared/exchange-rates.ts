import type { IntegerAmount, NumberFormats } from './util';

export type CustomUnit = {
  code: string;
  name: string;
  symbol: string;
  decimals: number;
};

export type ManualRate = { from: string; to: string; rate: string };

type Prefs = Partial<Record<string, string>>;

export type ExchangeRatePrefs = Partial<
  Record<`manualRate.${string}.${string}` | `customUnit.${string}`, string>
>;

export function manualRateKey(from: string, to: string) {
  return `manualRate.${from}.${to}` as const;
}

export function customUnitKey(code: string) {
  return `customUnit.${code}` as const;
}

const notImplemented = (): never => {
  throw new Error('not implemented');
};

export function isValidRate(_rate: string): boolean {
  return notImplemented();
}

export function convert(
  _amount: IntegerAmount,
  _from: string,
  _to: string,
  _rates: Prefs,
): IntegerAmount | null {
  return notImplemented();
}

export function formatInverseRate(_rate: string): string {
  return notImplemented();
}

export function parseRateInput(
  _input: string,
  _format: NumberFormats,
): string | null {
  return notImplemented();
}

export function formatRateForInput(
  _rate: string,
  _format: NumberFormats,
): string {
  return notImplemented();
}

export function validateCustomUnit(
  _unit: Record<keyof CustomUnit, unknown>,
): keyof CustomUnit | null {
  return notImplemented();
}

export function serializeCustomUnit(_unit: CustomUnit): string {
  return notImplemented();
}

export function getCustomUnits(_prefs: Prefs): CustomUnit[] {
  return notImplemented();
}

export function getManualRates(_prefs: Prefs): ManualRate[] {
  return notImplemented();
}

export function exchangeRatePrefError(
  _id: string,
  _value: string | undefined,
): string | null {
  return notImplemented();
}

export function setManualRatePatch(
  _prefs: Prefs,
  _from: string,
  _to: string,
  _rate: string,
): ExchangeRatePrefs {
  return notImplemented();
}

export function removeCustomUnitPatch(
  _prefs: Prefs,
  _code: string,
): ExchangeRatePrefs {
  return notImplemented();
}
