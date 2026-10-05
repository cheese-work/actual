import React, { useEffect, useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Text } from '@actual-app/components/text';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import * as monthUtils from '@actual-app/core/shared/months';
import type {
  SummaryContent,
  SummaryWidget,
} from '@actual-app/core/types/models';

import { DateRange } from '#components/reports/DateRange';
import { ReportCard } from '#components/reports/ReportCard';
import { ReportCardName } from '#components/reports/ReportCardName';
import { ReportCardValueSkeleton } from '#components/reports/ReportCardValueSkeleton';
import { calculateTimeRange } from '#components/reports/reportRanges';
import { summarySpreadsheet } from '#components/reports/spreadsheets/summary-spreadsheet';
import { SummaryNumber } from '#components/reports/SummaryNumber';
import { useReport } from '#components/reports/useReport';
import { useAccounts } from '#hooks/useAccounts';
import { useLocale } from '#hooks/useLocale';
import { useSyncedPrefs } from '#hooks/useSyncedPrefs';

type SummaryCardProps = {
  widgetId: string;
  isEditing?: boolean;
  meta?: SummaryWidget['meta'];
  onMetaChange: (newMeta: SummaryWidget['meta']) => void;
};

export function SummaryCard({
  widgetId,
  isEditing,
  meta = {},
  onMetaChange,
}: SummaryCardProps) {
  const locale = useLocale();
  const { t } = useTranslation();
  const [prefs] = useSyncedPrefs();
  const {
    data: accounts = [],
    isLoading: accountsLoading,
    isPlaceholderData: accountsPlaceholderData,
  } = useAccounts();
  const [latestTransaction, setLatestTransaction] = useState<string>('');
  const [nameMenuOpen, setNameMenuOpen] = useState(false);

  useEffect(() => {
    async function fetchLatestTransaction() {
      const latestTrans = await send('get-latest-transaction');
      setLatestTransaction(
        latestTrans ? latestTrans.date : monthUtils.currentDay(),
      );
    }
    void fetchLatestTransaction();
  }, []);

  const [start, end] = calculateTimeRange(
    meta?.timeFrame,
    {
      start: monthUtils.dayFromDate(monthUtils.currentMonth()),
      end: monthUtils.currentDay(),
      mode: 'full',
    },
    latestTransaction,
  );

  const content = useMemo(
    () =>
      (meta?.content
        ? (() => {
            try {
              return JSON.parse(meta.content);
            } catch (error) {
              console.error('Failed to parse meta.content:', error);
              return { type: 'sum' };
            }
          })()
        : { type: 'sum' }) as SummaryContent,
    [meta],
  );

  const params = useMemo(
    () =>
      summarySpreadsheet(
        start,
        end,
        meta?.conditions,
        meta?.conditionsOp,
        content,
        locale,
        accounts,
        prefs,
        !accountsLoading && !accountsPlaceholderData,
      ),
    [
      start,
      end,
      meta?.conditions,
      meta?.conditionsOp,
      content,
      locale,
      accounts,
      prefs,
      accountsLoading,
      accountsPlaceholderData,
    ],
  );

  const reportData = useReport('summary', params);
  const data = reportData && !('status' in reportData) ? reportData : null;
  const reportUnavailable = reportData !== null && 'status' in reportData;

  return (
    <ReportCard
      widgetId={widgetId}
      isEditing={isEditing}
      disableClick={nameMenuOpen}
      to={`/reports/summary/${widgetId}`}
      onRename={() => setNameMenuOpen(true)}
    >
      <View style={{ flex: 1, overflow: 'hidden' }}>
        <View style={{ flexGrow: 0, flexShrink: 0, padding: 20 }}>
          <ReportCardName
            name={meta?.name || t('Summary')}
            isEditing={nameMenuOpen}
            onChange={newName => {
              onMetaChange({
                ...meta,
                content: JSON.stringify(content),
                name: newName,
              });
              setNameMenuOpen(false);
            }}
            onClose={() => setNameMenuOpen(false)}
          />
          <DateRange start={start} end={end} />
        </View>
        <View
          style={{
            justifyContent: 'center',
            alignItems: 'center',
            flexGrow: 1,
            flexShrink: 1,
          }}
        >
          {data ? (
            <SummaryNumber
              value={data.total}
              contentType={content.type}
              suffix={content.type === 'percentage' ? '%' : ''}
              loading={false}
              initialFontSize={content.fontSize}
              animate={isEditing ?? false}
            />
          ) : reportUnavailable ? (
            <Text style={{ textAlign: 'center' }}>
              <Trans>
                Summary values are unavailable. Check that a Main currency is
                set and every included account has a valid exchange rate.
              </Trans>
            </Text>
          ) : (
            <ReportCardValueSkeleton />
          )}
          {data?.hasForeignCurrency && (
            <Text style={{ textAlign: 'center' }}>
              <Trans
                i18nKey="Values in {{currency}}. Foreign-currency history is an estimate at current rates."
                values={{ currency: prefs.defaultCurrencyCode }}
              />
            </Text>
          )}
        </View>
      </View>
    </ReportCard>
  );
}
