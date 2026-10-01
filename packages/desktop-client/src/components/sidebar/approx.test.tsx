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
import { SidebarBalance } from './redesign/SidebarBalance';

const mocks = vi.hoisted(() => ({
  prefs: {
    defaultCurrencyCode: 'VND',
    numberFormat: 'comma-dot',
    currencySymbolPosition: 'after',
    'manualRate.USD.VND': '25400',
  } as Record<string, string>,
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

describe('approximate Main-currency value in both sidebars', () => {
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
});
