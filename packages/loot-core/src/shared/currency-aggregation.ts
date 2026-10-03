import type { SyncedPrefs } from '#types/prefs';

import { getEffectiveAccountCurrency } from './currency-setup';
import { convert } from './exchange-rates';
import type { IntegerAmount } from './util';
import { MAX_SAFE_NUMBER, STORAGE_DECIMAL_PLACES } from './util';

export type CurrencyAccount = {
  id: string;
  currency?: string | null;
};

export type AccountAmount = {
  accountId: string;
  bucketId?: string;
  amount: IntegerAmount;
};

export type DisplayRoundingOptions =
  | {
      displayDecimalPlaces: number;
      immediateChildAmounts: readonly IntegerAmount[];
    }
  | {
      displayDecimalPlaces: number;
      immediateChildAccountGroups: readonly (readonly string[])[];
    };

export type DisplayRoundingAdjustment = {
  label: 'Rounding adjustment';
  amount: IntegerAmount;
  displayOnly: true;
  placement: 'last-child';
};

export type CurrencyAggregationResult =
  | { status: 'loading' }
  | { status: 'unavailable'; unavailableCurrency?: string }
  | {
      status: 'complete';
      amount: IntegerAmount;
      presentationAdjustment?: DisplayRoundingAdjustment;
    };

function isSafeAmount(amount: number): amount is IntegerAmount {
  return (
    Number.isInteger(amount) &&
    amount >= -MAX_SAFE_NUMBER &&
    amount <= MAX_SAFE_NUMBER
  );
}

function toSafeAmount(amount: bigint): IntegerAmount | null {
  const maximum = BigInt(MAX_SAFE_NUMBER);
  return amount >= -maximum && amount <= maximum ? Number(amount) : null;
}

function roundToDisplayPrecision(
  amount: IntegerAmount,
  displayDecimalPlaces: number,
): IntegerAmount | null {
  const unit = 10n ** BigInt(STORAGE_DECIMAL_PLACES - displayDecimalPlaces);
  const value = BigInt(amount);
  const quotient = value / unit;
  const remainder = value % unit;
  const twiceRemainder = (remainder < 0n ? -remainder : remainder) * 2n;

  let roundedQuotient = quotient;
  if (
    twiceRemainder > unit ||
    (twiceRemainder === unit && quotient % 2n !== 0n)
  ) {
    roundedQuotient += value < 0n ? -1n : 1n;
  }

  const rounded = roundedQuotient * unit;
  return rounded >= -BigInt(MAX_SAFE_NUMBER) &&
    rounded <= BigInt(MAX_SAFE_NUMBER)
    ? Number(rounded)
    : null;
}

function getPresentationAdjustment(
  amount: IntegerAmount,
  displayDecimalPlaces: number,
  immediateChildAmounts: readonly IntegerAmount[],
): DisplayRoundingAdjustment | null | undefined {
  if (
    !Number.isInteger(displayDecimalPlaces) ||
    displayDecimalPlaces < 0 ||
    displayDecimalPlaces > STORAGE_DECIMAL_PLACES
  ) {
    return undefined;
  }

  const roundedTotal = roundToDisplayPrecision(amount, displayDecimalPlaces);
  if (roundedTotal === null) {
    return undefined;
  }

  let roundedChildren = 0n;
  for (const childAmount of immediateChildAmounts) {
    if (!isSafeAmount(childAmount)) {
      return undefined;
    }
    const roundedChild = roundToDisplayPrecision(
      childAmount,
      displayDecimalPlaces,
    );
    if (roundedChild === null) {
      return undefined;
    }
    roundedChildren += BigInt(roundedChild);
  }

  const adjustment = toSafeAmount(BigInt(roundedTotal) - roundedChildren);
  if (adjustment === null) {
    return undefined;
  }

  return adjustment === 0
    ? null
    : {
        label: 'Rounding adjustment',
        amount: adjustment,
        displayOnly: true,
        placement: 'last-child',
      };
}

function getImmediateChildAmounts(
  accountGroups: readonly (readonly string[])[],
  accountAmounts: ReadonlyMap<string, bigint>,
): IntegerAmount[] | null {
  const seenAccountIds = new Set<string>();
  const amounts: IntegerAmount[] = [];

  for (const accountGroup of accountGroups) {
    let groupAmount = 0n;
    for (const accountId of accountGroup) {
      if (seenAccountIds.has(accountId)) {
        return null;
      }
      seenAccountIds.add(accountId);

      const accountAmount = accountAmounts.get(accountId);
      if (accountAmount === undefined) {
        return null;
      }
      groupAmount += accountAmount;
    }

    const safeGroupAmount = toSafeAmount(groupAmount);
    if (safeGroupAmount === null) {
      return null;
    }
    amounts.push(safeGroupAmount);
  }

  return seenAccountIds.size === accountAmounts.size ? amounts : null;
}

export function aggregateAccountAmountsInMainCurrency(
  amounts: readonly AccountAmount[] | null,
  accounts: readonly CurrencyAccount[],
  prefs: Readonly<SyncedPrefs>,
  display?: DisplayRoundingOptions,
): CurrencyAggregationResult {
  const mainCurrencyCode = prefs.defaultCurrencyCode;
  if (!mainCurrencyCode) {
    return { status: 'unavailable' };
  }
  if (amounts === null) {
    return { status: 'loading' };
  }

  const valuationTime = Date.now();
  const accountsById = new Map(accounts.map(account => [account.id, account]));
  const amountsByAccountAndBucket = new Map<
    string,
    Map<string | undefined, bigint>
  >();

  for (const { accountId, bucketId, amount } of amounts) {
    if (!isSafeAmount(amount)) {
      return { status: 'unavailable' };
    }
    const account = accountsById.get(accountId);
    if (!account) {
      return { status: 'unavailable' };
    }

    const bucketAmounts = amountsByAccountAndBucket.get(accountId) ?? new Map();
    bucketAmounts.set(
      bucketId,
      (bucketAmounts.get(bucketId) ?? 0n) + BigInt(amount),
    );
    amountsByAccountAndBucket.set(accountId, bucketAmounts);
  }

  let total = 0n;
  const convertedAmountsByAccount = new Map<string, bigint>();
  for (const [accountId, bucketAmounts] of amountsByAccountAndBucket) {
    const account = accountsById.get(accountId);
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

    let accountTotal = 0n;
    for (const nativeAmountSum of bucketAmounts.values()) {
      const nativeAmount = toSafeAmount(nativeAmountSum);
      if (nativeAmount === null) {
        return { status: 'unavailable' };
      }

      let converted: IntegerAmount | null;
      try {
        converted = convert(
          nativeAmount,
          accountCurrency,
          mainCurrencyCode,
          prefs,
          valuationTime,
        );
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('safeNumber:')) {
          return { status: 'unavailable' };
        }
        throw error;
      }

      if (converted === null) {
        return { status: 'unavailable', unavailableCurrency: accountCurrency };
      }
      if (!isSafeAmount(converted)) {
        return { status: 'unavailable' };
      }
      total += BigInt(converted);
      accountTotal += BigInt(converted);
    }
    convertedAmountsByAccount.set(accountId, accountTotal);
  }

  const safeTotal = toSafeAmount(total);
  if (safeTotal === null) {
    return { status: 'unavailable' };
  }

  if (!display) {
    return { status: 'complete', amount: safeTotal };
  }

  const immediateChildAmounts =
    'immediateChildAmounts' in display
      ? display.immediateChildAmounts
      : getImmediateChildAmounts(
          display.immediateChildAccountGroups,
          convertedAmountsByAccount,
        );
  if (immediateChildAmounts === null) {
    return { status: 'unavailable' };
  }

  const presentationAdjustment = getPresentationAdjustment(
    safeTotal,
    display.displayDecimalPlaces,
    immediateChildAmounts,
  );
  if (presentationAdjustment === undefined) {
    return { status: 'unavailable' };
  }
  return {
    status: 'complete',
    amount: safeTotal,
    ...(presentationAdjustment && { presentationAdjustment }),
  };
}
