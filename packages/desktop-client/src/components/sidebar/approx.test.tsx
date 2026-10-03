import React from 'react';
import type { ReactNode } from 'react';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { MemoryRouter } from 'react-router';

import { generateAccount } from '@actual-app/core/mocks';
import { render, screen } from '@testing-library/react';

import { TestProviders } from '#mocks';
import * as bindings from '#spreadsheet/bindings';

import { Account } from './Account';
import { useAccountCurrencyAggregation } from './AccountCurrencyBalance';
import { SidebarBalance } from './redesign/SidebarBalance';

const mocks = vi.hoisted(() => ({
  prefs: {
    defaultCurrencyCode: 'VND',
    numberFormat: 'comma-dot',
    currencySymbolPosition: 'after',
    'manualRate.USD.VND': '25400',
  } as Record<string, string>,
  balances: {} as Record<string, number | null>,
}));

vi.mock('#hooks/useSyncedPref', () => ({
  useSyncedPref: (key: string) => [mocks.prefs[key], vi.fn()],
}));
vi.mock('#hooks/useSyncedPrefs', () => ({
  useSyncedPrefs: () => [mocks.prefs, vi.fn()],
}));
vi.mock('#hooks/useSheetValue', () => ({
  useSheetValue: () => 40000, // $400.00 stored
}));
vi.mock('#hooks/useSheetName', () => ({
  useSheetName: () => ({ fullSheetName: 'test-cell' }),
}));
vi.mock('#hooks/useNotes', () => ({ useNotes: () => null }));

window.matchMedia = (query: string): MediaQueryList => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: vi.fn(),
  removeListener: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  dispatchEvent: vi.fn(() => false),
});

const account = { ...generateAccount('USD savings'), currency: 'USD' };

function renderRow(row: ReactNode) {
  return render(
    <TestProviders>
      <MemoryRouter>
        <DndProvider backend={HTML5Backend}>{row}</DndProvider>
      </MemoryRouter>
    </TestProviders>,
  );
}

function AggregateBalance({
  layout,
  testId,
}: {
  layout: 'legacy' | 'redesigned';
  testId: string;
}) {
  const aggregation = useAccountCurrencyAggregation([account], mocks.balances);

  return layout === 'legacy' ? (
    <Account
      name="All accounts"
      to="/accounts"
      query={bindings.allAccountBalance()}
      currencyAggregation={aggregation}
      balanceTestId={testId}
    />
  ) : (
    <SidebarBalance
      binding={bindings.allAccountBalance()}
      aggregation={aggregation}
      testId={testId}
    />
  );
}

describe('approximate Main-currency value in both sidebars', () => {
  beforeEach(() => {
    mocks.balances = {};
    mocks.prefs = {
      defaultCurrencyCode: 'VND',
      numberFormat: 'comma-dot',
      currencySymbolPosition: 'after',
      'manualRate.USD.VND': '25400',
    };
  });

  it('shows it in the legacy sidebar row', () => {
    renderRow(
      <Account
        name={account.name}
        account={account}
        to="/accounts/1"
        query={bindings.accountBalance(account.id)}
      />,
    );
    expect(screen.getByText(/~.*10,160,000.*₫/)).toBeInTheDocument();
  });

  it('shows it in the redesigned sidebar row', () => {
    renderRow(
      <SidebarBalance
        binding={bindings.accountBalance(account.id)}
        currency="USD"
        approxCurrency="USD"
      />,
    );
    expect(screen.getByText(/~.*10,160,000.*₫/)).toBeInTheDocument();
  });

  it('shows the no-rate hint in the redesigned sidebar row', () => {
    renderRow(
      <SidebarBalance
        binding={bindings.accountBalance(account.id)}
        currency="EUR"
        approxCurrency="EUR"
      />,
    );
    expect(screen.getByText('(no rate)')).toBeInTheDocument();
  });

  it('adds nothing to aggregate rows', () => {
    renderRow(<SidebarBalance binding={bindings.accountBalance(account.id)} />);
    expect(screen.queryByText(/~|no rate/)).not.toBeInTheDocument();
  });

  it('converts legacy aggregate rows from member account balances', () => {
    mocks.balances = { [account.id]: 40_000 };
    renderRow(
      <AggregateBalance layout="legacy" testId="legacy-aggregate-balance" />,
    );

    expect(screen.getByTestId('legacy-aggregate-balance')).toHaveTextContent(
      '~ 10,160,000',
    );
  });

  it('converts redesigned aggregate rows from member account balances', () => {
    mocks.balances = { [account.id]: 40_000 };
    renderRow(
      <AggregateBalance
        layout="redesigned"
        testId="redesigned-aggregate-balance"
      />,
    );

    expect(
      screen.getByTestId('redesigned-aggregate-balance'),
    ).toHaveTextContent('~ 10,160,000');
  });

  it('keeps an account native balance visible when its aggregate rate is missing', () => {
    delete mocks.prefs['manualRate.USD.VND'];
    mocks.balances = { [account.id]: 40_000 };

    renderRow(
      <>
        <AggregateBalance layout="legacy" testId="unavailable-total" />
        <Account
          name={account.name}
          account={account}
          to={`/accounts/${account.id}`}
          query={bindings.accountBalance(account.id)}
        />
      </>,
    );

    expect(screen.getByTestId('unavailable-total')).toHaveTextContent('USD');
    expect(screen.getByText(/400\.00/)).toBeInTheDocument();
  });
});
