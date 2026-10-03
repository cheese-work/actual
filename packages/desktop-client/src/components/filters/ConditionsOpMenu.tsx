import React from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import type { RuleConditionEntity } from '@actual-app/core/types/models';

import { FieldSelect } from '#components/rules/RuleEditor';

export function ConditionsOpMenu({
  conditionsOp,
  onChange,
  conditions,
}: {
  conditionsOp: 'and' | 'or';
  onChange: (value: 'and' | 'or') => void;
  conditions: RuleConditionEntity[];
}) {
  const { t } = useTranslation();
  return conditions.length > 1 ? (
    <Text style={{ color: theme.pageText, marginTop: 11, marginRight: 5 }}>
      <FieldSelect
        style={{ display: 'inline-flex' }}
        fields={[
          ['and', t('all')],
          ['or', t('any')],
        ]}
        value={conditionsOp}
        onChange={onChange}
      />
      <Trans>of:</Trans>
    </Text>
  ) : (
    <View />
  );
}
