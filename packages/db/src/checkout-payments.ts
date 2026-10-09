/**
 * Recording a payment a provider took, for the mirrors that discover one.
 *
 * Issue 595. Both the QuickBooks mirror and the BILL reconciliation find the
 * same thing -- somebody paid an invoice we sent them, somewhere else -- and
 * both were writing `invoice_payments` directly, where the ledger trigger from
 * migration 0023 refuses them. This is the sanctioned path, in one place,
 * because two copies of "how a provider payment becomes a receipt" is two
 * places for it to be subtly different about money.
 *
 * Everything here is derived from the provider's own payment id, which is what
 * makes it safe to call again: the command id is derived from it, so a repeat
 * is recognised by the ledger as the same command rather than a new one, and
 * `invoice_payments_provider_transaction_unique` refuses a second receipt even
 * if it were not.
 */

import { sql } from 'drizzle-orm'
import {
  InvoicePaymentExceedsBalanceError,
  InvoiceVersionConflictError,
  recordInvoicePayment,
  type InvoiceStateDatabase,
} from './invoice-state.js'

/**
 * The same database type the command path takes. Narrower than the one the
 * mirror sources use, because writing a receipt is a command and commands need
 * the transaction seam.
 */
type Database = InvoiceStateDatabase

/** The providers whose payments arrive as a checkout, per migration 0005. */
export type CheckoutProvider = 'stripe' | 'paypal' | 'quickbooks' | 'bill_com'

export interface CheckoutPaymentInput {
  invoiceId: number
  provider: CheckoutProvider
  /** The provider's own id for the account the money was taken into. */
  externalAccountId: string
  accountDisplayName: string
  /** The provider's own id for the payment. The idempotency key, throughout. */
  providerTransactionId: string
  /**
   * The provider's own id for the invoice this share of the payment settled,
   * for providers where one payment settles several invoices at once (BILL,
   * QuickBooks). The receipt is then keyed on the payment and this together:
   * keyed on the payment alone, the first invoice's receipt claimed the id and
   * every other invoice the payment covered was answered `already_recorded`
   * and left open -- one Kestrel Environmental payment for 1299 and 1302 closed only 1299.
   */
  share?: string
  amountCents: number
  /** A plain date, where the provider gave one. */
  paidOn: string | null
  now: string
}

export type CheckoutPaymentOutcome =
  | 'recorded'
  | 'already_recorded'
  | 'invoice_not_payable'
  /**
   * More than the invoice still owes, so not recorded: an invoice is never
   * overpaid by a provider's report. Usually the same money recorded twice --
   * an operator marked it paid first -- and otherwise a client who paid twice,
   * which a person has to settle with them. Either way it is left for a
   * person, and logged so they can find it.
   */
  | 'exceeds_balance'

/**
 * How many times a payment is re-decided when the invoice moves under it. A
 * version conflict means somebody else wrote between the read and the write --
 * often an operator recording the very same payment by hand -- and the right
 * answer depends on what they wrote, so it is read again rather than thrown.
 */
const maximumAttempts = 3

const nextPaymentId = async (database: Database): Promise<number> => {
  const rows = await database.all<{ next: number }>(
    sql`SELECT COALESCE(MAX(id), 0) + 1 AS next FROM invoice_payments`,
  )
  return rows[0]?.next ?? 1
}

/**
 * Records the payment, or says why it did not.
 *
 * Answers rather than throws for the cases a caller cannot do anything about:
 * the payment is already recorded, the invoice is not in a state that can take
 * one, or the payment is more than the invoice still owes. All are ordinary
 * during a reconciliation -- it re-reads the same payments on every pass, an
 * invoice may have been voided since, and an operator may have recorded the
 * same money by hand -- and an exception would make the outbox retry a correct
 * answer until it gave up.
 */
export const recordCheckoutPayment = async (
  database: Database,
  input: Readonly<CheckoutPaymentInput>,
): Promise<CheckoutPaymentOutcome> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await recordCheckoutPaymentOnce(database, input)
    } catch (cause) {
      if (cause instanceof InvoiceVersionConflictError && attempt < maximumAttempts) continue
      throw cause
    }
  }
}

const recordCheckoutPaymentOnce = async (
  database: Database,
  input: Readonly<CheckoutPaymentInput>,
): Promise<CheckoutPaymentOutcome> => {
  const invoices = await database.all<{ currency: string; version: number; state: string }>(
    sql`SELECT currency, version, state FROM invoices WHERE id = ${input.invoiceId}`,
  )
  const invoice = invoices[0]
  // Only an invoice that has been sent can receive a payment, which is the same
  // rule the ledger trigger enforces; saying so here means the caller gets an
  // answer instead of a constraint failure.
  if (invoice === undefined || !['open', 'paid'].includes(invoice.state)) {
    return 'invoice_not_payable'
  }

  // Looked up before inserting rather than `ON CONFLICT DO NOTHING`, because
  // `payment_provider_accounts_reject_identity_collision` is a BEFORE INSERT
  // trigger: it aborts the statement before the conflict clause can apply, so
  // the upsert spelling fails on every call after the first. The QuickBooks
  // source used that spelling, which is a second way its payment path could
  // not have worked.
  const accountId = await (async (): Promise<number | undefined> => {
    const existing = await database.all<{ id: number }>(sql`
      SELECT id FROM payment_provider_accounts
      WHERE provider = ${input.provider} AND provider_shape = 'checkout'
        AND external_account_id = ${input.externalAccountId}`)
    if (existing[0] !== undefined) return existing[0].id
    await database.run(sql`
      INSERT INTO payment_provider_accounts
        (provider, provider_shape, external_account_id, display_name, created_at, updated_at)
      VALUES (${input.provider}, 'checkout', ${input.externalAccountId},
        ${input.accountDisplayName}, ${input.now}, ${input.now})`)
    const created = await database.all<{ id: number }>(sql`
      SELECT id FROM payment_provider_accounts
      WHERE provider = ${input.provider} AND provider_shape = 'checkout'
        AND external_account_id = ${input.externalAccountId}`)
    return created[0]?.id
  })()
  if (accountId === undefined) return 'invoice_not_payable'

  const transactionId =
    input.share === undefined
      ? input.providerTransactionId
      : `${input.providerTransactionId}:${input.share}`
  // A share recorded before receipts were keyed per share carries the bare
  // payment id; on this same invoice, it is this share.
  const already = await database.all<{ id: number }>(sql`
    SELECT id FROM invoice_payments
    WHERE provider_account_id = ${accountId}
      AND (provider_transaction_id = ${transactionId}
        OR (invoice_id = ${input.invoiceId}
          AND provider_transaction_id = ${input.providerTransactionId}))`)
  if (already.length > 0) return 'already_recorded'

  // Derived from the provider's payment id so a second attempt is the same
  // command rather than a new one.
  const commandId = `${input.provider}-payment-${transactionId}`
  try {
    await recordInvoicePayment(database, {
      invoiceId: input.invoiceId,
      commandId,
      // Nobody typed this in. A provider took the money and a reconciliation
      // noticed, so there is no user to name.
      actor: { type: 'system', id: null },
      authorize: async () => true,
      expectedVersion: invoice.version,
      occurredAt: input.now,
      eventIds: [`${commandId}-recorded`, `${commandId}-settled`],
      payment: {
        type: 'checkout',
        id: await nextPaymentId(database),
        currency: invoice.currency,
        amountCents: input.amountCents,
        paidAt: null,
        paidDate: input.paidOn,
        provider: input.provider,
        providerAccountId: accountId,
        providerTransactionId: transactionId,
      },
    })
    return 'recorded'
  } catch (cause) {
    // A racing reconciliation may have recorded it between the check above and
    // the write; the unique index is what decides, and the answer is the same.
    const settled = await database.all<{ id: number }>(sql`
      SELECT id FROM invoice_payments
      WHERE provider_account_id = ${accountId}
        AND provider_transaction_id = ${transactionId}`)
    if (settled.length > 0) return 'already_recorded'
    // The command refuses a payment larger than the balance it would land on,
    // decided against the same version it writes at. A provider's report of
    // one is an answer, not a failure to retry.
    if (cause instanceof InvoicePaymentExceedsBalanceError) {
      return unrecordedOverpayment(input, cause.maximumCents)
    }
    throw cause
  }
}

/**
 * The record a refused overpayment leaves: the payment is real money a
 * provider reports, so declining to apply it must not be silent. Logged with
 * everything a person needs to find it at the provider and settle it.
 */
const unrecordedOverpayment = (
  input: Readonly<CheckoutPaymentInput>,
  dueAmountCents: number,
): 'exceeds_balance' => {
  console.warn('[payments] provider payment not recorded: more than the invoice still owes', {
    provider: input.provider,
    providerTransactionId: input.providerTransactionId,
    invoiceId: input.invoiceId,
    amountCents: input.amountCents,
    dueAmountCents,
    paidOn: input.paidOn,
  })
  return 'exceeds_balance'
}
