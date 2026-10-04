import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Block } from '@actual-app/components/block';
import { styles } from '@actual-app/components/styles';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import * as monthUtils from '@actual-app/core/shared/months';
import type { SpendingWidget } from '@actual-app/core/types/models';

import { FinancialText } from '#components/FinancialText';
import { PrivacyFilter } from '#components/PrivacyFilter';
import { DateRange } from '#components/reports/DateRange';
import { SpendingGraph } from '#components/reports/graphs/SpendingGraph';
import { LoadingIndicator } from '#components/reports/LoadingIndicator';
import { ReportCard } from '#components/reports/ReportCard';
import { ReportCardName } from '#components/reports/ReportCardName';
import { calculateSpendingReportTimeRange } from '#components/reports/reportRanges';
import {
  getSpendingAverageRangeLabel,
  normalizeSpendingAverageRange,
} from '#components/reports/spendingAverageRange';
import { createSpendingSpreadsheet } from '#components/reports/spreadsheets/spending-spreadsheet';
import { useReport } from '#components/reports/useReport';
import { useAccounts } from '#hooks/useAccounts';
import { isFinancialFormatType, useFormat } from '#hooks/useFormat';
import type { FormatType } from '#hooks/useFormat';
import { useSyncedPref } from '#hooks/useSyncedPref';
import { useSyncedPrefs } from '#hooks/useSyncedPrefs';

type SpendingCardProps = {
  widgetId: string;
  isEditing?: boolean;
  meta?: SpendingWidget['meta'];
  onMetaChange: (newMeta: SpendingWidget['meta']) => void;
};

export function SpendingCard({
  widgetId,
  isEditing,
  meta = {},
  onMetaChange,
}: SpendingCardProps) {
  const { t } = useTranslation();
  const format = useFormat();
  const [prefs] = useSyncedPrefs();
  const {
    data: accounts = [],
    isLoading: accountsLoading,
    isPlaceholderData: accountsPlaceholderData,
  } = useAccounts();
  const formatMainCurrency = useCallback(
    (value: unknown, type?: FormatType) =>
      typeof value === 'number' &&
      prefs.defaultCurrencyCode &&
      isFinancialFormatType(type)
        ? format.forCurrency(value, prefs.defaultCurrencyCode, type)
        : format(value, type),
    [format, prefs.defaultCurrencyCode],
  );
  const [budgetTypePref] = useSyncedPref('budgetType');
  const budgetType: 'envelope' | 'tracking' =
    budgetTypePref === 'tracking' ? 'tracking' : 'envelope';

  const [isCardHovered, setIsCardHovered] = useState(false);
  const [nameMenuOpen, setNameMenuOpen] = useState(false);

  const spendingReportMode = meta?.mode ?? 'single-month';
  const averageRange = normalizeSpendingAverageRange(meta?.averageRange);
  const averageRangeLabel = getSpendingAverageRangeLabel(averageRange, t);

  const [compare, compareTo] = calculateSpendingReportTimeRange(meta ?? {});

  const selection =
    spendingReportMode === 'single-month' ? 'compareTo' : spendingReportMode;
  const getGraphData = useMemo(() => {
    return createSpendingSpreadsheet({
      accounts,
      prefs,
      accountsReady: !accountsLoading && !accountsPlaceholderData,
      conditions: meta?.conditions,
      conditionsOp: meta?.conditionsOp,
      compare,
      compareTo,
      averageRange,
      budgetType,
    });
  }, [
    meta?.conditions,
    meta?.conditionsOp,
    accounts,
    prefs,
    accountsLoading,
    accountsPlaceholderData,
    compare,
    compareTo,
    averageRange,
    budgetType,
  ]);

  const reportData = useReport('default', getGraphData);
  const data = reportData && !('status' in reportData) ? reportData : null;
  const reportUnavailable = reportData !== null && 'status' in reportData;
  const todayDay =
    compare !== monthUtils.currentMonth()
      ? 27
      : monthUtils.getDay(monthUtils.currentDay()) - 1 >= 28
        ? 27
        : monthUtils.getDay(monthUtils.currentDay()) - 1;
  const difference =
    data &&
    Math.round(
      data.intervalData[todayDay][selection] -
        data.intervalData[todayDay].compare,
    );

  return (
    <ReportCard
      widgetId={widgetId}
      isEditing={isEditing}
      disableClick={nameMenuOpen}
      to={`/reports/spending/${widgetId}`}
      onRename={() => setNameMenuOpen(true)}
    >
      <View
        style={{ flex: 1 }}
        onPointerEnter={() => setIsCardHovered(true)}
        onPointerLeave={() => setIsCardHovered(false)}
      >
        <View style={{ flexDirection: 'row', padding: 20 }}>
          <View style={{ flex: 1 }}>
            <ReportCardName
              name={meta?.name || t('Monthly Spending')}
              isEditing={nameMenuOpen}
              onChange={newName => {
                onMetaChange({
                  ...meta,
                  name: newName,
                });
                setNameMenuOpen(false);
              }}
              onClose={() => setNameMenuOpen(false)}
            />
            <DateRange
              start={compare}
              end={compareTo}
              type={spendingReportMode}
              comparisonLabel={
                spendingReportMode === 'average' ? averageRangeLabel : undefined
              }
            />
          </View>
          {data && (
            <View style={{ textAlign: 'right' }}>
              <Block
                style={{
                  ...styles.mediumText,
                  fontWeight: 500,
                  marginBottom: 5,
                  color:
                    difference === 0 || difference == null
                      ? theme.reportsNumberNeutral
                      : difference > 0
                        ? theme.reportsNumberNegative
                        : theme.reportsNumberPositive,
                }}
              >
                <PrivacyFilter activationFilters={[!isCardHovered]}>
                  <FinancialText>
                    {data &&
                      (difference && difference > 0 ? '+' : '') +
                        formatMainCurrency(difference || 0, 'financial')}
                  </FinancialText>
                </PrivacyFilter>
              </Block>
            </View>
          )}
        </View>
        {data?.hasForeignCurrency && (
          <Block style={{ padding: '0 20px 8px' }}>
            {t(
              'Values in {{currencyCode}}. Foreign-currency history is an estimate at current rates.',
              { currencyCode: prefs.defaultCurrencyCode },
            )}
          </Block>
        )}
        {reportUnavailable ? (
          <Block style={{ padding: 20 }}>
            {t(
              'Spending is unavailable. Check that a Main currency is set and every included account has a valid exchange rate.',
            )}
          </Block>
        ) : data ? (
          <SpendingGraph
            style={{ flex: 1 }}
            compact
            data={data}
            mode={spendingReportMode}
            compare={compare}
            compareTo={compareTo}
            format={formatMainCurrency}
          />
        ) : (
          <LoadingIndicator />
        )}
      </View>
    </ReportCard>
  );
}
