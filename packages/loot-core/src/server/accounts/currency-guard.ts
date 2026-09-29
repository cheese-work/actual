import * as db from '#server/db';
import { APIError } from '#server/errors';
import { getEffectiveAccountCurrency } from '#shared/currency-setup';
import type { AccountEntity, TransactionEntity } from '#types/models';

// v1 per-account currency invariants (CHE-839):
// - only Main currency accounts may be on budget
// - an account's currency is fixed once it has transactions
// - transfers and transaction moves never cross currencies

async function getMainCurrency(): Promise<string> {
  const row = await db.first<Pick<db.DbPreference, 'value'>>(
    "SELECT value FROM preferences WHERE id = 'defaultCurrencyCode'",
  );
  return row?.value ?? '';
}

function effectiveCurrency(
  currency: string | null | undefined,
  mainCurrency: string,
) {
  return getEffectiveAccountCurrency(currency, {
    defaultCurrencyCode: mainCurrency,
  });
}

export async function assertAccountCurrencyChange(
  id: AccountEntity['id'] | null,
  changes: {
    currency?: string | null | undefined;
    offbudget?: boolean | 0 | 1 | undefined;
  },
) {
  if (changes.currency === undefined && changes.offbudget === undefined) {
    return;
  }

  const mainCurrency = await getMainCurrency();
  const current = id
    ? await db.first<Pick<db.DbAccount, 'currency' | 'offbudget'>>(
        'SELECT currency, offbudget FROM accounts WHERE id = ?',
        [id],
      )
    : null;

  const currency = effectiveCurrency(
    changes.currency !== undefined ? changes.currency : current?.currency,
    mainCurrency,
  );
  const offbudget = changes.offbudget ?? current?.offbudget ?? false;

  if (currency !== mainCurrency && !offbudget) {
    throw APIError(
      `${currency} accounts must be off budget: only accounts in the Main currency (${mainCurrency || 'not set'}) can be on budget. Mark the account as off budget.`,
    );
  }

  if (!id || !current || changes.currency === undefined) {
    return;
  }

  const currentCurrency = effectiveCurrency(current.currency, mainCurrency);
  if (currency === currentCurrency) {
    return;
  }

  const transaction = await db.first(
    'SELECT id FROM transactions WHERE acct = ? AND tombstone = 0 LIMIT 1',
    [id],
  );
  if (transaction) {
    throw APIError(
      `Cannot change this account's currency from ${currentCurrency} to ${currency} because it already has transactions. Create a new ${currency} account instead.`,
    );
  }
}

type TransactionWrite = Partial<
  Pick<TransactionEntity, 'id' | 'account' | 'payee'>
>;

async function getExistingTransactions(ids: string[]) {
  const rows: Pick<db.DbViewTransactionInternal, 'id' | 'account' | 'payee'>[] =
    [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    rows.push(
      ...(await db.all<
        Pick<db.DbViewTransactionInternal, 'id' | 'account' | 'payee'>
      >(
        `SELECT id, account, payee FROM v_transactions_internal WHERE id IN (${chunk.map(() => '?').join(',')})`,
        chunk,
      )),
    );
  }
  return new Map(rows.map(row => [row.id, row]));
}

export async function assertTransactionCurrencies({
  added = [],
  updated = [],
}: {
  added?: readonly TransactionWrite[] | undefined;
  updated?: readonly TransactionWrite[] | undefined;
}) {
  // Only writes that set an account or payee can create a transfer or
  // move money between accounts
  const relevantUpdates = updated.filter(
    t => t.account !== undefined || t.payee !== undefined,
  );
  if (added.length === 0 && relevantUpdates.length === 0) {
    return;
  }

  const mainCurrency = await getMainCurrency();
  const accounts = await db.all<Pick<db.DbAccount, 'id' | 'currency'>>(
    'SELECT id, currency FROM accounts',
  );
  const currencyOf = new Map(
    accounts.map(a => [a.id, effectiveCurrency(a.currency, mainCurrency)]),
  );
  const payees = await db.all<Pick<db.DbPayee, 'id' | 'transfer_acct'>>(
    'SELECT id, transfer_acct FROM payees WHERE transfer_acct IS NOT NULL',
  );
  const transferAccountOf = new Map(payees.map(p => [p.id, p.transfer_acct]));
  const existing = await getExistingTransactions(
    relevantUpdates.map(t => t.id).filter((id): id is string => !!id),
  );

  const writes = [
    ...added.map(t => ({ write: t, before: undefined })),
    ...relevantUpdates.map(t => ({
      write: t,
      before: t.id ? existing.get(t.id) : undefined,
    })),
  ];

  for (const { write, before } of writes) {
    const account = write.account ?? before?.account;
    const payee = write.payee !== undefined ? write.payee : before?.payee;
    const currency = account ? currencyOf.get(account) : undefined;
    if (!currency) {
      continue;
    }

    const previousCurrency = before?.account
      ? currencyOf.get(before.account)
      : undefined;
    if (previousCurrency && previousCurrency !== currency) {
      throw APIError(
        `Cannot move a transaction from a ${previousCurrency} account to a ${currency} account. Delete it and re-enter it in the ${currency} account instead.`,
      );
    }

    const transferAccount = payee ? transferAccountOf.get(payee) : undefined;
    const transferCurrency = transferAccount
      ? currencyOf.get(transferAccount)
      : undefined;
    if (transferCurrency && transferCurrency !== currency) {
      throw APIError(
        `Cannot transfer between accounts in different currencies (${currency} to ${transferCurrency}). Record a separate transaction in each account instead.`,
      );
    }
  }
}
