import React from 'react';

import { generateAccount } from '@actual-app/core/mocks';
import { render, screen } from '@testing-library/react';

import { TestProviders } from '#mocks';

import { AccountCurrencyBalance } from './AccountCurrencyBalance';

const mocks = vi.hoisted(() => ({
  prefs: {} as Record<string, string>,
  balances: {} as Record<string, number | null>,
  privacyMode: false,
}));

vi.mock('#hooks/useSyncedPref', () => ({
  useSyncedPref: (key: string) => [mocks.prefs[key], vi.fn()],
}));
vi.mock('#hooks/useSyncedPrefs', () => ({
  useSyncedPrefs: () => [mocks.prefs, vi.fn()],
}));
vi.mock('#hooks/usePrivacyMode', () => ({
  usePrivacyMode: () => mocks.privacyMode,
}));
vi.mock('@actual-app/components/hooks/useResponsive', () => ({
  useResponsive: () => ({ isNarrowWidth: false }),
}));

function resetMocks() {
  mocks.prefs = {
    defaultCurrencyCode: 'VND',
    numberFormat: 'comma-dot',
    currencySymbolPosition: 'after',
    'manualRate.USD.VND': '25400',
  };
  mocks.balances = {};
  mocks.privacyMode = false;
}

function makeAccount(name: string, currency: string) {
  return { ...generateAccount(name), currency };
}

describe('AccountCurrencyBalance', () => {
  beforeEach(resetMocks);

  it('converts per-account balances before summing and marks FX totals approximate', () => {
    const usd = makeAccount('USD savings', 'USD');
    const vnd = makeAccount('VND cash', 'VND');
    mocks.balances = { [usd.id]: 40_000, [vnd.id]: 10_000 };

    render(
      <TestProviders>
        <AccountCurrencyBalance
          accounts={[usd, vnd]}
          balances={mocks.balances}
          testId="all-accounts-balance"
        />
      </TestProviders>,
    );

    expect(screen.getByTestId('all-accounts-balance')).toHaveTextContent('~');
    expect(screen.getByTestId('all-accounts-balance')).toHaveTextContent(
      '10,160,100',
    );
  });

  it('keeps Main-only totals exact and treats a loaded empty list as zero', () => {
    const vnd = makeAccount('VND cash', 'VND');
    mocks.balances = { [vnd.id]: 10_000 };
    const result = render(
      <TestProviders>
        <AccountCurrencyBalance
          accounts={[vnd]}
          balances={mocks.balances}
          testId="group-balance"
        />
      </TestProviders>,
    );

    expect(screen.getByTestId('group-balance')).toHaveTextContent('100');
    expect(screen.getByTestId('group-balance')).not.toHaveTextContent('~');

    result.rerender(
      <TestProviders>
        <AccountCurrencyBalance
          accounts={[]}
          balances={mocks.balances}
          testId="group-balance"
        />
      </TestProviders>,
    );

    expect(screen.getByTestId('group-balance')).toHaveTextContent('0');
  });

  it('keeps group totals independent and recalculates when membership changes', () => {
    const usd = makeAccount('USD savings', 'USD');
    const vnd = makeAccount('VND cash', 'VND');
    mocks.balances = { [usd.id]: 40_000, [vnd.id]: 10_000 };

    const result = render(
      <TestProviders>
        <AccountCurrencyBalance
          accounts={[usd]}
          balances={mocks.balances}
          testId="usd-group-balance"
        />
        <AccountCurrencyBalance
          accounts={[vnd]}
          balances={mocks.balances}
          testId="vnd-group-balance"
        />
      </TestProviders>,
    );

    expect(screen.getByTestId('usd-group-balance')).toHaveTextContent(
      '~ 10,160,000',
    );
    expect(screen.getByTestId('vnd-group-balance')).toHaveTextContent('100');
    expect(screen.getByTestId('vnd-group-balance')).not.toHaveTextContent('~');

    result.rerender(
      <TestProviders>
        <AccountCurrencyBalance
          accounts={[vnd]}
          balances={mocks.balances}
          testId="usd-group-balance"
        />
        <AccountCurrencyBalance
          accounts={[]}
          balances={mocks.balances}
          testId="vnd-group-balance"
        />
      </TestProviders>,
    );

    expect(screen.getByTestId('usd-group-balance')).toHaveTextContent('100');
    expect(screen.getByTestId('usd-group-balance')).not.toHaveTextContent('~');
    expect(screen.getByTestId('vnd-group-balance')).toHaveTextContent('0');
  });

  it('stays loading until every member balance is available', () => {
    const usd = makeAccount('USD savings', 'USD');

    render(
      <TestProviders>
        <AccountCurrencyBalance
          accounts={[usd]}
          balances={mocks.balances}
          testId="group-balance"
        />
      </TestProviders>,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Loading');
  });

  it('marks the entire total unavailable and names the currency without a rate', () => {
    const usd = makeAccount('USD savings', 'USD');
    const eur = makeAccount('EUR savings', 'EUR');
    mocks.balances = { [usd.id]: 40_000, [eur.id]: 20_000 };

    render(
      <TestProviders>
        <AccountCurrencyBalance
          accounts={[usd, eur]}
          balances={mocks.balances}
          testId="group-balance"
        />
      </TestProviders>,
    );

    expect(screen.getByTestId('group-balance')).toHaveTextContent('no rate');
    expect(screen.getByTestId('group-balance')).toHaveTextContent('EUR');
    expect(screen.getByTestId('group-balance')).not.toHaveTextContent(
      '10,160,000',
    );
  });

  it('recalculates on rate and Main-currency preference changes', () => {
    const usd = makeAccount('USD savings', 'USD');
    mocks.balances = { [usd.id]: 40_000 };
    const result = render(
      <TestProviders>
        <AccountCurrencyBalance
          accounts={[usd]}
          balances={mocks.balances}
          testId="all-balance"
        />
      </TestProviders>,
    );

    expect(screen.getByTestId('all-balance')).toHaveTextContent('10,160,000');

    mocks.prefs = { ...mocks.prefs, 'manualRate.USD.VND': '25000' };
    result.rerender(
      <TestProviders>
        <AccountCurrencyBalance
          accounts={[usd]}
          balances={mocks.balances}
          testId="all-balance"
        />
      </TestProviders>,
    );
    expect(screen.getByTestId('all-balance')).toHaveTextContent('10,000,000');

    mocks.prefs = { ...mocks.prefs, defaultCurrencyCode: 'USD' };
    result.rerender(
      <TestProviders>
        <AccountCurrencyBalance
          accounts={[usd]}
          balances={mocks.balances}
          testId="all-balance"
        />
      </TestProviders>,
    );
    expect(screen.getByTestId('all-balance')).not.toHaveTextContent('~');
    expect(screen.getByTestId('all-balance')).toHaveTextContent('400.00$');
  });

  it('respects privacy masking for converted financial values', () => {
    const usd = makeAccount('USD savings', 'USD');
    mocks.balances = { [usd.id]: 40_000 };
    mocks.privacyMode = true;

    const { container } = render(
      <TestProviders>
        <AccountCurrencyBalance
          accounts={[usd]}
          balances={mocks.balances}
          testId="private-balance"
        />
      </TestProviders>,
    );

    expect(container.querySelector('[aria-hidden="true"]')).toHaveTextContent(
      '**10*160*000*',
    );
  });
});
