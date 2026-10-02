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

  let roundedChildren = 0n;
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
    }
  }

  const safeTotal = toSafeAmount(total);
  if (safeTotal === null) {
    return { status: 'unavailable' };
  }

  if (!display) {
    return { status: 'complete', amount: safeTotal };
  }

  const presentationAdjustment = getPresentationAdjustment(safeTotal, display);
  if (presentationAdjustment === undefined) {
    return { status: 'unavailable' };
  }
  return {
    status: 'complete',
    amount: safeTotal,
    ...(presentationAdjustment && { presentationAdjustment }),
  };
}
