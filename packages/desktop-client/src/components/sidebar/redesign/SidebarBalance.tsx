import type { CSSProperties } from '@actual-app/components/styles';
import { View } from '@actual-app/components/view';

import { ApproxMain } from '#components/accounts/ApproxMain';
import { CellValue, CellValueText } from '#components/spreadsheet/CellValue';
import type { Binding, SheetFields } from '#spreadsheet';

type SidebarBalanceProps<FieldName extends SheetFields<'account'>> = {
  binding: Binding<'account', FieldName>;
  style?: CSSProperties;
  testId?: string;
  currency?: string | null;
  /** An account row's own currency: shows the approximate Main-currency
   * value under the balance. Leave undefined for aggregate rows. */
  approxCurrency?: string | null;
};

export function SidebarBalance<FieldName extends SheetFields<'account'>>({
  binding,
  style,
  testId,
  currency,
  approxCurrency,
}: SidebarBalanceProps<FieldName>) {
  return (
    <CellValue<'account', FieldName> binding={binding} type="financial">
      {props => {
        const balance = (
          <CellValueText<'account', FieldName>
            {...props}
            currency={currency}
            data-testid={testId ?? props.name}
            style={{ textAlign: 'right', ...style }}
          />
        );
        if (approxCurrency === undefined || typeof props.value !== 'number') {
          return balance;
        }
        return (
          <View style={{ alignItems: 'flex-end' }}>
            {balance}
            <ApproxMain value={props.value} currency={approxCurrency} />
          </View>
        );
      }}
    </CellValue>
  );
}
