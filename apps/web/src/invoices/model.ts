import type {
  Attachment,
  Invoice,
  InvoiceEmailDeliveryInput,
  InvoiceLine,
  InvoiceLineInput,
  InvoiceLineUpdateInput,
  InvoiceMessage,
  InvoicePayment,
  InvoicePaymentInput,
  InvoicePaymentUpdateInput,
  InvoiceRecipient,
  InvoiceTransitionInput,
  VersionedRowDeleteInput,
  Whoami,
} from '@ezacto/client'

export interface InvoicePaymentApi {
  getInvoice(id: number, signal?: AbortSignal): Promise<Invoice>
  listInvoiceMessages(id: number, signal?: AbortSignal): Promise<readonly InvoiceMessage[]>
  listInvoicePayments(id: number, signal?: AbortSignal): Promise<readonly InvoicePayment[]>
  listInvoiceAttachments?(id: number, signal?: AbortSignal): Promise<readonly Attachment[]>
  uploadInvoiceAttachment?(
    id: number,
    commandId: string,
    body: FormData,
    signal?: AbortSignal,
  ): Promise<Attachment>
  recordInvoicePayment(
    id: number,
    commandId: string,
    input: InvoicePaymentInput,
    signal?: AbortSignal,
  ): Promise<Invoice>
  updateInvoicePayment(
    id: number,
    paymentId: number,
    commandId: string,
    input: InvoicePaymentUpdateInput,
    signal?: AbortSignal,
  ): Promise<Invoice>
  deleteInvoicePayment(
    id: number,
    paymentId: number,
    commandId: string,
    input: VersionedRowDeleteInput,
    signal?: AbortSignal,
  ): Promise<Invoice>
  createInvoiceLine(
    id: number,
    commandId: string,
    input: InvoiceLineInput,
    signal?: AbortSignal,
  ): Promise<Invoice>
  updateInvoiceLine(
    id: number,
    lineId: number,
    commandId: string,
    input: InvoiceLineUpdateInput,
    signal?: AbortSignal,
  ): Promise<Invoice>
  deleteInvoiceLine(
    id: number,
    lineId: number,
    commandId: string,
    input: VersionedRowDeleteInput,
    signal?: AbortSignal,
  ): Promise<Invoice>
  transitionInvoice(
    id: number,
    commandId: string,
    input: InvoiceTransitionInput,
    signal?: AbortSignal,
  ): Promise<Invoice>
  deliverInvoiceEmail(
    id: number,
    commandId: string,
    input: InvoiceEmailDeliveryInput,
    signal?: AbortSignal,
  ): Promise<Invoice>
}

export const invoiceProfileHasAccess = (profile: Whoami['profile']): boolean =>
  profile === 'accounting' ||
  profile === 'executive_manager' ||
  profile === 'administrator'

const invoiceIdentityHasScope = (
  identity: Readonly<Whoami>,
  scope: 'invoices:read' | 'invoices:write',
): boolean =>
  invoiceProfileHasAccess(identity.profile) &&
  (identity.authentication.kind === 'session' ||
    identity.authentication.scopes.includes(scope))

export const invoiceIdentityCanRead = (identity: Readonly<Whoami>): boolean =>
  invoiceIdentityHasScope(identity, 'invoices:read')

export const invoiceIdentityCanWrite = (identity: Readonly<Whoami>): boolean =>
  invoiceIdentityHasScope(identity, 'invoices:write')

export const invoiceIdFromPathname = (pathname: string): number | null => {
  const match = /^\/invoices\/([1-9][0-9]*)\/?$/u.exec(pathname)
  if (match === null) return null
  const id = Number(match[1])
  return Number.isSafeInteger(id) ? id : null
}

export const invoiceStateLabel = (invoice: Readonly<Invoice>): string => {
  if (invoice.state !== 'closed') {
    return invoice.state[0]!.toLocaleUpperCase('en-US') + invoice.state.slice(1)
  }
  if (invoice.close_reason === 'written_off') return 'Written off'
  if (invoice.close_reason === 'cancelled') return 'Cancelled'
  return 'Closed'
}

export const invoiceMessageLabel = (
  message: Readonly<InvoiceMessage>,
): string => {
  const event = message.event_type?.trim()
  if (event === undefined || event === null || event === '')
    return 'Invoice activity'
  if (event === 'send') return 'marked sent'
  return event.replaceAll('_', ' ').replaceAll('-', ' ')
}

export const invoicePaymentDate = (
  payment: Readonly<InvoicePayment>,
): string | null => payment.paid_date ?? payment.paid_at

export const invoiceCanRecordPayment = (invoice: Readonly<Invoice>): boolean =>
  invoice.state === 'open' && invoice.due_amount_cents > 0

export const invoiceCanMarkSent = (invoice: Readonly<Invoice>): boolean =>
  invoice.state === 'draft' || invoice.state === 'open'

export const invoiceCanEditLines = (invoice: Readonly<Invoice>): boolean =>
  invoice.state !== 'closed'

const signedMoneyPattern = /^(-?)(?:0|[1-9][0-9]*)(?:\.([0-9]{1,2}))?$/u
const decimalPattern = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:e([+-]?[0-9]+))?$/iu
const invoiceCentsLimit = 9_000_000_000_000n

interface DecimalRatio {
  readonly numerator: bigint
  readonly denominator: bigint
}

const decimalRatio = (value: string): DecimalRatio => {
  const match = decimalPattern.exec(value)
  if (match === null) throw new Error('Quantity must be a plain decimal number.')
  const fraction = match[3] ?? ''
  const exponent = Number(match[4] ?? '0')
  if (!Number.isSafeInteger(exponent)) {
    throw new Error('Quantity is outside the supported range.')
  }
  let numerator = BigInt(`${match[2]}${fraction}`)
  if (match[1] === '-') numerator = -numerator
  const scale = fraction.length - exponent
  if (scale < 0) return { numerator: numerator * 10n ** BigInt(-scale), denominator: 1n }
  return { numerator, denominator: 10n ** BigInt(scale) }
}

const sameRatio = (left: DecimalRatio, right: DecimalRatio): boolean =>
  left.numerator * right.denominator === right.numerator * left.denominator

export interface InvoiceLineValues {
  readonly quantity: number
  readonly unitPriceCents: number
  readonly amountCents: number
}

export const invoiceLineUnitPriceCents = (raw: string): number => {
  const value = raw.trim()
  const match = signedMoneyPattern.exec(value)
  if (match === null) {
    throw new Error('Rate must be a decimal amount with no more than two decimal places.')
  }
  const negative = match[1] === '-'
  const unsigned = negative ? value.slice(1) : value
  const [whole, fraction = ''] = unsigned.split('.')
  let cents = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'))
  if (negative) cents = -cents
  if (cents < -invoiceCentsLimit || cents > invoiceCentsLimit) {
    throw new Error('Rate is too large.')
  }
  return Number(cents)
}

export const invoiceLineValues = (
  rawQuantity: string,
  rawUnitPrice: string,
): InvoiceLineValues => {
  const quantityText = rawQuantity.trim()
  if (
    quantityText.length === 0 ||
    quantityText.length > 1_000 ||
    !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(quantityText)
  ) {
    throw new Error('Quantity must be a plain decimal number.')
  }
  const quantity = Number(quantityText)
  if (
    !Number.isFinite(quantity) ||
    !sameRatio(decimalRatio(quantityText), decimalRatio(quantity.toString()))
  ) {
    throw new Error('Quantity cannot be represented without changing its decimal value.')
  }
  const unitPriceCents = invoiceLineUnitPriceCents(rawUnitPrice)
  const ratio = decimalRatio(quantityText)
  const product = ratio.numerator * BigInt(unitPriceCents)
  const magnitude = product < 0n ? -product : product
  let rounded = magnitude / ratio.denominator
  if ((magnitude % ratio.denominator) * 2n >= ratio.denominator) rounded += 1n
  if (product < 0n) rounded = -rounded
  if (rounded < -invoiceCentsLimit || rounded > invoiceCentsLimit) {
    throw new Error('Quantity and rate produce an amount that is too large.')
  }
  return { quantity, unitPriceCents, amountCents: Number(rounded) }
}

export const invoiceLineUnitPriceForForm = (cents: number): string => {
  const value = BigInt(cents)
  const magnitude = value < 0n ? -value : value
  return `${value < 0n ? '-' : ''}${magnitude / 100n}.${String(magnitude % 100n).padStart(2, '0')}`
}

export const invoiceLineQuantityForForm = (line: Readonly<InvoiceLine>): string =>
  line.quantity.toString()

const recipientEmailPattern = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u

export const invoiceRecipients = (raw: string): InvoiceRecipient[] => {
  const lines = raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  if (lines.length === 0) throw new Error('Enter at least one recipient email address.')
  if (lines.length > 1_000) throw new Error('No more than 1,000 recipients can be recorded at once.')
  const seen = new Set<string>()
  return lines.flatMap((line) => {
    const named = /^(.*?)\s*<([^<>]+)>$/u.exec(line)
    const name = named === null ? '' : named[1]!.trim()
    const email = (named === null ? line : named[2]!).trim()
    if (
      name.length > 1_000 ||
      email.length > 320 ||
      !recipientEmailPattern.test(email)
    ) {
      throw new Error(`Enter a valid recipient as email@example.com or Name <email@example.com>.`)
    }
    const key = email.toLocaleLowerCase('en-US')
    if (seen.has(key)) return []
    seen.add(key)
    return [{ name, email }]
  })
}

export const invoiceTemplateVariableNames = [
  '%invoice_id%',
  '%invoice_number%',
  '%invoice_amount%',
  '%invoice_due_date%',
] as const

export const interpolateInvoiceTemplate = (
  template: string,
  invoice: Readonly<Invoice>,
): string => {
  const variables: Record<(typeof invoiceTemplateVariableNames)[number], string> = {
    '%invoice_id%': String(invoice.id),
    '%invoice_number%': invoice.number,
    '%invoice_amount%': new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: invoice.currency,
    }).format(invoice.amount_cents / 100),
    '%invoice_due_date%': invoice.due_date,
  }
  return template.replace(
    /%(?:invoice_id|invoice_number|invoice_amount|invoice_due_date)%/gu,
    (variable) => variables[variable as keyof typeof variables],
  )
}

export const invoiceReminderDate = (raw: string, today: string): string => {
  if (raw === '') throw new Error('Choose a reminder date.')
  const date = new Date(`${raw}T00:00:00.000Z`)
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(raw) ||
    !Number.isFinite(date.valueOf()) ||
    date.toISOString().slice(0, 10) !== raw
  ) {
    throw new Error('Choose a valid reminder date.')
  }
  if (raw < today) throw new Error('The reminder date cannot be in the past.')
  return raw
}

export const invoicePlannedReminder = (
  invoice: Readonly<Invoice>,
  messages: readonly InvoiceMessage[],
): string | null => {
  if (invoice.state !== 'open') return null
  return (
    [...messages]
      .reverse()
      .find(
        (message) =>
          message.event_type === 'send' && message.send_reminder_on !== null,
      )?.send_reminder_on ?? null
  )
}

export const invoicePaymentCanUpdate = (
  invoice: Readonly<Invoice>,
  payment: Readonly<InvoicePayment>,
): boolean =>
  (invoice.state === 'open' || invoice.state === 'paid') &&
  payment.provider === 'manual' &&
  payment.provider_shape === 'manual' &&
  payment.recorded_by_user_id !== null

export const invoicePaymentCanDelete = (
  invoice: Readonly<Invoice>,
  payment: Readonly<InvoicePayment>,
): boolean =>
  (invoice.state === 'open' || invoice.state === 'paid') &&
  payment.recorded_by_user_id !== null

const moneyPattern = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/u

export const invoicePaymentAmountCents = (raw: string): number => {
  const value = raw.trim()
  if (!moneyPattern.test(value)) {
    throw new Error('Amount must be greater than zero with no more than two decimals.')
  }
  const [whole, fraction = ''] = value.split('.')
  const cents = Number(BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0')))
  if (!Number.isSafeInteger(cents) || cents < 1) {
    throw new Error('Amount must be greater than zero with no more than two decimals.')
  }
  if (cents > 9_000_000_000_000) throw new Error('Amount is too large.')
  return cents
}

export const invoicePaymentAmountForForm = (cents: number): string =>
  `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`

const localTimestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/u

export const invoicePaymentInstant = (raw: string): string => {
  const match = localTimestampPattern.exec(raw)
  if (match === null) throw new Error('Choose a valid payment date and time.')
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] ?? 0),
  )
  if (
    date.getFullYear() !== Number(match[1]) ||
    date.getMonth() !== Number(match[2]) - 1 ||
    date.getDate() !== Number(match[3]) ||
    date.getHours() !== Number(match[4]) ||
    date.getMinutes() !== Number(match[5]) ||
    date.getSeconds() !== Number(match[6] ?? 0)
  ) {
    throw new Error('Choose a valid payment date and time.')
  }
  return date.toISOString()
}

export const invoicePaymentLocalInstant = (instant: string): string => {
  const date = new Date(instant)
  if (!Number.isFinite(date.valueOf())) return ''
  const part = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}`
}

export type InvoicePaymentTiming =
  | { readonly paid_date: string }
  | { readonly paid_at: string }

export const invoicePaymentTiming = (
  precision: 'date' | 'timestamp',
  value: string,
): InvoicePaymentTiming => {
  if (precision === 'timestamp') return { paid_at: invoicePaymentInstant(value) }
  const date = new Date(`${value}T00:00:00.000Z`)
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
    !Number.isFinite(date.valueOf()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw new Error('Choose a valid payment date.')
  }
  return { paid_date: value }
}

export const invoicePaymentProviderLabel = (
  payment: Readonly<InvoicePayment>,
): string => {
  if (payment.provider === 'manual') return 'Manual'
  return payment.provider
    .split('_')
    .map((part) => part[0]!.toLocaleUpperCase('en-US') + part.slice(1))
    .join(' ')
}

export const invoicePeriod = (invoice: Readonly<Invoice>): string | null =>
  invoice.period_start === null || invoice.period_end === null
    ? null
    : `${invoice.period_start} – ${invoice.period_end}`
