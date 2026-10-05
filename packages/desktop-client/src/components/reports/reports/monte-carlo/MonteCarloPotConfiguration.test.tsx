import { GridList } from 'react-aria-components';

import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TestProviders } from '#mocks';

import { MonteCarloPotConfiguration } from './MonteCarloPotConfiguration';
import { createMonteCarloPot } from './monteCarloSimulation';
import type { MonteCarloPot } from './monteCarloSimulation';

const mocks = vi.hoisted(() => ({ accounts: [] as unknown[] }));

vi.mock('#hooks/useAccounts', () => ({
  useAccounts: () => ({
    data: mocks.accounts,
    isLoading: false,
    isPlaceholderData: false,
  }),
}));

// A native JPY balance of 1,000,000 that is worth 6,700.00 in Main
const NATIVE_BALANCE = 100_000_000;
const MAIN_BALANCE = 670_000;
const yenAccount = { id: 'jpy', name: 'Yen savings', closed: 0, offbudget: 0 };

function renderPot(
  pot: MonteCarloPot,
  displayBalance: number | null | undefined,
) {
  const onPotChange = vi.fn();
  render(
    <TestProviders>
      <GridList aria-label="Pots" items={[pot]}>
        {item => (
          <MonteCarloPotConfiguration
            pot={item}
            displayBalance={displayBalance}
            potLabel="Pot 1"
            canRemove
            usesHistoricalReturns={false}
            usesTaxBands={false}
            onPotChange={onPotChange}
            onRemove={vi.fn()}
          />
        )}
      </GridList>
    </TestProviders>,
  );
  return onPotChange;
}

const linkedPot = {
  ...createMonteCarloPot('p1'),
  accountId: 'jpy',
  startingBalance: NATIVE_BALANCE,
};

async function openLinkedAccountMenu() {
  await userEvent.click(screen.getByRole('button', { name: /Yen savings/ }));
  return screen.findByRole('menu');
}

describe('MonteCarloPotConfiguration linked balance in Main', () => {
  beforeEach(() => {
    mocks.accounts = [yenAccount];
  });

  it('carries the Main value over when a convertible pot is unlinked', async () => {
    const onPotChange = renderPot(linkedPot, MAIN_BALANCE);

    const menu = await openLinkedAccountMenu();
    await userEvent.click(within(menu).getByText('None'));

    expect(onPotChange).toHaveBeenCalledTimes(1);
    expect(onPotChange).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: null,
        startingBalance: MAIN_BALANCE,
      }),
    );
    expect(onPotChange.mock.calls[0][0].startingBalance).not.toBe(
      NATIVE_BALANCE,
    );
  });

  it('keeps the stored balance when unlinking with no Main currency', async () => {
    const onPotChange = renderPot(linkedPot, undefined);

    const menu = await openLinkedAccountMenu();
    await userEvent.click(within(menu).getByText('None'));

    expect(onPotChange).toHaveBeenCalledWith({ accountId: null });
  });

  it('shows Unavailable and offers no unlink while the balance cannot be valued', async () => {
    renderPot(linkedPot, null);

    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    const menu = await openLinkedAccountMenu();
    expect(within(menu).queryByText('None')).not.toBeInTheDocument();
    expect(within(menu).getByText('Yen savings')).toBeInTheDocument();
  });

  it('offers no unlink for a deleted linked account', async () => {
    mocks.accounts = [];
    renderPot(linkedPot, null);

    await userEvent.click(
      screen.getByRole('button', { name: /Unavailable account/ }),
    );
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByText('None')).not.toBeInTheDocument();
  });

  it('still lists None for a manual pot', async () => {
    renderPot(
      { ...createMonteCarloPot('p2'), startingBalance: 5000 },
      undefined,
    );

    await userEvent.click(screen.getByRole('button', { name: /None/ }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('None')).toBeInTheDocument();
  });
});
