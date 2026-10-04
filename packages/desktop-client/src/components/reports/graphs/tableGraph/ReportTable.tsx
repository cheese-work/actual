import React, { useLayoutEffect, useRef } from 'react';
import type { RefObject, UIEventHandler } from 'react';
import { useTranslation } from 'react-i18next';

import { Block } from '@actual-app/components/block';
import type { CSSProperties } from '@actual-app/components/styles';
import { View } from '@actual-app/components/view';
import type {
  balanceTypeOpType,
  DataEntity,
  GroupedEntity,
  RuleConditionEntity,
} from '@actual-app/core/types/models';

import { useFormat } from '#hooks/useFormat';

import { createReportTableDisplayRows } from './report-display-rounding';
import { ReportTableHeader } from './ReportTableHeader';
import { ReportTableList } from './ReportTableList';
import { ReportTableRow } from './ReportTableRow';
import { ReportTableTotals } from './ReportTableTotals';

type ReportTableProps = {
  saveScrollWidth: (value: number) => void;
  headerScrollRef: RefObject<HTMLDivElement | null>;
  listScrollRef: RefObject<HTMLDivElement | null>;
  totalScrollRef: RefObject<HTMLDivElement | null>;
  handleScroll: UIEventHandler<HTMLDivElement>;
  groupBy: string;
  balanceTypeOp: balanceTypeOpType;
  data: DataEntity;
  filters?: RuleConditionEntity[];
  mode: string;
  intervalsCount: number;
  interval: string;
  compact: boolean;
  style?: CSSProperties;
  compactStyle?: CSSProperties;
  showHiddenCategories?: boolean;
  showOffBudget?: boolean;
};

export type renderTotalsProps = {
  metadata: GroupedEntity;
  mode: string;
  totalsStyle: CSSProperties;
  testStyle: CSSProperties;
  scrollWidthTotals: number;
};

export type renderRowProps = {
  item: GroupedEntity;
  mode: string;
  style?: CSSProperties;
  average?: number;
};

export function ReportTable({
  saveScrollWidth,
  headerScrollRef,
  listScrollRef,
  totalScrollRef,
  handleScroll,
  groupBy,
  balanceTypeOp,
  data,
  filters,
  mode,
  intervalsCount,
  interval,
  compact,
  style,
  compactStyle,
  showHiddenCategories,
  showOffBudget,
}: ReportTableProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();
  const format = useFormat();
  const displayDecimalPlaces = format.numberFormat.hideFraction
    ? 0
    : format.currency.decimalPlaces;
  const { data: displayData, totalAdjustment } = createReportTableDisplayRows({
    data,
    groupBy,
    balanceTypeOp,
    mode,
    displayDecimalPlaces,
    intervalsCount,
    label: t('Rounding adjustment'),
  });

  useLayoutEffect(() => {
    if (contentRef.current && saveScrollWidth) {
      saveScrollWidth(contentRef.current ? contentRef.current.offsetWidth : 0);
    }
  });

  const renderRow = ({ item, mode, style, average }: renderRowProps) => {
    return (
      <ReportTableRow
        item={item}
        averageOverride={average}
        balanceTypeOp={balanceTypeOp}
        groupBy={groupBy}
        mode={mode}
        filters={filters}
        startDate={displayData.startDate}
        endDate={displayData.endDate}
        intervalsCount={intervalsCount}
        compact={compact}
        style={style}
        compactStyle={compactStyle}
        showHiddenCategories={showHiddenCategories}
        showOffBudget={showOffBudget}
        interval={interval}
      />
    );
  };

  const renderTotals = ({
    metadata,
    mode,
    totalsStyle,
    testStyle,
    scrollWidthTotals,
  }: renderTotalsProps) => {
    return (
      <ReportTableRow
        item={metadata}
        balanceTypeOp={balanceTypeOp}
        groupBy={groupBy}
        mode={mode}
        filters={filters}
        startDate={displayData.startDate}
        endDate={displayData.endDate}
        intervalsCount={intervalsCount}
        compact={compact}
        style={totalsStyle}
        compactStyle={compactStyle}
        showHiddenCategories={showHiddenCategories}
        showOffBudget={showOffBudget}
        totalStyle={testStyle}
        totalScrollRef={totalScrollRef}
        handleScroll={handleScroll}
        height={32 + scrollWidthTotals}
        interval={interval}
        colorized
      />
    );
  };

  return (
    <View>
      <ReportTableHeader
        headerScrollRef={headerScrollRef}
        handleScroll={handleScroll}
        data={displayData.intervalData}
        groupBy={groupBy}
        interval={interval}
        balanceTypeOp={balanceTypeOp}
        compact={compact}
        style={style}
        compactStyle={compactStyle}
        mode={mode}
      />
      <View
        style={{
          flex: 1,
          flexDirection: 'row',
          outline: 'none',
          '& .animated .animated-row': { transition: '.25s transform' },
        }}
        tabIndex={0}
      >
        <Block
          innerRef={listScrollRef}
          onScroll={handleScroll}
          id="list"
          style={{
            overflowY: 'auto',
            scrollbarWidth: 'none',
            '::-webkit-scrollbar': { display: 'none' },
            flex: 1,
            outline: 'none',
            '& .animated .animated-row': { transition: '.25s transform' },
          }}
        >
          <ReportTableList
            data={displayData}
            mode={mode}
            groupBy={groupBy}
            renderRow={renderRow}
            totalAdjustment={totalAdjustment}
            style={style}
          />
        </Block>
      </View>
      <ReportTableTotals
        data={displayData}
        mode={mode}
        totalScrollRef={totalScrollRef}
        compact={compact}
        style={style}
        renderTotals={renderTotals}
      />
    </View>
  );
}
