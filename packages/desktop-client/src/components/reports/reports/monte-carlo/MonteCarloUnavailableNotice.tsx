import { useTranslation } from 'react-i18next';

import { Block } from '@actual-app/components/block';
import { theme } from '@actual-app/components/theme';

import { useSyncedPrefs } from '#hooks/useSyncedPrefs';

/**
 * Shown instead of results when a linked pot cannot be valued in Main, so a
 * missing exchange rate never turns into a zero or partial simulation.
 */
export function MonteCarloUnavailableNotice({
  compact = false,
}: {
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const [prefs] = useSyncedPrefs();

  return (
    <Block
      role="note"
      style={{
        padding: compact ? '0 20px 20px' : '10px 0',
        color: theme.pageTextSubdued,
      }}
    >
      {t(
        'Unavailable: a linked account balance cannot be converted to {{currencyCode}}. Add an exchange rate in Settings, link the pot to another account or remove the pot.',
        { currencyCode: prefs.defaultCurrencyCode },
      )}
    </Block>
  );
}
