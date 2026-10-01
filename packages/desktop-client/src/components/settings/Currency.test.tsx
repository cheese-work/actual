import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TestProviders } from '#mocks';

import { CurrencySettings } from './Currency';

const mocks = vi.hoisted(() => ({
  prefs: {
    defaultCurrencyCode: 'USD',
    numberFormat: 'comma-dot',
    'manualRate.USD.EUR': '0.9',
  } as Record<string, string>,
  save: vi.fn(),
}));

vi.mock('#hooks/useSyncedPref', () => ({
  useSyncedPref: (key: string) => [mocks.prefs[key], vi.fn()],
}));

vi.mock('#hooks/useSyncedPrefs', () => ({
  useSyncedPrefs: () => [mocks.prefs, mocks.save],
}));

describe('CurrencySettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('adds a validated custom unit to synced preferences', async () => {
    const user = userEvent.setup();
    render(<CurrencySettings />, { wrapper: TestProviders });

    await user.type(
      screen.getByRole('textbox', { name: 'Custom unit code' }),
      'banana',
    );
    await user.type(
      screen.getByRole('textbox', { name: 'Custom unit name' }),
      'Banana',
    );
    await user.type(
      screen.getByRole('textbox', { name: 'Custom unit symbol' }),
      '🍌',
    );
    await user.click(screen.getByRole('button', { name: 'Add custom unit' }));

    expect(mocks.save).toHaveBeenCalledWith({
      'customUnit.X-BANANA': JSON.stringify({
        name: 'Banana',
        symbol: '🍌',
        decimals: 2,
      }),
    });
  });

  it('saves a rate to the Main currency and clears its stale inverse', async () => {
    const user = userEvent.setup();
    render(<CurrencySettings />, { wrapper: TestProviders });

    await user.clear(screen.getByRole('textbox', { name: 'EUR to USD rate' }));
    await user.type(
      screen.getByRole('textbox', { name: 'EUR to USD rate' }),
      '1.08',
    );
    await user.click(screen.getByRole('button', { name: 'Save EUR rate' }));

    expect(mocks.save).toHaveBeenCalledWith({
      'manualRate.EUR.USD': '1.08',
      'manualRate.USD.EUR': '',
    });
  });

  it('rejects invalid rate input without saving it', async () => {
    const user = userEvent.setup();
    render(<CurrencySettings />, { wrapper: TestProviders });

    await user.clear(screen.getByRole('textbox', { name: 'EUR to USD rate' }));
    await user.type(
      screen.getByRole('textbox', { name: 'EUR to USD rate' }),
      '0',
    );
    await user.click(screen.getByRole('button', { name: 'Save EUR rate' }));

    expect(mocks.save).not.toHaveBeenCalled();
    expect(
      screen.getByText('Enter a positive rate using your number format.'),
    ).toBeInTheDocument();
  });
});
