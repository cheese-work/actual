import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TestProviders } from '#mocks';

import { Spending } from './Spending';

vi.mock('#components/reports/useReport', () => ({
  useReport: () => ({ status: 'unavailable' }),
}));

vi.mock('#hooks/useDashboardWidget', () => ({
  useDashboardWidget: () => ({ data: undefined, isPending: false }),
}));

vi.mock('#hooks/useAccounts', () => ({
  useAccounts: () => ({
    data: [],
    isLoading: false,
    isPlaceholderData: false,
  }),
}));

vi.mock('#hooks/useLocale', () => ({ useLocale: () => 'en' }));

vi.mock('#hooks/useFormat', () => {
  const format = Object.assign(() => '', {
    forCurrency: () => '',
  });

  return {
    isFinancialFormatType: (type: string) => type.startsWith('financial'),
    useFormat: () => format,
  };
});

vi.mock('@actual-app/components/hooks/useResponsive', () => ({
  useResponsive: () => ({ isNarrowWidth: false }),
}));

describe('Spending', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps the page header and displays the unavailable report message', () => {
    render(
      <TestProviders>
        <MemoryRouter initialEntries={['/reports/spending']}>
          <Routes>
            <Route path="/reports/spending" element={<Spending />} />
          </Routes>
        </MemoryRouter>
      </TestProviders>,
    );

    expect(screen.getByText('Monthly Spending')).toBeInTheDocument();
    expect(screen.getByText(/Spending is unavailable/)).toBeInTheDocument();
  });
});
