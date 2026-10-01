import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as db from '#server/db';
import { PostError } from '#server/errors';
import { handlers } from '#server/main';
import { runHandler } from '#server/mutators';

beforeEach(async () => {
  vi.restoreAllMocks();
  await global.emptyDatabase()();
});

describe('synced exchange-rate preferences', () => {
  it('rejects malformed rates and custom units before storing them', async () => {
    await expect(
      runHandler(handlers['preferences/save'], {
        id: 'manualRate.USD.VND',
        value: '1,5',
      }),
    ).rejects.toBeInstanceOf(PostError);
    await expect(
      runHandler(handlers['preferences/save'], {
        id: 'customUnit.X-BANANA',
        value: 'not-json',
      }),
    ).rejects.toBeInstanceOf(PostError);

    expect(
      await db.first('SELECT id FROM preferences WHERE id = ?', [
        'manualRate.USD.VND',
      ]),
    ).toBeNull();
    expect(
      await db.first('SELECT id FROM preferences WHERE id = ?', [
        'customUnit.X-BANANA',
      ]),
    ).toBeNull();
  });

  it('stores valid manual rates and custom units', async () => {
    await runHandler(handlers['preferences/save'], {
      id: 'manualRate.USD.VND',
      value: '25400',
    });
    await runHandler(handlers['preferences/save'], {
      id: 'customUnit.X-BANANA',
      value: JSON.stringify({ name: 'Banana', symbol: '🍌', decimals: 0 }),
    });

    expect(
      await db.first('SELECT id, value FROM preferences WHERE id = ?', [
        'manualRate.USD.VND',
      ]),
    ).toEqual({ id: 'manualRate.USD.VND', value: '25400' });
    expect(
      await db.first('SELECT id, value FROM preferences WHERE id = ?', [
        'customUnit.X-BANANA',
      ]),
    ).toEqual({
      id: 'customUnit.X-BANANA',
      value: JSON.stringify({ name: 'Banana', symbol: '🍌', decimals: 0 }),
    });
  });

  it('saves multiple synced preferences together', async () => {
    await runHandler(handlers['preferences/save'], {
      prefs: {
        'manualRate.EUR.USD': '1.08',
        'manualRate.USD.EUR': '',
      },
    });

    expect(
      await db.all('SELECT id, value FROM preferences ORDER BY id'),
    ).toEqual([
      { id: 'manualRate.EUR.USD', value: '1.08' },
      { id: 'manualRate.USD.EUR', value: '' },
    ]);
  });

  it('does not persist any preference when a multi-key write fails', async () => {
    await db.update('preferences', {
      id: 'manualRate.EUR.USD',
      value: '0.4',
    });
    await db.update('preferences', {
      id: 'manualRate.USD.EUR',
      value: '2.5',
    });

    const originalUpdate = db.update;
    let updateCount = 0;
    vi.spyOn(db, 'update').mockImplementation(async (...args) => {
      updateCount += 1;
      if (updateCount === 2) {
        throw new Error('Injected preference write failure');
      }
      return originalUpdate(...args);
    });

    await expect(
      runHandler(handlers['preferences/save'], {
        prefs: {
          'manualRate.EUR.USD': '1.08',
          'manualRate.USD.EUR': '',
        },
      }),
    ).rejects.toThrow('Injected preference write failure');

    expect(
      await db.all('SELECT id, value FROM preferences ORDER BY id'),
    ).toEqual([
      { id: 'manualRate.EUR.USD', value: '0.4' },
      { id: 'manualRate.USD.EUR', value: '2.5' },
    ]);
  });
});
