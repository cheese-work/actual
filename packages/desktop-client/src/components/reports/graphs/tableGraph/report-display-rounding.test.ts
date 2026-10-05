import { createElement } from 'react';

import type { GroupedEntity } from '@actual-app/core/types/models';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { CustomTooltip as BarGraphTooltip } from '#components/reports/graphs/BarGraph';
import {
  ActiveShapeDesktop,
  ActiveShapeMobile,
} from '#components/reports/graphs/DonutGraph';
import { TestProviders } from '#mocks';

import {
  createReportAmountFormatter,
  createReportDisplayAdjustment,
  createReportTableDisplayRows,
} from './report-display-rounding';
import type { ReportAmountFormat } from './report-display-rounding';

function makeReportFormat(decimalPlaces: number): ReportAmountFormat {
  const currency = { decimalPlaces };
  const numberFormat = { hideFraction: false };
  const format: ReportAmountFormat = Object.assign(
    (value: unknown, type = 'financial') => {
      const displayDecimalPlaces =
        type === 'financial-no-decimals' || numberFormat.hideFraction
          ? 0
          : currency.decimalPlaces;

      return new Intl.NumberFormat('en-US', {
        minimumFractionDigits: displayDecimalPlaces,
        maximumFractionDigits: displayDecimalPlaces,
      }).format((value as number) / 100);
    },
    { currency, numberFormat },
  );

  return format;
}

describe('createReportAmountFormatter', () => {
  it('rounds a positive even half tie before formatting', () => {
    const format = makeReportFormat(0);

    expect(format(250, 'financial')).toBe('3');
    expect(createReportAmountFormatter(format)(250)).toBe('2');
  });

  it.each(['financial', 'financial-no-decimals'] as const)(
    'formats fractional and infinite values with %s without throwing',
    type => {
      const formatAmount = createReportAmountFormatter(makeReportFormat(0));

      expect(typeof formatAmount(0.25, type)).toBe('string');
      expect(typeof formatAmount(Infinity, type)).toBe('string');
    },
  );

  it('keeps chart tooltip values aligned with table amounts', () => {
    const format = makeReportFormat(0);
    const tableAmount = createReportAmountFormatter(format)(250);
    const { container } = render(
      createElement(
        TestProviders,
        null,
        createElement(BarGraphTooltip, {
          active: true,
          payload: [
            {
              payload: {
                name: 'Tie date',
                totalAssets: 250,
                totalDebts: 0,
                netAssets: 250,
                netDebts: 0,
                totalTotals: 250,
                totalBudgeted: 250,
                networth: 250,
                totalChange: 0,
                children: [{ props: { name: 'Category', fill: '#000' } }],
              },
            },
          ],
          balanceTypeOp: 'totalTotals',
          yAxis: 'name',
          format: createReportAmountFormatter(format),
        }),
      ),
    );

    expect(
      Array.from(container.querySelectorAll('strong')).map(
        amount => amount.textContent,
      ),
    ).toContain(tableAmount);
  });

  it('rounds mobile and desktop donut amounts on an even half tie', () => {
    const format = createReportAmountFormatter(makeReportFormat(0));
    const shapeProps = {
      cx: 100,
      cy: 100,
      midAngle: 45,
      innerRadius: 20,
      outerRadius: 40,
      startAngle: 0,
      endAngle: 90,
      fill: '#000',
      payload: { name: 'Tie' },
      percent: 0.5,
      value: 250,
      expandInward: false,
      chartInnerRadius: 30,
      chartMidRadius: 50,
      chartOuterRadius: 70,
      formatAmount: format,
    };

    for (const ActiveShape of [ActiveShapeMobile, ActiveShapeDesktop]) {
      const { container } = render(
        createElement(
          TestProviders,
          null,
          createElement('svg', null, createElement(ActiveShape, shapeProps)),
        ),
      );

      expect(
        Array.from(container.querySelectorAll('text')).map(
          text => text.textContent,
        ),
      ).toContain('2');
    }
  });
});

function makeRow(total: number, children: number[]): GroupedEntity {
  return {
    id: 'parent',
    name: 'Parent',
    intervalData: [],
    totalAssets: 0,
    totalDebts: 0,
    netAssets: 0,
    netDebts: 0,
    totalTotals: total,
    totalBudgeted: total,
    categories: children.map((amount, index) => ({
      id: String(index),
      name: `Child ${index}`,
      intervalData: [],
      totalAssets: 0,
      totalDebts: 0,
      netAssets: 0,
      netDebts: 0,
      totalTotals: amount,
      totalBudgeted: amount,
    })),
  };
}

describe('createReportDisplayAdjustment', () => {
  it('reconciles visible JPY totals without changing the canonical rows', () => {
    const parent = makeRow(150, [50, 50, 50]);
    const children = parent.categories!;
    const snapshot = structuredClone(parent);

    const result = createReportDisplayAdjustment({
      parent,
      children,
      balanceTypeOp: 'totalTotals',
      mode: 'total',
      displayDecimalPlaces: 0,
      intervalsCount: 1,
      label: 'Rounding adjustment',
    });

    expect(result?.totalTotals).toBe(200);
    expect(parent).toEqual(snapshot);
    expect(children.map(child => child.totalTotals)).toEqual([50, 50, 50]);
  });

  it('reconciles VND intervals and the subtotal with the same leaf values', () => {
    const parent = makeRow(98, [49, 49]);
    parent.intervalData = [
      {
        date: '2026-01-01',
        totalAssets: 0,
        totalDebts: 0,
        netAssets: 0,
        netDebts: 0,
        totalTotals: 98,
        totalBudgeted: 98,
      },
    ];
    const children = parent.categories!.map((child, index) => ({
      ...child,
      intervalData: [
        {
          date: '2026-01-01',
          totalAssets: 0,
          totalDebts: 0,
          netAssets: 0,
          netDebts: 0,
          totalTotals: index === 0 ? 49 : 49,
          totalBudgeted: index === 0 ? 49 : 49,
        },
      ],
    }));

    const result = createReportDisplayAdjustment({
      parent,
      children,
      balanceTypeOp: 'totalTotals',
      mode: 'time',
      displayDecimalPlaces: 0,
      intervalsCount: 1,
      label: 'Rounding adjustment',
    });

    expect(result?.totalTotals).toBe(100);
    expect(result?.intervalData[0]?.totalTotals).toBe(100);
  });

  it('is order-independent and omits a zero residual', () => {
    const first = makeRow(98, [49, 49]);
    const second = makeRow(98, [49, 49].reverse());
    const getAdjustment = (row: GroupedEntity) =>
      createReportDisplayAdjustment({
        parent: row,
        children: row.categories!,
        balanceTypeOp: 'totalTotals',
        mode: 'total',
        displayDecimalPlaces: 0,
        intervalsCount: 1,
        label: 'Rounding adjustment',
      });

    expect(getAdjustment(first)?.totalTotals).toBe(
      getAdjustment(second)?.totalTotals,
    );
    expect(
      createReportDisplayAdjustment({
        parent: makeRow(100, [25, 75]),
        children: makeRow(100, [25, 75]).categories!,
        balanceTypeOp: 'totalTotals',
        mode: 'total',
        displayDecimalPlaces: 0,
        intervalsCount: 1,
        label: 'Rounding adjustment',
      }),
    ).toBeNull();
  });

  it('preserves the sign of negative half-even subtotal residuals', () => {
    const parent = makeRow(-150, [-50, -50, -50]);

    const result = createReportDisplayAdjustment({
      parent,
      children: parent.categories!,
      balanceTypeOp: 'totalTotals',
      mode: 'total',
      displayDecimalPlaces: 0,
      intervalsCount: 1,
      label: 'Rounding adjustment',
    });

    expect(result?.totalTotals).toBe(-200);
    expect(result?.displayAverage).toBe(-200);
  });

  it('adds adjustments after each category leaf group without changing source rows', () => {
    const group = makeRow(150, [50, 50, 50]);
    const data = {
      groupedData: [group],
      intervalData: [],
      totalAssets: 0,
      totalDebts: 0,
      netAssets: 0,
      netDebts: 0,
      totalTotals: 150,
      totalBudgeted: 0,
    };
    const snapshot = structuredClone(data);

    const result = createReportTableDisplayRows({
      data,
      groupBy: 'Category',
      balanceTypeOp: 'totalTotals',
      mode: 'total',
      displayDecimalPlaces: 0,
      intervalsCount: 1,
      label: 'Rounding adjustment',
    });

    expect(result.data.groupedData?.[0]?.categories?.at(-1)?.id).toBe(
      'rounding-adjustment',
    );
    expect(result.data.groupedData?.[0]?.categories?.at(-1)?.totalTotals).toBe(
      200,
    );
    expect(result.totalAdjustment).toBeNull();
    expect(data).toEqual(snapshot);
  });
});
