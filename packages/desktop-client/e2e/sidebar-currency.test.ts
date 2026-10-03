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
  test('shows the adjustment at the matching subtotal in both layouts', async ({
    browser,
  }) => {
    const page = await browser.newPage();
    const configurationPage = new ConfigurationPage(page);

    try {
      await page.goto('/');
      await configurationPage.startFresh();
      await saveSyncedPrefs(page, {
        defaultCurrencyCode: 'VND',
        currencySetupFinalized: 'true',
        'manualRate.USD.VND': '40',
      });

      const groupId = await page.evaluate(async () => {
        const send = (window as TestWindow).$send;
        const leftId = (await send('account-create', {
          name: 'USD residual left',
          balance: 0.01,
          offBudget: true,
          currency: 'USD',
        })) as string;
        const rightId = (await send('account-create', {
          name: 'USD residual right',
          balance: 0.01,
          offBudget: true,
          currency: 'USD',
        })) as string;
        const id = (await send('account-group-create', {
          name: 'USD residual group',
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
        return id;
      });
      await page.reload();

      await saveSyncedPrefs(page, { 'flags.newSidebarUI': 'false' });
      const legacyAdjustment = page.getByTestId(
        'sidebar-off-budget-balance-adjustment',
      );
      const legacyAdjustmentValue = page.getByTestId(
        'sidebar-off-budget-balance-adjustment-value',
      );
      await expect(legacyAdjustment).toContainText('Rounding adjustment');
      await expect(legacyAdjustmentValue).toContainText('+');
      await expect(legacyAdjustmentValue).toContainText('1');
      await expect(
        page.getByTestId('sidebar-account-group-' + groupId + '-balance'),
      ).toHaveCount(0);

      await saveSyncedPrefs(page, { 'flags.newSidebarUI': 'true' });
      const groupAdjustment = page.getByTestId(
        `sidebar-account-group-${groupId}-balance-adjustment`,
      );
      const groupAdjustmentValue = page.getByTestId(
        `sidebar-account-group-${groupId}-balance-adjustment-value`,
      );
      await expect(groupAdjustment).toContainText('Rounding adjustment');
      await expect(groupAdjustmentValue).toContainText('+');
      await expect(groupAdjustmentValue).toContainText('1');
      await expect(
        page.getByTestId('sidebar-off-budget-balance-adjustment'),
      ).toHaveCount(0);
    } finally {
      await page.close();
    }
  });
});
