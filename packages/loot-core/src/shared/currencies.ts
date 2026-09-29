import type { NumberFormats } from './util';

export type Currency = {
  code: string;
  symbol: string;
  name: string;
  decimalPlaces: number;
  // Display-only precision when it differs from decimalPlaces. Storage is
  // fixed at STORAGE_DECIMAL_PLACES for every currency (see CHE-838).
  displayDecimalPlaces?: number;
  numberFormat: NumberFormats;
  symbolFirst: boolean;
  // CLDR spacing between symbol and amount in the currency's home locale.
  spaceBetweenAmountAndSymbol: boolean;
};

// When adding a new currency with a higher decimal precision, make sure to update
// the MAX_SAFE_NUMBER in util.ts.
// When adding a currency, also update the translation map in
// packages/desktop-client/src/components/settings/Currency.tsx for the translation.
// Number formats and symbol placement based on CLDR (Common Locale Data Repository) /
// LDML (Locale Data Markup Language) locale conventions and Intl.NumberFormat standards
// References:
// https://www.localeplanet.com/icu/decimal-symbols.html
// https://www.localeplanet.com/api/auto/currencymap.html
// prettier-ignore
export const currencies: Currency[] = [
  { code: '', name: 'None', symbol: '', decimalPlaces: 2, numberFormat: 'comma-dot', symbolFirst: true, spaceBetweenAmountAndSymbol: false },
  { code: 'AED', name: 'UAE Dirham', symbol: 'د.إ', decimalPlaces: 2, numberFormat: 'comma-dot', symbolFirst: false, spaceBetweenAmountAndSymbol: true },
  { code: 'ARS', name: 'Argentinian Peso', symbol: 'Arg$', decimalPlaces: 2, numberFormat: 'dot-comma', symbolFirst: true, spaceBetweenAmountAndSymbol: true },
  { code: 'AUD', name: 'Australian Dollar', symbol: 'A$', decimalPlaces: 2, numberFormat: 'comma-dot', symbolFirst: true, spaceBetweenAmountAndSymbol: false },
  { code: 'BRL', name: 'Brazilian Real', symbol: 'R$', decimalPlaces: 2, numberFormat: 'dot-comma', symbolFirst: true, spaceBetweenAmountAndSymbol: true },
  { code: 'BYN', name: 'Belarusian Ruble', symbol: 'Br', decimalPlaces: 2, numberFormat: 'space-comma', symbolFirst: false, spaceBetweenAmountAndSymbol: true },
  { code: 'CAD', name: 'Canadian Dollar', symbol: 'CA$', decimalPlaces: 2, numberFormat: 'comma-dot', symbolFirst: true, spaceBetweenAmountAndSymbol: false },
  { code: 'CHF', name: 'Swiss Franc', symbol: 'Fr.', decimalPlaces: 2, numberFormat: 'apostrophe-dot', symbolFirst: true, spaceBetweenAmountAndSymbol: true },
  { code: 'CLP', name: 'Chilean Peso', symbol: 'CLP$', decimalPlaces: 2, numberFormat: 'dot-comma', symbolFirst: true, spaceBetweenAmountAndSymbol: false },
  { code: 'CNY', name: 'Yuan Renminbi', symbol: '¥', decimalPlaces: 2, numberFormat: 'comma-dot', symbolFirst: true, spaceBetweenAmountAndSymbol: false },
  { code: 'COP', name: 'Colombian Peso', symbol: 'Col$', decimalPlaces: 2, numberFormat: 'dot-comma', symbolFirst: true, spaceBetweenAmountAndSymbol: true },
  { code: 'CRC', name: 'Costa Rican Colón', symbol: '₡', decimalPlaces: 2, numberFormat: 'space-comma', symbolFirst: true, spaceBetweenAmountAndSymbol: false },
  { code: 'CZK', name: 'Czech Koruna', symbol: 'Kč', decimalPlaces: 2, numberFormat: 'space-comma', symbolFirst: false, spaceBetweenAmountAndSymbol: true },
  { code: 'DKK', name: 'Danish Krone', symbol: 'kr', decimalPlaces: 2, numberFormat: 'dot-comma', symbolFirst: false, spaceBetweenAmountAndSymbol: true },
  { code: 'DOP', name: 'Dominican Peso', symbol: 'RD$', decimalPlaces: 2, numberFormat: 'comma-dot', symbolFirst: true, spaceBetweenAmountAndSymbol: false },
  { code: 'EGP', name: 'Egyptian Pound', symbol: 'ج.م', decimalPlaces: 2, numberFormat: 'comma-dot', symbolFirst: false, spaceBetweenAmountAndSymbol: true },
  { code: 'EUR', name: 'Euro', symbol: '€', decimalPlaces: 2, numberFormat: 'dot-comma', symbolFirst: false, spaceBetweenAmountAndSymbol: true },
  { code: 'GBP', name: 'Pound Sterling', symbol: '£', decimalPlaces: 2, numberFormat: 'comma-dot', symbolFirst: true, spaceBetweenAmountAndSymbol: false },
  { code: 'GTQ', name: 'Guatemalan Quetzal', symbol: 'Q', decimalPlaces: 2, numberFormat: 'comma-dot', symbolFirst: true, spaceBetweenAmountAndSymbol: true },
  { code: 'HKD', name: 'Hong Kong Dollar', symbol: 'HK$', decimalPlaces: 2, numberFormat: 'comma-dot', symbolFirst: true, spaceBetweenAmountAndSymbol: false },
  { code: 'HUF', name: 'Hungarian Forint', symbol: 'Ft', decimalPlaces: 2, numberFormat: 'space-comma', symbolFirst: false, spaceBetweenAmountAndSymbol: true },
  { code: 'IDR', name: 'Indonesian Rupiah', symbol: 'Rp', decimalPlaces: 2, numberFormat: 'dot-comma', symbolFirst: true, spaceBetweenAmountAndSymbol: true },
  { code: 'ILS', name: 'Israeli New Shekel', symbol: '₪', decimalPlaces: 2, numberFormat: 'comma-dot', symbolFirst: true, spaceBetweenAmountAndSymbol: false },
  { code: 'INR', name: 'Indian Rupee', symbol: '₹', decimalPlaces: 2, numberFormat: 'comma-dot-in', symbolFirst: true, spaceBetweenAmountAndSymbol: false },
  { code: 'IRR', name: 'Iranian Rial', symbol: '﷼', decimalPlaces: 0, numberFormat: 'comma-dot', symbolFirst: false, spaceBetweenAmountAndSymbol: true },
  { code: 'JMD', name: 'Jamaican Dollar', symbol: 'J$', decimalPlaces: 2, numberFormat: 'comma-dot', symbolFirst: true, spaceBetweenAmountAndSymbol: false },
  { code: 'JPY', name: 'Japanese Yen', symbol: '¥', decimalPlaces: 0, numberFormat: 'comma-dot', symbolFirst: true, spaceBetweenAmountAndSymbol: false },
  { code: 'KRW', name: 'South Korean Won', symbol: '₩', decimalPlaces: 0, numberFormat: 'comma-dot', symbolFirst: true, spaceBetweenAmountAndSymbol: false },
  { code: 'LKR', name: 'Sri Lankan Rupee', symbol: 'Rs.', decimalPlaces: 2, numberFormat: 'comma-dot', symbolFirst: true, spaceBetweenAmountAndSymbol: true },
  { code: 'MDL', name: 'Moldovan Leu', symbol: 'L', decimalPlaces: 2, numberFormat: 'dot-comma', symbolFirst: false, spaceBetweenAmountAndSymbol: true },
  { code: 'MKD', name: 'Macedonian Denar', symbol: 'ден', decimalPlaces: 2, numberFormat: 'dot-comma', symbolFirst: false, spaceBetweenAmountAndSymbol: true },
  { code: 'MXN', name: 'Mexican Peso', symbol: '$', decimalPlaces: 2, numberFormat: 'comma-dot', symbolFirst: true, spaceBetweenAmountAndSymbol: false },
  { code: 'MYR', name: 'Malaysian Ringgit', symbol: 'RM', decimalPlaces: 2, numberFormat: 'comma-dot', symbolFirst: true, spaceBetweenAmountAndSymbol: true },
  { code: 'PEN', name: 'Peruvian Sol', symbol: 'S/', decimalPlaces: 2, numberFormat: 'comma-dot', symbolFirst: true, spaceBetweenAmountAndSymbol: true },
  { code: 'PHP', name: 'Philippine Peso', symbol: '₱', decimalPlaces: 2, numberFormat: 'comma-dot', symbolFirst: true, spaceBetweenAmountAndSymbol: false },
  { code: 'PKR', name: 'Pakistani Rupee', symbol: 'Rs.', decimalPlaces: 2, numberFormat: 'comma-dot', symbolFirst: true, spaceBetweenAmountAndSymbol: true },
  { code: 'PLN', name: 'Polish Złoty', symbol: 'zł', decimalPlaces: 2, numberFormat: 'space-comma', symbolFirst: false, spaceBetweenAmountAndSymbol: true },
  { code: 'QAR', name: 'Qatari Riyal', symbol: 'ر.ق', decimalPlaces: 2, numberFormat: 'comma-dot', symbolFirst: false, spaceBetweenAmountAndSymbol: true },
  { code: 'RON', name: 'Romanian Leu', symbol: 'lei', decimalPlaces: 2, numberFormat: 'dot-comma', symbolFirst: false, spaceBetweenAmountAndSymbol: true },
  { code: 'RSD', name: 'Serbian Dinar', symbol: 'дин', decimalPlaces: 2, numberFormat: 'dot-comma', symbolFirst: false, spaceBetweenAmountAndSymbol: true },
  { code: 'RUB', name: 'Russian Ruble', symbol: '₽', decimalPlaces: 2, numberFormat: 'space-comma', symbolFirst: false, spaceBetweenAmountAndSymbol: true },
  { code: 'SAR', name: 'Saudi Riyal', symbol: 'ر.س', decimalPlaces: 2, numberFormat: 'comma-dot', symbolFirst: false, spaceBetweenAmountAndSymbol: true },
  { code: 'SEK', name: 'Swedish Krona', symbol: 'kr', decimalPlaces: 2, numberFormat: 'space-comma', symbolFirst: false, spaceBetweenAmountAndSymbol: true },
  { code: 'SGD', name: 'Singapore Dollar', symbol: 'S$', decimalPlaces: 2, numberFormat: 'comma-dot', symbolFirst: true, spaceBetweenAmountAndSymbol: false },
  { code: 'THB', name: 'Thai Baht', symbol: '฿', decimalPlaces: 2, numberFormat: 'comma-dot', symbolFirst: true, spaceBetweenAmountAndSymbol: false },
  { code: 'TRY', name: 'Turkish Lira', symbol: '₺', decimalPlaces: 2, numberFormat: 'dot-comma', symbolFirst: true, spaceBetweenAmountAndSymbol: false },
  { code: 'TWD', name: 'New Taiwan Dollar', symbol: 'NT$', decimalPlaces: 2, numberFormat: 'comma-dot', symbolFirst: true, spaceBetweenAmountAndSymbol: false },
  { code: 'UAH', name: 'Ukrainian Hryvnia', symbol: '₴', decimalPlaces: 2, numberFormat: 'space-comma', symbolFirst: false, spaceBetweenAmountAndSymbol: true },
  { code: 'USD', name: 'US Dollar', symbol: '$', decimalPlaces: 2, numberFormat: 'comma-dot', symbolFirst: true, spaceBetweenAmountAndSymbol: false },
  { code: 'UYU', name: 'Uruguayan Peso', symbol: '$U', decimalPlaces: 2, numberFormat: 'dot-comma', symbolFirst: true, spaceBetweenAmountAndSymbol: true },
  { code: 'UZS', name: 'Uzbek Soum', symbol: 'UZS', decimalPlaces: 2, numberFormat: 'space-comma', symbolFirst: false, spaceBetweenAmountAndSymbol: true },
  { code: 'VND', name: 'Vietnamese Dong', symbol: '₫', decimalPlaces: 2, displayDecimalPlaces: 0, numberFormat: 'comma-dot', symbolFirst: false, spaceBetweenAmountAndSymbol: true },
];

export function getCurrency(code: string): Currency {
  return currencies.find(c => c.code === code) || currencies[0];
}

export function getDecimalPlaces(currencyCode: string): number {
  return getCurrency(currencyCode)?.decimalPlaces ?? 2;
}
