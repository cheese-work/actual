import { getEffectiveAccountCurrency } from '@actual-app/core/shared/currency-setup';
import { convert } from '@actual-app/core/shared/exchange-rates';
import type { AccountEntity } from '@actual-app/core/types/models';
import type { SyncedPrefs } from '@actual-app/core/types/prefs';

export type ReportDataStatus = { status: 'loading' | 'unavailable' };

type ConvertibleReportRow = {
  account: string;
  accountOffBudget: boolean;
  amount: number;
};

export function convertReportQueryRows<T extends ConvertibleReportRow>(
  rows: T[],
  accounts: AccountEntity[],
  prefs: Readonly<SyncedPrefs>,
  showOffBudget: boolean,
  valuationTime: number,
): T[] | ReportDataStatus {
  const mainCurrency = prefs.defaultCurrencyCode;
  if (!mainCurrency) {
    return { status: 'unavailable' };
  }

  const accountsById = new Map(accounts.map(account => [account.id, account]));
  const convertedRows: T[] = [];
  let total = 0n;

  for (const row of rows) {
    if (!showOffBudget && row.accountOffBudget) {
      continue;
    }
    if (!row.account || !Number.isSafeInteger(row.amount)) {
      return { status: 'unavailable' };
    }

    const account = accountsById.get(row.account);
    if (!account) {
      return { status: 'unavailable' };
    }

    const accountCurrency = getEffectiveAccountCurrency(
      account.currency,
      prefs,
    );
    if (!accountCurrency) {
      return { status: 'unavailable' };
    }

    let amount: number | null;
    try {
      // Per-row rounding can shift foreign off-budget interval totals by minor units.
      amount = convert(
        row.amount,
        accountCurrency,
        mainCurrency,
        prefs,
        valuationTime,
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('safeNumber:')) {
        return { status: 'unavailable' };
      }
      throw error;
    }
    if (amount === null) {
      return { status: 'unavailable' };
    }

    total += BigInt(amount);
    if (
      total < -BigInt(Number.MAX_SAFE_INTEGER) ||
      total > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      return { status: 'unavailable' };
    }

    convertedRows.push({ ...row, amount } as T);
  }

  return convertedRows;
}

/**
 * Converts one native account amount to Main. Null when Main is unset, the
 * account is unknown, no rate exists, or the amount is not a safe integer.
 */
export function convertAccountAmount(
  amount: number,
  account: Pick<AccountEntity, 'currency'> | undefined,
  prefs: Readonly<SyncedPrefs>,
  valuationTime: number,
): number | null {
  const mainCurrency = prefs.defaultCurrencyCode;
  if (!mainCurrency || !account || !Number.isSafeInteger(amount)) {
    return null;
  }
  try {
    return convert(
      amount,
      getEffectiveAccountCurrency(account.currency, prefs),
      mainCurrency,
      prefs,
      valuationTime,
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('safeNumber:')) {
      return null;
    }
    throw error;
  }
}

/** Safe-sums converted leaves; null when any leaf is unavailable or the sum is unsafe. */
export function sumConvertedLeaves(
  leaves: Array<number | null>,
): number | null {
  let total = 0;
  for (const leaf of leaves) {
    if (leaf === null) {
      return null;
    }
    total += leaf;
    if (!Number.isSafeInteger(total)) {
      return null;
    }
  }
  return total;
}

export function hasForeignAccount(
  accounts: Array<Pick<AccountEntity, 'currency'>>,
  prefs: Readonly<SyncedPrefs>,
): boolean {
  return accounts.some(
    account =>
      getEffectiveAccountCurrency(account.currency, prefs) !==
      prefs.defaultCurrencyCode,
  );
}
