/**
 * Comparing our invoices with the QuickBooks company, and saying where they
 * disagree (issue 1013, slice 1).
 *
 * Pure: two lists in, a report out. Nothing here reaches QuickBooks or the
 * database, and nothing it returns is an instruction -- the report names a
 * difference and leaves it to a person. Which side is right is decided by the
 * rule the book already follows: ezacto for the invoice (number, total,
 * currency), QuickBooks for money received there.
 */

import type { QuickBooksInvoice } from './client.js'

/** An invoice of record here, with what has been received against it. */
export interface ReconcileLocalInvoice {
  readonly id: number
  readonly number: string
  readonly currency: string
  readonly amountCents: number
  /** The sum of the receipts recorded here, whichever system recorded them. */
  readonly paidCents: number
  /** The QuickBooks invoice this one is linked to, where the mirror linked it. */
  readonly quickBooksId: string | null
}

export type ReconcileIssue =
  | 'voided_in_quickbooks'
  | 'missing_in_quickbooks'
  | 'amount_differs'
  | 'currency_differs'
  | 'payments_differ'

export type ReconcileStatus = 'matched' | ReconcileIssue | 'missing_here'

export interface ReconciliationRow {
  readonly status: ReconcileStatus
  /** Every difference found; `status` is the first. Empty for a match. */
  readonly issues: readonly ReconcileIssue[]
  readonly ezactoInvoiceId: number | null
  readonly number: string
  readonly quickBooksId: string | null
  /** Whether the mirror has linked the pair, or they were paired by number. */
  readonly linked: boolean
  readonly ezactoAmountCents: number | null
  readonly quickBooksAmountCents: number | null
  readonly ezactoCurrency: string | null
  /** Null where the company uses a single currency and states none. */
  readonly quickBooksCurrency: string | null
  readonly ezactoPaidCents: number | null
  /** Total less balance as QuickBooks states them; null where no balance is stated. */
  readonly quickBooksPaidCents: number | null
  readonly detail: string
}

export interface ReconciliationReport {
  readonly rows: readonly ReconciliationRow[]
  readonly counts: Readonly<Record<ReconcileStatus, number>>
}

const statuses: readonly ReconcileStatus[] = [
  'matched',
  'voided_in_quickbooks',
  'missing_in_quickbooks',
  'amount_differs',
  'currency_differs',
  'payments_differ',
  'missing_here',
]

const cents = (amount: number | undefined): number | null =>
  amount === undefined ? null : Math.round(amount * 100)

const money = (value: number): string => (value / 100).toFixed(2)

/**
 * QuickBooks voids a document by zeroing it and replacing its private note with
 * "Voided", keeping the number. A zero total alone is not enough to say so: the
 * note is what separates a void from an invoice entered at nothing.
 */
const isVoided = (invoice: Readonly<QuickBooksInvoice>): boolean =>
  invoice.TotalAmt === 0 && /^voided\b/iu.test((invoice.PrivateNote ?? '').trim())

const compare = (
  ours: Readonly<ReconcileLocalInvoice>,
  theirs: Readonly<QuickBooksInvoice>,
): { issues: ReconcileIssue[]; details: string[]; theirPaid: number | null } => {
  const issues: ReconcileIssue[] = []
  const details: string[] = []
  const theirTotal = cents(theirs.TotalAmt)
  const theirPaid =
    theirTotal === null || theirs.Balance === undefined
      ? null
      : theirTotal - Math.round(theirs.Balance * 100)

  if (isVoided(theirs)) {
    issues.push('voided_in_quickbooks')
    details.push('voided in QuickBooks')
    return { issues, details, theirPaid }
  }
  if (theirTotal !== null && theirTotal !== ours.amountCents) {
    issues.push('amount_differs')
    details.push(`total is ${money(ours.amountCents)} here and ${money(theirTotal)} in QuickBooks`)
  }
  const theirCurrency = theirs.CurrencyRef?.value ?? null
  if (theirCurrency !== null && theirCurrency !== ours.currency) {
    issues.push('currency_differs')
    details.push(`currency is ${ours.currency} here and ${theirCurrency} in QuickBooks`)
  }
  if (theirPaid !== null && theirPaid !== ours.paidCents) {
    issues.push('payments_differ')
    const partial = theirPaid > 0 && theirTotal !== null && theirPaid < theirTotal
    details.push(
      `${money(ours.paidCents)} received here, ${money(theirPaid)} in QuickBooks${partial ? ' (partly paid there)' : ''}`,
    )
  }
  return { issues, details, theirPaid }
}

/**
 * Pairs each invoice of record here with its QuickBooks document -- by link
 * where the mirror made one, by number otherwise -- and lists what differs.
 * QuickBooks invoices nothing here claims are reported as missing here.
 */
export const reconcileInvoices = (
  local: readonly ReconcileLocalInvoice[],
  remote: readonly QuickBooksInvoice[],
): ReconciliationReport => {
  const byId = new Map(remote.map((invoice) => [invoice.Id, invoice]))
  const byNumber = new Map<string, QuickBooksInvoice>()
  for (const invoice of remote) {
    if (invoice.DocNumber !== undefined && !byNumber.has(invoice.DocNumber)) {
      byNumber.set(invoice.DocNumber, invoice)
    }
  }
  const claimed = new Set<string>()
  const rows: ReconciliationRow[] = []

  for (const ours of local) {
    const linked = ours.quickBooksId !== null
    const theirs = linked ? byId.get(ours.quickBooksId!) : byNumber.get(ours.number)
    const base = {
      ezactoInvoiceId: ours.id,
      number: ours.number,
      linked,
      ezactoAmountCents: ours.amountCents,
      ezactoCurrency: ours.currency,
      ezactoPaidCents: ours.paidCents,
    }
    if (theirs === undefined) {
      rows.push({
        ...base,
        status: 'missing_in_quickbooks',
        issues: ['missing_in_quickbooks'],
        quickBooksId: ours.quickBooksId,
        quickBooksAmountCents: null,
        quickBooksCurrency: null,
        quickBooksPaidCents: null,
        detail: linked
          ? 'linked to a QuickBooks invoice the company no longer holds'
          : 'not in QuickBooks',
      })
      continue
    }
    claimed.add(theirs.Id)
    const { issues, details, theirPaid } = compare(ours, theirs)
    rows.push({
      ...base,
      status: issues[0] ?? 'matched',
      issues,
      quickBooksId: theirs.Id,
      quickBooksAmountCents: cents(theirs.TotalAmt),
      quickBooksCurrency: theirs.CurrencyRef?.value ?? null,
      quickBooksPaidCents: theirPaid,
      detail: details.join('; '),
    })
  }

  for (const theirs of remote) {
    if (claimed.has(theirs.Id)) continue
    rows.push({
      status: 'missing_here',
      issues: [],
      ezactoInvoiceId: null,
      number: theirs.DocNumber ?? '',
      quickBooksId: theirs.Id,
      linked: false,
      ezactoAmountCents: null,
      quickBooksAmountCents: cents(theirs.TotalAmt),
      ezactoCurrency: null,
      quickBooksCurrency: theirs.CurrencyRef?.value ?? null,
      ezactoPaidCents: null,
      quickBooksPaidCents:
        theirs.TotalAmt === undefined || theirs.Balance === undefined
          ? null
          : Math.round(theirs.TotalAmt * 100) - Math.round(theirs.Balance * 100),
      detail: 'in QuickBooks, with no invoice here',
    })
  }

  const counts = Object.fromEntries(statuses.map((status) => [status, 0])) as Record<
    ReconcileStatus,
    number
  >
  for (const row of rows) counts[row.status] += 1
  return { rows, counts }
}
