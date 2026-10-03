import type { SyncedPrefs } from '@actual-app/core/types/prefs';
import type { Page } from '@playwright/test';

import { expect, test } from './fixtures';
import { ConfigurationPage } from './page-models/configuration-page';
import { MobileNavigation } from './page-models/mobile-navigation';

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

test.describe('Mobile Accounts', () => {
  let page: Page;
  let navigation: MobileNavigation;
  let configurationPage: ConfigurationPage;

  test.beforeEach(async ({ browser }) => {
    page = await browser.newPage();
    navigation = new MobileNavigation(page);
    configurationPage = new ConfigurationPage(page);

    await page.setViewportSize({
      width: 350,
      height: 600,
    });
    await page.goto('/');
    await configurationPage.createTestFile();
  });

  test.afterEach(async () => {
    await page?.close();
  });

  test('opens the accounts page and asserts on balances', async () => {
    const accountsPage = await navigation.goToAccountsPage();
    await accountsPage.waitFor();

    const account = await accountsPage.getNthAccount(1);

    await expect(account.name).toHaveText('Ally Savings');
    await expect(account.balance).toHaveText('7,653.00');
    await expect(page).toMatchThemeScreenshots();
  });

  test('shows loading while the account query is pending', async () => {
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
    await page.evaluate(() =>
      sessionStorage.setItem('holdAccountsRequests', 'true'),
    );

    await page.goto('/accounts');
    await page.waitForFunction(
      () => (window as TestWindow).__accountsRequestHeld,
    );
    try {
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
      await expect(page.getByTestId('mobile-accounts-loading')).toHaveText(
        'Loading...',
      );
    } finally {
      await page.evaluate(() => {
        sessionStorage.removeItem('holdAccountsRequests');
        (window as TestWindow).__releaseAccountsRequests();
      });
    }

    await expect(page.getByTestId('mobile-accounts-loading')).toHaveCount(0);
    await expect(page.getByLabel('Account list')).toBeVisible();
  });

  test('masks mobile aggregate balances when privacy mode is enabled', async () => {
    await configurationPage.initializeTestMainCurrency();
    const accountsPage = await navigation.goToAccountsPage();
    await accountsPage.waitFor();
    await saveSyncedPrefs(page, { isPrivacyEnabled: 'true' });

    const allAccountsBalance = page.getByTestId('mobile-account-total-all');
    const redactedBalance = allAccountsBalance.locator('[aria-hidden="true"]');
    await expect(redactedBalance).toBeVisible();
    await expect(redactedBalance).toContainText('*');
  });

  test('converts mobile All and Off budget register balances to Main', async ({
    browser,
  }) => {
    const freshPage = await browser.newPage();
    const freshConfigurationPage = new ConfigurationPage(freshPage);

    await freshPage.setViewportSize({ width: 350, height: 600 });
    await freshPage.goto('/');
    await freshConfigurationPage.startFresh();
    await saveSyncedPrefs(freshPage, {
      defaultCurrencyCode: 'VND',
      currencySetupFinalized: 'true',
      'manualRate.USD.VND': '25000',
    });
    await freshPage.evaluate(async () => {
      const send = (window as TestWindow).$send;
      await send('account-create', {
        name: 'USD off-budget',
        balance: 400,
        offBudget: true,
        currency: 'USD',
      });
      await send('account-create', {
        name: 'VND on-budget',
        balance: 1_000_000,
        offBudget: false,
        currency: 'VND',
      });
    });

    await freshPage.goto('/accounts');
    await waitForAccountsLoaded(freshPage);
    const allAccountsBalance = freshPage.getByTestId(
      'mobile-account-total-all',
    );
    const offBudgetBalance = freshPage.getByTestId(
      'mobile-account-total-offbudget',
    );
    await expect(allAccountsBalance).toContainText('11,000,000');
    await expect(allAccountsBalance).toContainText('~');
    await expect(offBudgetBalance).toContainText('10,000,000');
    await expect(offBudgetBalance).toContainText('~');

    await freshPage.goto('/accounts');
    await freshPage
      .getByRole('button', { name: 'View All accounts transactions' })
      .click();
    await expect(freshPage.getByTestId('transactions-balance')).toContainText(
      '11,000,000',
    );
    await freshPage.goto('/accounts');
    await freshPage
      .getByRole('button', { name: 'View Off budget transactions' })
      .click();
    await expect(freshPage.getByTestId('transactions-balance')).toContainText(
      '10,000,000',
    );
    await freshPage.close();
  });

  test('opens individual account page and checks that filtering is working', async () => {
    const accountsPage = await navigation.goToAccountsPage();
    await accountsPage.waitFor();

    const accountPage = await accountsPage.openNthAccount(0);
    await accountPage.waitFor();

    await expect(accountPage.heading).toHaveText('Bank of America');
    await expect(accountPage.transactionList).toBeVisible();
    expect(await accountPage.getBalance()).toBeGreaterThan(0);
    await expect(accountPage.noTransactionsMessage).not.toBeVisible();
    await expect(page).toMatchThemeScreenshots();

    await accountPage.searchByText('nothing should be found');
    await expect(accountPage.noTransactionsMessage).toBeVisible();
    await expect(accountPage.transactions).toHaveCount(0);
    await expect(page).toMatchThemeScreenshots();

    await accountPage.clearSearch();
    await expect(accountPage.transactions).not.toHaveCount(0);

    await accountPage.searchByText('Kroger');
    await expect(accountPage.transactions).not.toHaveCount(0);
    await expect(page).toMatchThemeScreenshots();
  });

  test('reconciles an account', async () => {
    const accountsPage = await navigation.goToAccountsPage();
    await accountsPage.waitFor();

    const accountPage = await accountsPage.openNthAccount(0);
    await accountPage.waitFor();

    await accountPage.startReconciliation('200.00');
    await expect(accountPage.reconcilingBannerDifference).toBeVisible();
    await expect(page).toMatchThemeScreenshots();

    await accountPage.createReconciliationTransaction();
    await expect(accountPage.reconcilingBannerAllReconciled).toBeVisible();
    await expect(page).toMatchThemeScreenshots();

    await accountPage.unclearFirstTransaction();
    await expect(accountPage.reconcilingBannerDifference).toBeVisible();

    await accountPage.clearFirstTransaction();
    await expect(accountPage.reconcilingBannerAllReconciled).toBeVisible();

    await accountPage.lockTransactions();
    await expect(accountPage.reconcilingBanner).not.toBeVisible();
  });
});
