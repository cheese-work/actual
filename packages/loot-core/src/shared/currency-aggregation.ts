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

export type DisplayRoundingOptions = {
  displayDecimalPlaces: number;
  /** Canonical Main-currency amounts for this subtotal's immediate children. */
  immediateChildAmounts: readonly IntegerAmount[];
};

export type DisplayRoundingAdjustment = {
  label: 'Rounding adjustment';
  amount: IntegerAmount;
  displayOnly: true;
  placement: 'last-child';
};

export type CurrencyAggregationResult =
  | { status: 'loading' }
  | { status: 'unavailable' }
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

function safeAdd(a: IntegerAmount, b: IntegerAmount): IntegerAmount | null {
  const sum = a + b;
  return isSafeAmount(sum) ? sum : null;
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
  options: DisplayRoundingOptions,
): DisplayRoundingAdjustment | null | undefined {
  if (
    !Number.isInteger(options.displayDecimalPlaces) ||
    options.displayDecimalPlaces < 0 ||
    options.displayDecimalPlaces > STORAGE_DECIMAL_PLACES
  ) {
    return undefined;
  }

  const roundedTotal = roundToDisplayPrecision(
    amount,
    options.displayDecimalPlaces,
  );
  if (roundedTotal === null) {
    return undefined;
  }

  let roundedChildren = 0;
  for (const childAmount of options.immediateChildAmounts) {
    if (!isSafeAmount(childAmount)) {
      return undefined;
    }
    const roundedChild = roundToDisplayPrecision(
      childAmount,
      options.displayDecimalPlaces,
    );
    if (roundedChild === null) {
      return undefined;
    }
    const nextRoundedChildren = safeAdd(roundedChildren, roundedChild);
    if (nextRoundedChildren === null) {
      return undefined;
    }
    roundedChildren = nextRoundedChildren;
  }

  const adjustment = safeAdd(roundedTotal, -roundedChildren);
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

  const accountsById = new Map(accounts.map(account => [account.id, account]));
  const amountsByAccountAndBucket = new Map<
    string,
    Map<string | undefined, IntegerAmount>
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
    const nativeAmount = safeAdd(bucketAmounts.get(bucketId) ?? 0, amount);
    if (nativeAmount === null) {
      return { status: 'unavailable' };
    }
    bucketAmounts.set(bucketId, nativeAmount);
    amountsByAccountAndBucket.set(accountId, bucketAmounts);
  }

  let total = 0;
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

    for (const nativeAmount of bucketAmounts.values()) {
      let converted: IntegerAmount | null;
      try {
        converted = convert(
          nativeAmount,
          accountCurrency,
          mainCurrencyCode,
          prefs,
        );
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('safeNumber:')) {
          return { status: 'unavailable' };
        }
        throw error;
      }

      if (converted === null || !isSafeAmount(converted)) {
        return { status: 'unavailable' };
      }
      const nextTotal = safeAdd(total, converted);
      if (nextTotal === null) {
        return { status: 'unavailable' };
      }
      total = nextTotal;
    }
  }

  if (!display) {
    return { status: 'complete', amount: total };
  }

  const presentationAdjustment = getPresentationAdjustment(total, display);
  if (presentationAdjustment === undefined) {
    return { status: 'unavailable' };
  }
  return {
    status: 'complete',
    amount: total,
    ...(presentationAdjustment && { presentationAdjustment }),
  };
}
