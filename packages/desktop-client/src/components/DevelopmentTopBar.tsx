import { Trans } from 'react-i18next';

import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

import { Link } from './common/Link';

export function DevelopmentTopBar() {
  return (
    <View
      style={{
        padding: '6px 20px',
        display: 'flex',
        flexDirection: 'row',
        justifyContent: 'space-between',
        color: theme.warningText,
        backgroundColor: theme.warningBackground,
        borderBottom: `1px solid ${theme.warningBorder}`,
        zIndex: 1,
        flexShrink: 0,
      }}
    >
      <View>
        <Trans>This is a demo build of Actual.</Trans>
      </View>
      <View>
        <Link
          variant="external"
          linkColor="purple"
          to={`https://github.com/actualbudget/actual/pull/${import.meta.env.REACT_APP_REVIEW_ID}`}
        >
          <Trans>Open the PR:</Trans> #{import.meta.env.REACT_APP_REVIEW_ID}
        </Link>
      </View>
    </View>
  );
}
