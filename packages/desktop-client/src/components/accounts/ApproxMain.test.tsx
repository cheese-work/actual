import React from 'react';

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TestProviders } from '#mocks';

import { ApproxMain } from './ApproxMain';

const mocks = vi.hoisted(() => ({ prefs: {} as Record<string, string> }));

vi.mock('#hooks/useSyncedPref', () => ({
  useSyncedPref: (key: string) => [mocks.prefs[key], vi.fn()],
}));
vi.mock('#hooks/useSyncedPrefs', () => ({
  useSyncedPrefs: () => [mocks.prefs, vi.fn()],
}));

function renderApprox(value: number, currency: string | null) {
  return render(<ApproxMain value={value} currency={currency} />, {
    wrapper: TestProviders,
  });
}

describe('ApproxMain', () => {
  beforeEach(() => {
    mocks.prefs = {
      defaultCurrencyCode: 'VND',
      numberFormat: 'comma-dot',
      currencySymbolPosition: 'after',
      'manualRate.USD.VND': '30000',
      'customUnit.X-BANANA': '{"name":"Banana","symbol":"🍌","decimals":0}',
      'manualRate.X-BANANA.VND': '5000',
    };
  });

  it('shows the main-currency value of a USD account', () => {
    renderApprox(40000, 'USD'); // $400.00 stored
    expect(screen.getByText(/~.*12,000,000.*₫/)).toBeInTheDocument();
  });

  it('shows the main-currency value of a custom-unit account', () => {
    renderApprox(1000, 'X-BANANA'); // 10 bananas stored
    expect(screen.getByText(/~.*50,000.*₫/)).toBeInTheDocument();
  });

  it('shows a no-rate hint and no number when the rate is missing', () => {
    renderApprox(40000, 'EUR');
    expect(screen.getByText('no rate')).toBeInTheDocument();
    expect(screen.queryByText(/~/)).not.toBeInTheDocument();
  });

  it('renders nothing for a main-currency account', () => {
    const { container } = renderApprox(40000, 'VND');
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for an account without its own currency', () => {
    const { container } = renderApprox(40000, null);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when no Main currency is set', () => {
    mocks.prefs = {};
    const { container } = renderApprox(40000, 'USD');
    expect(container).toBeEmptyDOMElement();
  });
});
