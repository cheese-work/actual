// @ts-strict-ignore
import React from 'react';
import type { ComponentPropsWithoutRef, CSSProperties, ReactNode } from 'react';

import { Text } from '@actual-app/components/text';

import { FinancialText } from '#components/FinancialText';
import { PrivacyFilter } from '#components/PrivacyFilter';
import { useFormat } from '#hooks/useFormat';
import type { FormatType } from '#hooks/useFormat';
import { useSheetName } from '#hooks/useSheetName';
import { useSheetValue } from '#hooks/useSheetValue';
import type {
  Binding,
  SheetFields,
  SheetNames,
  Spreadsheets,
} from '#spreadsheet';

type CellValueProps<
  SheetName extends SheetNames,
  FieldName extends SheetFields<SheetName>,
> = {
  children?: ({
    type,
    name,
    value,
  }: {
    type?: FormatType;
    name: string;
    value: Spreadsheets[SheetName][FieldName];
  }) => ReactNode;
  binding: Binding<SheetName, FieldName>;
  type?: FormatType;
  /** Effective account currency (see getEffectiveAccountCurrency) to format
   * this value in, instead of the Main currency. Ignored for non-financial
   * `type`s. */
  currency?: string | null;
};

export function CellValue<
  SheetName extends SheetNames,
  FieldName extends SheetFields<SheetName>,
>({
  type,
  binding,
  children,
  currency,
  ...props
}: CellValueProps<SheetName, FieldName>) {
  const { fullSheetName } = useSheetName(binding);
  const sheetValue = useSheetValue(binding);

  return typeof children === 'function' ? (
    <>{children({ type, name: fullSheetName, value: sheetValue })}</>
  ) : (
    <CellValueText
      type={type}
      name={fullSheetName}
      value={sheetValue}
      currency={currency}
      {...props}
    />
  );
}

const PRIVACY_FILTER_TYPES = ['financial', 'financial-with-sign'];

type CellValueTextProps<
  SheetName extends SheetNames,
  FieldName extends SheetFields<SheetName>,
> = Omit<ComponentPropsWithoutRef<typeof Text>, 'value' | 'as'> & {
  type?: FormatType;
  name: string;
  value: Spreadsheets[SheetName][FieldName];
  style?: CSSProperties;
  formatter?: (
    value: Spreadsheets[SheetName][FieldName],
    type?: FormatType,
  ) => string;
  /** Effective account currency (see getEffectiveAccountCurrency) to format
   * this value in, instead of the Main currency. Ignored for non-financial
   * `type`s, and when `formatter` is provided. */
  currency?: string | null;
};

export function CellValueText<
  SheetName extends SheetNames,
  FieldName extends SheetFields<SheetName>,
>({
  type,
  name,
  value,
  formatter,
  currency,
  style,
  ...props
}: CellValueTextProps<SheetName, FieldName>) {
  const format = useFormat();
  const isFinancial =
    type === 'financial' ||
    type === 'financial-with-sign' ||
    type === 'financial-no-decimals';
  const sharedProps = {
    style,
    'data-testid': name,
    'data-cellname': name,
    ...props,
  };

  const renderValue = () => {
    if (formatter) {
      return formatter(value, type);
    }
    if (currency && isFinancial && typeof value === 'number') {
      return format.forCurrency(value, currency, type);
    }
    return format(value, type);
  };

  if (isFinancial) {
    return (
      <FinancialText
        {...sharedProps}
        style={{
          whiteSpace: 'nowrap',
          ...style,
        }}
      >
        <PrivacyFilter
          activationFilters={[PRIVACY_FILTER_TYPES.includes(type)]}
        >
          {renderValue()}
        </PrivacyFilter>
      </FinancialText>
    );
  }

  return (
    <Text {...sharedProps}>
      <PrivacyFilter activationFilters={[PRIVACY_FILTER_TYPES.includes(type)]}>
        {renderValue()}
      </PrivacyFilter>
    </Text>
  );
}
