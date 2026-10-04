import type { CSSProperties } from '@actual-app/components/styles';

import {
  AccountCurrencyBalance,
  SidebarAccountBalance,
} from '#components/sidebar/AccountCurrencyBalance';
import type { AccountCurrencyAggregation } from '#components/sidebar/AccountCurrencyBalance';
import type { Binding, SheetFields } from '#spreadsheet';

type SidebarBalanceProps<FieldName extends SheetFields<'account'>> = {
  binding: Binding<'account', FieldName>;
  style?: CSSProperties;
  testId?: string;
  currency?: string | null;
  /** An account row's own currency: shows the approximate Main-currency
   * value under the balance. Leave undefined for aggregate rows. */
  approxCurrency?: string | null;
  aggregation?: AccountCurrencyAggregation;
};

export function SidebarBalance<FieldName extends SheetFields<'account'>>({
  binding,
  style,
  testId,
  currency,
  approxCurrency,
  aggregation,
}: SidebarBalanceProps<FieldName>) {
  if (aggregation !== undefined) {
    return (
      <AccountCurrencyBalance
        aggregation={aggregation}
        style={style}
        testId={testId}
      />
    );
  }

  return (
    <SidebarAccountBalance
      binding={binding}
      currency={currency}
      approxCurrency={approxCurrency}
      style={style}
      testId={testId}
    />
  );
}
