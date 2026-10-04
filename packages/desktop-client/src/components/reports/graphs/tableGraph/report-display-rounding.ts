import {
  getPresentationAdjustment,
  roundToDisplayPrecision,
} from '@actual-app/core/shared/currency-aggregation';
import type {
  balanceTypeOpType,
  DataEntity,
  GroupedEntity,
  IntervalEntity,
} from '@actual-app/core/types/models';

type ReportAmounts = Pick<
  GroupedEntity,
  | 'intervalData'
  | 'totalAssets'
  | 'totalDebts'
  | 'netAssets'
  | 'netDebts'
  | 'totalTotals'
  | 'totalBudgeted'
> & { date?: string };

type ReportAmountField =
  | 'totalAssets'
  | 'totalDebts'
  | 'netAssets'
  | 'netDebts'
  | 'totalTotals'
  | 'totalBudgeted';
export type ReportDisplayRow = GroupedEntity & { displayAverage?: number };

function getAdjustment(
  total: number,
  childAmounts: number[],
  displayDecimalPlaces: number,
): number {
  const displayedTotal = roundToDisplayPrecision(total, displayDecimalPlaces);
  if (displayedTotal === null) {
    return 0;
  }

  return (
    getPresentationAdjustment(
      displayedTotal,
      displayDecimalPlaces,
      childAmounts,
    )?.amount ?? 0
  );
}

function emptyInterval(date: string): IntervalEntity {
  return {
    date,
    totalAssets: 0,
    totalDebts: 0,
    netAssets: 0,
    netDebts: 0,
    totalTotals: 0,
    totalBudgeted: 0,
  };
}

export function createReportDisplayAdjustment({
  parent,
  children,
  balanceTypeOp,
  mode,
  displayDecimalPlaces,
  intervalsCount,
  label,
}: {
  parent: ReportAmounts;
  children: readonly ReportAmounts[];
  balanceTypeOp: balanceTypeOpType;
  mode: string;
  displayDecimalPlaces: number;
  intervalsCount: number;
  label: string;
}): ReportDisplayRow | null {
  if (children.length === 0) {
    return null;
  }

  const adjustment: ReportDisplayRow = {
    id: 'rounding-adjustment',
    name: label,
    intervalData: [],
    totalAssets: 0,
    totalDebts: 0,
    netAssets: 0,
    netDebts: 0,
    totalTotals: 0,
    totalBudgeted: 0,
  };
  let hasAdjustment = false;

  const fields: ReportAmountField[] =
    mode === 'time'
      ? [balanceTypeOp]
      : balanceTypeOp === 'totalTotals'
        ? ['totalAssets', 'totalDebts', 'totalTotals']
        : balanceTypeOp === 'totalBudgeted'
          ? ['totalAssets', 'totalDebts', 'totalBudgeted']
          : [balanceTypeOp];

  for (const field of fields) {
    const amount = getAdjustment(
      parent[field],
      children.map(child => child[field]),
      displayDecimalPlaces,
    );
    if (amount !== 0) {
      adjustment[field] = amount;
      hasAdjustment = true;
    }
  }

  if (mode !== 'time' && intervalsCount > 0) {
    const averageAdjustment = getAdjustment(
      Math.round(parent[balanceTypeOp] / intervalsCount),
      children.map(child => Math.round(child[balanceTypeOp] / intervalsCount)),
      displayDecimalPlaces,
    );
    if (averageAdjustment !== 0) {
      adjustment.displayAverage = averageAdjustment;
      hasAdjustment = true;
    }
  }

  if (mode === 'time') {
    adjustment.intervalData = parent.intervalData.map((interval, index) => {
      const row = emptyInterval(interval.date);
      const childAmounts = children.map(child => {
        const childInterval = child.intervalData[index];
        return childInterval
          ? childInterval[balanceTypeOp]
          : child.date === interval.date
            ? child[balanceTypeOp]
            : 0;
      });
      const amount = getAdjustment(
        interval[balanceTypeOp],
        childAmounts,
        displayDecimalPlaces,
      );
      if (amount !== 0) {
        row[balanceTypeOp] = amount;
        hasAdjustment = true;
      }
      return row;
    });
  }

  return hasAdjustment ? adjustment : null;
}

function intervalAsGroupedEntity(interval: IntervalEntity): GroupedEntity {
  return {
    ...interval,
    id: interval.date,
    name: interval.date,
    intervalData: [],
  };
}

export function createReportTableDisplayRows({
  data,
  groupBy,
  balanceTypeOp,
  mode,
  displayDecimalPlaces,
  intervalsCount,
  label,
}: {
  data: DataEntity;
  groupBy: string;
  balanceTypeOp: balanceTypeOpType;
  mode: string;
  displayDecimalPlaces: number;
  intervalsCount: number;
  label: string;
}): { data: DataEntity; totalAdjustment: ReportDisplayRow | null } {
  const groupedData =
    groupBy === 'Category'
      ? (data.groupedData ?? []).map(group => {
          const children = group.categories ?? [];
          const adjustment = createReportDisplayAdjustment({
            parent: group,
            children,
            balanceTypeOp,
            mode,
            displayDecimalPlaces,
            intervalsCount,
            label,
          });
          return adjustment
            ? { ...group, categories: [...children, adjustment] }
            : group;
        })
      : data.groupedData;

  const visibleChildren =
    groupBy === 'Category'
      ? (groupedData ?? [])
      : groupBy === 'Interval'
        ? data.intervalData.map(intervalAsGroupedEntity)
        : (data.data ?? []);

  const totalAdjustment = createReportDisplayAdjustment({
    parent: data,
    children: visibleChildren,
    balanceTypeOp,
    mode,
    displayDecimalPlaces,
    intervalsCount,
    label,
  });

  return {
    data: groupBy === 'Category' ? { ...data, groupedData } : data,
    totalAdjustment,
  };
}
