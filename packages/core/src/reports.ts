const centsLimit = 9_000_000_000_000

const assertNonnegativeSafeInteger = (value: number, field: string): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`)
  }
}

const assertSafeInteger = (value: number, field: string): void => {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${field} must be a safe integer`)
}

const checkedCents = (value: bigint, field: string): number => {
  if (value < -BigInt(centsLimit) || value > BigInt(centsLimit)) {
    throw new RangeError(`${field} exceeds the supported cents range`)
  }
  return Number(value)
}

/**
 * Canonical tracked-time pricing shared by reports and invoice generation.
 * Stored rounded seconds are multiplied using integer arithmetic and the final
 * fractional cent is rounded half-up.
 *
 * Seconds are signed: a Harvest correction entry offsets an earlier one, so its
 * contribution to every total it touches is negative by construction. Price the
 * magnitude and carry the sign back, so the half-cent rounds away from zero on
 * both sides and a correction cancels exactly the amount it was written to
 * cancel. The rate is a magnitude and stays non-negative.
 */
export const trackedAmountCents = (roundedSeconds: number, hourlyRateCents: number): number => {
  assertSafeInteger(roundedSeconds, 'rounded seconds')
  assertNonnegativeSafeInteger(hourlyRateCents, 'hourly rate cents')
  const magnitude = BigInt(Math.abs(roundedSeconds)) * BigInt(hourlyRateCents)
  const cents = (magnitude + 1_800n) / 3_600n
  return checkedCents(roundedSeconds < 0 ? -cents : cents, 'tracked amount')
}

export interface UninvoicedTimeCandidate {
  id: number
  currency: string
  roundedSeconds: number
  billableRateCents: number | null
}

export interface UninvoicedExpenseCandidate {
  id: number
  currency: string
  totalCostCents: number
}

export interface UninvoicedCurrencyTotal {
  currency: string
  roundedSeconds: number
  timeEntryCount: number
  unpricedTimeEntryCount: number
  expenseCount: number
  timeCents: number
  expenseCents: number
  totalCents: number
}

type MutableUninvoicedCurrencyTotal = UninvoicedCurrencyTotal

const currencyCode = (value: string): string => {
  const normalized = value.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new RangeError('report currency must be a three-letter code')
  }
  return normalized
}

const checkedAdd = (left: number, right: number, field: string): number => {
  const sum = BigInt(left) + BigInt(right)
  if (sum > BigInt(Number.MAX_SAFE_INTEGER) || sum < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${field} exceeds the supported aggregate range`)
  }
  return Number(sum)
}

/**
 * The generation preview is the invariant-11 seam: invoice generation consumes
 * these exact per-currency totals instead of independently re-pricing rows.
 */
export const uninvoicedGenerationPreview = (input: {
  timeEntries: readonly Readonly<UninvoicedTimeCandidate>[]
  expenses: readonly Readonly<UninvoicedExpenseCandidate>[]
}): readonly UninvoicedCurrencyTotal[] => {
  const totals = new Map<string, MutableUninvoicedCurrencyTotal>()
  const totalFor = (currency: string): MutableUninvoicedCurrencyTotal => {
    const code = currencyCode(currency)
    let total = totals.get(code)
    if (total === undefined) {
      total = {
        currency: code,
        roundedSeconds: 0,
        timeEntryCount: 0,
        unpricedTimeEntryCount: 0,
        expenseCount: 0,
        timeCents: 0,
        expenseCents: 0,
        totalCents: 0,
      }
      totals.set(code, total)
    }
    return total
  }

  for (const entry of input.timeEntries) {
    assertNonnegativeSafeInteger(entry.id, 'time entry id')
    assertSafeInteger(entry.roundedSeconds, 'rounded seconds')
    const total = totalFor(entry.currency)
    total.roundedSeconds = checkedAdd(total.roundedSeconds, entry.roundedSeconds, 'rounded seconds')
    total.timeEntryCount += 1
    if (entry.billableRateCents === null) {
      total.unpricedTimeEntryCount += 1
      continue
    }
    const cents = trackedAmountCents(entry.roundedSeconds, entry.billableRateCents)
    total.timeCents = checkedAdd(total.timeCents, cents, 'time cents')
    total.totalCents = checkedAdd(total.totalCents, cents, 'total cents')
  }

  for (const expense of input.expenses) {
    assertNonnegativeSafeInteger(expense.id, 'expense id')
    assertNonnegativeSafeInteger(expense.totalCostCents, 'expense cents')
    if (expense.totalCostCents > centsLimit) {
      throw new RangeError('expense cents exceeds the supported cents range')
    }
    const total = totalFor(expense.currency)
    total.expenseCount += 1
    total.expenseCents = checkedAdd(total.expenseCents, expense.totalCostCents, 'expense cents')
    total.totalCents = checkedAdd(total.totalCents, expense.totalCostCents, 'total cents')
  }

  return [...totals.values()].sort((left, right) => left.currency.localeCompare(right.currency))
}
