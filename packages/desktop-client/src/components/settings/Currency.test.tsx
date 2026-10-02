import { act, render, screen } from '@testing-library/react';
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
  fetchAutomaticRates: vi.fn<
    (
      sourceCodes: string[],
      mainCurrencyCode: string,
    ) => Promise<
      Array<{
        from: string;
        to: string;
        rate: string;
        fetchedAt: number;
      }>
    >
  >(),
}));

vi.mock('#hooks/useSyncedPref', () => ({
  useSyncedPref: (key: string) => [mocks.prefs[key], vi.fn()],
}));

vi.mock('#hooks/useSyncedPrefs', () => ({
  useSyncedPrefs: () => [mocks.prefs, mocks.save],
}));

vi.mock('@actual-app/core/shared/automatic-rates', async () => {
  const actual = await vi.importActual(
    '@actual-app/core/shared/automatic-rates',
  );
  return { ...actual, fetchAutomaticRates: mocks.fetchAutomaticRates };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('CurrencySettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prefs = {
      defaultCurrencyCode: 'USD',
      numberFormat: 'comma-dot',
      'manualRate.USD.EUR': '0.9',
    };
    mocks.fetchAutomaticRates.mockReset();
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

  it('lets a standard currency use automatic rates', async () => {
    const user = userEvent.setup();
    render(<CurrencySettings />, { wrapper: TestProviders });

    await user.click(screen.getByLabelText('EUR rate mode'));
    await user.click(await screen.findByRole('button', { name: 'Automatic' }));

    expect(mocks.save).toHaveBeenCalledWith({ 'rateMode.EUR': 'auto' });
  });

  it('keeps custom units manual and the crypto picker deferred', () => {
    mocks.prefs = {
      ...mocks.prefs,
      'customUnit.X-BANANA': JSON.stringify({
        name: 'Banana',
        symbol: '🍌',
        decimals: 2,
      }),
      'rateMode.USDT': 'auto',
    };
    render(<CurrencySettings />, { wrapper: TestProviders });

    expect(
      screen.queryByLabelText('X-BANANA rate mode'),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText('USDT rate mode')).not.toBeInTheDocument();
  });

  it('shows the cached rate and age when an on-demand refresh is offline', async () => {
    const fetchedAt = Date.now() - 60 * 60 * 1000;
    mocks.prefs = {
      ...mocks.prefs,
      'rateMode.EUR': 'auto',
      'autoRate.USD.EUR': JSON.stringify({ rate: '0.9', fetchedAt }),
    };
    mocks.fetchAutomaticRates.mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    render(<CurrencySettings />, { wrapper: TestProviders });

    expect(screen.getByText('1 EUR = 1.11111 USD')).toBeInTheDocument();
    expect(screen.getByText('Updated 1 hour ago')).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: 'Refresh EUR rate now' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not refresh the automatic rate. The cached rate is unchanged.',
    );
    expect(screen.getByText('1 EUR = 1.11111 USD')).toBeInTheDocument();
  });

  it('shows and refreshes the effective automatic mode after a Main flip', async () => {
    const fetchedAt = Date.now();
    mocks.prefs = {
      defaultCurrencyCode: 'EUR',
      numberFormat: 'comma-dot',
      'rateMode.EUR': 'auto',
      'autoRate.USD.EUR': JSON.stringify({ rate: '0.9', fetchedAt }),
    };
    mocks.fetchAutomaticRates.mockResolvedValue([
      { from: 'EUR', to: 'USD', rate: '1.25', fetchedAt },
    ]);
    const user = userEvent.setup();
    render(<CurrencySettings />, { wrapper: TestProviders });

    expect(screen.getByLabelText('USD rate mode')).toHaveTextContent(
      'Automatic',
    );
    expect(screen.getByText('1 USD = 0.9 EUR')).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: 'Refresh USD rate now' }),
    );

    expect(mocks.fetchAutomaticRates).toHaveBeenCalledWith(['USD'], 'EUR');
    expect(mocks.save).toHaveBeenCalledWith({
      'autoRate.EUR.USD': JSON.stringify({ rate: '1.25', fetchedAt }),
    });
  });

  it('keeps an explicit manual mode without a rate out of automatic UI', () => {
    mocks.prefs = {
      defaultCurrencyCode: 'EUR',
      numberFormat: 'comma-dot',
      'rateMode.EUR': 'auto',
      'rateMode.USD': 'manual',
      'autoRate.USD.EUR': JSON.stringify({
        rate: '0.9',
        fetchedAt: Date.now(),
      }),
    };
    render(<CurrencySettings />, { wrapper: TestProviders });

    expect(screen.getByLabelText('USD rate mode')).toHaveTextContent('Manual');
    expect(
      screen.queryByRole('button', { name: 'Refresh USD rate now' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('1 USD = 0.9 EUR')).not.toBeInTheDocument();
  });

  it('shows counterpart auto controls when Main retains a manual row mode', () => {
    const fetchedAt = Date.now();
    mocks.prefs = {
      defaultCurrencyCode: 'EUR',
      numberFormat: 'comma-dot',
      'rateMode.EUR': 'manual',
      'rateMode.USD': 'auto',
      'autoRate.EUR.USD': JSON.stringify({ rate: '1.25', fetchedAt }),
    };
    render(<CurrencySettings />, { wrapper: TestProviders });

    expect(screen.getByLabelText('USD rate mode')).toHaveTextContent(
      'Automatic',
    );
    expect(screen.getByText('1 USD = 0.8 EUR')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Refresh USD rate now' }),
    ).toBeInTheDocument();
  });

  it('saves an on-demand automatic rate in the synced cache', async () => {
    const fetchedAt = Date.now();
    mocks.prefs = { ...mocks.prefs, 'rateMode.EUR': 'auto' };
    mocks.fetchAutomaticRates.mockResolvedValue([
      { from: 'USD', to: 'EUR', rate: '0.91', fetchedAt },
    ]);
    const user = userEvent.setup();
    render(<CurrencySettings />, { wrapper: TestProviders });

    await user.click(
      screen.getByRole('button', { name: 'Refresh EUR rate now' }),
    );

    expect(mocks.fetchAutomaticRates).toHaveBeenCalledWith(['EUR'], 'USD');
    expect(mocks.save).toHaveBeenCalledWith({
      'autoRate.USD.EUR': JSON.stringify({ rate: '0.91', fetchedAt }),
    });
  });

  it('does not save an on-demand result after Main currency selection changes', async () => {
    const request =
      deferred<
        Array<{ from: string; to: string; rate: string; fetchedAt: number }>
      >();
    mocks.prefs = { ...mocks.prefs, 'rateMode.EUR': 'auto' };
    mocks.fetchAutomaticRates.mockReturnValue(request.promise);
    const user = userEvent.setup();
    const { rerender } = render(<CurrencySettings />, {
      wrapper: TestProviders,
    });

    await user.click(
      screen.getByRole('button', { name: 'Refresh EUR rate now' }),
    );
    mocks.prefs = { ...mocks.prefs, defaultCurrencyCode: 'GBP' };
    rerender(<CurrencySettings />);

    await act(async () => {
      request.resolve([
        { from: 'USD', to: 'EUR', rate: '0.91', fetchedAt: Date.now() },
      ]);
      await request.promise;
    });

    expect(mocks.save).not.toHaveBeenCalledWith({
      'autoRate.USD.EUR': expect.any(String),
    });
  });

  it('explains when a saved manual rate overrides automatic mode', () => {
    mocks.prefs = {
      ...mocks.prefs,
      'rateMode.EUR': 'auto',
      'manualRate.EUR.USD': '1.2',
    };
    render(<CurrencySettings />, { wrapper: TestProviders });

    expect(
      screen.getByText(
        'The manual rate takes precedence over the automatic rate.',
      ),
    ).toBeInTheDocument();
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

  it('discards an unsaved rate when the Main currency changes', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<CurrencySettings />, {
      wrapper: TestProviders,
    });

    await user.type(
      screen.getByRole('textbox', { name: 'JPY to USD rate' }),
      '1.08',
    );

    mocks.prefs = { ...mocks.prefs, defaultCurrencyCode: 'GBP' };
    rerender(<CurrencySettings />);

    const changedPairInput = screen.getByRole('textbox', {
      name: 'JPY to GBP rate',
    });
    expect(changedPairInput).toHaveValue('');

    await user.click(screen.getByRole('button', { name: 'Save JPY rate' }));
    expect(mocks.save).not.toHaveBeenCalledWith(
      expect.objectContaining({ 'manualRate.JPY.GBP': '1.08' }),
    );
  });

  it('does not persist the rounded display value for an untouched inverse rate', async () => {
    mocks.prefs['manualRate.USD.EUR'] = '3';
    const user = userEvent.setup();
    render(<CurrencySettings />, { wrapper: TestProviders });

    expect(
      screen.getByRole('textbox', { name: 'EUR to USD rate' }),
    ).toHaveValue('0.333333');
    await user.click(screen.getByRole('button', { name: 'Save EUR rate' }));

    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.prefs['manualRate.USD.EUR']).toBe('3');
  });

  it('does not announce a custom unit error before the form is touched', () => {
    render(<CurrencySettings />, { wrapper: TestProviders });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows custom unit validation after the form is touched', async () => {
    const user = userEvent.setup();
    render(<CurrencySettings />, { wrapper: TestProviders });

    await user.type(
      screen.getByRole('textbox', { name: 'Custom unit code' }),
      '!!!',
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Use 1–10 letters or digits for the code.',
    );
  });
});
