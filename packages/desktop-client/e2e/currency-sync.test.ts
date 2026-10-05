import fs from 'node:fs';
import path from 'node:path';

import type { Page } from '@playwright/test';

import {
  appReady,
  connect,
  createFixture,
  derive,
  EVIDENCE_DIR,
  grab,
  MONTH,
  NOTE,
  open,
  pageText,
  POINTS_NATIVE,
  RATE_HOSTS,
  round2,
  savePrefs,
  send,
  SERVER_URL,
  shoot,
  sidebarOf,
  sync,
  USD,
  usd,
} from './currency-sync-helpers';
import type { Json, Rates, TestWindow } from './currency-sync-helpers';
import { expect, test } from './fixtures';
import { BudgetPage } from './page-models/budget-page';
import { ConfigurationPage } from './page-models/configuration-page';

// Two isolated browser clients against a disposable local sync server (see
// currency-sync-helpers.ts for E2E_SYNC_SERVER_URL / E2E_EVIDENCE_DIR).
// Without E2E_SYNC_SERVER_URL the suite is skipped (CI does not run it); it
// never touches a real server.
const observed: Record<string, unknown> = {};

// ---------------------------------------------------------------- budget math

const BUDGET_CELL_NAMES = [
  'budget',
  'sum-amount',
  'leftover',
  'carryover',
] as const;

// What the stored rows and the evaluated spreadsheet say about the Rent
// category in January 2017. Native amounts are never converted.
async function snapshot(page: Page, categoryId: string) {
  await appReady(page);
  return page.evaluate(
    async ([m, category, names]) => {
      const w = window as TestWindow;
      const rows = async (table: string, fields: string[]) =>
        (await w.$query(w.$q(table).select(fields))).data;
      const byId = (a: { id: string }, b: { id: string }) =>
        a.id.localeCompare(b.id);
      const transactions = (await rows('transactions', [
        'id',
        'account',
        'amount',
        'date',
        'category',
      ])) as Array<{ id: string }>;
      const budgets = (await rows('zero_budgets', [
        'id',
        'month',
        'category',
        'amount',
      ])) as Array<{ id: string }>;
      const cells = (await w.$send('envelope-budget-month', {
        month: m,
      })) as Array<{ name: string; value: unknown }>;
      const category_cells: Record<string, unknown> = {};
      for (const name of names) {
        category_cells[name] = cells.find(
          cell => cell.name.split('!')[1] === `${name}-${category}`,
        )?.value;
      }
      return {
        transactions: transactions.sort(byId),
        budgets: budgets.sort(byId),
        categoryCells: category_cells,
      };
    },
    [MONTH, categoryId, BUDGET_CELL_NAMES] as const,
  );
}

// Finite, known results first: an unchanged null can never pass.
const EXPECTED_CATEGORY_CELLS = {
  budget: 20000,
  'sum-amount': -15000,
  leftover: 5000,
  carryover: false,
};
const EXPECTED_AMOUNTS = [-15000, -2000, 10000, 50000, 100000];

async function expectBudgetMath(
  pages: Page[],
  categoryId: string,
  before: Awaited<ReturnType<typeof snapshot>>,
  label: string,
) {
  for (const page of pages) {
    const current = await snapshot(page, categoryId);
    expect(current.categoryCells, `${label}: evaluated cells`).toEqual(
      EXPECTED_CATEGORY_CELLS,
    );
    expect(
      current.transactions
        .map(t => (t as { amount: number }).amount)
        .sort((x, y) => x - y),
      `${label}: native amounts`,
    ).toEqual(EXPECTED_AMOUNTS.slice().sort((a, b) => a - b));
    expect(current.budgets, `${label}: budget entry`).toHaveLength(1);
    expect((current.budgets[0] as { amount: number }).amount).toBe(20000);
    // Rate edits and sync never moved a stored amount or a category result.
    expect(current, `${label}: snapshot vs before`).toEqual(before);
  }
}

// ------------------------------------------------------------ surface reading

type Surface = {
  name: string;
  route: (ctx: Context) => string;
  extract: (t: string) => unknown;
};
type Context = {
  dashboardId: string;
  reportId: string;
  forecastId: string;
  analysisId: string;
};

const RATE_FREE = {
  cashFlowPage: [
    '$500.00',
    '-$150.00',
    '$0.00',
    '+$350.00',
  ] /* income, expenses, transfers, net: on-budget accounts only */,
  spendingMtd: ['$150.00'],
  budgetAnalysis: ['$200.00', '-$150.00', '$0.00', '+$50.00'],
  cashFlowCard: ['+$350.00', '$500.00', '$150.00'],
  summaryCards: ['$500.00', '$150.00', '$150.00'],
  thisMonthCard: ['+$150.00'],
};

const SURFACES: Surface[] = [
  {
    name: 'sidebar',
    route: () => '/budget',
    extract: t => sidebarOf(t),
  },
  {
    name: 'dashboard net worth card',
    route: c => `/reports/${c.dashboardId}`,
    extract: t =>
      grab(
        t,
        new RegExp(
          `Net Worth \\| Aug 2016 - Jan 2017 \\| (?:${USD} \\| ${USD}|(Net worth is unavailable\\.))`,
        ),
      ),
  },
  {
    name: 'dashboard cash flow card (on-budget only)',
    route: c => `/reports/${c.dashboardId}`,
    extract: t =>
      grab(
        t,
        new RegExp(
          `Cash Flow \\| January 2017 \\| ${USD} \\| Income \\| ${USD} \\| Expenses \\| ${USD}`,
        ),
      ),
  },
  {
    name: 'dashboard summary cards (on-budget conditions)',
    route: c => `/reports/${c.dashboardId}`,
    extract: t =>
      grab(
        t,
        new RegExp(
          `Total Income \\(YTD\\) \\| January 2017 \\| ${USD} \\| Total Expenses \\(YTD\\) \\| January 2017 \\| ${USD} \\| Avg Per Month \\| January 2017 \\| ${USD} \\| Avg Per Transaction \\| January 2017 \\| ${USD}`,
        ),
      ),
  },
  {
    name: 'dashboard spending card',
    route: c => `/reports/${c.dashboardId}`,
    extract: t =>
      grab(
        t,
        new RegExp(`This Month \\| Compare Jan 2017 to Dec 2016 \\| ${USD}`),
      ),
  },
  {
    name: 'net worth page',
    route: () => '/reports/net-worth',
    extract: t =>
      grab(
        t,
        new RegExp(
          `Trend \\| (?:${NOTE} \\| ${USD} \\| ${USD}|(Net worth is unavailable\\.))`,
        ),
      ),
  },
  {
    name: 'cash flow page (Main, on-budget only)',
    route: () => '/reports/cash-flow',
    extract: t =>
      grab(
        t,
        new RegExp(
          `Income: \\| ${USD} \\| Expenses: \\| ${USD} \\| Transfers: \\| ${USD} \\| ${USD}`,
        ),
      ),
  },
  {
    name: 'spending page',
    route: () => '/reports/spending',
    extract: t => grab(t, new RegExp(`Spent Jan 2017 MTD: \\| ${USD}`)),
  },
  {
    name: 'summary page',
    route: () => '/reports/summary',
    extract: t =>
      grab(
        t,
        new RegExp(
          `(?:all transactions \\| Filter \\| ${USD} \\| ${NOTE}|(Summary values are unavailable\\.))`,
        ),
      ),
  },
  {
    name: 'calendar page',
    route: () => '/reports/calendar',
    extract: t =>
      grab(
        t,
        new RegExp(
          `(?:${NOTE} \\| January 2017 \\| ${USD} \\| ${USD} \\| S \\||(Calendar is unavailable\\.))`,
        ),
      ),
  },
  {
    name: 'balance forecast page',
    route: c => `/reports/forecast/${c.forecastId}`,
    extract: t =>
      grab(
        t,
        new RegExp(
          `(?:${USD} \\| Ending Balance: 2017-12 \\| Lowest visible point: ${USD} \\(2017-01\\)|(Balance forecast is unavailable\\.))`,
        ),
      ),
  },
  {
    name: 'crossover page',
    route: () => '/reports/crossover',
    // Its projection numbers live in a hover tooltip, so only the
    // available / unavailable state is read.
    extract: t =>
      /Crossover point is unavailable\./.test(t)
        ? 'unavailable'
        : t.includes('Years to Retire:')
          ? 'rendered'
          : 'loading',
  },
  {
    name: 'budget analysis page',
    route: c => `/reports/budget-analysis/${c.analysisId}`,
    extract: t =>
      grab(
        t,
        new RegExp(
          `Budgeted: \\| ${USD} \\| Spent: \\| ${USD} \\| Overspending adj: \\| ${USD} \\| Ending balance: \\| ${USD}`,
        ),
      ),
  },
  {
    name: 'saved custom report (table)',
    route: c => `/reports/custom/${c.reportId}`,
    extract: t => {
      const unavailable = /Custom report values are unavailable\./.exec(t);
      if (unavailable) {
        return [unavailable[0]];
      }
      const start = t.indexOf(
        'Account | Deposits | Payments | Totals | Average | ',
      );
      if (start < 0) {
        return grab(t, /Account \| Deposits/);
      }
      return t
        .slice(
          start + 'Account | Deposits | Payments | Totals | Average | '.length,
        )
        .split(' | ')
        .slice(0, 20);
    },
  },
];

const sidebarFor = (rates: Rates) => {
  const v = derive(rates);
  return `All accounts | ~ ${usd(v.all)} | On budget | $350.00 | Checking | $350.00 | Off budget | ~ ${usd(v.off)} | Euro savings | 80.00 € | (~ ${usd(v.euroNet)}) | Loyalty points | 1,000 pt | (~ ${usd(v.pointsNet)})`;
};

// The EUR rate is removed: totals that need it say so, the custom unit still
// converts, and the on-budget account is untouched.
const sidebarWithoutEur = (points: number) =>
  `All accounts | (no rate: EUR) | On budget | $350.00 | Checking | $350.00 | Off budget | (no rate: EUR) | Euro savings | 80.00 € | (no rate) | Loyalty points | 1,000 pt | (~ ${usd(round2(POINTS_NATIVE * points))})`;

// The converted figures every surface must show for a rate pair. Foreign
// accounts are off budget, so Main-only surfaces (cash flow, the on-budget
// summary cards, the budget category math) never move with a rate.
function expectedFor(rates: Rates) {
  const v = derive(rates);
  const income = round2(500 + v.euroDeposit + v.pointsNet);
  const expenses = round2(150 - v.euroPayment);
  return {
    sidebar: sidebarFor(rates),
    'dashboard net worth card': [usd(v.all), `+${usd(v.all)}`, undefined],
    'dashboard cash flow card (on-budget only)': RATE_FREE.cashFlowCard,
    'dashboard summary cards (on-budget conditions)': [
      ...RATE_FREE.summaryCards.slice(0, 2),
      ANY,
      RATE_FREE.summaryCards[2],
    ],
    'dashboard spending card': RATE_FREE.thisMonthCard,
    'net worth page': [usd(v.all), `+${usd(v.all)}`, undefined],
    'cash flow page (Main, on-budget only)': RATE_FREE.cashFlowPage,
    'spending page': RATE_FREE.spendingMtd,
    'summary page': [usd(v.all), undefined],
    'calendar page': [usd(income), usd(expenses), undefined],
    'balance forecast page': [usd(v.all), usd(v.all), undefined],
    'crossover page': 'rendered',
    'budget analysis page': RATE_FREE.budgetAnalysis,
    'saved custom report (table)': [
      'Checking',
      '$500.00',
      '-$150.00',
      '$350.00',
      '$350.00',
      'Euro savings',
      usd(v.euroDeposit),
      usd(v.euroPayment),
      usd(v.euroNet),
      usd(v.euroNet),
      'Loyalty points',
      usd(v.pointsNet),
      '$0.00',
      usd(v.pointsNet),
      usd(v.pointsNet),
      'Totals',
      usd(income),
      usd(-expenses),
      usd(v.all),
      usd(v.all),
    ],
  } as Record<string, unknown>;
}

// Optional capture groups come back undefined. The summary card's Avg Per
// Month is a rate-independent figure the app derives per day: recorded in the
// evidence, not pinned here.
const ANY = '__ANY__';
function normalise(value: unknown, expected: unknown): unknown {
  if (!Array.isArray(value) || !Array.isArray(expected)) {
    return value;
  }
  return value.map((item, index) =>
    expected[index] === ANY ? ANY : (item ?? undefined),
  );
}

const unavailable = (groups: number, message: string) => [
  ...Array<undefined>(groups).fill(undefined),
  message,
];

async function expectSurface(
  page: Page,
  ctx: Context,
  surface: Surface,
  expected: unknown,
  step: string,
  label: string,
) {
  await open(page, surface.route(ctx));
  let raw: unknown;
  await expect
    .poll(
      async () => {
        raw = surface.extract(await pageText(page));
        return normalise(raw, expected);
      },
      {
        message: `${label}: ${surface.name}`,
        timeout: 60_000,
        intervals: [500, 1000, 2000],
      },
    )
    .toEqual(expected);
  const record = (observed[step] ??= {}) as Record<string, unknown>;
  record[`${label} / ${surface.name}`] = raw;
}

async function expectAllSurfaces(
  page: Page,
  ctx: Context,
  rates: Rates,
  step: string,
  label: string,
) {
  const expected = expectedFor(rates);
  for (const surface of SURFACES) {
    await expectSurface(
      page,
      ctx,
      surface,
      expected[surface.name],
      step,
      label,
    );
  }
}

// ------------------------------------------------------- persisted settings

function savedReport(accountIds: string[]) {
  return {
    name: 'Euro totals',
    startDate: `${MONTH}-01`,
    endDate: `${MONTH}-31`,
    isDateStatic: false,
    dateRange: 'This month',
    mode: 'total',
    groupBy: 'Account',
    interval: 'Monthly',
    balanceType: 'Net',
    showEmpty: false,
    showOffBudget: true,
    showHiddenCategories: true,
    includeCurrentInterval: true,
    showUncategorized: true,
    trimIntervals: false,
    showTrendLines: false,
    graphType: 'TableGraph',
    conditionsOp: 'and',
    conditions: [{ field: 'account', op: 'oneOf', value: accountIds }],
  };
}

const REPORT_FIELDS = Object.keys(savedReport([]));

async function readSavedReport(page: Page) {
  const reports = await send<Array<Json>>(page, 'report/get');
  const report = reports.find(r => r.name === 'Euro totals');
  expect(report, 'saved report exists').toBeTruthy();
  const fields: Json = {};
  for (const key of REPORT_FIELDS) {
    fields[key] = (report as Json)[key];
  }
  return { id: (report as Json).id as string, count: reports.length, fields };
}

async function expectPersistedSettings(
  pages: Page[],
  expectedPrefs: Record<string, string>,
  accountIds: string[],
  label: string,
) {
  for (const page of pages) {
    const prefs = await send<Record<string, string>>(page, 'preferences/get');
    for (const [key, value] of Object.entries(expectedPrefs)) {
      expect(prefs[key], `${label}: pref ${key}`).toBe(value);
    }
    const saved = await readSavedReport(page);
    expect(saved.count, `${label}: saved reports`).toBe(1);
    expect(saved.fields, `${label}: saved report settings`).toEqual(
      savedReport(accountIds),
    );
  }
}

// ----------------------------------------------------------------------- test

test.describe('multi-currency persistence across two clients', () => {
  test.skip(!SERVER_URL, 'needs E2E_SYNC_SERVER_URL (disposable server)');

  test('rates, units, saved reports and report surfaces agree after sync and reload', async ({
    browser,
  }) => {
    test.setTimeout(900_000);

    // browser.newPage() gives each client its own storage: two devices.
    const clientA = await browser.newPage();
    const clientB = await browser.newPage();
    const clients = [clientA, clientB];
    const rateRequests: string[] = [];
    for (const page of clients) {
      await page.route(RATE_HOSTS, route => {
        rateRequests.push(route.request().url());
        return route.abort();
      });
    }

    try {
      // Client A: disposable budget, USD Main; a USD checking account, a EUR
      // account and a manual custom-unit account, both off budget.
      await clientA.goto('/');
      const configurationA = new ConfigurationPage(clientA);
      await configurationA.startFresh();
      await configurationA.initializeTestMainCurrency();
      await savePrefs(clientA, {
        'flags.newSidebarUI': 'false',
        hideFraction: 'false',
        'flags.balanceForecastReport': 'true',
        'flags.budgetAnalysisReport': 'true',
      });

      const fixture = await createFixture(clientA);
      const { categoryId, dashboardId } = fixture;
      const accountIds = [fixture.checking, fixture.euro, fixture.points];

      // Budget category math, evaluated and finite, before any rate exists.
      await clientA.reload();
      await new BudgetPage(clientA).waitFor();
      const before = await snapshot(clientA, categoryId);
      expect(before.categoryCells).toEqual(EXPECTED_CATEGORY_CELLS);
      expect(
        before.transactions.map(t => (t as { date: string }).date),
      ).toEqual(Array(5).fill(`${MONTH}-01`));
      observed.beforeA = before;

      // Upload from A, download on B.
      await connect(clientA);
      const upload = await send<{ error?: unknown }>(clientA, 'upload-budget');
      expect(upload.error).toBeUndefined();
      // A fresh local budget syncs only once sync is enabled for it.
      const enable = await send<{ error?: unknown }>(clientA, 'sync-budget');
      expect(enable.error).toBeUndefined();
      // Pick this run's own upload, so a reused server still works.
      const [localBudget] = await send<Array<{ cloudFileId?: string }>>(
        clientA,
        'get-budgets',
      );
      expect(localBudget.cloudFileId).toBeTruthy();
      const cloudFileId = localBudget.cloudFileId as string;

      await clientB.goto('/');
      await connect(clientB);
      await clientB.evaluate(
        id =>
          (window as TestWindow).__actionsForMenu.downloadBudget({
            cloudFileId: id,
          }),
        cloudFileId,
      );
      await new BudgetPage(clientB).waitFor();

      // Units, rates, a saved report and the derived widgets written on A.
      await savePrefs(clientA, {
        'manualRate.EUR.USD': '1.1',
        'customUnit.X-POINTS': JSON.stringify({
          name: 'Points',
          symbol: 'pt',
          decimals: 0,
        }),
        'manualRate.X-POINTS.USD': '0.01',
      });
      const report = savedReport(accountIds);
      const reportId = await send<string>(clientA, 'report/create', report);
      const widgetTypes = [
        'balance-forecast-card',
        'budget-analysis-card',
        'custom-report',
      ];
      for (const type of widgetTypes) {
        await send(clientA, 'dashboard-add-widget', {
          type,
          width: 4,
          height: 2,
          meta: type === 'custom-report' ? { id: reportId } : null,
          dashboard_page_id: dashboardId,
        });
      }
      await sync(clientA);
      await sync(clientB);

      const widgetIds = await clientB.evaluate(async () => {
        const w = window as TestWindow;
        return (await w.$query(w.$q('dashboard').select(['id', 'type'])))
          .data as Array<{ id: string; type: string }>;
      });
      const widgetOf = (type: string) => {
        const widget = widgetIds.find(w => w.type === type);
        expect(widget, `widget ${type} reached B`).toBeTruthy();
        return (widget as { id: string }).id;
      };
      const ctx: Context = {
        dashboardId,
        reportId,
        forecastId: widgetOf('balance-forecast-card'),
        analysisId: widgetOf('budget-analysis-card'),
      };

      // P1-1 (after sync): prefs and the saved report's real settings agree.
      const firstPrefs = {
        defaultCurrencyCode: 'USD',
        'manualRate.EUR.USD': '1.1',
        'customUnit.X-POINTS': JSON.stringify({
          name: 'Points',
          symbol: 'pt',
          decimals: 0,
        }),
        'manualRate.X-POINTS.USD': '0.01',
      };
      await expectPersistedSettings(clients, firstPrefs, accountIds, 'synced');
      const syncedReport = await readSavedReport(clientB);
      expect(syncedReport.id).toBe(reportId);
      observed.syncedPrefsB = firstPrefs;
      observed.syncedReportB = syncedReport.fields;
      await expectBudgetMath(clients, categoryId, before, 'synced');

      // Step 1: manual EUR 1.1, X-POINTS 0.01 (stored 1,000 pt -> $10.00).
      const step1: Rates = { eur: 1.1, points: 0.01 };
      await expectAllSurfaces(clientB, ctx, step1, 'step1-manual-1.1', 'B');
      await open(clientA, '/budget');
      await expect
        .poll(async () => sidebarOf(await pageText(clientA)))
        .toBe(expectedFor(step1).sidebar);
      await shoot(clientA, 'a-1-manual-1.1');
      await shoot(clientB, 'b-1-manual-1.1');
      await expectBudgetMath(clients, categoryId, before, 'step1');

      // Step 2: manual edits on A, EUR 1.25 and a custom-unit rate change.
      await savePrefs(clientA, {
        'manualRate.EUR.USD': '1.25',
        'manualRate.X-POINTS.USD': '0.02',
      });
      await sync(clientA);
      await sync(clientB);
      const step2: Rates = { eur: 1.25, points: 0.02 };
      await expectAllSurfaces(clientB, ctx, step2, 'step2-manual-1.25', 'B');
      await shoot(clientB, 'b-2-manual-1.25');
      await expectBudgetMath(clients, categoryId, before, 'step2');

      // Step 3: manual removal on B reaches A. Totals that need EUR are
      // unavailable, not stale; Main-only surfaces keep their value.
      await savePrefs(clientB, { 'manualRate.EUR.USD': '' });
      await sync(clientB);
      await sync(clientA);
      for (const page of clients) {
        const label = page === clientA ? 'A' : 'B';
        await open(page, '/budget');
        await expect
          .poll(async () => sidebarOf(await pageText(page)), {
            message: `${label}: removed sidebar`,
          })
          .toBe(sidebarWithoutEur(0.02));
      }
      const rateFree = expectedFor(step2);
      const removedSurfaces: Record<string, unknown> = {
        'dashboard net worth card': unavailable(2, 'Net worth is unavailable.'),
        'net worth page': unavailable(2, 'Net worth is unavailable.'),
        'summary page': unavailable(1, 'Summary values are unavailable.'),
        'calendar page': unavailable(2, 'Calendar is unavailable.'),
        'balance forecast page': unavailable(
          2,
          'Balance forecast is unavailable.',
        ),
        'crossover page': 'unavailable',
        'saved custom report (table)': [
          'Custom report values are unavailable.',
        ],
        // Main-only surfaces: foreign accounts are off budget, so a missing
        // EUR rate cannot touch them.
        'dashboard cash flow card (on-budget only)':
          rateFree['dashboard cash flow card (on-budget only)'],
        'dashboard summary cards (on-budget conditions)':
          rateFree['dashboard summary cards (on-budget conditions)'],
        'dashboard spending card': rateFree['dashboard spending card'],
        'cash flow page (Main, on-budget only)':
          rateFree['cash flow page (Main, on-budget only)'],
        'spending page': rateFree['spending page'],
        'budget analysis page': rateFree['budget analysis page'],
      };
      for (const surface of SURFACES) {
        if (surface.name in removedSurfaces) {
          await expectSurface(
            clientB,
            ctx,
            surface,
            removedSurfaces[surface.name],
            'step3-eur-removed',
            'B',
          );
        }
      }
      await open(clientA, '/budget');
      await shoot(clientA, 'a-3-removed');
      await expectBudgetMath(clients, categoryId, before, 'step3');

      // Step 4: cached automatic EUR rate (a fresh cache means no fetch),
      // then a newer cached rate.
      await savePrefs(clientA, {
        'rateMode.EUR': 'auto',
        'autoRate.EUR.USD': JSON.stringify({
          rate: '1.2',
          fetchedAt: Date.now(),
        }),
      });
      await sync(clientA);
      await sync(clientB);
      await expectAllSurfaces(
        clientB,
        ctx,
        { eur: 1.2, points: 0.02 },
        'step4-cached-1.2',
        'B',
      );

      const finalRates: Rates = { eur: 1.3, points: 0.02 };
      await savePrefs(clientA, {
        'autoRate.EUR.USD': JSON.stringify({
          rate: '1.3',
          fetchedAt: Date.now(),
        }),
      });
      await sync(clientA);
      await sync(clientB);
      await expectAllSurfaces(
        clientB,
        ctx,
        finalRates,
        'step5-cached-1.3',
        'B',
      );
      await open(clientA, '/budget');
      await shoot(clientA, 'a-4-cached-1.3');
      await open(clientB, '/budget');
      await shoot(clientB, 'b-4-cached-1.3');
      await expectBudgetMath(clients, categoryId, before, 'step5');

      // P1-1 (after a full reload): both clients re-read everything from
      // their own storage and still agree with the intended settings.
      const finalPrefs = {
        ...firstPrefs,
        'manualRate.EUR.USD': '',
        'manualRate.X-POINTS.USD': '0.02',
        'rateMode.EUR': 'auto',
      };
      for (const page of clients) {
        await open(page, '/budget');
        await page.reload();
        await new BudgetPage(page).waitFor();
      }
      await expectPersistedSettings(clients, finalPrefs, accountIds, 'reload');
      for (const page of clients) {
        const prefs = await send<Record<string, string>>(
          page,
          'preferences/get',
        );
        expect(JSON.parse(prefs['autoRate.EUR.USD']).rate).toBe('1.3');
      }
      observed.reloadedPrefs = finalPrefs;
      observed.reloadedReport = (await readSavedReport(clientB)).fields;
      await expectBudgetMath(clients, categoryId, before, 'reload');

      // After reload, the receiving client AND the author both render the
      // same numbers from persisted state.
      await expectAllSurfaces(
        clientB,
        ctx,
        finalRates,
        'step6-after-reload-B',
        'B',
      );
      for (const surface of SURFACES) {
        if (
          ['sidebar', 'saved custom report (table)', 'net worth page'].includes(
            surface.name,
          )
        ) {
          await expectSurface(
            clientA,
            ctx,
            surface,
            expectedFor(finalRates)[surface.name],
            'step6-after-reload-A',
            'A',
          );
        }
      }
      await open(clientB, `/reports/${dashboardId}`);
      await shoot(clientB, 'b-5-reports');
      await open(clientB, `/reports/custom/${reportId}`);
      await shoot(clientB, 'b-6-saved-report');

      expect(rateRequests).toEqual([]);
    } finally {
      observed.rateRequests = rateRequests;
      if (EVIDENCE_DIR) {
        fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
        fs.writeFileSync(
          path.join(EVIDENCE_DIR, 'observed.json'),
          JSON.stringify(observed, null, 2),
        );
      }
      await clientA.close();
      await clientB.close();
    }
  });
});
