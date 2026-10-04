import { expect, test } from './fixtures';
import { ConfigurationPage } from './page-models/configuration-page';

test.describe('sidebar keyboard drag with a rounding adjustment', () => {
  test('drops an account after the last account of a group', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const page = await browser.newPage();
    const configurationPage = new ConfigurationPage(page);

    try {
      await page.goto('/');
      await configurationPage.startFresh();
      await page.goto('/accounts');
      await page.waitForFunction(() => {
        const state = window.__TANSTACK_QUERY_CLIENT__.getQueryState([
          'accounts',
          'lists',
        ]);
        return state?.status === 'success' && Array.isArray(state.data);
      });
      // 0.01 USD at a rate of 50 rounds to 0 VND, so the group shows an adjustment row.
      await page.evaluate(async () => {
        await window.__actionsForMenu.saveSyncedPrefs({
          prefs: {
            defaultCurrencyCode: 'VND',
            currencySetupFinalized: 'true',
            'manualRate.USD.VND': '50',
            'flags.newSidebarUI': 'true',
          },
        });
      });
      const { groupId, movedId } = await page.evaluate(async () => {
        const send = window.$send;
        const create = async (name: string) =>
          (await send('account-create', {
            name,
            balance: 0.01,
            offBudget: true,
            currency: 'USD',
          })) as string;
        const firstId = await create('Group one');
        const secondId = await create('Group two');
        const movedId = await create('Moved');
        const groupId = (await send('account-group-create', {
          name: 'Group',
        })) as string;
        await send('account-move', {
          id: firstId,
          targetId: null,
          accountGroupId: groupId,
        });
        await send('account-move', {
          id: secondId,
          targetId: firstId,
          accountGroupId: groupId,
        });
        return { groupId, movedId };
      });
      await page.reload();

      const tree = page.getByRole('treegrid', { name: 'Off budget' });
      await expect(
        page.getByTestId(`sidebar-account-group-${groupId}-balance-adjustment`),
      ).toBeVisible();

      // Keyboard drag: first stop is the Moved row itself, second is the slot
      // right above the adjustment row, i.e. after the group's last account.
      await tree
        .getByRole('row')
        .filter({ hasText: 'Moved' })
        .getByRole('button')
        .first()
        .focus();
      await page.keyboard.press('Enter');
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('Enter');

      await expect
        .poll(() =>
          page.evaluate(
            async ({ movedId, groupId }) => {
              const accounts = (await window.$send('accounts-get')) as Array<{
                id: string;
                account_group_id: string | null;
                sort_order: number;
              }>;
              const moved = accounts.find(a => a.id === movedId);
              const others = accounts.filter(
                a => a.account_group_id === groupId && a.id !== movedId,
              );
              return (
                moved?.account_group_id === groupId &&
                others.length === 2 &&
                others.every(a => moved.sort_order > a.sort_order)
              );
            },
            { movedId, groupId },
          ),
        )
        .toBe(true);
    } finally {
      await page.close();
    }
  });
});
