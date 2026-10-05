import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Block } from '@actual-app/components/block';
import { theme } from '@actual-app/components/theme';

import { hasForeignAccount } from '#components/reports/spreadsheets/report-currency';
import { useAccounts } from '#hooks/useAccounts';
import { useSyncedPrefs } from '#hooks/useSyncedPrefs';

function UnconvertedCurrencyNotice({
  children,
}: {
  children: (currencyCode: string) => ReactNode;
}) {
  const [prefs] = useSyncedPrefs();
  const { data: accounts = [] } = useAccounts();

  if (!prefs.defaultCurrencyCode || !hasForeignAccount(accounts, prefs)) {
    return null;
  }

  return (
    <Block
      role="note"
      style={{ padding: '0 20px 8px', color: theme.pageTextSubdued }}
    >
      {children(prefs.defaultCurrencyCode)}
    </Block>
  );
}

/**
 * Formula output has no account denomination, so it is never converted to
 * Main. Warn when foreign-currency accounts exist that it may mix amounts.
 */
export function FormulaCurrencyNotice() {
  const { t } = useTranslation();
  return (
    <UnconvertedCurrencyNotice>
      {currencyCode =>
        t(
          'Formula results are not converted to {{currencyCode}}. Formulas that combine foreign-currency account amounts are unsupported and may mix currencies.',
          { currencyCode },
        )
      }
    </UnconvertedCurrencyNotice>
  );
}
