import { beforeEach, describe, expect, it } from 'vitest';

import * as db from '#server/db';
import { PostError } from '#server/errors';
import { handlers } from '#server/main';
import { runHandler } from '#server/mutators';

beforeEach(async () => {
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
});
