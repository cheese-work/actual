import { describe, expect, it, vi } from 'vitest';

import { createCustomSpreadsheet } from './custom-spreadsheet';
import { createGroupedSpreadsheet } from './grouped-spreadsheet';

const spreadsheetProps = {
  startDate: '2026-10-01',
  endDate: '2026-10-31',
  interval: 'Monthly',
  categories: { list: [], grouped: [] },
  conditions: [],
  conditionsOp: 'and',
  showEmpty: false,
  showOffBudget: false,
  showHiddenCategories: false,
  showUncategorized: false,
  trimIntervals: false,
  groupBy: 'Category',
  accountsReady: false,
  prefs: { defaultCurrencyCode: 'USD' },
};

describe('custom report spreadsheet loading', () => {
  it('keeps custom report data loading until account data is ready', async () => {
    const setData = vi.fn();

    await createCustomSpreadsheet(spreadsheetProps)(undefined!, setData);

    expect(setData).toHaveBeenCalledWith({ status: 'loading' });
  });

  it('keeps grouped report data loading until account data is ready', async () => {
    const setData = vi.fn();

    await createGroupedSpreadsheet(spreadsheetProps)(undefined!, setData);

    expect(setData).toHaveBeenCalledWith({ status: 'loading' });
  });
});
