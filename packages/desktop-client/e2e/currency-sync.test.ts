import fs from 'node:fs';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test } from './fixtures';
import { BudgetPage } from './page-models/budget-page';
import { ConfigurationPage } from './page-models/configuration-page';
import { Navigation } from './page-models/navigation';

// Two isolated browser clients against a disposable local sync server:
//   E2E_SYNC_SERVER_URL=http://127.0.0.1:5106 (a fresh ACTUAL_DATA_DIR)
//   E2E_EVIDENCE_DIR=<dir>  optional: screenshots and observed values
// Without E2E_SYNC_SERVER_URL the suite is skipped; it never touches a real
// server.
const SERVER_URL = process.env.E2E_SYNC_SERVER_URL;
const EVIDENCE_DIR = process.env.E2E_EVIDENCE_DIR;
const PASSWORD = 'che-1024-disposable';
const RATE_HOSTS = /frankfurter|coingecko/;

type TestWindow = Window & {
  $send: (method: string, args?: Record<string, unknown>) => Promise<unknown>;
  $query: (query: unknown) => Promise<{ data: unknown[] }>;
  $q: (table: string) => {
    select: (fields: string[]) => unknown;
  };
  __actionsForMenu: {
    saveSyncedPrefs: (payload: {
      prefs: Record<string, string>;
    }) => Promise<unknown>;
    downloadBudget: (payload: { cloudFileId: string }) => Promise<unknown>;
  };
};

const observed: Record<string, unknown> = {};

async function send<T = unknown>(
  page: Page,
  method: string,
  args?: Record<string, unknown>,
) {
  return page.evaluate(
    ([name, params]) =>
      (window as TestWindow).$send(name, params as Record<string, unknown>),
    [method, args] as const,
  ) as Promise<T>;
}

async function savePrefs(page: Page, prefs: Record<string, string>) {
  await page.evaluate(async values => {
    await (window as TestWindow).__actionsForMenu.saveSyncedPrefs({
      prefs: values,
    });
  }, prefs);
}

async function connect(page: Page) {
  await send(page, 'set-server-url', { url: SERVER_URL });
  // Already bootstrapped by the first client: that error is expected.
  await send(page, 'subscribe-bootstrap', { password: PASSWORD });
  const signIn = await send<{ error?: string }>(page, 'subscribe-sign-in', {
    password: PASSWORD,
  });
  expect(signIn.error).toBeUndefined();
}

// Pushes this client's changes and pulls the other client's. fullSync is
// single-flight: a call made while an automatic sync runs joins it and may
// miss the newest change, so the second call guarantees one full round trip.
async function sync(page: Page) {
  for (let round = 0; round < 2; round++) {
    const result = await send<{ error?: unknown } | undefined>(page, 'sync');
    expect(result?.error).toBeUndefined();
  }
}

async function snapshot(page: Page, month: string, categoryId: string) {
  return page.evaluate(
    async ([m, category]) => {
      const w = window as TestWindow;
      const rows = async (table: string, fields: string[]) =>
        (await w.$query(w.$q(table).select(fields))).data;
      const transactions = await rows('transactions', [
        'id',
        'account',
        'amount',
        'date',
        'category',
      ]);
      const budgets = await rows('zero_budgets', [
        'id',
        'month',
        'category',
        'amount',
      ]);
      const cells = (await w.$send('envelope-budget-month', {
        month: m,
      })) as Array<{ name: string; value: unknown }>;
      const byId = (a: { id: string }, b: { id: string }) =>
        a.id.localeCompare(b.id);
      return {
        transactions: (transactions as Array<{ id: string }>).sort(byId),
        budgets: (budgets as Array<{ id: string }>).sort(byId),
        categoryCells: cells
          .filter(cell => cell.name.includes(category))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    },
    [month, categoryId] as const,
  );
}

async function expectBothClients(
  pages: Page[],
  expected: RegExp | string,
  label: string,
) {
  for (const page of pages) {
    const total = page.getByTestId('sidebar-off-budget-balance');
    if (typeof expected === 'string') {
      await expect(total, label).toContainText(expected);
    } else {
      await expect(total, label).toHaveText(expected);
    }
  }
}

async function shoot(page: Page, name: string) {
  if (EVIDENCE_DIR) {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: path.join(EVIDENCE_DIR, `${name}.png`) });
  }
}

test.describe('multi-currency persistence across two clients', () => {
  test.skip(!SERVER_URL, 'needs E2E_SYNC_SERVER_URL (disposable server)');

  test('rates, units and saved reports agree after sync and reload', async ({
    browser,
  }) => {
    test.setTimeout(240_000);

    // browser.newPage() gives each client its own storage: two devices.
    const clientA = await browser.newPage();
    const clientB = await browser.newPage();
    const rateRequests: string[] = [];
    for (const page of [clientA, clientB]) {
      await page.route(RATE_HOSTS, route => {
        rateRequests.push(route.request().url());
        return route.abort();
      });
    }

    try {
      // Client A: disposable budget, USD Main, EUR off-budget account.
      await clientA.goto('/');
      const configurationA = new ConfigurationPage(clientA);
      await configurationA.startFresh();
      await configurationA.initializeTestMainCurrency();
      await savePrefs(clientA, {
        'flags.newSidebarUI': 'false',
        hideFraction: 'false',
      });

      // Test mode pins the app clock, so ask the page, not Node.
      const month = await clientA.evaluate(() =>
        new Date().toISOString().slice(0, 7),
      );
      const { categoryId } = await clientA.evaluate(async m => {
        const w = window as TestWindow;
        await w.$send('account-create', {
          name: 'Euro savings',
          balance: 100,
          offBudget: true,
          currency: 'EUR',
        });
        await w.$send('account-create', {
          name: 'Checking',
          balance: 500,
          offBudget: false,
          currency: 'USD',
        });
        const groupId = await w.$send('category-group-create', {
          name: 'Bills',
        });
        const categoryId = (await w.$send('category-create', {
          name: 'Rent',
          groupId,
        })) as string;
        await w.$send('budget/budget-amount', {
          month: m,
          category: categoryId,
          amount: 20000,
        });
        return { categoryId };
      }, month);
      await clientA.reload();
      await new BudgetPage(clientA).waitFor();

      const before = await snapshot(clientA, month, categoryId);
      expect(before.transactions).toHaveLength(2);
      expect(
        before.transactions
          .map(t => (t as { amount: number }).amount)
          .sort((a, b) => a - b),
      ).toEqual([10000, 50000]);
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

      // Main currency, unit, rate and a saved report written on A reach B.
      await savePrefs(clientA, {
        'manualRate.EUR.USD': '1.1',
        'customUnit.X-POINTS': JSON.stringify({
          name: 'Points',
          symbol: 'pt',
          decimals: 0,
        }),
        'manualRate.X-POINTS.USD': '0.01',
      });
      await send(clientA, 'report/create', {
        name: 'Euro totals',
        startDate: `${month}-01`,
        endDate: `${month}-28`,
        isDateStatic: false,
        dateRange: 'This month',
        mode: 'total',
        groupBy: 'Category',
        interval: 'Monthly',
        balanceType: 'Payment',
        showEmpty: false,
        showOffBudget: true,
        showHiddenCategories: false,
        includeCurrentInterval: true,
        showUncategorized: true,
        trimIntervals: false,
        showTrendLines: false,
        graphType: 'BarGraph',
        conditionsOp: 'and',
        conditions: [],
      });
      await sync(clientA);
      await sync(clientB);

      const prefsKeys = [
        'defaultCurrencyCode',
        'manualRate.EUR.USD',
        'customUnit.X-POINTS',
        'manualRate.X-POINTS.USD',
      ];
      const prefsA = await send<Record<string, string>>(
        clientA,
        'preferences/get',
      );
      const prefsB = await send<Record<string, string>>(
        clientB,
        'preferences/get',
      );
      for (const key of prefsKeys) {
        expect(prefsB[key], key).toBe(prefsA[key]);
      }
      expect(prefsB.defaultCurrencyCode).toBe('USD');
      expect(prefsB['manualRate.EUR.USD']).toBe('1.1');
      const reportNames = async (page: Page) =>
        (await send<Array<{ name: string }>>(page, 'report/get')).map(
          r => r.name,
        );
      expect(await reportNames(clientB)).toEqual(await reportNames(clientA));
      expect(await reportNames(clientB)).toContain('Euro totals');
      observed.prefsB = Object.fromEntries(prefsKeys.map(k => [k, prefsB[k]]));

      // Manual rate: 100.00 EUR x 1.1.
      await expectBothClients([clientA, clientB], '110.00', 'manual 1.1');
      await shoot(clientA, 'a-1-manual-1.1');
      await shoot(clientB, 'b-1-manual-1.1');

      // Manual edit on A.
      await savePrefs(clientA, { 'manualRate.EUR.USD': '1.25' });
      await sync(clientA);
      await sync(clientB);
      await expectBothClients([clientA, clientB], '125.00', 'manual 1.25');
      await shoot(clientB, 'b-2-manual-1.25');

      // Manual removal on B reaches A: the total is unavailable, not stale.
      await savePrefs(clientB, { 'manualRate.EUR.USD': '' });
      await sync(clientB);
      await sync(clientA);
      await expectBothClients([clientA, clientB], /N\/A|no rate/, 'removed');
      await shoot(clientA, 'a-3-removed');

      // Cached automatic rate: a fresh cache means no network fetch.
      await savePrefs(clientA, {
        'rateMode.EUR': 'auto',
        'autoRate.EUR.USD': JSON.stringify({
          rate: '1.2',
          fetchedAt: Date.now(),
        }),
      });
      await sync(clientA);
      await sync(clientB);
      await expectBothClients([clientA, clientB], '120.00', 'cached 1.2');

      await savePrefs(clientA, {
        'autoRate.EUR.USD': JSON.stringify({
          rate: '1.3',
          fetchedAt: Date.now(),
        }),
      });
      await sync(clientA);
      await sync(clientB);
      await expectBothClients([clientA, clientB], '130.00', 'cached 1.3');
      await shoot(clientA, 'a-4-cached-1.3');
      await shoot(clientB, 'b-4-cached-1.3');

      // Reload: both clients keep agreeing with the persisted prefs.
      for (const page of [clientA, clientB]) {
        await page.reload();
        await new BudgetPage(page).waitFor();
      }
      await expectBothClients([clientA, clientB], '130.00', 'after reload');

      // A report surface on B shows the current-rate estimate label.
      await new Navigation(clientB).goToReportsPage();
      await expect(
        clientB.getByText(
          'Values in USD. Foreign-currency history is an estimate at current rates.',
        ),
      ).toBeVisible({ timeout: 45_000 });
      await shoot(clientB, 'b-5-reports');

      // Stored amounts and budget category math never moved.
      const afterA = await snapshot(clientA, month, categoryId);
      const afterB = await snapshot(clientB, month, categoryId);
      expect(afterA).toEqual(before);
      expect(afterB).toEqual(before);
      observed.afterB = afterB;
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
