import { sql, type SQL } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import type { InvoicePaymentOption } from './schema.js'

export type { InvoicePaymentOption } from './schema.js'

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>

type SqlRunner = {
  run(query: SQL): unknown
}

const enabledPaymentOptions = new Set<InvoicePaymentOption>([
  'stripe_checkout',
  'paypal_checkout',
  'quickbooks_checkout',
  'mercury_transfer',
  'wise_transfer',
])

const canonicalTimestamp = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/

const timestampEpochMilliseconds = (value: string): number => {
  const match = canonicalTimestamp.exec(value)
  if (!match) throw new Error('source updated timestamp must be canonical UTC with Z')
  const normalized = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${(match[7] ?? '').padEnd(3, '0')}Z`
  const milliseconds = Date.parse(normalized)
  if (!Number.isSafeInteger(milliseconds) || new Date(milliseconds).toISOString() !== normalized) {
    throw new Error('source updated timestamp must be a real canonical UTC instant')
  }
  return milliseconds
}

const requireCanonicalDate = (value: string): void => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('paid date must be canonical')
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isSafeInteger(milliseconds) || new Date(milliseconds).toISOString().slice(0, 10) !== value) {
    throw new Error('paid date must be a real canonical date')
  }
}

export interface HarvestPaymentDateEvidence {
  paidAt: string | null
  paidDate: string | null
}

export interface CanonicalPaymentDates {
  paidAt: string | null
  paidDate: string | null
  sourcePaidAt: string | null
  sourcePaidDate: string | null
  sourceDateDisagrees: boolean
}

export const canonicalizeHarvestPaymentDates = (
  source: HarvestPaymentDateEvidence,
): CanonicalPaymentDates => {
  if (source.paidAt !== null) timestampEpochMilliseconds(source.paidAt)
  if (source.paidDate !== null) requireCanonicalDate(source.paidDate)
  if (source.paidAt === null && source.paidDate === null) {
    throw new Error('Harvest payment must provide paid_at or paid_date')
  }
  return {
    paidAt: source.paidAt,
    paidDate: source.paidAt === null ? source.paidDate : null,
    sourcePaidAt: source.paidAt,
    sourcePaidDate: source.paidDate,
    sourceDateDisagrees:
      source.paidAt !== null &&
      source.paidDate !== null &&
      source.paidAt.slice(0, 10) !== source.paidDate,
  }
}

export const reemitHarvestPaymentDates = (
  payment: Pick<
    CanonicalPaymentDates,
    'paidAt' | 'paidDate' | 'sourcePaidAt' | 'sourcePaidDate'
  >,
): HarvestPaymentDateEvidence => {
  if (payment.sourcePaidAt !== null || payment.sourcePaidDate !== null) {
    return { paidAt: payment.sourcePaidAt, paidDate: payment.sourcePaidDate }
  }
  if (payment.paidAt !== null) {
    timestampEpochMilliseconds(payment.paidAt)
    return { paidAt: payment.paidAt, paidDate: payment.paidAt.slice(0, 10) }
  }
  if (payment.paidDate !== null) {
    requireCanonicalDate(payment.paidDate)
    return { paidAt: `${payment.paidDate}T00:00:00Z`, paidDate: payment.paidDate }
  }
  throw new Error('payment must provide a canonical paid timestamp or date')
}

export const percentageToRatePpm = (decimalPercent: string): number => {
  const match = /^(0|[1-9]\d{0,2})(?:\.(\d{1,4}))?$/.exec(decimalPercent)
  if (!match) throw new Error('percentage must be an exact decimal with at most four places')
  const whole = Number(match[1])
  const fractional = Number((match[2] ?? '').padEnd(4, '0'))
  if (whole > 100 || (whole === 100 && fractional !== 0)) {
    throw new Error('percentage must be between 0 and 100')
  }
  return whole * 10_000 + fractional
}

export interface InvoiceSourceObservation {
  invoiceId: number
  sourceAmountCents: number | null
  sourceDueAmountCents: number | null
  sourceTaxAmountCents: number | null
  sourceTax2AmountCents: number | null
  sourceDiscountAmountCents: number | null
  sourcePaymentOptions: readonly string[] | null
  sourceUpdatedAt: string
}

export const refreshInvoiceSourceObservation = async (
  database: Database,
  input: InvoiceSourceObservation,
): Promise<boolean> => {
  const incomingEpochMilliseconds = timestampEpochMilliseconds(input.sourceUpdatedAt)
  const result = await (database as unknown as SqlRunner).run(sql`
    UPDATE invoices
    SET source_amount_cents = ${input.sourceAmountCents},
      source_due_amount_cents = ${input.sourceDueAmountCents},
      source_tax_amount_cents = ${input.sourceTaxAmountCents},
      source_tax2_amount_cents = ${input.sourceTax2AmountCents},
      source_discount_amount_cents = ${input.sourceDiscountAmountCents},
      source_payment_options = ${input.sourcePaymentOptions === null ? null : JSON.stringify(input.sourcePaymentOptions)},
      source_updated_at = ${input.sourceUpdatedAt}
    WHERE id = ${input.invoiceId} AND harvest_id IS NOT NULL
      AND (source_updated_at IS NULL OR (
        CAST(strftime('%s', source_updated_at) AS INTEGER) * 1000
        + CASE WHEN instr(source_updated_at, '.') = 0 THEN 0 ELSE
          CAST(
            substr(source_updated_at, 21, length(source_updated_at) - 21)
            || substr('000', 1, 3 - (length(source_updated_at) - 21))
            AS INTEGER
          )
        END
      ) < ${incomingEpochMilliseconds})
  `)
  return changes(result) > 0
}

export interface InvoicePaymentOptionsChange {
  invoiceId: number
  paymentOptions: readonly InvoicePaymentOption[]
  updatedAt: string
}

export const setInvoicePaymentOptions = async (
  database: Database,
  input: InvoicePaymentOptionsChange,
): Promise<void> => {
  if (
    Object.prototype.hasOwnProperty.call(input, 'referenceToken') ||
    Object.prototype.hasOwnProperty.call(input, 'reference_token')
  ) {
    throw new Error('invoice reference token is server-generated')
  }
  if (new Set(input.paymentOptions).size !== input.paymentOptions.length) {
    throw new Error('invoice payment options must be unique')
  }
  if (input.paymentOptions.some((option) => !enabledPaymentOptions.has(option))) {
    throw new Error('invoice payment option is unavailable')
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await (database as unknown as SqlRunner).run(sql`
        UPDATE invoices
        SET payment_options = ${JSON.stringify(input.paymentOptions)}, updated_at = ${input.updatedAt}
        WHERE id = ${input.invoiceId}
      `)
      if (changes(result) === 0) throw new Error('invoice does not exist')
      return
    } catch (error) {
      const message = String(error).toLowerCase()
      if (
        attempt === 2 ||
        (!message.includes('reference token') && !message.includes('reference_token'))
      ) {
        throw error
      }
    }
  }
}

export interface BankDepositConfirmation {
  depositId: number
  invoiceId: number
  paidAt: string
  notes?: string | null
  recordedByUserId?: number | null
  createdAt: string
  updatedAt: string
}

export const confirmBankDeposit = async (
  database: Database,
  input: BankDepositConfirmation,
): Promise<void> => {
  const result = await (database as unknown as SqlRunner).run(sql`
    INSERT INTO invoice_payments (
      invoice_id, currency, amount_cents, paid_at, paid_date, notes, recorded_by_user_id,
      provider, provider_shape, provider_account_id, provider_transaction_id,
      bank_deposit_id, created_at, updated_at
    )
    SELECT invoice.id, deposit.currency, deposit.amount_cents, ${input.paidAt}, NULL,
      ${input.notes ?? null}, ${input.recordedByUserId ?? null}, account.provider,
      account.provider_shape, account.id, deposit.provider_transaction_id,
      deposit.id, ${input.createdAt}, ${input.updatedAt}
    FROM bank_deposits deposit
    JOIN payment_provider_accounts account ON account.id = deposit.provider_account_id
    JOIN invoices invoice ON invoice.id = ${input.invoiceId}
    WHERE deposit.id = ${input.depositId}
      AND deposit.match_state IN ('unmatched', 'suggested')
      AND (deposit.suggested_invoice_id IS NULL OR deposit.suggested_invoice_id = invoice.id)
      AND deposit.currency = invoice.currency
      AND account.provider <> 'bill_com'
  `)
  if (changes(result) === 0) throw new Error('bank deposit is not confirmable for this invoice')
}

const changes = (result: unknown): number => {
  if (typeof result !== 'object' || result === null) return 0
  if ('changes' in result && typeof result.changes === 'number') return result.changes
  if ('meta' in result && typeof result.meta === 'object' && result.meta !== null) {
    const meta = result.meta
    if ('changes' in meta && typeof meta.changes === 'number') return meta.changes
  }
  return 0
}
