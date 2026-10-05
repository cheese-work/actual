import type {
  AccountEntity,
  balanceTypeOpType,
  CategoryEntity,
  CategoryGroupEntity,
  RuleConditionEntity,
} from '@actual-app/core/types/models';
import type { SyncedPrefs } from '@actual-app/core/types/prefs';

import type { QueryDataEntity } from '#components/reports/ReportOptions';
import { aqlQuery } from '#queries/aqlQuery';

import { fetchBudgetData } from './budgetDataQuery';
import { makeQuery } from './makeQuery';
import { convertReportQueryRows } from './report-currency';
import type { ReportDataStatus } from './report-currency';

export async function fetchSpreadsheetQueryData({
  balanceTypeOp,
  startDate,
  endDate,
  interval,
  categories,
  categoryGroups,
  conditions,
  conditionsOp,
  conditionsOpKey,
  filters,
  budgetType,
  accounts,
  prefs,
  showOffBudget,
  accountsReady,
}: {
  balanceTypeOp: balanceTypeOpType | undefined;
  startDate: string;
  endDate: string;
  interval: string;
  categories: CategoryEntity[];
  categoryGroups: CategoryGroupEntity[];
  conditions: RuleConditionEntity[];
  conditionsOp: string;
  conditionsOpKey: string;
  filters: unknown[];
  budgetType?: SyncedPrefs['budgetType'];
  accounts: AccountEntity[];
  prefs: Readonly<SyncedPrefs>;
  showOffBudget: boolean;
  accountsReady: boolean;
}): Promise<
  { assets: QueryDataEntity[]; debts: QueryDataEntity[] } | ReportDataStatus
> {
  if (!prefs.defaultCurrencyCode) {
    return { status: 'unavailable' };
  }

  if (balanceTypeOp === 'totalBudgeted') {
    return fetchBudgetData({
      startDate,
      endDate,
      interval,
      categories,
      categoryGroups,
      conditions,
      conditionsOp: conditionsOp === 'or' ? 'or' : 'and',
      budgetType,
    });
  }

  if (!accountsReady) {
    return { status: 'loading' };
  }

  const [assets, debts] = await Promise.all([
    aqlQuery(
      makeQuery(
        'assets',
        startDate,
        endDate,
        interval,
        conditionsOpKey,
        filters,
      ),
    ).then(({ data }) => data),
    aqlQuery(
      makeQuery(
        'debts',
        startDate,
        endDate,
        interval,
        conditionsOpKey,
        filters,
      ),
    ).then(({ data }) => data),
  ]);

  const valuationTime = Date.now();
  const convertedAssets = convertReportQueryRows<QueryDataEntity>(
    assets,
    accounts,
    prefs,
    showOffBudget,
    valuationTime,
  );
  const convertedDebts = convertReportQueryRows<QueryDataEntity>(
    debts,
    accounts,
    prefs,
    showOffBudget,
    valuationTime,
  );
  if ('status' in convertedAssets) {
    return convertedAssets;
  }
  if ('status' in convertedDebts) {
    return convertedDebts;
  }

  return { assets: convertedAssets, debts: convertedDebts };
}
