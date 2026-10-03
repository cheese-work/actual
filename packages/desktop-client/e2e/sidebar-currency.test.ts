import type { SyncedPrefs } from '@actual-app/core/types/prefs';
import type { Page } from '@playwright/test';

import { expect, test } from './fixtures';
import { ConfigurationPage } from './page-models/configuration-page';

type TestWindow = Window & {
  __accountsRequestHeld: boolean;
  __releaseAccountsRequests: () => void;
  $send: (method: string, args?: Record<string, unknown>) => Promise<unknown>;
  __TANSTACK_QUERY_CLIENT__: {
    getQueryState: (queryKey: string[]) =>
      | {
          data: unknown;
          fetchStatus: string;
          status: string;
        }
      | undefined;
  };
  __actionsForMenu: {
    saveSyncedPrefs: (payload: { prefs: SyncedPrefs }) => Promise<unknown>;
  };
};

async function saveSyncedPrefs(page: Page, prefs: SyncedPrefs) {
  await page.evaluate(async values => {
    await (window as TestWindow).__actionsForMenu.saveSyncedPrefs({
      prefs: values,
    });
  }, prefs);
}

async function waitForAccountsLoaded(page: Page) {
  await page.waitForFunction(() => {
    const state = (
      window as TestWindow
    ).__TANSTACK_QUERY_CLIENT__.getQueryState(['accounts', 'lists']);
    return state?.status === 'success' && Array.isArray(state.data);
  });
}

async function holdAccountsRequest(page: Page) {
  await page.evaluate(() =>
    sessionStorage.setItem('holdAccountsRequests', 'true'),
  );
  await page.reload();
  await page.waitForFunction(
    () => (window as TestWindow).__accountsRequestHeld,
  );
}

async function releaseAccountsRequest(page: Page) {
  await page.evaluate(() => {
    sessionStorage.removeItem('holdAccountsRequests');
    (window as TestWindow).__releaseAccountsRequests();
  });
}

test.describe('sidebar aggregate query readiness', () => {
  test('shows loading for placeholder accounts in both layouts', async ({
    browser,
  }) => {
    const page = await browser.newPage();
    const configurationPage = new ConfigurationPage(page);

    await page.addInitScript(() => {
      const originalPostMessage = Worker.prototype.postMessage;
      const heldRequests: Array<() => void> = [];
      window.__accountsRequestHeld = false;
      window.__releaseAccountsRequests = () => {
        heldRequests.splice(0).forEach(release => release());
      };
      Worker.prototype.postMessage = function (
        this: Worker,
        message: unknown,
        ...transfer: unknown[]
      ) {
        if (
          sessionStorage.getItem('holdAccountsRequests') === 'true' &&
          typeof message === 'object' &&
          message !== null &&
          'name' in message &&
          message.name === 'accounts-get'
        ) {
          heldRequests.push(() =>
            Reflect.apply(originalPostMessage, this, [message, ...transfer]),
          );
          window.__accountsRequestHeld = true;
          return;
        }

        return Reflect.apply(originalPostMessage, this, [message, ...transfer]);
      } as typeof Worker.prototype.postMessage;
    });

    try {
      await page.goto('/');
      await configurationPage.createTestFile();
      await waitForAccountsLoaded(page);
      await configurationPage.initializeTestMainCurrency();

      for (const newSidebarUI of [false, true]) {
        await saveSyncedPrefs(page, {
          'flags.newSidebarUI': String(newSidebarUI),
        });
        await holdAccountsRequest(page);

        const queryState = await page.evaluate(() => {
          const state = (
            window as TestWindow
          ).__TANSTACK_QUERY_CLIENT__.getQueryState(['accounts', 'lists']);
          return {
            dataIsUndefined: state?.data === undefined,
            fetchStatus: state?.fetchStatus,
            status: state?.status,
          };
        });

        expect(queryState).toEqual({
          dataIsUndefined: true,
          fetchStatus: 'fetching',
          status: 'pending',
        });
        await expect(
          page.getByTestId('sidebar-all-accounts-balance'),
        ).toHaveText('Loading...');

        await releaseAccountsRequest(page);
        await waitForAccountsLoaded(page);
      }
    } finally {
      await page.close();
    }
  });

  test('shows zero after both layouts load a genuinely empty account list', async ({
    browser,
  }) => {
    const page = await browser.newPage();
    const configurationPage = new ConfigurationPage(page);

    try {
      await page.goto('/');
      await configurationPage.startFresh();
      await waitForAccountsLoaded(page);
      await configurationPage.initializeTestMainCurrency();

      for (const newSidebarUI of [false, true]) {
        await saveSyncedPrefs(page, {
          'flags.newSidebarUI': String(newSidebarUI),
        });
        await page.waitForFunction(() => {
          const state = (
            window as TestWindow
          ).__TANSTACK_QUERY_CLIENT__.getQueryState(['accounts', 'lists']);
          return (
            state?.status === 'success' &&
            Array.isArray(state.data) &&
            state.data.length === 0
          );
        });
        await expect(
          page.getByTestId('sidebar-all-accounts-balance'),
        ).toContainText('0.00');
      }
    } finally {
      await page.close();
    }
  });
});

test.describe('sidebar display rounding adjustments', () => {
  test('rounds native Main account rows at hidden-cents precision', async ({
    browser,
  }) => {
    test.setTimeout(120_000);

    for (const sign of [1, -1]) {
      const page = await browser.newPage();
      const configurationPage = new ConfigurationPage(page);
      const signLabel = sign > 0 ? 'positive' : 'negative';
      const signedDollar =
        sign > 0 ? /\+\p{Cf}*\$\p{Cf}*1/u : /-\p{Cf}*\$\p{Cf}*1/u;

      try {
        await page.goto('/');
        await configurationPage.startFresh();
        await page.goto('/accounts');
        await waitForAccountsLoaded(page);
        await configurationPage.initializeTestMainCurrency();
        await saveSyncedPrefs(page, {
          hideFraction: 'true',
        });

        const { groupId, leftId, rightId } = await page.evaluate(
          async ({ accountSign, signLabel }) => {
            const send = (window as TestWindow).$send;
            const leftId = (await send('account-create', {
              name: `USD ${signLabel} left`,
              balance: accountSign * 0.5,
              offBudget: true,
              currency: 'USD',
            })) as string;
            const rightId = (await send('account-create', {
              name: `USD ${signLabel} right`,
              balance: accountSign * 0.5,
              offBudget: true,
              currency: 'USD',
            })) as string;
            const groupId = (await send('account-group-create', {
              name: `USD ${signLabel} group`,
            })) as string;
            await send('account-move', {
              id: leftId,
              targetId: null,
              accountGroupId: groupId,
            });
            await send('account-move', {
              id: rightId,
              targetId: leftId,
              accountGroupId: groupId,
            });
            return { groupId, leftId, rightId };
          },
          { accountSign: sign, signLabel },
        );
        await page.reload();
        await waitForAccountsLoaded(page);
        const total = page.getByTestId('sidebar-off-budget-balance');
        const adjustment = page.getByTestId(
          'sidebar-off-budget-balance-adjustment',
        );
        const offBudgetTree = page.getByRole('treegrid', {
          name: 'Off budget',
        });

        for (const newSidebarUI of [false, true]) {
          await saveSyncedPrefs(page, {
            'flags.newSidebarUI': String(newSidebarUI),
          });
          await expect(offBudgetTree).toHaveCount(newSidebarUI ? 1 : 0);

          for (const accountId of [leftId, rightId]) {
            await expect(
              page.locator(`[data-cellname$="balance-${accountId}"]`),
            ).toHaveText(/^\p{Cf}*\$\p{Cf}*0\p{Cf}*$/u);
          }

          await expect(total).toContainText('1');
          if (sign < 0) {
            await expect(total).toContainText('-');
          }

          if (newSidebarUI) {
            const groupTotal = page.getByTestId(
              `sidebar-account-group-${groupId}-balance`,
            );
            const groupAdjustment = page.getByTestId(
              `sidebar-account-group-${groupId}-balance-adjustment`,
            );
            await expect(groupTotal).toContainText('1');
            await expect(groupAdjustment).toContainText(signedDollar);
            await expect(adjustment).toHaveCount(0);
          } else {
            await expect(adjustment).toContainText(signedDollar);
          }
        }

        await saveSyncedPrefs(page, { hideFraction: 'false' });
        await page.reload();
        await waitForAccountsLoaded(page);

        for (const newSidebarUI of [false, true]) {
          await saveSyncedPrefs(page, {
            'flags.newSidebarUI': String(newSidebarUI),
          });

          for (const accountId of [leftId, rightId]) {
            await expect(
              page.locator(`[data-cellname$="balance-${accountId}"]`),
            ).toContainText('0.50');
          }
          await expect(total).toContainText('1.00');
          await expect(adjustment).toHaveCount(0);

          if (newSidebarUI) {
            await expect(
              page.getByTestId(`sidebar-account-group-${groupId}-balance`),
            ).toContainText('1.00');
            await expect(
              page.getByTestId(
                `sidebar-account-group-${groupId}-balance-adjustment`,
              ),
            ).toHaveCount(0);
          }
        }
      } finally {
        await page.close();
      }
    }
  });

  test('shows the adjustment at the matching subtotal in both layouts', async ({
    browser,
  }) => {
    test.setTimeout(120_000);

    for (const sign of [1, -1]) {
      const page = await browser.newPage();
      const configurationPage = new ConfigurationPage(page);
      const signLabel = sign > 0 ? 'positive' : 'negative';

      try {
        await page.goto('/');
        await configurationPage.startFresh();
        await page.goto('/accounts');
        await waitForAccountsLoaded(page);
        await saveSyncedPrefs(page, {
          defaultCurrencyCode: 'VND',
          currencySetupFinalized: 'true',
          'manualRate.USD.VND': '50',
        });

        const { groupId, leftId, rightId } = await page.evaluate(
          async ({ accountSign, signLabel }) => {
            const send = (window as TestWindow).$send;
            const leftId = (await send('account-create', {
              name: `USD ${signLabel} left`,
              balance: accountSign * 0.01,
              offBudget: true,
              currency: 'USD',
            })) as string;
            const rightId = (await send('account-create', {
              name: `USD ${signLabel} right`,
              balance: accountSign * 0.01,
              offBudget: true,
              currency: 'USD',
            })) as string;
            const id = (await send('account-group-create', {
              name: `USD ${signLabel} group`,
            })) as string;
            await send('account-move', {
              id: leftId,
              targetId: null,
              accountGroupId: id,
            });
            await send('account-move', {
              id: rightId,
              targetId: leftId,
              accountGroupId: id,
            });
            return { groupId: id, leftId, rightId };
          },
          { accountSign: sign, signLabel },
        );
        await page.reload();
        await waitForAccountsLoaded(page);
        const offBudgetTree = page.getByRole('treegrid', {
          name: 'Off budget',
        });

        await saveSyncedPrefs(page, { 'flags.newSidebarUI': 'false' });
        await expect(offBudgetTree).toHaveCount(0);
        const legacyAdjustment = page.getByTestId(
          'sidebar-off-budget-balance-adjustment',
        );
        const legacyAdjustmentValue = page.getByTestId(
          'sidebar-off-budget-balance-adjustment-value',
        );
        await expect(legacyAdjustment).toContainText('Rounding adjustment');
        await expect(legacyAdjustmentValue).toContainText(sign > 0 ? '+' : '-');
        await expect(legacyAdjustmentValue).toContainText('1');
        const legacyBalance = page.getByTestId('sidebar-off-budget-balance');
        await expect(legacyBalance).toContainText('~');
        await expect(legacyBalance).toContainText('1');
        if (sign < 0) {
          await expect(legacyBalance).toContainText('-');
        }
        const legacyAdjustmentElement = await legacyAdjustment.elementHandle();
        expect(legacyAdjustmentElement).not.toBeNull();
        for (const [accountId, side] of [
          [leftId, 'left'],
          [rightId, 'right'],
        ] as const) {
          const child = page.locator(`[data-cellname$="balance-${accountId}"]`);
          await expect(child).toHaveCount(1);
          const childRow = page
            .getByRole('link')
            .filter({ hasText: `USD ${signLabel} ${side}` });
          await expect(childRow).toHaveCount(1);
          await expect(childRow.getByText(/~.*-?0/)).toHaveCount(1);
          expect(
            await child.evaluate(
              (childNode, adjustment) =>
                Boolean(
                  childNode.compareDocumentPosition(adjustment as Node) &
                  Node.DOCUMENT_POSITION_FOLLOWING,
                ),
              legacyAdjustmentElement,
            ),
          ).toBe(true);
        }

        await saveSyncedPrefs(page, { 'flags.newSidebarUI': 'true' });
        await expect(offBudgetTree).toHaveCount(1);
        const groupBalance = page.getByTestId(
          `sidebar-account-group-${groupId}-balance`,
        );
        const groupAdjustment = page.getByTestId(
          `sidebar-account-group-${groupId}-balance-adjustment`,
        );
        const groupAdjustmentValue = page.getByTestId(
          `sidebar-account-group-${groupId}-balance-adjustment-value`,
        );
        await expect(groupBalance).toContainText('~');
        await expect(groupBalance).toContainText('1');
        if (sign < 0) {
          await expect(groupBalance).toContainText('-');
        }
        await expect(groupAdjustment).toContainText('Rounding adjustment');
        await expect(groupAdjustmentValue).toContainText(sign > 0 ? '+' : '-');
        await expect(groupAdjustmentValue).toContainText('1');
        const groupAdjustmentElement = await groupAdjustment.elementHandle();
        expect(groupAdjustmentElement).not.toBeNull();
        for (const accountId of [leftId, rightId]) {
          const child = page.locator(`[data-cellname$="balance-${accountId}"]`);
          await expect(child).toHaveCount(1);
          expect(
            await child.evaluate(
              (childNode, adjustment) =>
                Boolean(
                  childNode.compareDocumentPosition(adjustment as Node) &
                  Node.DOCUMENT_POSITION_FOLLOWING,
                ),
              groupAdjustmentElement,
            ),
          ).toBe(true);
        }
        await expect(
          page.getByTestId('sidebar-off-budget-balance-adjustment'),
        ).toHaveCount(0);
      } finally {
        await page.close();
      }
    }
  });
});
