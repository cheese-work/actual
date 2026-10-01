import React, { useEffect, useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Input } from '@actual-app/components/input';
import { Select } from '@actual-app/components/select';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { currencies, getCurrency } from '@actual-app/core/shared/currencies';
import {
  customUnitKey,
  formatInverseRate,
  formatRateForInput,
  getCustomUnits,
  getManualRates,
  parseRateInput,
  removeCustomUnitPatch,
  serializeCustomUnit,
  setManualRatePatch,
  validateCustomUnit,
} from '@actual-app/core/shared/exchange-rates';
import type { CustomUnit } from '@actual-app/core/shared/exchange-rates';
import { parseNumberFormat } from '@actual-app/core/shared/util';
import { css } from '@emotion/css';

import { Checkbox, FormField, FormLabel } from '#components/forms';
import { useSyncedPref } from '#hooks/useSyncedPref';
import { useSyncedPrefs } from '#hooks/useSyncedPrefs';

import { Column, Setting } from './UI';

type RateUnit = {
  code: string;
  name: string;
};

function ManualRateInput({
  unit,
  mainCurrencyCode,
  initialRate,
  onSave,
}: {
  unit: RateUnit;
  mainCurrencyCode: string;
  initialRate: string;
  onSave: (rate: string) => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initialRate);
  const [hasError, setHasError] = useState(false);
  const [numberFormatPref] = useSyncedPref('numberFormat');
  const numberFormat = parseNumberFormat({ format: numberFormatPref }).format;
  const id = `manual-rate-${unit.code}`;

  useEffect(() => {
    setValue(initialRate);
    setHasError(false);
  }, [initialRate]);

  const save = () => {
    if (value.trim() === '') {
      onSave('');
      setHasError(false);
      return;
    }

    const rate = parseRateInput(value, numberFormat);
    if (!rate) {
      setHasError(true);
      return;
    }

    onSave(rate);
    setHasError(false);
  };

  return (
    <View
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'flex-end',
        gap: 10,
        width: '100%',
      }}
    >
      <FormField style={{ flex: 1 }}>
        <FormLabel
          htmlFor={id}
          title={t('{{from}} to {{to}} rate', {
            from: unit.code,
            to: mainCurrencyCode,
          })}
        />
        <Input
          id={id}
          type="text"
          inputMode="decimal"
          value={value}
          aria-invalid={hasError}
          onChange={event => setValue(event.target.value)}
        />
      </FormField>
      <Button
        onPress={save}
        aria-label={t('Save {{code}} rate', { code: unit.code })}
      >
        <Trans>Save</Trans>
      </Button>
      {hasError && (
        <Text role="alert" style={{ color: theme.errorText }}>
          <Trans>Enter a positive rate using your number format.</Trans>
        </Text>
      )}
    </View>
  );
}

export function CurrencySettings() {
  const { t } = useTranslation();
  const [syncedPrefs, setSyncedPrefs] = useSyncedPrefs();

  const currencyTranslations = useMemo(
    () =>
      new Map<string, string>([
        ['', t('None')],
        ['AED', t('UAE Dirham')],
        ['ARS', t('Argentinian Peso')],
        ['AUD', t('Australian Dollar')],
        ['BRL', t('Brazilian Real')],
        ['BYN', t('Belarusian Ruble')],
        ['CAD', t('Canadian Dollar')],
        ['CHF', t('Swiss Franc')],
        ['CLP', t('Chilean Peso')],
        ['CNY', t('Yuan Renminbi')],
        ['COP', t('Colombian Peso')],
        ['CRC', t('Costa Rican Colón')],
        ['CZK', t('Czech Koruna')],
        ['DKK', t('Danish Krone')],
        ['DOP', t('Dominican Peso')],
        ['EGP', t('Egyptian Pound')],
        ['EUR', t('Euro')],
        ['GBP', t('Pound Sterling')],
        ['GTQ', t('Guatemalan Quetzal')],
        ['HKD', t('Hong Kong Dollar')],
        ['HUF', t('Hungarian Forint')],
        ['IDR', t('Indonesian Rupiah')],
        ['ILS', t('Israeli New Shekel')],
        ['INR', t('Indian Rupee')],
        ['IRR', t('Iranian Rial')],
        ['JMD', t('Jamaican Dollar')],
        ['JPY', t('Japanese Yen')],
        ['KRW', t('South Korean Won')],
        ['LKR', t('Sri Lankan Rupee')],
        ['MDL', t('Moldovan Leu')],
        ['MKD', t('Macedonian Denar')],
        ['MXN', t('Mexican Peso')],
        ['MYR', t('Malaysian Ringgit')],
        ['PEN', t('Peruvian Sol')],
        ['PHP', t('Philippine Peso')],
        ['PKR', t('Pakistani Rupee')],
        ['PLN', t('Polish Złoty')],
        ['QAR', t('Qatari Riyal')],
        ['RON', t('Romanian Leu')],
        ['RSD', t('Serbian Dinar')],
        ['RUB', t('Russian Ruble')],
        ['SAR', t('Saudi Riyal')],
        ['SEK', t('Swedish Krona')],
        ['SGD', t('Singapore Dollar')],
        ['THB', t('Thai Baht')],
        ['TRY', t('Turkish Lira')],
        ['TWD', t('New Taiwan Dollar')],
        ['UAH', t('Ukrainian Hryvnia')],
        ['USD', t('US Dollar')],
        ['UYU', t('Uruguayan Peso')],
        ['UZS', t('Uzbek Soum')],
      ]),
    [t],
  );

  const [defaultCurrencyCode, setDefaultCurrencyCodePref] = useSyncedPref(
    'defaultCurrencyCode',
  );
  const [numberFormatPref] = useSyncedPref('numberFormat');
  const numberFormat = parseNumberFormat({ format: numberFormatPref }).format;
  const selectedCurrencyCode = defaultCurrencyCode || '';
  const customUnits = getCustomUnits(syncedPrefs);
  const manualRates = getManualRates(syncedPrefs);
  const mainCurrency = selectedCurrencyCode
    ? getCurrency(selectedCurrencyCode)
    : null;
  const rateUnits = useMemo<RateUnit[]>(
    () =>
      [
        ...currencies
          .filter(
            currency =>
              currency.code !== '' && currency.code !== selectedCurrencyCode,
          )
          .map(currency => ({
            code: currency.code,
            name: currencyTranslations.get(currency.code) ?? currency.name,
          })),
        ...customUnits.map(unit => ({
          code: unit.code,
          name: `${unit.name} (${unit.symbol})`,
        })),
      ].sort((a, b) => a.code.localeCompare(b.code, 'en')),
    [customUnits, currencyTranslations, selectedCurrencyCode],
  );
  const [unitCodeInput, setUnitCodeInput] = useState('');
  const [unitNameInput, setUnitNameInput] = useState('');
  const [unitSymbolInput, setUnitSymbolInput] = useState('');
  const [unitDecimalsInput, setUnitDecimalsInput] = useState('2');

  const [symbolPosition, setSymbolPositionPref] = useSyncedPref(
    'currencySymbolPosition',
  );
  const [spaceEnabled, setSpaceEnabledPref] = useSyncedPref(
    'currencySpaceBetweenAmountAndSymbol',
  );
  const [, setNumberFormatPref] = useSyncedPref('numberFormat');
  const [, setHideFractionPref] = useSyncedPref('hideFraction');

  const selectButtonClassName = css({
    '&[data-hovered]': {
      backgroundColor: theme.buttonNormalBackgroundHover,
    },
  });

  const currencyOptions: [string, string][] = currencies.map(currency => {
    const translatedName =
      currencyTranslations.get(currency.code) ?? currency.name;
    if (currency.code === '') {
      return [currency.code, translatedName];
    }
    return [
      currency.code,
      `${currency.code} - ${translatedName} (${currency.symbol})`,
    ];
  });

  const handleCurrencyChange = (code: string) => {
    setDefaultCurrencyCodePref(code);
    if (code !== '') {
      const cur = getCurrency(code);
      setNumberFormatPref(cur.numberFormat);
      setHideFractionPref(cur.decimalPlaces === 0 ? 'true' : 'false');
      setSpaceEnabledPref(cur.spaceBetweenAmountAndSymbol ? 'true' : 'false');
      setSymbolPositionPref(cur.symbolFirst ? 'before' : 'after');
    }
  };

  const symbolPositionOptions = useMemo(() => {
    const selectedCurrency = getCurrency(selectedCurrencyCode);
    const symbol = selectedCurrency.symbol || '$';
    const space = spaceEnabled === 'true' ? ' ' : '';

    return [
      {
        value: 'before',
        label: `${t('Before amount')} (${t('e.g.')} ${symbol}${space}100)`,
      },
      {
        value: 'after',
        label: `${t('After amount')} (${t('e.g.')} 100${space}${symbol})`,
      },
    ];
  }, [selectedCurrencyCode, spaceEnabled, t]);

  const customUnitCodeValue = `X-${unitCodeInput.trim().replace(/^X-/i, '').toUpperCase()}`;
  const customUnitCandidate: CustomUnit = {
    code: customUnitCodeValue,
    name: unitNameInput,
    symbol: unitSymbolInput,
    decimals: unitDecimalsInput === '' ? -1 : Number(unitDecimalsInput),
  };
  const invalidCustomUnitField = validateCustomUnit(customUnitCandidate);
  const hasDuplicateCustomUnit = customUnits.some(
    unit => unit.code === customUnitCandidate.code,
  );
  const customUnitError = hasDuplicateCustomUnit
    ? t('A custom unit with this code already exists.')
    : invalidCustomUnitField === 'code'
      ? t('Use 1–10 letters or digits for the code.')
      : invalidCustomUnitField === 'name'
        ? t('Enter a name up to 40 characters.')
        : invalidCustomUnitField === 'symbol'
          ? t('Enter a symbol up to 8 characters.')
          : invalidCustomUnitField === 'decimals'
            ? t('Display decimals must be 0, 1, or 2.')
            : null;

  const addCustomUnit = () => {
    if (invalidCustomUnitField || hasDuplicateCustomUnit) {
      return;
    }
    setSyncedPrefs({
      [customUnitKey(customUnitCandidate.code)]:
        serializeCustomUnit(customUnitCandidate),
    });
    setUnitCodeInput('');
    setUnitNameInput('');
    setUnitSymbolInput('');
    setUnitDecimalsInput('2');
  };

  const saveRate = (from: string, rate: string) => {
    setSyncedPrefs(
      setManualRatePatch(syncedPrefs, from, selectedCurrencyCode, rate),
    );
  };

  return (
    <>
      <Setting
        primaryAction={
          <View
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '1.5em',
              width: '100%',
            }}
          >
            <View
              style={{ display: 'flex', flexDirection: 'row', gap: '1.5em' }}
            >
              <Column title={t('Default Currency')}>
                <Select
                  value={selectedCurrencyCode}
                  onChange={handleCurrencyChange}
                  options={currencyOptions}
                  className={selectButtonClassName}
                  style={{ width: '100%' }}
                />
              </Column>

              <Column
                title={t('Symbol Position')}
                style={{
                  visibility:
                    selectedCurrencyCode === '' ? 'hidden' : 'visible',
                }}
              >
                <Select
                  value={symbolPosition || 'before'}
                  onChange={value => setSymbolPositionPref(value)}
                  options={symbolPositionOptions.map(f => [f.value, f.label])}
                  className={selectButtonClassName}
                  style={{ width: '100%' }}
                  disabled={selectedCurrencyCode === ''}
                />
              </Column>
            </View>

            {selectedCurrencyCode !== '' && (
              <View
                style={{
                  display: 'flex',
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'flex-start',
                }}
              >
                <Checkbox
                  id="settings-spaceEnabled"
                  checked={spaceEnabled === 'true'}
                  onChange={e =>
                    setSpaceEnabledPref(e.target.checked ? 'true' : 'false')
                  }
                />
                <label
                  htmlFor="settings-spaceEnabled"
                  style={{ marginLeft: '0.5em' }}
                >
                  <Trans>Add space between amount and symbol</Trans>
                </label>
              </View>
            )}
          </View>
        }
      >
        <Text>
          <Trans>
            <strong>Currency settings</strong> affect how amounts are displayed
            throughout the application. Changing the currency will affect the
            number format, symbol position, and whether fractions are shown.
            These can be adjusted after the currency is set.
          </Trans>
        </Text>
      </Setting>
      <Setting>
        <View style={{ display: 'flex', flexDirection: 'column', gap: 15 }}>
          <View>
            <Text style={{ fontWeight: 600 }}>
              <Trans>Manual exchange rates</Trans>
            </Text>
            <Text>
              {mainCurrency ? (
                <Trans>
                  Enter how much one unit is worth in{' '}
                  {{
                    mainCurrency: selectedCurrencyCode,
                  }}
                  . The inverse rate is calculated automatically.
                </Trans>
              ) : (
                <Trans>Select a default currency to set manual rates.</Trans>
              )}
            </Text>
          </View>
          {mainCurrency &&
            rateUnits.map(unit => {
              const direct = manualRates.find(
                rate =>
                  rate.from === unit.code && rate.to === selectedCurrencyCode,
              );
              const inverse = manualRates.find(
                rate =>
                  rate.from === selectedCurrencyCode && rate.to === unit.code,
              );
              const rate =
                direct?.rate ??
                (inverse ? formatInverseRate(inverse.rate) : '');

              return (
                <ManualRateInput
                  key={unit.code}
                  unit={unit}
                  mainCurrencyCode={selectedCurrencyCode}
                  initialRate={formatRateForInput(
                    rate,
                    parseNumberFormat({ format: numberFormat }).format,
                  )}
                  onSave={value => saveRate(unit.code, value)}
                />
              );
            })}
          <View
            style={{
              borderTop: `1px solid ${theme.pillBorderDark}`,
              paddingTop: 12,
            }}
          >
            <Text style={{ fontWeight: 600, marginBottom: 8 }}>
              <Trans>Custom units</Trans>
            </Text>
            <Text style={{ marginBottom: 10 }}>
              <Trans>
                Use a unique code; custom unit codes are saved with an X-
                prefix.
              </Trans>
            </Text>
            <View
              style={{
                display: 'flex',
                flexDirection: 'row',
                flexWrap: 'wrap',
                alignItems: 'flex-end',
                gap: 10,
              }}
            >
              <FormField style={{ flex: '1 1 120px' }}>
                <FormLabel
                  htmlFor="custom-unit-code"
                  title={t('Custom unit code')}
                />
                <Input
                  id="custom-unit-code"
                  value={unitCodeInput}
                  maxLength={12}
                  onChange={event => setUnitCodeInput(event.target.value)}
                />
              </FormField>
              <FormField style={{ flex: '2 1 140px' }}>
                <FormLabel
                  htmlFor="custom-unit-name"
                  title={t('Custom unit name')}
                />
                <Input
                  id="custom-unit-name"
                  value={unitNameInput}
                  maxLength={40}
                  onChange={event => setUnitNameInput(event.target.value)}
                />
              </FormField>
              <FormField style={{ flex: '1 1 100px' }}>
                <FormLabel
                  htmlFor="custom-unit-symbol"
                  title={t('Custom unit symbol')}
                />
                <Input
                  id="custom-unit-symbol"
                  value={unitSymbolInput}
                  maxLength={8}
                  onChange={event => setUnitSymbolInput(event.target.value)}
                />
              </FormField>
              <FormField style={{ width: 90 }}>
                <FormLabel
                  htmlFor="custom-unit-decimals"
                  title={t('Display decimals')}
                />
                <Input
                  id="custom-unit-decimals"
                  type="number"
                  min={0}
                  max={2}
                  step={1}
                  value={unitDecimalsInput}
                  onChange={event => setUnitDecimalsInput(event.target.value)}
                />
              </FormField>
              <Button
                onPress={addCustomUnit}
                isDisabled={Boolean(
                  invalidCustomUnitField || hasDuplicateCustomUnit,
                )}
              >
                <Trans>Add custom unit</Trans>
              </Button>
            </View>
            {customUnitError && (
              <Text role="alert" style={{ color: theme.errorText }}>
                {customUnitError}
              </Text>
            )}
            {customUnits.map(unit => (
              <View
                key={unit.code}
                style={{
                  display: 'flex',
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                  marginTop: 8,
                }}
              >
                <Text>
                  {unit.code} — {unit.name} ({unit.symbol}), {unit.decimals}{' '}
                  <Trans>decimals</Trans>
                </Text>
                <Button
                  onPress={() =>
                    setSyncedPrefs(
                      removeCustomUnitPatch(syncedPrefs, unit.code),
                    )
                  }
                  aria-label={t('Remove {{code}}', { code: unit.code })}
                >
                  <Trans>Remove</Trans>
                </Button>
              </View>
            ))}
          </View>
        </View>
      </Setting>
    </>
  );
}
