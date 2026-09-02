import type {
  Invoice,
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
  transitionInvoice(
    id: number,
    commandId: string,
    input: InvoiceTransitionInput,
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
  return event.replaceAll('_', ' ').replaceAll('-', ' ')
}

export const invoicePaymentDate = (
  payment: Readonly<InvoicePayment>,
): string | null => payment.paid_date ?? payment.paid_at

export const invoiceCanRecordPayment = (invoice: Readonly<Invoice>): boolean =>
  invoice.state === 'open' && invoice.due_amount_cents > 0

export const invoiceCanSend = (invoice: Readonly<Invoice>): boolean =>
  invoice.state === 'draft' || invoice.state === 'open'

const recipientEmailPattern = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u

export const invoiceRecipients = (raw: string): InvoiceRecipient[] => {
  const lines = raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  if (lines.length === 0) throw new Error('Enter at least one recipient email address.')
  if (lines.length > 1_000) throw new Error('No more than 1,000 recipients can be sent at once.')
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

export const invoiceScheduledReminder = (
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
