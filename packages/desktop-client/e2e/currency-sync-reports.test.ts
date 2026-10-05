import fs from 'node:fs';

import type { Page } from '@playwright/test';

import {
  BIDI,
  bootTwoClients,
  derive,
  open,
  pageText,
  runSelfDescription,
  savePrefs,
  send,
  SERVER_URL,
  shoot,
  sync,
  usd,
  writeObserved,
} from './currency-sync-helpers';
import type { Rates } from './currency-sync-helpers';
import { expect, test } from './fixtures';
import { BudgetPage } from './page-models/budget-page';

// CHE-1197: browser values the first journey (currency-sync.test.ts) left
// open, on the same real two-client / disposable-sync-server design. Client A
// writes rates, B receives them over sync, and B's rendered numbers must equal
// the canonical converted model. Unavailable is asserted as unavailable,
// never as zero. Needs E2E_SYNC_SERVER_URL (CI skips it; local runs are the
// evidence).
const observed: Record<string, unknown> = {};

const REPORT_NAME = (graph: string) => `Chart ${graph}`;
const GRAPHS = [
  ['BarGraph', 'total'],
  ['DonutGraph', 'total'],
  ['LineGraph', 'time'],
  ['AreaGraph', 'time'],
  ['StackedBarGraph', 'time'],
] as const;

const unbidi = (text: string) => text.replace(BIDI, '').replace(/\s+/g, ' ');

// Hover across the chart and collect every distinct tooltip it shows. Charts
// draw a tooltip only for the point under the pointer, so one sweep reads
// every bar, line point or area column the report has.
async function hoverTooltips(page: Page) {
  const chart = page.locator('.recharts-wrapper').first();
  await chart.waitFor({ timeout: 60_000 });
  const box = await chart.boundingBox();
  expect(box, 'chart is drawn').toBeTruthy();
  const { x, y, width, height } = box as NonNullable<typeof box>;
  const seen = new Set<string>();
  for (const row of [0.3, 0.6]) {
    for (let i = 1; i <= 14; i++) {
      await page.mouse.move(x + (width * i) / 15, y + height * row);
      await page.waitForTimeout(80);
      const text = await page.evaluate(() =>
        Array.from(
          document.querySelectorAll<HTMLElement>('.recharts-tooltip-wrapper'),
        )
          .filter(el => el.style.visibility !== 'hidden')
          .map(el => el.innerText.replace(/\s*\n+\s*/g, ' | '))
          .join(' ## '),
      );
      if (text.trim()) {
        seen.add(unbidi(text));
      }
    }
  }
  return [...seen];
}

// The donut draws the hovered slice's name, amount and share as SVG text.
async function donutLabels(page: Page) {
  const sectors = page.locator('.recharts-sector');
  const labels: string[] = [];
  for (let i = 0; i < (await sectors.count()); i++) {
    // The donut animates in: a slice that is not hoverable yet is skipped and
    // the caller's poll tries again.
    try {
      await sectors.nth(i).hover({ force: true, timeout: 5_000 });
    } catch {
      continue;
    }
    labels.push(
      unbidi(
        await page.evaluate(() =>
          Array.from(document.querySelectorAll('.recharts-wrapper svg text'))
            .map(node => node.textContent)
            .join(' | '),
        ),
      ),
    );
  }
  return labels;
}

const share = (part: number, whole: number) =>
  `(${((part / whole) * 100).toFixed(2)}%)`;

// What every chart must show for a rate pair: per-account Net, the whole
// report's Assets/Debts/Net, and the donut shares.
function chartExpectations(rates: Rates) {
  const v = derive(rates);
  const assets = 500 + v.euroDeposit + v.pointsNet;
  return {
    bar: [
      `Checking | Assets: | $500.00 | Debts: | -$150.00 | Net: | $350.00`,
      `Euro savings | Assets: | ${usd(v.euroDeposit)} | Debts: | -${usd(-v.euroPayment)} | Net: | ${usd(v.euroNet)}`,
      `Loyalty points | Assets: | ${usd(v.pointsNet)} | Debts: | $0.00 | Net: | ${usd(v.pointsNet)}`,
    ],
    series: `Jan '17 | Checking | $350.00 | Euro savings | ${usd(v.euroNet)} | Loyalty points | ${usd(v.pointsNet)} | Total | ${usd(v.all)}`,
    area: `Jan '17 | Assets: | ${usd(assets)} | Debts: | -${usd(150 - v.euroPayment)} | Net: | ${usd(v.all)}`,
    donut: [
      `Checking | $350.00 | ${share(350, v.all)}`,
      `Euro savings | ${usd(v.euroNet)} | ${share(v.euroNet, v.all)}`,
      `Loyalty points | ${usd(v.pointsNet)} | ${share(v.pointsNet, v.all)}`,
    ],
  };
}

// Crossover: investment income is round(balance * 4% / 12) cents; the Rent
// category's 150.00 sets expenses and target income; "Life savings" is the
// converted balance of every selected account.
function crossoverTooltip(rates: Rates) {
  const { all } = derive(rates);
  const income = Math.round((all * 100 * 0.04) / 12) / 100;
  return `Monthly investment income: | ${usd(income)} | Monthly expenses: | $150.00 | Target income: | $150.00 | Life savings: | ${usd(all)}`;
}

const NUM = /^-?\d+(\.\d{1,2})?$/;
const BUDGET_ANALYSIS_ROWS = [
  '2016-08,0,0,0,0',
  '2016-09,0,0,0,0',
  '2016-10,0,0,0,0',
  '2016-11,0,0,0,0',
  '2016-12,0,0,0,0',
  '2017-01,200,-150,0,50',
];
const BUDGET_ANALYSIS_HEADER =
  'Month,Budgeted,Spent,Overspending Adjustment,Balance';

async function download(page: Page, click: () => Promise<void>) {
  const pending = page.waitForEvent('download');
  await click();
  const file = await pending;
  const filePath = await file.path();
  return {
    name: file.suggestedFilename(),
    bytes: fs.readFileSync(filePath),
  };
}

test.describe('currency report values and exports across two clients', () => {
  test.skip(!SERVER_URL, 'needs E2E_SYNC_SERVER_URL (disposable server)');
  test.use({ actionTimeout: 20_000 });

  test('crossover, charts, summary, budget overview and exports follow the canonical converted model', async ({
    browser,
  }) => {
    test.setTimeout(900_000);
    observed.run = runSelfDescription(['currency-sync-reports.test.ts']);
    const c = await bootTwoClients(browser, {
      flags: { 'flags.budgetAnalysisReport': 'true' },
    });
    const { b: reader, a: author, fixture } = c;
    const reportIds: Record<string, string> = {};
    let budgetAnalysisId = '';

    // The reports pages only settle after the dashboard has loaded once on a
    // client (observed: a first visit to /reports/crossover spins forever).
    let warm = false;
    async function readSurface(route: string) {
      if (!warm) {
        await open(reader, `/reports/${fixture.dashboardId}`);
        await expect
          .poll(async () => pageText(reader), { timeout: 60_000 })
          .toContain('Budget Overview');
        warm = true;
      }
      await open(reader, route);
      await expect
        .poll(async () => !(await pageText(reader)).includes('Loading'), {
          timeout: 60_000,
        })
        .toBe(true);
    }

    async function expectChartsAndCrossover(rates: Rates, step: string) {
      const want = chartExpectations(rates);
      const seen: Record<string, unknown> = {};
      await readSurface('/reports/crossover');
      await expect
        .poll(
          async () =>
            (observed[`${step}-crossover-last`] = await hoverTooltips(reader)),
          {
            message: `${step}: crossover tooltip`,
            timeout: 60_000,
          },
        )
        .toEqual(
          expect.arrayContaining([
            expect.stringContaining(crossoverTooltip(rates)),
          ]),
        );
      seen.crossover = (await hoverTooltips(reader)).slice(0, 2);
      await shoot(reader, `${step}-crossover`);

      for (const [graph] of GRAPHS) {
        await readSurface(`/reports/custom/${reportIds[graph]}`);
        if (graph === 'DonutGraph') {
          await expect
            .poll(() => donutLabels(reader), { timeout: 60_000 })
            .toEqual(
              expect.arrayContaining(
                want.donut.map(label => expect.stringContaining(label)),
              ),
            );
          seen[graph] = await donutLabels(reader);
        } else {
          const expected =
            graph === 'BarGraph'
              ? want.bar
              : graph === 'AreaGraph'
                ? [want.area]
                : [want.series];
          await expect
            .poll(() => hoverTooltips(reader), {
              message: `${step}: ${graph} tooltips`,
              timeout: 60_000,
            })
            .toEqual(
              expect.arrayContaining(
                expected.map(text => expect.stringContaining(text)),
              ),
            );
          seen[graph] = await hoverTooltips(reader);
        }
        await shoot(reader, `${step}-${graph}`);
      }
      observed[`${step}-charts`] = seen;
    }

    // Main-only: the summary card's Avg Per Month is the fixture's 150.00
    // expense divided by the elapsed fraction of the pinned month (day 1 of
    // 31): 150 * 31 = 4,650.00. Budget Overview prorates the 200.00 budget
    // the same way: 150.00 spent - 200.00 * 1/31, rounded = 143.55. Neither
    // moves with a rate; foreign accounts are off budget.
    const AVG_PER_MONTH = usd((150 * 31) / 1);
    const BUDGET_OVERVIEW = `+${usd(Math.round((150 - 200 / 31) * 100) / 100)}`;
    async function expectMainOnlyCards(step: string) {
      await readSurface(`/reports/${fixture.dashboardId}`);
      const avgPerMonth = `Avg Per Month | January 2017 | ${AVG_PER_MONTH} | Avg Per Transaction`;
      const overview = `Budget Overview | Compare Jan 2017 to budgeted | ${BUDGET_OVERVIEW} | 3-Month Average`;
      for (const [label, expected] of [
        ['Avg Per Month', avgPerMonth],
        ['Budget Overview', overview],
      ]) {
        await expect
          .poll(async () => unbidi(await pageText(reader)), {
            message: `${step}: ${label}`,
            timeout: 60_000,
          })
          .toContain(expected);
      }
      observed[`${step}-main-only-cards`] = {
        avgPerMonth: AVG_PER_MONTH,
        budgetOverview: BUDGET_OVERVIEW,
        appCalendar: 'Jan 2017',
      };
    }

    async function exportBudgetAnalysis(step: string) {
      await readSurface(`/reports/budget-analysis/${budgetAnalysisId}`);
      const file = await download(reader, () =>
        reader.getByRole('button', { name: 'Export as CSV' }).click(),
      );
      expect(file.name, `${step}: file name`).toBe(
        'budget-analysis-2016-08-2017-01.csv',
      );
      const lines = file.bytes.toString('utf8').trim().split('\n');
      // Schema unchanged: the same header and one row per month.
      expect(lines[0], `${step}: header`).toBe(BUDGET_ANALYSIS_HEADER);
      expect(lines.slice(1), `${step}: rows`).toEqual(BUDGET_ANALYSIS_ROWS);
      // Machine-readable: plain decimal numbers, no symbol, separator or
      // display rounding adjustment.
      for (const cell of lines.slice(1).flatMap(l => l.split(',').slice(1))) {
        expect(cell, `${step}: cell ${cell}`).toMatch(NUM);
      }
      // The same canonical numbers the page shows (displayed with $ and .00).
      const page = await pageText(reader);
      expect(unbidi(page)).toContain(
        'Budgeted: | $200.00 | Spent: | -$150.00 | Overspending adj: | $0.00 | Ending balance: | +$50.00',
      );
      observed[`${step}-budget-analysis-csv`] = {
        name: file.name,
        text: file.bytes.toString('utf8'),
      };
    }

    try {
      // Rates, a saved report per chart type and a budget analysis widget,
      // all written on A.
      await savePrefs(author, {
        'manualRate.EUR.USD': '1.1',
        'customUnit.X-POINTS': JSON.stringify({
          name: 'Points',
          symbol: 'pt',
          decimals: 0,
        }),
        'manualRate.X-POINTS.USD': '0.01',
      });
      for (const [graph, mode] of GRAPHS) {
        reportIds[graph] = await send<string>(author, 'report/create', {
          name: REPORT_NAME(graph),
          startDate: '2017-01-01',
          endDate: '2017-01-31',
          isDateStatic: false,
          dateRange: 'This month',
          mode,
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
          graphType: graph,
          conditionsOp: 'and',
          conditions: [{ field: 'account', op: 'oneOf', value: c.accountIds }],
        });
      }
      await send(author, 'dashboard-add-widget', {
        type: 'budget-analysis-card',
        width: 4,
        height: 2,
        meta: null,
        dashboard_page_id: fixture.dashboardId,
      });
      await sync(author);
      await sync(reader);
      budgetAnalysisId = await reader.evaluate(async () => {
        const w = window as unknown as {
          $query: (
            q: unknown,
          ) => Promise<{ data: Array<{ id: string; type: string }> }>;
          $q: (t: string) => { select: (f: string[]) => unknown };
        };
        const { data } = await w.$query(
          w.$q('dashboard').select(['id', 'type']),
        );
        return data.find(d => d.type === 'budget-analysis-card')?.id ?? '';
      });
      expect(budgetAnalysisId).toBeTruthy();

      // Step 1: EUR 1.1, points 0.01.
      const step1: Rates = { eur: 1.1, points: 0.01 };
      await expectChartsAndCrossover(step1, 'step1-eur-1.1');
      await expectMainOnlyCards('step1-eur-1.1');
      await exportBudgetAnalysis('step1-eur-1.1');

      // Step 2: a rate update on A reaches B; export again.
      await savePrefs(author, {
        'manualRate.EUR.USD': '1.25',
        'manualRate.X-POINTS.USD': '0.02',
      });
      await sync(author);
      await sync(reader);
      const step2: Rates = { eur: 1.25, points: 0.02 };
      await expectChartsAndCrossover(step2, 'step2-eur-1.25');
      await expectMainOnlyCards('step2-eur-1.25');
      await exportBudgetAnalysis('step2-eur-1.25');

      // Step 3: EUR rate removed on B. Rate-dependent charts and crossover
      // say unavailable; Main-only cards and the export do not move.
      await savePrefs(reader, { 'manualRate.EUR.USD': '' });
      await sync(reader);
      await sync(author);
      await readSurface('/reports/crossover');
      await expect
        .poll(async () => pageText(reader), { timeout: 60_000 })
        .toContain('Crossover point is unavailable.');
      expect(await reader.locator('.recharts-wrapper').count()).toBe(0);
      for (const [graph] of GRAPHS) {
        await readSurface(`/reports/custom/${reportIds[graph]}`);
        await expect
          .poll(async () => pageText(reader), {
            message: `${graph} unavailable`,
            timeout: 60_000,
          })
          .toContain('Custom report values are unavailable.');
        expect(await reader.locator('.recharts-wrapper').count()).toBe(0);
      }
      await expectMainOnlyCards('step3-eur-removed');
      await exportBudgetAnalysis('step3-eur-removed');

      // Step 4: EUR 1.2 restored on A; after a full reload B renders the
      // same numbers from its own storage.
      await savePrefs(author, { 'manualRate.EUR.USD': '1.2' });
      await sync(author);
      await sync(reader);
      await open(reader, '/budget');
      await reader.reload();
      warm = false;
      await new BudgetPage(reader).waitFor({ timeout: 90_000 });
      const step4: Rates = { eur: 1.2, points: 0.02 };
      await expectChartsAndCrossover(step4, 'step4-reloaded-eur-1.2');
      await expectMainOnlyCards('step4-reloaded-eur-1.2');
      await exportBudgetAnalysis('step4-reloaded-eur-1.2');

      expect(c.rateRequests).toEqual([]);
    } finally {
      observed.rateRequests = c.rateRequests;
      writeObserved('observed-reports.json', observed);
      await c.close();
    }
  });
});
