import type {
  Attachment,
  Invoice,
  InvoiceEditInput,
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

export type InvoiceState = Invoice['state']

/**
 * What the Invoices list opens on.
 *
 * The question an operator arrives with is "what is outstanding", and the list
 * used to answer it with all 739 invoices ever issued, newest first. Paid is
 * settled; closed is written off or cancelled, which is settled by another
 * name. Neither is outstanding, so neither is here -- the other states stay one
 * click away rather than being the thing you have to read past.
 */
export const defaultInvoiceStates: readonly InvoiceState[] = ['draft', 'open']

export type InvoiceListFilter = 'outstanding' | 'paid' | 'closed' | 'all'

/**
 * The states each toolbar position asks the server for. "All" asks for none,
 * which is the absent parameter and therefore every state -- the behaviour
 * this list had before it could be asked anything.
 */
export const invoiceStatesFor = (
  filter: InvoiceListFilter,
): readonly InvoiceState[] | undefined => {
  if (filter === 'all') return undefined
  if (filter === 'outstanding') return defaultInvoiceStates
  return [filter]
}

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
  updateInvoice(
    id: number,
    commandId: string,
    input: InvoiceEditInput,
    signal?: AbortSignal,
  ): Promise<Invoice>
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
  if (invoice.state === 'closed') {
    if (invoice.close_reason === 'written_off') return 'Written off'
    if (invoice.close_reason === 'cancelled') return 'Cancelled'
    return 'Closed'
  }
  // Open means the invoice exists and is billable; sent means it has reached
  // the client. Both were reading as "Open", which is the difference between an
  // invoice you still have to send and one you are waiting on. Derived from
  // sent_at rather than carried as a fifth state: an invoice can be paid
  // without ever being sent, so sending is not a step in the sequence.
  if (invoice.state === 'open' && typeof invoice.sent_at === 'string') return 'Sent'
  return invoice.state[0]!.toLocaleUpperCase('en-US') + invoice.state.slice(1)
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

export type InvoiceOverflowCommand = 'draft' | 'cancel' | 'write_off' | 'reopen'

export interface InvoiceOverflowTransition {
  readonly command: InvoiceOverflowCommand
  readonly label: string
  /** Red *text*, never a red fill: a fill would owe the AA body-text bar. */
  readonly destructive: boolean
  readonly summary: string
}

/**
 * The four lifecycle verbs beyond `send`. `invoiceStateLabel` has always been
 * able to render `Written off` and `Cancelled`; until these were offered no
 * operator could reach either state from the shell.
 */
export const invoiceOverflowTransitions: readonly InvoiceOverflowTransition[] = [
  {
    command: 'draft',
    label: 'Return to draft',
    destructive: false,
    summary:
      'This moves the invoice back to draft so it can be reworked before it goes out again.',
  },
  {
    command: 'reopen',
    label: 'Reopen invoice',
    destructive: false,
    summary:
      'This reopens the closed invoice and restores whatever balance was written off when it closed.',
  },
  {
    command: 'write_off',
    label: 'Write off balance',
    destructive: true,
    summary:
      'This closes the invoice and writes off the balance still due. Reopening restores it.',
  },
  {
    command: 'cancel',
    label: 'Cancel invoice',
    destructive: true,
    summary: 'This closes the invoice as cancelled. Reopening restores it.',
  },
]

/**
 * Mirrors the reducer in @ezacto/core rather than offering every verb and
 * letting the server refuse: an illegal_invoice_transition is an error the
 * operator cannot act on, and the menu is the only place the rule is visible.
 * The payment count is passed in because the API's Invoice carries the money
 * but not the count -- the detail page has already loaded the payments.
 */
export const invoiceCanIssueTransition = (
  invoice: Readonly<Invoice>,
  paymentCount: number,
  command: InvoiceOverflowCommand,
): boolean => {
  switch (command) {
    case 'draft':
      return (
        invoice.state === 'open' && paymentCount === 0 && invoice.written_off_cents === 0
      )
    case 'cancel':
      return invoice.state === 'draft' || invoice.state === 'open'
    case 'write_off':
      return invoice.state === 'open' && invoice.due_amount_cents > 0
    case 'reopen':
      return invoice.state === 'closed'
  }
}

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

const ratePercentPattern = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,4}))?$/u

// Rates are stored as integer parts-per-million and shown as a percentage.
// Reading the digits keeps 8.25% at exactly 82500 ppm, which multiplying a
// parsed float by 10_000 does not.
export const invoiceRatePpm = (raw: string, label: string): number | null => {
  const value = raw.trim()
  if (value === '') return null
  const match = ratePercentPattern.exec(value)
  if (match === null) {
    throw new Error(`${label} must be a percentage with no more than four decimal places.`)
  }
  const ppm = Number(`${match[1]}${(match[2] ?? '').padEnd(4, '0')}`)
  if (ppm > 1_000_000) throw new Error(`${label} cannot exceed 100%.`)
  return ppm
}

export const invoiceRatePercentForForm = (ppm: number | null): string =>
  ppm === null ? '' : String(ppm / 10_000)

/**
 * One Send, held as a single value: which invoice it belongs to, what it has
 * already committed, and what it still owes. The `send` transition and the
 * email are two commands, so a delivery that fails after the transition
 * committed must retry the email alone -- and every path that used to reset a
 * boolean for its own reasons (a conflict reload, a reopened dialog, an edited
 * field) has to read this instead of forgetting it.
 */
export interface InvoiceSendAttempt {
  readonly invoiceId: number
  /**
   * The idempotency key for `send`, kept for the whole life of the attempt. A
   * command that never committed leaves no ledger row, so reusing the key costs
   * nothing; one that did commit is replayed when the input matches and refused
   * as `command_id_reused` when it does not. Minting a fresh key is the only
   * way to record a second sent message, so the attempt never mints one twice.
   */
  readonly transitionCommandId: string
  /** The version the committed `send` returned; null while `send` is still owed. */
  readonly sentVersion: number | null
  /** The email half, present only while it is asked for and not yet accepted. */
  readonly delivery: InvoiceSendDelivery | null
}

export interface InvoiceSendDelivery {
  /** Kept across retries so a retry is a retry, not a second email. */
  readonly commandId: string
  /** The recipients confirmed with the send this delivery belongs to. */
  readonly recipients: readonly InvoiceRecipient[]
}

export const invoiceSendAttemptFor = (
  attempt: InvoiceSendAttempt | null,
  invoiceId: number,
): InvoiceSendAttempt | null =>
  attempt !== null && attempt.invoiceId === invoiceId ? attempt : null

/**
 * What a Send submission may still issue, read off the attempt rather than off
 * the dialog's checkbox. `send` covers a first attempt and any retry of one
 * that never committed; `delivery` is the email alone, owed by an attempt whose
 * `send` did commit and which nothing may run a second time; `nothing` is the
 * operator taking that owed email off the submit, which issues no request at
 * all and so must never be reported as a send.
 */
export const invoiceSendWork = (
  attempt: InvoiceSendAttempt | null,
  invoiceId: number,
  delivering: boolean,
): 'send' | 'delivery' | 'nothing' => {
  const live = invoiceSendAttemptFor(attempt, invoiceId)
  if (live === null || live.sentVersion === null) return 'send'
  return delivering && live.delivery !== null ? 'delivery' : 'nothing'
}

/** What a failed Send submission leaves behind: the attempt, and what to say. */
export interface InvoiceSendFailure {
  /** The attempt the next submit reads, or null once its key is spent. */
  readonly attempt: InvoiceSendAttempt | null
  /** The line the operator is owed, where the generic conflict line is wrong. */
  readonly notice: string | null
}

/**
 * When a key is retired. The ledger writes a row only for a command that
 * committed, replays an identical retry off it, and refuses a changed one as
 * `command_id_reused` -- so that code is the server reporting that this key's
 * command *did* commit and the response was what went missing. The key is spent
 * from that moment: held, it refuses every later submit under the same code,
 * including a deliberate `Send invoice again`, and the shared conflict line
 * describes an invoice somebody else moved, which is not what happened. So it
 * is retired here, and the operator is told the invoice went out and what a
 * further submit would do.
 *
 * Every other failure is the opposite case -- a version conflict, a dropped
 * connection, a refusal -- and keeps the attempt, because holding the key is
 * the only thing that makes a retry a retry rather than a second sent message.
 */
export const invoiceSendFailure = (
  attempt: InvoiceSendAttempt | null,
  invoiceId: number,
  code: string | null,
): InvoiceSendFailure => {
  const live = invoiceSendAttemptFor(attempt, invoiceId)
  if (live === null || code !== 'command_id_reused') return { attempt, notice: null }
  return {
    attempt: null,
    // Which half the spent key belongs to is the same question `invoiceSendWork`
    // asks: a `send` that has not returned its version is what was refused,
    // otherwise the email was. Neither line claims anything about the reload
    // that follows -- it can itself fail, and the document says which.
    notice:
      live.sentVersion === null
        ? 'This invoice was already recorded as sent under this attempt; its response was lost, not refused. Submitting again records a second sent message.'
        : 'The email for this send was already queued under this attempt; its response was lost, not refused. Submitting again records a second sent message and a second email.',
  }
}

const recipientEmailPattern = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u

/**
 * The inverse of `invoiceRecipients` for one recipient, so a resumed send shows
 * the addresses it will actually deliver to rather than the empty box a form
 * reset leaves behind.
 */
export const invoiceRecipientLine = (recipient: Readonly<InvoiceRecipient>): string =>
  recipient.name.trim() === '' ? recipient.email : `${recipient.name} <${recipient.email}>`

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
  '%invoice_line_items%',
] as const

const invoiceMoney = (cents: number, currency: string): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100)

const invoiceQuantity = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 })

/**
 * The same block the invoice email carries, for the message recorded on the
 * invoice. `invoiceLineItemsBlock` in @ezacto/core is the wire authority and
 * this shape follows it; the composer runs in the browser, which holds the
 * invoice already and does not import the domain package to render a list it
 * can see. A description is free text, so its whitespace is collapsed here as
 * it is there -- a newline in it would otherwise draw a row of its own. Line
 * amounts are pre-tax, so the discount and tax that separate them from the
 * header total are stated here as they are there, and in the wording the
 * invoice document on screen already uses.
 */
export const invoiceLineItemsText = (invoice: Readonly<Invoice>): string => {
  const rows = invoice.line_items.flatMap((line) => {
    const kind = line.kind.replace(/\s+/gu, ' ').trim()
    const description = (line.description ?? '').replace(/\s+/gu, ' ').trim()
    const label = [kind, description].filter((part) => part !== '').join(': ')
    return [
      label === '' ? 'Line item' : label,
      `  ${invoiceQuantity.format(line.quantity)} x ${invoiceMoney(line.unit_price_cents, invoice.currency)}` +
        ` = ${invoiceMoney(line.amount_cents, invoice.currency)}`,
    ]
  })
  const discount = invoice.discount_amount_cents
  const tax = invoice.tax_amount_cents + invoice.tax2_amount_cents
  const summary =
    discount === 0 && tax === 0
      ? []
      : [
          ['Subtotal', invoice.amount_cents + discount - tax] as const,
          ...(discount === 0 ? [] : [['Discount', -discount] as const]),
          ...(tax === 0 ? [] : [['Tax', tax] as const]),
        ]
  return [
    'Line items',
    ...(rows.length === 0 ? ['This invoice has no line items.'] : rows),
    ...summary.map(([name, cents]) => `${name}: ${invoiceMoney(cents, invoice.currency)}`),
    `Total: ${invoiceMoney(invoice.amount_cents, invoice.currency)}`,
  ].join('\n')
}

export const interpolateInvoiceTemplate = (
  template: string,
  invoice: Readonly<Invoice>,
): string => {
  const variables: Record<(typeof invoiceTemplateVariableNames)[number], string> = {
    '%invoice_id%': String(invoice.id),
    '%invoice_number%': invoice.number,
    '%invoice_amount%': invoiceMoney(invoice.amount_cents, invoice.currency),
    '%invoice_due_date%': invoice.due_date,
    '%invoice_line_items%': invoiceLineItemsText(invoice),
  }
  return template.replace(
    /%(?:invoice_id|invoice_number|invoice_amount|invoice_due_date|invoice_line_items)%/gu,
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
