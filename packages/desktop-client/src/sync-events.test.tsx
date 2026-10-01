import { act } from 'react';

import * as connection from '@actual-app/core/platform/client/connection';
import type { ServerEvents } from '@actual-app/core/types/server-events';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  configureTestAppStore,
  createTestQueryClient,
  TestProviders,
} from '#mocks';

import { CurrencySettings } from './components/settings/Currency';
import { saveSyncedPrefs, setPrefs } from './prefs/prefsSlice';
import { listenForSyncEvent } from './sync-events';

const mocks = vi.hoisted(() => ({
  callbacks: [] as Array<(event: ServerEvents['sync-event']) => void>,
  send: vi.fn(),
}));

describe('sync preference events', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    mocks.callbacks = [];
    mocks.send.mockReset();
    vi.spyOn(connection, 'send').mockImplementation(mocks.send);
  });

  it('sends a multi-key preference patch as one persistence request', async () => {
    const queryClient = createTestQueryClient();
    const store = configureTestAppStore({ queryClient });
    const prefs = {
      'manualRate.EUR.USD': '1.08',
      'manualRate.USD.EUR': '',
    };
    mocks.send.mockResolvedValue(undefined);

    await store.dispatch(saveSyncedPrefs({ prefs }));

    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenCalledWith('preferences/save', { prefs });
    expect(store.getState().prefs.synced).toEqual(prefs);
  });

  it('refreshes the visible settings for a received preferences table event', async () => {
    const queryClient = createTestQueryClient();
    const store = configureTestAppStore({ queryClient });
    let syncedPrefs: Record<string, string> = {
      defaultCurrencyCode: 'USD',
      numberFormat: 'comma-dot',
    };
    store.dispatch(
      setPrefs({
        local: { id: 'budget-b' },
        global: {},
        synced: syncedPrefs,
      }),
    );

    mocks.send.mockImplementation(async name => {
      if (name === 'load-prefs') {
        return { id: 'budget-b' };
      }
      if (name === 'load-global-prefs') {
        return {};
      }
      if (name === 'preferences/get') {
        return syncedPrefs;
      }
      return undefined;
    });
    vi.spyOn(connection, 'listen').mockImplementation((name, callback) => {
      if (name === 'sync-event') {
        mocks.callbacks.push(callback);
      }
      return vi.fn();
    });

    const unlisten = listenForSyncEvent(store, queryClient);
    render(
      <TestProviders store={store} queryClient={queryClient}>
        <CurrencySettings />
      </TestProviders>,
    );

    expect(
      screen.getByRole('textbox', { name: 'EUR to USD rate' }),
    ).toHaveValue('');

    syncedPrefs = {
      ...syncedPrefs,
      'manualRate.EUR.USD': '1.08',
    };
    await act(async () => {
      mocks.callbacks.forEach(callback =>
        callback({ type: 'success', tables: ['preferences'] }),
      );
    });

    await waitFor(() => {
      expect(
        screen.getByRole('textbox', { name: 'EUR to USD rate' }),
      ).toHaveValue('1.08');
    });
    unlisten();
  });
});
