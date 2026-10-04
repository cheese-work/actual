import React from 'react';
import type { CSSProperties } from 'react';

import { Block } from '@actual-app/components/block';
import { styles } from '@actual-app/components/styles';
import { theme } from '@actual-app/components/theme';

import { FinancialText } from '#components/FinancialText';
import { useFormat } from '#hooks/useFormat';

export function Change({
  amount,
  style,
  currencyCode,
}: {
  amount: number;
  style?: CSSProperties;
  currencyCode?: string | null;
}) {
  const format = useFormat();
  const formattedAmount = currencyCode
    ? format.forCurrency(amount, currencyCode, 'financial')
    : format(amount, 'financial');

  return (
    <FinancialText
      as={Block}
      style={{
        ...styles.smallText,
        color:
          amount === 0
            ? theme.reportsNumberNeutral
            : amount < 0
              ? theme.reportsNumberNegative
              : theme.reportsNumberPositive,
        ...style,
      }}
    >
      {amount >= 0 ? '+' : ''}
      {formattedAmount}
    </FinancialText>
  );
}
