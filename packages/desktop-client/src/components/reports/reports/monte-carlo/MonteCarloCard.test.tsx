import { MemoryRouter } from 'react-router';

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TestProviders } from '#mocks';

import { MonteCarloCard } from './MonteCarloCard';
import type { MonteCarloMainConversion } from './monteCarloCurrency';

const mocks = vi.hoisted(() => ({
  main: { status: 'loading', config: null, linkedBalances: {} } as unknown,
}));

vi.mock('./useResolvedMonteCarloConfig', () => ({
  useResolvedMonteCarloConfig: () => ({ main: mocks.main }),
}));
vi.mock('#hooks/useSyncedPrefs', () => ({
  useSyncedPrefs: () => [{ defaultCurrencyCode: 'USD' }],
}));
vi.mock('@actual-app/components/hooks/useResponsive', () => ({
  useResponsive: () => ({ isNarrowWidth: false }),
}));

function setConversion(main: MonteCarloMainConversion) {
  mocks.main = main;
}

function renderCard() {
  render(
    <TestProviders>
      <MemoryRouter>
        <MonteCarloCard widgetId="w1" meta={{}} onMetaChange={vi.fn()} />
      </MemoryRouter>
    </TestProviders>,
  );
}

describe('MonteCarloCard', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(
          private callback: (entries: { isIntersecting: boolean }[]) => void,
        ) {}
        // The card only renders its body once it is in view
        observe() {
          this.callback([{ isIntersecting: true }]);
        }
        unobserve = vi.fn();
        disconnect = vi.fn();
      },
    );
    setConversion({ status: 'loading', config: null, linkedBalances: {} });
  });

  it('shows the unavailable notice, not a result, when a linked pot cannot be valued', () => {
    setConversion({
      status: 'unavailable',
      config: null,
      linkedBalances: { p1: null },
    });
    renderCard();

    expect(screen.getByRole('note')).toHaveTextContent(
      'cannot be converted to USD',
    );
    expect(screen.queryByText(/Success rate/)).not.toBeInTheDocument();
  });

  it('shows no notice while accounts are still loading', () => {
    renderCard();

    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(screen.queryByText(/Success rate/)).not.toBeInTheDocument();
  });
});
