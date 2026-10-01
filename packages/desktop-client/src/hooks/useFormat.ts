import { useCallback, useEffect, useMemo } from 'react';

import { evalArithmetic } from '@actual-app/core/shared/arithmetic';
import { getCurrency } from '@actual-app/core/shared/currencies';
import type { Currency } from '@actual-app/core/shared/currencies';
import { formatAccountAmount } from '@actual-app/core/shared/currency-setup';
import type { AmountFormat } from '@actual-app/core/shared/currency-setup';
import { getCustomUnits } from '@actual-app/core/shared/exchange-rates';
import {
  amountToInteger,
  currencyToAmount,
  getNumberFormat,
  integerToAmount,
  integerToCurrency,
  parseNumberFormat,
  setNumberFormat,
  STORAGE_DECIMAL_PLACES,
} from '@actual-app/core/shared/util';
import type { IntegerAmount } from '@actual-app/core/shared/util';

import { useSyncedPref } from './useSyncedPref';
import { useSyncedPrefs } from './useSyncedPrefs';

export type FormatType =
  | 'string'
  | 'number'
  | 'percentage'
  | 'financial'
  | 'financial-with-sign'
  | 'financial-no-decimals';

export type FinancialFormatType = Extract<
  FormatType,
  'financial' | 'financial-with-sign' | 'financial-no-decimals'
>;

export function isFinancialFormatType(
  type: FormatType | undefined,
): type is FinancialFormatType {
  return (
    type === 'financial' ||
    type === 'financial-with-sign' ||
    type === 'financial-no-decimals'
  );
}

export type UseFormatResult = {
  (value: unknown, type?: FormatType): string;
  forEdit: (value: IntegerAmount) => string;
  fromEdit: (
    value: string,
    defaultValue?: number | null,
  ) => IntegerAmount | null;
  /**
   * Formats a stored (scale-100) amount for display using an explicit
   * currency code instead of the Main currency — for rendering an
   * account's own currency (see getEffectiveAccountCurrency). Falls back
   * to the Main currency's formatting when `currencyCode` is empty or
   * nullish (no currency, as in budgets without a Main currency).
   */
  forCurrency: (
    value: IntegerAmount,
    currencyCode: string | null | undefined,
    type?: FinancialFormatType,
  ) => string;
  currency: Currency;
  /** The user's number format prefs, for formatAccountAmount. */
  numberFormat: AmountFormat;
};

export type FormatResult = {
  numericValue?: number;
  formattedString: string;
};

function format(
  value: unknown,
  type: FormatType,
  formatter: { format: (value: number) => string },
  decimalPlaces: number,
): FormatResult {
  switch (type) {
    case 'string': {
      const val = JSON.stringify(value);

      if (val.charAt(0) === '"' && val.charAt(val.length - 1) === '"') {
        return { formattedString: val.slice(1, -1) };
      }
      return { formattedString: val };
    }
    case 'number':
      if (typeof value !== 'number') {
        throw new Error(
          'Value is not a number (' + typeof value + '): ' + value,
        );
      }
      return { numericValue: value, formattedString: formatter.format(value) };
    case 'percentage':
      return { formattedString: value + '%' };
    case 'financial-with-sign':
    case 'financial-no-decimals':
    case 'financial': {
      let localValue = value;
      if (localValue == null || localValue === '') {
        localValue = 0;
      } else if (typeof localValue === 'string') {
        // This case is generally flawed, but we need to support it for
        // backwards compatibility for now.
        // For example, it is not clear how the string might look like
        // The Budget sends 12300, if the user inputs 123.00, but
        // there might be other components that send 123 with the same user input.
        // Ideally the string case will be removed in the future. We should always
        // use the IntegerAmount.
        // The parseInt with the replace is a workaround for the case and looks like
        // the "least wrong" solution.
        const integerString = localValue.replace(/[^\d-]/g, '');
        const parsed = parseInt(integerString, 10);
        if (isNaN(parsed)) {
          throw new Error(`Invalid numeric value: ${localValue}`);
        }
        localValue = parsed;
      }

      if (typeof localValue !== 'number') {
        throw new Error(
          'Value is not a number (' + typeof localValue + '): ' + localValue,
        );
      }

      return {
        numericValue: localValue,
        formattedString: integerToCurrency(
          localValue,
          formatter,
          decimalPlaces,
        ),
      };
    }
    default:
      throw new Error('Unknown format type: ' + type);
  }
}

function withSign(
  styledValue: string,
  numericValue: number | undefined,
  type: FormatType,
): string {
  return type === 'financial-with-sign' &&
    numericValue != null &&
    numericValue >= 0
    ? '+' + styledValue
    : styledValue;
}

export function useFormat(): UseFormatResult {
  const [numberFormatPref] = useSyncedPref('numberFormat');
  const [hideFractionPref] = useSyncedPref('hideFraction');
  const [defaultCurrencyCodePref] = useSyncedPref('defaultCurrencyCode');
  const [syncedPrefs] = useSyncedPrefs();
  const customUnits = useMemo(() => getCustomUnits(syncedPrefs), [syncedPrefs]);
  const [symbolPositionPref] = useSyncedPref('currencySymbolPosition');
  const [spaceEnabledPref] = useSyncedPref(
    'currencySpaceBetweenAmountAndSymbol',
  );

  const activeCurrency = useMemo(() => {
    return getCurrency(defaultCurrencyCodePref || '');
  }, [defaultCurrencyCodePref]);

  const numberFormatConfig = useMemo(
    () =>
      parseNumberFormat({
        format: numberFormatPref,
        hideFraction: hideFractionPref === 'true',
      }),
    [numberFormatPref, hideFractionPref],
  );

  // Hack: keep the global number format in sync - update the settings when
  // the underlying configuration changes.
  // This should be patched by moving all number-formatting utilities away from
  // the global `getNumberFormat()` and to using the reactive `useFormat` hook.
  useEffect(() => {
    setNumberFormat(numberFormatConfig);
  }, [numberFormatConfig]);

  const applyCurrencyStyling = useCallback(
    (
      formattedNumericValue: string,
      currencySymbol: string,
      position: 'before' | 'after' = symbolPositionPref === 'after'
        ? 'after'
        : 'before',
      spaceEnabled: boolean = spaceEnabledPref === 'true',
    ): string => {
      if (!currencySymbol) {
        return formattedNumericValue;
      }

      let sign = '';
      let valueWithoutSign = formattedNumericValue;
      if (formattedNumericValue.startsWith('-')) {
        sign = '-';
        valueWithoutSign = formattedNumericValue.slice(1);
      }

      const space = spaceEnabled ? '\u202F' : '';

      const styledAmount =
        position === 'after'
          ? `${valueWithoutSign}${space}${currencySymbol}`
          : `\u202A${currencySymbol}\u202C${space}${valueWithoutSign}`;

      return sign + styledAmount;
    },
    [symbolPositionPref, spaceEnabledPref],
  );

  const formatDisplay = useCallback(
    (value: unknown, type: FormatType = 'string'): string => {
      const isFinancialType = isFinancialFormatType(type);

      let displayDecimalPlaces: number | undefined;

      if (isFinancialType) {
        if (type === 'financial-no-decimals' || hideFractionPref === 'true') {
          displayDecimalPlaces = 0;
        } else {
          displayDecimalPlaces = activeCurrency.decimalPlaces;
        }
      }

      const intlFormatter = getNumberFormat({
        format: numberFormatConfig.format,
        decimalPlaces: displayDecimalPlaces,
      }).formatter;

      const { numericValue, formattedString } = format(
        value,
        type,
        intlFormatter,
        activeCurrency.decimalPlaces,
      );

      let styledValue = formattedString;
      if (isFinancialType && activeCurrency && activeCurrency.code !== '') {
        styledValue = applyCurrencyStyling(
          formattedString,
          activeCurrency.symbol,
        );
      }

      return withSign(styledValue, numericValue, type);
    },
    [
      activeCurrency,
      numberFormatConfig,
      applyCurrencyStyling,
      hideFractionPref,
    ],
  );

  const toAmount = useCallback(
    (value: number) => integerToAmount(value, activeCurrency.decimalPlaces),
    [activeCurrency.decimalPlaces],
  );

  const fromAmount = useCallback(
    (value: number) => amountToInteger(value, activeCurrency.decimalPlaces),
    [activeCurrency.decimalPlaces],
  );

  const forEdit = useCallback(
    (value: IntegerAmount) => {
      const amount = toAmount(value);
      const decimalPlaces =
        hideFractionPref === 'true' ? 0 : activeCurrency.decimalPlaces;
      const editFormatter = getNumberFormat({
        format: numberFormatConfig.format,
        decimalPlaces,
      }).formatter;
      return editFormatter.format(amount);
    },
    [
      toAmount,
      hideFractionPref,
      activeCurrency.decimalPlaces,
      numberFormatConfig.format,
    ],
  );

  const fromEdit = useCallback(
    (
      value: string,
      defaultValue: number | null = null,
    ): IntegerAmount | null => {
      if (value == null) {
        return defaultValue;
      }

      const trimmed = value.trim();
      if (trimmed === '') {
        return defaultValue;
      }

      // strip directional formatting characters and letters
      const normalized = trimmed
        .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
        .replace(/\p{L}+/gu, '');
      let numericValue: number | null = evalArithmetic(normalized, null);

      if (numericValue === null || isNaN(numericValue)) {
        numericValue = currencyToAmount(normalized);
      }

      if (numericValue !== null && !isNaN(numericValue)) {
        return fromAmount(numericValue);
      }

      return defaultValue;
    },
    [fromAmount],
  );

  const forCurrency = useCallback(
    (
      value: IntegerAmount,
      currencyCode: string | null | undefined,
      type: FinancialFormatType = 'financial',
    ): string => {
      if (!currencyCode) {
        return formatDisplay(value, type);
      }

      // Custom units carry their own symbol and decimals; the symbol
      // always follows the amount.
      const unit = customUnits.find(u => u.code === currencyCode);
      if (unit) {
        const unitFormatter = getNumberFormat({
          format: numberFormatConfig.format,
          decimalPlaces:
            numberFormatConfig.hideFraction || type === 'financial-no-decimals'
              ? 0
              : unit.decimals,
        }).formatter;
        return withSign(
          applyCurrencyStyling(
            integerToCurrency(value, unitFormatter, STORAGE_DECIMAL_PLACES),
            unit.symbol,
            'after',
            true,
          ),
          value,
          type,
        );
      }

      const currency = getCurrency(currencyCode);
      const formattedString = formatAccountAmount(value, currencyCode, {
        ...numberFormatConfig,
        hideFraction:
          numberFormatConfig.hideFraction || type === 'financial-no-decimals',
      });

      // Non-Main currencies use their own symbol placement and spacing;
      // the Main currency keeps the user's prefs (applyCurrencyStyling's
      // defaults). Unknown codes resolve to the symbol-less None currency.
      let position: 'before' | 'after' | undefined;
      let spaceEnabled: boolean | undefined;
      if (currency.code !== activeCurrency.code) {
        position = currency.symbolFirst ? 'before' : 'after';
        spaceEnabled = currency.spaceBetweenAmountAndSymbol;
      }
      const styledValue = applyCurrencyStyling(
        formattedString,
        currency.symbol,
        position,
        spaceEnabled,
      );

      return withSign(styledValue, value, type);
    },
    [
      activeCurrency.code,
      customUnits,
      formatDisplay,
      numberFormatConfig,
      applyCurrencyStyling,
    ],
  );

  return Object.assign(formatDisplay, {
    forEdit,
    fromEdit,
    forCurrency,
    currency: activeCurrency,
    numberFormat: numberFormatConfig,
  });
}
