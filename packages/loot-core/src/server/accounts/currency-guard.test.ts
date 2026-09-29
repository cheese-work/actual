import type { APIAccountEntity } from '#server/api-models';
import * as db from '#server/db';
import { handlers } from '#server/main';
import { runHandler, runMutator } from '#server/mutators';
import * as prefs from '#server/prefs';
import { app as schedulesApp } from '#server/schedules/app';
import type { TransactionEntity } from '#types/models';

vi.mock('#server/post');

const CROSS_CURRENCY = /different currencies \(USD to EUR\)/;
const OFF_BUDGET = /EUR accounts must be off budget/;

let usd: string;
let usd2: string;
let eur: string;
let eur2: string;

async function transferPayee(accountId: string) {
  const payee = await db.first<Pick<db.DbPayee, 'id'>>(
    'SELECT id FROM payees WHERE transfer_acct = ?',
    [accountId],
  );
  if (!payee) {
    throw new Error(`No transfer payee for ${accountId}`);
  }
  return payee.id;
}

function transactionsIn(accountId: string) {
  return db.all<db.DbViewTransactionInternal>(
    'SELECT * FROM v_transactions_internal WHERE account = ? AND tombstone = 0',
    [accountId],
  );
}

async function addTransaction(
  fields: Pick<TransactionEntity, 'account'> & Partial<TransactionEntity>,
) {
  const id = fields.id ?? `tx-${Math.random()}`;
  await runHandler(handlers['transaction-add'], {
    id,
    amount: -1000,
    date: '2026-09-01',
    ...fields,
  });
  return id;
}

beforeEach(async () => {
  await global.emptyDatabase()();
  await prefs.loadPrefs();
  await runMutator(() =>
    db.update('preferences', { id: 'defaultCurrencyCode', value: 'USD' }),
  );

  usd = await runHandler(handlers['account-create'], { name: 'Checking' });
  usd2 = await runHandler(handlers['account-create'], {
    name: 'Savings',
    currency: 'USD',
  });
  eur = await runHandler(handlers['account-create'], {
    name: 'Euro',
    currency: 'EUR',
    offBudget: true,
  });
  eur2 = await runHandler(handlers['account-create'], {
    name: 'Euro 2',
    currency: 'EUR',
    offBudget: true,
  });
});

afterEach(() => {
  prefs.unloadPrefs();
});

describe('account guards', () => {
  test('account-create rejects an on-budget non-main-currency account', async () => {
    await expect(
      runHandler(handlers['account-create'], { name: 'X', currency: 'EUR' }),
    ).rejects.toMatchObject({ message: expect.stringMatching(OFF_BUDGET) });
    expect(await db.all("SELECT id FROM accounts WHERE name = 'X'")).toEqual(
      [],
    );
  });

  test('account-update rejects a non-main currency on an on-budget account', async () => {
    await expect(
      runHandler(handlers['account-update'], { id: usd, currency: 'EUR' }),
    ).rejects.toMatchObject({ message: expect.stringMatching(OFF_BUDGET) });
  });

  test('account-update changes currency only before transactions exist', async () => {
    await runHandler(handlers['account-update'], { id: eur2, currency: 'JPY' });
    expect(await db.getAccount(eur2)).toMatchObject({ currency: 'JPY' });

    await addTransaction({ account: eur });
    await expect(
      runHandler(handlers['account-update'], { id: eur, currency: 'JPY' }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(
        /from EUR to JPY because it already has transactions/,
      ),
    });
    expect(await db.getAccount(eur)).toMatchObject({ currency: 'EUR' });

    // Renames and same-currency writes still pass
    await runHandler(handlers['account-update'], {
      id: eur,
      name: 'Euro renamed',
      currency: 'EUR',
    });
  });

  test('api/account-update rejects moving a non-main account on budget', async () => {
    await expect(
      handlers['api/account-update']({ id: eur, fields: { offbudget: false } }),
    ).rejects.toMatchObject({ message: expect.stringMatching(OFF_BUDGET) });
    expect(await db.getAccount(eur)).toMatchObject({ offbudget: 1 });

    await addTransaction({ account: usd });
    await expect(
      handlers['api/account-update']({
        id: usd,
        // Not in the typed API model yet, but untyped callers (bots) can pass
        // it straight through fromExternal
        fields: { currency: 'EUR' } as Partial<APIAccountEntity>,
      }),
    ).rejects.toMatchObject({ message: expect.stringMatching(OFF_BUDGET) });
  });
});

describe('transaction guards', () => {
  test('transaction-add rejects a cross-currency transfer and writes nothing', async () => {
    await expect(
      addTransaction({ account: usd, payee: await transferPayee(eur) }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(CROSS_CURRENCY),
    });
    expect(await transactionsIn(usd)).toEqual([]);
    expect(await transactionsIn(eur)).toEqual([]);
  });

  test('same-currency transfers still work', async () => {
    await addTransaction({ account: usd, payee: await transferPayee(usd2) });
    await addTransaction({ account: eur, payee: await transferPayee(eur2) });
    expect(await transactionsIn(usd2)).toHaveLength(1);
    expect(await transactionsIn(eur2)).toHaveLength(1);
  });

  test('transactions-batch-update rejects retargeting a payee to another currency', async () => {
    const id = await addTransaction({ account: usd });
    await expect(
      runHandler(handlers['transactions-batch-update'], {
        updated: [{ id, payee: await transferPayee(eur) }],
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(CROSS_CURRENCY),
    });
  });

  test('moving a transaction to an account in another currency is rejected', async () => {
    const id = await addTransaction({ account: usd });
    await expect(
      runHandler(handlers['transaction-update'], {
        ...(await db.getTransaction(id)),
        account: eur,
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/from a USD account to a EUR account/),
    });

    await runHandler(handlers['transaction-update'], {
      ...(await db.getTransaction(id)),
      account: usd2,
    });
    expect(await transactionsIn(usd2)).toHaveLength(1);
  });

  test('a split child cannot transfer to another currency', async () => {
    await expect(
      runHandler(handlers['transactions-batch-update'], {
        added: [
          {
            id: 'parent',
            account: usd,
            amount: -2000,
            date: '2026-09-01',
            is_parent: true,
          },
          {
            id: 'child',
            account: usd,
            amount: -2000,
            date: '2026-09-01',
            is_child: true,
            parent_id: 'parent',
            payee: await transferPayee(eur),
          },
        ],
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(CROSS_CURRENCY),
    });
  });

  test('api/transactions-add rejects a cross-currency transfer payee without running transfers', async () => {
    await expect(
      handlers['api/transactions-add']({
        accountId: usd,
        transactions: [
          {
            date: '2026-09-01',
            amount: -1000,
            payee: await transferPayee(eur),
          },
        ],
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(CROSS_CURRENCY),
    });
    expect(await transactionsIn(usd)).toEqual([]);
  });

  test('transactions-import rejects a cross-currency transfer', async () => {
    await expect(
      runHandler(handlers['transactions-import'], {
        accountId: usd,
        transactions: [
          {
            account: usd,
            date: '2026-09-01',
            amount: -1000,
            payee: await transferPayee(eur),
          },
        ],
        isPreview: false,
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(CROSS_CURRENCY),
    });
    expect(await transactionsIn(usd)).toEqual([]);
  });

  test('rule-apply-actions rejects setting a cross-currency transfer payee', async () => {
    const id = await addTransaction({ account: usd });
    await expect(
      runHandler(handlers['rule-apply-actions'], {
        transactions: [await db.getTransaction(id)],
        actions: [
          {
            op: 'set',
            field: 'payee',
            value: await transferPayee(eur),
            type: 'id',
          },
        ],
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(CROSS_CURRENCY),
    });
    expect(await transactionsIn(eur)).toEqual([]);
  });

  test('schedule/post-transaction rejects a cross-currency transfer schedule', async () => {
    // Indexes schedule conditions so the schedule resolves its account/payee
    schedulesApp.startServices();
    onTestFinished(() => schedulesApp.stopServices());

    const scheduleId = await runHandler(handlers['schedule/create'], {
      conditions: [
        { op: 'is', field: 'date', value: '2026-09-01' },
        { op: 'is', field: 'account', value: usd },
        { op: 'is', field: 'payee', value: await transferPayee(eur) },
        { op: 'is', field: 'amount', value: -1000 },
      ],
    });

    await expect(
      runHandler(handlers['schedule/post-transaction'], { id: scheduleId }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(CROSS_CURRENCY),
    });
    expect(await transactionsIn(usd)).toEqual([]);
  });

  test('account-close rejects a cross-currency balance transfer and leaves the account open', async () => {
    await addTransaction({ account: usd, amount: 5000 });

    await expect(
      runHandler(handlers['account-close'], {
        id: usd,
        transferAccountId: eur,
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(CROSS_CURRENCY),
    });
    expect(await db.getAccount(usd)).toMatchObject({ closed: 0 });

    await runHandler(handlers['account-close'], {
      id: usd,
      transferAccountId: usd2,
    });
    expect(await db.getAccount(usd)).toMatchObject({ closed: 1 });
  });
});
