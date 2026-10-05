import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { Browser, Page } from '@playwright/test';

import { expect } from './fixtures';
import { BudgetPage } from './page-models/budget-page';
import { ConfigurationPage } from './page-models/configuration-page';

// Shared by the two-client currency journeys (currency-sync*.test.ts).
// Two isolated browser clients run against a disposable local sync server:
//   E2E_SYNC_SERVER_URL=http://127.0.0.1:<port> (a fresh ACTUAL_DATA_DIR)
//   E2E_EVIDENCE_DIR=<dir>  optional: screenshots and observed values
export const SERVER_URL = process.env.E2E_SYNC_SERVER_URL;
export const EVIDENCE_DIR = process.env.E2E_EVIDENCE_DIR;
export const PASSWORD = 'che-1024-disposable';
export const RATE_HOSTS = /frankfurter|coingecko/;

// Test mode pins the app clock: every date below is January 2017.
export const MONTH = '2017-01';
export const EURO_NATIVE = 80; // 100.00 EUR deposit, 20.00 EUR expense
export const POINTS_NATIVE = 1000; // 1,000 pt, a decimals-0 custom unit

export type TestWindow = Window & {
  $send: (method: string, args?: Record<string, unknown>) => Promise<unknown>;
  $query: (query: unknown) => Promise<{ data: unknown[] }>;
  $q: (table: string) => {
    select: (fields: string[]) => unknown;
  };
  __navigate: (url: string) => void;
  __actionsForMenu: {
    saveSyncedPrefs: (payload: {
      prefs: Record<string, string>;
    }) => Promise<unknown>;
    downloadBudget: (payload: { cloudFileId: string }) => Promise<unknown>;
  };
};

export type Json = Record<string, unknown>;

// The dev server may reload every open page once when a lazily imported
// dependency is first optimised; wait for the app globals to come back.
export async function appReady(page: Page) {
  await page.waitForFunction(
    () =>
      typeof (window as TestWindow).$q === 'function' &&
      typeof (window as TestWindow).__navigate === 'function',
    undefined,
    { timeout: 30_000 },
  );
}

export async function send<T = unknown>(
  page: Page,
  method: string,
  args?: Record<string, unknown>,
) {
  await appReady(page);
  return page.evaluate(
    ([name, params]) =>
      (window as TestWindow).$send(name, params as Record<string, unknown>),
    [method, args] as const,
  ) as Promise<T>;
}

export async function savePrefs(page: Page, prefs: Record<string, string>) {
  await page.evaluate(async values => {
    await (window as TestWindow).__actionsForMenu.saveSyncedPrefs({
      prefs: values,
    });
  }, prefs);
}

export async function connect(page: Page) {
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
export async function sync(page: Page) {
  for (let round = 0; round < 2; round++) {
    const result = await send<{ error?: unknown } | undefined>(page, 'sync');
    expect(result?.error).toBeUndefined();
  }
}

export async function shoot(page: Page, name: string) {
  if (EVIDENCE_DIR) {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: path.join(EVIDENCE_DIR, `${name}.png`) });
  }
}

export const BIDI = /[‪-‮⁦-⁩]/g;

// Rendered text of the whole app, one ' | ' per line break, without the
// bidi marks the currency formatter wraps amounts in.
export async function pageText(page: Page) {
  const raw = await page
    .evaluate(() => document.body.innerText)
    // A page that is reloading has no text yet: the poll tries again.
    .catch(() => '');
  return raw
    .replace(BIDI, '')
    .replace(/[\u00a0\u202f]/g, ' ')
    .replace(/\s*\n+\s*/g, ' | ');
}

// Right after a prefs sync the router can briefly drop flag-gated routes and
// bounce to /budget, so navigate until the app stays on the requested route.
export async function open(page: Page, route: string) {
  await expect
    .poll(
      async () => {
        await appReady(page);
        const path = await page.evaluate(() => window.location.pathname);
        if (path !== route) {
          await page.evaluate(
            url => (window as TestWindow).__navigate(url),
            route,
          );
          await page.waitForTimeout(250);
        }
        return page.evaluate(() => window.location.pathname);
      },
      { message: `open ${route}`, timeout: 30_000 },
    )
    .toBe(route);
}

export function grab(t: string, re: RegExp): string[] | { unmatched: string } {
  const match = re.exec(t);
  if (match) {
    return match.slice(1);
  }
  const start = t.indexOf(' | Help | ');
  return { unmatched: t.slice(start < 0 ? 0 : start + 10, start + 600) };
}

export const sidebarOf = (t: string) =>
  t.slice(t.indexOf('All accounts'), t.indexOf(' | Add account'));

export const USD = '(-?\\+?\\$[\\d,]+\\.\\d\\d)';
export const NOTE =
  'Values in USD\\. Foreign-currency history is an estimate at current rates\\.';

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const usd = (n: number) =>
  `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

export type Rates = { eur: number; points: number };

// Everything a rate pair implies, in Main (USD). On-budget Checking is 500.00
// income and a 150.00 Rent expense; the foreign accounts are off budget.
export function derive({ eur, points }: Rates) {
  const euroNet = round2(EURO_NATIVE * eur);
  const euroDeposit = round2(100 * eur);
  const euroPayment = round2(-20 * eur);
  const pointsNet = round2(POINTS_NATIVE * points);
  const off = round2(euroNet + pointsNet);
  const all = round2(350 + off);
  return { euroNet, euroDeposit, euroPayment, pointsNet, off, all };
}

// Disposable fixture on client A: an on-budget USD Checking account (500.00
// income, a 150.00 Rent expense), an off-budget EUR account and an off-budget
// custom-unit account, a Rent budget of 200.00, all dated January 2017.
export async function createFixture(page: Page) {
  return page.evaluate(async m => {
    const w = window as TestWindow;
    const euro = (await w.$send('account-create', {
      name: 'Euro savings',
      balance: 100,
      offBudget: true,
      currency: 'EUR',
    })) as string;
    const points = (await w.$send('account-create', {
      name: 'Loyalty points',
      balance: 1000,
      offBudget: true,
      currency: 'X-POINTS',
    })) as string;
    const checking = (await w.$send('account-create', {
      name: 'Checking',
      balance: 500,
      offBudget: false,
      currency: 'USD',
    })) as string;
    const groupId = await w.$send('category-group-create', {
      name: 'Bills',
    });
    const categoryId = (await w.$send('category-create', {
      name: 'Rent',
      groupId,
    })) as string;
    const date = `${m}-01`;
    await w.$send('transactions-batch-update', {
      added: [
        // Aligned with the budget month: spent -150.00 of 200.00.
        {
          id: w.crypto.randomUUID(),
          account: checking,
          date,
          amount: -15000,
          category: categoryId,
        },
        { id: w.crypto.randomUUID(), account: euro, date, amount: -2000 },
      ],
    });
    await w.$send('budget/budget-amount', {
      month: m,
      category: categoryId,
      amount: 20000,
    });
    const pages = (await w.$query(w.$q('dashboard_pages').select(['id'])))
      .data as Array<{ id: string }>;
    return { euro, points, checking, categoryId, dashboardId: pages[0].id };
  }, MONTH);
}

export type Fixture = Awaited<ReturnType<typeof createFixture>>;

export type TwoClients = {
  a: Page;
  b: Page;
  fixture: Fixture;
  accountIds: string[];
  rateRequests: string[];
  close: () => Promise<void>;
};

// Client A builds the disposable budget and uploads it; client B downloads it
// through the same sync server. browser.newPage() gives each client its own
// storage, so they are two devices. Only the external rate hosts are routed,
// and aborted: no rate is ever fetched. The app calendar is pinned to
// 2017-01-01 by the Playwright user agent (loot-core months.ts), which is what
// makes day-dependent cards deterministic. (page.clock.setFixedTime was tried
// and rejected: with it the dashboard never leaves "Loading reports...".)
export async function bootTwoClients(
  browser: Browser,
  options: { flags?: Record<string, string> } = {},
): Promise<TwoClients> {
  const a = await browser.newPage();
  const b = await browser.newPage();
  const rateRequests: string[] = [];
  for (const page of [a, b]) {
    await page.route(RATE_HOSTS, route => {
      rateRequests.push(route.request().url());
      return route.abort();
    });
  }
  await a.goto('/');
  await new ConfigurationPage(a).startFresh();
  await new ConfigurationPage(a).initializeTestMainCurrency();
  await savePrefs(a, {
    'flags.newSidebarUI': 'false',
    hideFraction: 'false',
    ...options.flags,
  });
  const fixture = await createFixture(a);
  await a.reload();
  await new BudgetPage(a).waitFor({ timeout: 90_000 });

  await connect(a);
  const upload = await send<{ error?: unknown }>(a, 'upload-budget');
  expect(upload.error).toBeUndefined();
  const enable = await send<{ error?: unknown }>(a, 'sync-budget');
  expect(enable.error).toBeUndefined();
  const [localBudget] = await send<Array<{ cloudFileId?: string }>>(
    a,
    'get-budgets',
  );
  expect(localBudget.cloudFileId).toBeTruthy();
  await b.goto('/');
  await connect(b);
  await b.evaluate(
    id =>
      (window as TestWindow).__actionsForMenu.downloadBudget({
        cloudFileId: id,
      }),
    localBudget.cloudFileId as string,
  );
  await new BudgetPage(b).waitFor({ timeout: 90_000 });

  return {
    a,
    b,
    fixture,
    accountIds: [fixture.checking, fixture.euro, fixture.points],
    rateRequests,
    close: async () => {
      await a.close();
      await b.close();
    },
  };
}

// What this run says about itself, written at run time. The git and tree ids
// come from the pre-run record through the environment; the source hashes are
// computed here from the files that actually executed.
export function runSelfDescription(files: string[]) {
  const hash = (file: string) =>
    createHash('sha256')
      .update(fs.readFileSync(path.join(__dirname, file)))
      .digest('hex');
  return {
    startedAt: new Date().toISOString(),
    gitSha: process.env.E2E_GIT_SHA ?? null,
    treeSha: process.env.E2E_TREE_SHA ?? null,
    appUrl: process.env.E2E_START_URL ?? null,
    syncServerUrl: SERVER_URL ?? null,
    node: process.version,
    sources: Object.fromEntries(
      [...files, 'currency-sync-helpers.ts'].map(file => [file, hash(file)]),
    ),
  };
}

export function writeObserved(file: string, value: unknown) {
  if (EVIDENCE_DIR) {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(EVIDENCE_DIR, file),
      JSON.stringify(value, null, 2),
    );
  }
}

process.stderr.write(`[step ${new Date().toISOString()}] ${m}\n`);
