import type { Page } from '@playwright/test';

import {
  BIDI,
  SERVER_URL,
  bootTwoClients,
  open,
  pageText,
  runSelfDescription,
  savePrefs,
  send,
  shoot,
  sync,
  writeObserved,
} from './currency-sync-helpers';
import type { Json, TestWindow } from './currency-sync-helpers';
import { expect, test } from './fixtures';
import { BudgetPage } from './page-models/budget-page';

// CHE-1197: Monte Carlo on the accumulated candidate, on the real two-client /
// disposable-sync-server design. Client A writes widgets, rates and an account
// deletion; client B reads. Mixed-currency linked pots (EUR, a custom unit and
// USD) must show their balances converted to Main, and a missing rate or a
// deleted linked account must show "Unavailable" - never zero - on the pot
// table, the page and the dashboard card. The simulation is seeded, so the
// same Main balances give identical results whether pots are linked or
// entered by hand: that pins the simulation semantics. No Monte Carlo VRT
// baseline exists; this uses browser assertions and saved screenshots only.
const observed: Record<string, unknown> = {};

const UNAVAILABLE =
  'Unavailable: a linked account balance cannot be converted to USD. Add an exchange rate in Settings or unlink the pot.';
const BASE = {
  currentAge: 60,
  targetAge: 70,
  simulationCount: 1000,
  spendingPhases: [{ id: 'phase-1', name: 'Phase 1', annualWithdrawal: 4500 }],
};

// Stored native balances: 80.00 EUR, 1,000 pt (scale 100), 350.00 USD.
const NATIVE = { euro: 8000, points: 100000, checking: 35000 };
const mainCents = (eur: number, points: number) => ({
  euro: Math.round(NATIVE.euro * eur),
  points: Math.round(NATIVE.points * points),
  checking: NATIVE.checking,
});
const dollars = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

const clean = (text: string) => text.replace(BIDI, '');

async function widgets(page: Page) {
  return page.evaluate(async () => {
    const w = window as unknown as TestWindow;
    return (await w.$query(w.$q('dashboard').select(['id', 'type', 'meta'])))
      .data as Array<{ id: string; type: string; meta: Json }>;
  });
}

// Results block of the page (success, medians, depletion) as one string.
async function readResults(page: Page) {
  await expect
    .poll(async () => pageText(page), { timeout: 60_000 })
    .toContain('SUCCESS RATE');
  const text = clean(await pageText(page));
  const from = text.indexOf('SUCCESS RATE');
  return text.slice(from, text.indexOf(' | Portfolio performance', from));
}

// Starting balance cell of every pot: a $ amount, or "Unavailable".
async function readPots(page: Page) {
  await page.getByText('Investment pots', { exact: true }).first().click();
  await expect(page.getByText('Pot name')).toBeVisible();
  const cells = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input')).map(input => ({
      label: input.getAttribute('aria-label') ?? '',
      value: input.value,
    })),
  );
  const pots: Record<string, string> = {};
  let name = '';
  for (const [i, cell] of cells.entries()) {
    const value = clean(cell.value);
    if (cell.label || cell.value === 'on') {
      continue;
    }
    if (value.startsWith('$')) {
      pots[name] = value;
    } else {
      name = value;
      pots[name] = cells[i + 1]?.label ? 'Unavailable' : '?';
    }
  }
  return pots;
}

test.describe('Monte Carlo linked pots across two clients', () => {
  test.skip(!SERVER_URL, 'needs E2E_SYNC_SERVER_URL (disposable server)');
  test.use({ actionTimeout: 20_000 });

  test('mixed-currency pots convert to Main and report unavailable, never zero', async ({
    browser,
  }) => {
    test.setTimeout(900_000);
    observed.run = runSelfDescription(['currency-sync-monte-carlo.test.ts']);
    const c = await bootTwoClients(browser, {
      flags: { 'flags.monteCarloReport': 'true' },
    });
    const { a: author, b: reader, fixture } = c;
    const id: Record<string, string> = {};

    const linkedPots = [
      { id: 'pot-eur', name: 'Euro pot', accountId: fixture.euro },
      { id: 'pot-pts', name: 'Points pot', accountId: fixture.points },
      { id: 'pot-chk', name: 'Checking pot', accountId: fixture.checking },
    ];
    const twinPots = (eur: number, points: number) => {
      const cents = mainCents(eur, points);
      return [
        { id: 'pot-eur', name: 'Euro pot', startingBalance: cents.euro },
        { id: 'pot-pts', name: 'Points pot', startingBalance: cents.points },
        {
          id: 'pot-chk',
          name: 'Checking pot',
          startingBalance: cents.checking,
        },
      ];
    };

    // The widget list is cached per page load: a reload picks up edits that
    // arrived over sync.
    async function reloadReader() {
      await open(reader, '/budget');
      await reader.reload();
      await new BudgetPage(reader).waitFor({ timeout: 90_000 });
    }

    async function openPage(widgetId: string) {
      await open(reader, `/reports/monte-carlo/${widgetId}`);
      await expect
        .poll(async () => pageText(reader), { timeout: 60_000 })
        .toContain('Configuration');
    }

    // The dashboard card of one widget: a success percentage, or the notice.
    async function readCard(name: string) {
      await reloadReader();
      await open(reader, `/reports/${fixture.dashboardId}`);
      // Cards far below the fold are not rendered until scrolled into view.
      await expect
        .poll(
          async () => {
            await reader.evaluate(() =>
              document.querySelectorAll('div').forEach(el => {
                if (el.scrollHeight > el.clientHeight + 50) {
                  el.scrollTop = el.scrollHeight;
                }
              }),
            );
            await reader.waitForTimeout(300);
            return clean(await pageText(reader));
          },
          { timeout: 60_000 },
        )
        .toContain(name);
      const text = clean(await pageText(reader));
      return text.slice(text.indexOf(name), text.indexOf(name) + 260);
    }

    async function persisted(widgetId: string) {
      const rows = await widgets(reader);
      return rows.find(row => row.id === widgetId)?.meta as Json;
    }

    try {
      await savePrefs(author, {
        'manualRate.EUR.USD': '1.1',
        'customUnit.X-POINTS': JSON.stringify({
          name: 'Points',
          symbol: 'pt',
          decimals: 0,
        }),
        'manualRate.X-POINTS.USD': '0.01',
      });
      const add = (meta: Json) =>
        send(author, 'dashboard-add-widget', {
          type: 'monte-carlo-card',
          width: 4,
          height: 2,
          meta,
          dashboard_page_id: fixture.dashboardId,
        });
      await add({
        ...BASE,
        name: 'MC linked',
        pots: linkedPots.map(p => ({
          ...p,
          startingBalance:
            NATIVE[
              p.id === 'pot-eur'
                ? 'euro'
                : p.id === 'pot-pts'
                  ? 'points'
                  : 'checking'
            ],
        })),
      });
      await add({ ...BASE, name: 'MC manual', pots: twinPots(1.1, 0.01) });
      await add({
        ...BASE,
        name: 'MC usd only',
        pots: [
          {
            id: 'pot-chk',
            name: 'Checking pot',
            startingBalance: NATIVE.checking,
            accountId: fixture.checking,
          },
        ],
      });
      await sync(author);
      await sync(reader);
      for (const row of await widgets(reader)) {
        if (row.type === 'monte-carlo-card') {
          id[String((row.meta as Json).name)] = row.id;
        }
      }
      expect(Object.keys(id).sort()).toEqual([
        'MC linked',
        'MC manual',
        'MC usd only',
      ]);

      // A state: pot table, page results and card, for linked, twin, USD.
      async function expectState(
        label: string,
        eur: number,
        points: number,
        usdOnly: { results?: string },
      ) {
        const cents = mainCents(eur, points);
        await openPage(id['MC linked']);
        const pots = await readPots(reader);
        expect(pots, `${label}: linked pot balances`).toEqual({
          'Euro pot': dollars(cents.euro),
          'Points pot': dollars(cents.points),
          'Checking pot': dollars(cents.checking),
        });
        const linked = await readResults(reader);
        await shoot(reader, `${label}-linked-page`);

        await openPage(id['MC manual']);
        const manualPots = await readPots(reader);
        expect(manualPots, `${label}: manual pot balances`).toEqual(pots);
        const manual = await readResults(reader);
        // Seeded simulation: Main-equivalent balances give identical results.
        expect(linked, `${label}: linked == manual Main equivalent`).toBe(
          manual,
        );
        expect(linked).toMatch(/SUCCESS RATE \| \d+(\.\d)?% \| MEDIAN ENDING/);

        await openPage(id['MC usd only']);
        const only = await readResults(reader);
        if (usdOnly.results) {
          expect(only, `${label}: Main-only pot unchanged`).toBe(
            usdOnly.results,
          );
        }
        const percent = /SUCCESS RATE \| (\d+(?:\.\d)?%)/.exec(linked)?.[1];
        const card = await readCard('MC linked');
        expect(card, `${label}: card`).toContain(
          `${percent} | Success rate to age 70`,
        );
        observed[label] = { pots, linked, manual, only, card };
        return only;
      }

      const s1 = await expectState('step1-eur-1.1', 1.1, 0.01, {});

      // Saved native configuration: Save widget keeps native balances; a rate
      // edit never rewrites them.
      await openPage(id['MC linked']);
      await reader.getByRole('button', { name: 'Save widget' }).click();
      await expect(
        reader.getByText('Dashboard widget successfully saved.'),
      ).toBeVisible();
      await sync(reader);
      await sync(author);
      const saved = await persisted(id['MC linked']);
      const savedPots = (saved.pots as Array<Json>).map(p => [
        p.id,
        p.startingBalance,
        p.accountId,
      ]);
      expect(savedPots).toEqual([
        ['pot-eur', NATIVE.euro, fixture.euro],
        ['pot-pts', NATIVE.points, fixture.points],
        ['pot-chk', NATIVE.checking, fixture.checking],
      ]);
      expect(saved).toMatchObject(BASE);
      observed.savedNative = saved;

      // Step 2: a rate update on A. Twin balances follow the new Main values.
      await savePrefs(author, {
        'manualRate.EUR.USD': '1.25',
        'manualRate.X-POINTS.USD': '0.02',
      });
      await send(author, 'dashboard-update-widget', {
        id: id['MC manual'],
        meta: { ...BASE, name: 'MC manual', pots: twinPots(1.25, 0.02) },
      });
      await sync(author);
      await sync(reader);
      await reloadReader();
      expect(
        await persisted(id['MC linked']),
        'native config after rate edit',
      ).toEqual(saved);
      await expectState('step2-eur-1.25', 1.25, 0.02, { results: s1 });
      await openPage(id['MC linked']);
      await reader.getByRole('button', { name: 'Save widget' }).click();
      await expect(
        reader.getByText('Dashboard widget successfully saved.'),
      ).toBeVisible();
      await sync(reader);
      expect(
        await persisted(id['MC linked']),
        'native config after re-save',
      ).toEqual(saved);

      // Step 3: EUR rate removed. Euro pot, page and card are unavailable;
      // the other pots still convert; the USD-only widget is untouched.
      await savePrefs(reader, { 'manualRate.EUR.USD': '' });
      await sync(reader);
      await sync(author);
      await openPage(id['MC linked']);
      const removedPots = await readPots(reader);
      expect(removedPots).toEqual({
        'Euro pot': 'Unavailable',
        'Points pot': dollars(mainCents(1.25, 0.02).points),
        'Checking pot': '$350.00',
      });
      await expect
        .poll(async () => clean(await pageText(reader)))
        .toContain(UNAVAILABLE);
      expect(clean(await pageText(reader))).not.toContain('SUCCESS RATE');
      await shoot(reader, 'step3-removed-page');
      expect(await readCard('MC linked')).toContain(UNAVAILABLE);
      await openPage(id['MC usd only']);
      expect(await readResults(reader)).toBe(s1);
      observed['step3-eur-removed'] = { pots: removedPots };

      // Step 4: EUR back at 1.2, then the linked Loyalty points account is
      // deleted on A. Only that pot is unavailable.
      await savePrefs(author, { 'manualRate.EUR.USD': '1.2' });
      await send(author, 'account-close', {
        id: fixture.points,
        forced: true,
      });
      await sync(author);
      await sync(reader);
      await openPage(id['MC linked']);
      const deletedPots = await readPots(reader);
      expect(deletedPots).toEqual({
        'Euro pot': dollars(mainCents(1.2, 0.02).euro),
        'Points pot': 'Unavailable',
        'Checking pot': '$350.00',
      });
      const text = clean(await pageText(reader));
      expect(text).toContain(UNAVAILABLE);
      expect(text).toContain('Unavailable account');
      expect(text).not.toContain('SUCCESS RATE');
      await shoot(reader, 'step4-deleted-account-page');
      expect(await readCard('MC linked')).toContain(UNAVAILABLE);
      // The stored link and native balance are kept, not zeroed or rewritten.
      expect(await persisted(id['MC linked'])).toEqual(saved);
      await openPage(id['MC usd only']);
      expect(await readResults(reader)).toBe(s1);
      observed['step4-deleted-account'] = { pots: deletedPots };

      expect(c.rateRequests).toEqual([]);
    } finally {
      observed.rateRequests = c.rateRequests;
      writeObserved('observed-monte-carlo.json', observed);
      await c.close();
    }
  });
});
