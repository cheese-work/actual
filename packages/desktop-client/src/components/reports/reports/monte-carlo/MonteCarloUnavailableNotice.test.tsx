import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TestProviders } from '#mocks';

import { MonteCarloUnavailableNotice } from './MonteCarloUnavailableNotice';

vi.mock('#hooks/useSyncedPrefs', () => ({
  useSyncedPrefs: () => [{ defaultCurrencyCode: 'USD' }],
}));

describe('MonteCarloUnavailableNotice', () => {
  it('names the Main currency and only recovery paths that keep units correct', () => {
    render(
      <TestProviders>
        <MonteCarloUnavailableNotice />
      </TestProviders>,
    );

    const note = screen.getByRole('note');
    expect(note).toHaveTextContent('cannot be converted to USD');
    expect(note).toHaveTextContent('link the pot to another account');
    expect(note).toHaveTextContent('remove the pot');
    expect(note).not.toHaveTextContent(/unlink/i);
  });
});
