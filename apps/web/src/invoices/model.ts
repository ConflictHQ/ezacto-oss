import { EzactoApiError } from '@conflict-hq/ezacto-client'
import type {
  Attachment,
  GeneralResource,
  Invoice,
  InvoiceEditInput,
  InvoiceEmailDeliveryInput,
  InvoiceGenerationInput,
  InvoiceLine,
  InvoiceLineInput,
  InvoiceLineUpdateInput,
  InvoiceMessage,
  InvoicePayment,
  InvoicePaymentInput,
  InvoicePaymentUpdateInput,
  InvoiceQuickBooksEnvelope,
  InvoiceReminderPreferenceEnvelope,
  InvoiceDocumentPreferenceEnvelope,
  InvoiceDocumentPreferenceInput,
  InvoiceRecipient,
  InvoiceTransitionInput,
  VersionedRowDeleteInput,
  Whoami,
} from '@conflict-hq/ezacto-client'
import { parseDurationSeconds } from '../shell/model.js'

/**
 * The sentence to show for a failed invoice request: the first field the API
 * named, else its message, else the error's own. Shared by the detail page and
 * the editor so a refusal reads the same on both.
 */
export const invoiceApiMessage = (error: unknown): string => {
  if (error instanceof EzactoApiError && typeof error.body === 'object' && error.body !== null) {
    const detail = Reflect.get(error.body, 'error')
    if (typeof detail === 'object' && detail !== null) {
      const fields = Reflect.get(detail, 'fields')
      if (Array.isArray(fields)) {
        const first = fields.find(
          (field) =>
            typeof field === 'object' &&
            field !== null &&
            typeof Reflect.get(field, 'message') === 'string',
        )
        if (first !== undefined) return String(Reflect.get(first, 'message'))
      }
      const message = Reflect.get(detail, 'message')
      if (typeof message === 'string' && message.trim() !== '') return message
    }
  }
  return error instanceof Error ? error.message : 'The request could not be completed.'
}

export const invoiceApiErrorCode = (error: unknown): string | null => {
  if (!(error instanceof EzactoApiError) || typeof error.body !== 'object' || error.body === null) {
    return null
  }
  const detail = Reflect.get(error.body, 'error')
  if (typeof detail !== 'object' || detail === null) return null
  const code = Reflect.get(detail, 'code')
  return typeof code === 'string' ? code : null
}

/**
 * The refusals that mean the invoice moved since the page read it: a stale
 * version, a line changed underneath, or a held key reused for a different
 * request. Each is answered by reading the invoice again, not by retrying.
 */
export const invoiceConflictCodes: ReadonlySet<string> = new Set([
  'invoice_version_conflict',
  'trigger_row_conflict',
  'command_id_reused',
])

/** Where one invoice stands with QuickBooks, as the API reports it (issue 819). */
export type InvoiceQuickBooksState = InvoiceQuickBooksEnvelope['data']
export type InvoiceReminderPreference = InvoiceReminderPreferenceEnvelope['data']
/** Which documents go with an invoice's email, its own choice and what it resolves to. */
export type InvoiceDocumentPreference = InvoiceDocumentPreferenceEnvelope['data']

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

export type InvoiceListFilter = 'outstanding' | 'overdue' | 'paid' | 'closed' | 'all'

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
  if (filter === 'overdue') return ['open']
  return [filter]
}

export type InvoiceHoursReportFormat = 'pdf' | 'csv' | 'xlsx'

export interface InvoicePaymentApi {
  getInvoice(id: number, signal?: AbortSignal): Promise<Invoice>
  /** The hours this invoice billed, as a file (the work journal, issue 647). */
  downloadInvoiceHoursReport?(
    id: number,
    format: InvoiceHoursReportFormat,
    detail: 'detailed' | 'summary',
    signal?: AbortSignal,
  ): Promise<{ readonly blob: Blob; readonly filename: string }>
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
  /**
   * The QuickBooks line and its Sync button (issue 819). Optional because the
   * routes are mounted only where the deployment carries Intuit keys; a build
   * without them shows neither.
   */
  getInvoiceQuickBooks?(id: number, signal?: AbortSignal): Promise<InvoiceQuickBooksState>
  syncInvoiceQuickBooks?(id: number, signal?: AbortSignal): Promise<InvoiceQuickBooksState>
  /**
   * The Reminders fact and its switch (issue 850): whether this invoice will
   * be reminded, when the next one is booked, and the one control that turns
   * them off for this invoice alone. Optional the way QuickBooks is.
   */
  getInvoiceReminderPreference?(id: number, signal?: AbortSignal): Promise<InvoiceReminderPreference>
  setInvoiceReminderPreference?(
    id: number,
    reminders: boolean | null,
    signal?: AbortSignal,
  ): Promise<InvoiceReminderPreference>
  /**
   * What the Send dialog attaches: the invoice PDF, the hours report and the
   * invoice's own files, each the invoice's own choice or the organization's
   * (issues 626 and 647). Optional because a deployment without the routes
   * has nothing to choose, and the dialog then offers nothing.
   */
  getInvoiceDocumentPreference?(id: number, signal?: AbortSignal): Promise<InvoiceDocumentPreference>
  setInvoiceDocumentPreference?(
    id: number,
    input: InvoiceDocumentPreferenceInput,
    signal?: AbortSignal,
  ): Promise<InvoiceDocumentPreference>
}

export type InvoiceJournalFormat = 'pdf' | 'csv' | 'xlsx'

/** The hours report's files, in the order the product lists them. */
export const invoiceJournalFormats: readonly InvoiceJournalFormat[] = ['pdf', 'csv', 'xlsx']

/** What goes with an invoice's email, as the Send dialog's boxes hold it. */
export interface InvoiceAttachmentChoice {
  readonly pdf: boolean
  readonly files: boolean
  readonly journal: 'detailed' | 'summary' | false
  readonly journalFormats: readonly InvoiceJournalFormat[]
}

const journalLevel = (value: unknown): 'detailed' | 'summary' | false =>
  value === 'detailed' || value === 'summary' ? value : false

const sameFormats = (
  left: readonly InvoiceJournalFormat[],
  right: readonly InvoiceJournalFormat[],
): boolean => [...left].sort().join() === [...right].sort().join()

/**
 * What the email will carry if nobody changes anything: the invoice's own
 * choices where it has them, the organization's where it does not. The
 * server resolves it, so the dialog opens on its answer rather than working
 * the precedence out a second time.
 */
export const invoiceAttachmentsEffective = (
  preference: Readonly<InvoiceDocumentPreference>,
): InvoiceAttachmentChoice => ({
  pdf: preference.effective,
  files: preference.effective_files,
  journal: journalLevel(preference.effective_journal),
  journalFormats: preference.effective_journal_formats,
})

/**
 * The invoice's own preference, written only where the dialog was changed from
 * what the invoice would have done anyway -- or null when nothing was.
 *
 * A choice that lands back on the organization's default is written as null,
 * which hands the invoice back to the organization rather than pinning it to a
 * value that happens to match today: a default changed next month should still
 * reach it. Files are only ever written where the invoice has some to offer.
 */
export const invoiceAttachmentChanges = (
  preference: Readonly<InvoiceDocumentPreference>,
  chosen: Readonly<InvoiceAttachmentChoice>,
  filesOffered: boolean,
): InvoiceDocumentPreferenceInput | null => {
  if (chosen.journal !== false && chosen.journalFormats.length === 0) {
    throw new Error('Choose at least one file for the hours report.')
  }
  const effective = invoiceAttachmentsEffective(preference)
  const input: InvoiceDocumentPreferenceInput = {}
  if (chosen.pdf !== effective.pdf) {
    input.attach_pdf = chosen.pdf === preference.organization_attach_pdf ? null : chosen.pdf
  }
  if (filesOffered && chosen.files !== effective.files) {
    input.attach_files = chosen.files === preference.organization_attach_files ? null : chosen.files
  }
  if (chosen.journal !== effective.journal) {
    input.attach_journal =
      chosen.journal === journalLevel(preference.organization_attach_journal) ? null : chosen.journal
  }
  if (chosen.journal !== false && !sameFormats(chosen.journalFormats, effective.journalFormats)) {
    input.journal_formats = sameFormats(chosen.journalFormats, preference.organization_journal_formats)
      ? null
      : [...chosen.journalFormats]
  }
  return Object.keys(input).length === 0 ? null : input
}

/**
 * What the edit page reads and writes. The writes are the detail page's own --
 * the same commands under the same keys -- and the two reads are for the
 * read-only client and the projects a line can be linked to.
 */
export interface InvoiceEditorApi
  extends Pick<
    InvoicePaymentApi,
    'getInvoice' | 'updateInvoice' | 'createInvoiceLine' | 'updateInvoiceLine' | 'deleteInvoiceLine'
  > {
  /** The client the invoice is for, by name. A name is a nicety; the page edits without one. */
  getDirectoryClient?(id: number, signal?: AbortSignal): Promise<GeneralResource>
  /**
   * The client's projects, archived ones included: a line keeps the link it
   * has, and the database refuses a link to another client's project, so these
   * are the only ones worth offering.
   */
  listInvoiceClientProjects?(
    clientId: number,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<{
    readonly data: readonly GeneralResource[]
    readonly page: { readonly next_cursor: string | null }
  }>
}

/**
 * The Reminders fact, in one line. Off for this invoice says so; on names the
 * next date, or that there is no policy to book from.
 */
export const invoiceRemindersLine = (
  preference: Readonly<InvoiceReminderPreference>,
  dateLabel: (value: string) => string,
): string => {
  if (preference.reminders === false) return 'Off for this invoice'
  if (preference.next_reminder_at !== null) {
    return `Next reminder ${dateLabel(preference.next_reminder_at.slice(0, 10))}`
  }
  if (preference.organization_reminder_policy === null) {
    return 'No reminder policy set for the organization'
  }
  return 'None booked'
}

/**
 * The QuickBooks fact on the invoice page, in one line. "Not connected" is the
 * deployment's state; "Not synced" is this invoice's, with the reason the last
 * attempt gave where it gave one, so a refusal is read rather than guessed at.
 * A synced invoice names the QuickBooks document and how many receipts
 * followed it, and still reports a later attempt that was refused or failed --
 * a receipt the mirror could not file is not settled just because the invoice
 * was.
 */
export const invoiceQuickBooksLine = (
  state: Readonly<InvoiceQuickBooksState>,
  dateLabel: (value: string) => string,
): string => {
  if (!state.connected) return 'Not connected'
  const outcome = state.last_outcome
  const trouble =
    outcome !== null && (outcome.kind === 'refused' || outcome.kind === 'failed')
      ? (outcome.reason ?? 'the last attempt gave no reason')
      : null
  if (state.invoice === null) {
    return trouble === null ? 'Not synced' : `Not synced: ${trouble}`
  }
  const parts = [
    `Synced to QuickBooks invoice ${state.invoice.quickbooks_id} on ${dateLabel(state.invoice.mirrored_at)}`,
  ]
  const count = state.payments.length
  if (count > 0) parts.push(`${count} ${count === 1 ? 'payment' : 'payments'} synced`)
  if (trouble !== null) parts.push(`last attempt ${outcome!.kind}: ${trouble}`)
  return parts.join(' \u00b7 ')
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

/**
 * Where an invoice's pages live, and the one place that says so.
 *
 * Every link the app draws to an invoice is built here and every invoice page
 * reads its address back through `invoiceIdFromPathname` below, so moving the
 * address from the record id to the invoice number is a change to these two
 * functions and the worker's route table -- not a search through every screen
 * that happens to link to an invoice.
 */
export const invoicePagePath = (invoiceId: number, page: 'detail' | 'edit' = 'detail'): string =>
  page === 'edit' ? `/invoices/${invoiceId}/edit` : `/invoices/${invoiceId}`

/** The invoice a detail (or edit) page is for; null for any other path. */
export const invoiceIdFromPathname = (
  pathname: string,
  page: 'detail' | 'edit' = 'detail',
): number | null => {
  const match = (
    page === 'edit' ? /^\/invoices\/([1-9][0-9]*)\/edit\/?$/u : /^\/invoices\/([1-9][0-9]*)\/?$/u
  ).exec(pathname)
  if (match === null) return null
  const id = Number(match[1])
  return Number.isSafeInteger(id) ? id : null
}

/**
 * What the edit page opens on, carried in its hash: one line to put the cursor
 * in, or a fresh line to start. The detail page's per-line Edit and its Add
 * line both land here, so the editor is the one place a line changes.
 */
export type InvoiceEditFocus = { readonly line: number } | 'new-line'

export const invoiceEditHref = (invoiceId: number, focus?: InvoiceEditFocus): string =>
  `${invoicePagePath(invoiceId, 'edit')}${
    focus === undefined ? '' : focus === 'new-line' ? '#new-line' : `#line-${focus.line}`
  }`

export const invoiceEditFocusFromHash = (hash: string): InvoiceEditFocus | null => {
  if (hash === '#new-line') return 'new-line'
  const match = /^#line-([1-9][0-9]*)$/u.exec(hash)
  if (match === null) return null
  const line = Number(match[1])
  return Number.isSafeInteger(line) ? { line } : null
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

/** `today` is the viewer's local calendar day, `YYYY-MM-DD`. */
export const invoiceIsPastDue = (invoice: Readonly<Invoice>, today: string): boolean =>
  invoice.state === 'open' && invoice.due_amount_cents > 0 && invoice.due_date < today

export type InvoiceStatusTone = 'draft' | 'sent' | 'late' | 'paid' | 'neutral'

/**
 * The pill: the state label, except that an open invoice past its due date
 * reads Late, and the colour it is drawn in. Open-but-unsent and closed stay
 * neutral -- the four tones are the four states someone scans the list for.
 */
export const invoiceStatusPill = (
  invoice: Readonly<Invoice>,
  today: string,
): { readonly label: string; readonly tone: InvoiceStatusTone } => {
  if (invoiceIsPastDue(invoice, today)) return { label: 'Late', tone: 'late' }
  const label = invoiceStateLabel(invoice)
  if (invoice.state === 'draft') return { label, tone: 'draft' }
  if (invoice.state === 'paid') return { label, tone: 'paid' }
  if (label === 'Sent') return { label, tone: 'sent' }
  return { label, tone: 'neutral' }
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
 * One line as the edit page holds it: every field the string its control hands
 * over, and where the row came from.
 */
export interface InvoiceLineDraft {
  /** Stable for the life of the page: a line not saved yet has no id to go by. */
  readonly key: string
  /** The line on the invoice this row edits; null for one not saved yet. */
  readonly lineId: number | null
  readonly kind: string
  readonly description: string
  readonly quantity: string
  readonly rate: string
  readonly taxed: boolean
  readonly taxed2: boolean
  readonly projectId: string
  /** Marked to go when the page saves, and still on screen until then. */
  readonly removed: boolean
}

/** The whole edit page as its controls hold it. */
export interface InvoiceDraft {
  readonly subject: string
  readonly purchaseOrder: string
  readonly notes: string
  readonly issueDate: string
  readonly dueDate: string
  readonly paymentTerms: string
  readonly tax: string
  readonly tax2: string
  readonly discount: string
  readonly lines: readonly InvoiceLineDraft[]
}

const invoiceLinesInOrder = (invoice: Readonly<Invoice>): readonly InvoiceLine[] =>
  [...invoice.line_items].sort((left, right) => left.position - right.position || left.id - right.id)

export const invoiceLineDraft = (line: Readonly<InvoiceLine>): InvoiceLineDraft => ({
  key: `line-${line.id}`,
  lineId: line.id,
  kind: line.kind,
  description: line.description ?? '',
  quantity: invoiceLineQuantityForForm(line),
  rate: invoiceLineUnitPriceForForm(line.unit_price_cents),
  taxed: line.taxed,
  taxed2: line.taxed2,
  projectId: line.project_id === null ? '' : String(line.project_id),
  removed: false,
})

/** A fresh line, seeded the way the Add line dialog seeded one. */
export const invoiceBlankLineDraft = (key: string): InvoiceLineDraft => ({
  key,
  lineId: null,
  kind: 'Service',
  description: '',
  quantity: '1',
  rate: '0.00',
  taxed: false,
  taxed2: false,
  projectId: '',
  removed: false,
})

export const invoiceDraft = (invoice: Readonly<Invoice>): InvoiceDraft => ({
  subject: invoice.subject ?? '',
  purchaseOrder: invoice.purchase_order ?? '',
  notes: invoice.notes ?? '',
  issueDate: invoice.issue_date,
  dueDate: invoice.due_date,
  paymentTerms: invoice.payment_terms,
  tax: invoiceRatePercentForForm(invoice.tax_rate_ppm),
  tax2: invoiceRatePercentForForm(invoice.tax2_rate_ppm),
  discount: invoiceRatePercentForForm(invoice.discount_rate_ppm),
  lines: invoiceLinesInOrder(invoice).map(invoiceLineDraft),
})

export type InvoiceHeaderEdit = Required<
  Pick<InvoiceEditInput, 'subject' | 'purchase_order' | 'notes' | 'issue_date' | 'due_date' | 'payment_terms'>
>
export type InvoiceRatesEdit = Required<
  Pick<InvoiceEditInput, 'tax_rate_ppm' | 'tax2_rate_ppm' | 'discount_rate_ppm'>
>

/** What one line will say once saved, parsed and checked. */
export interface InvoiceLineEdit {
  readonly kind: string
  readonly description: string | null
  readonly quantity: number
  readonly unit_price_cents: number
  readonly taxed: boolean
  readonly taxed2: boolean
  readonly project_id: number | null
}

/**
 * One command a save has to send. The API takes one edit per request -- the
 * document, the rates, or one line -- so a page that changed several things is
 * several commands, sent in this order on rising versions.
 */
export type InvoiceEditStep =
  | { readonly kind: 'header'; readonly edit: InvoiceHeaderEdit }
  | { readonly kind: 'rates'; readonly edit: InvoiceRatesEdit }
  | { readonly kind: 'line-delete'; readonly key: string; readonly line: InvoiceLine }
  | {
      readonly kind: 'line-update'
      readonly key: string
      readonly line: InvoiceLine
      readonly edit: InvoiceLineEdit
    }
  | {
      readonly kind: 'line-create'
      readonly key: string
      readonly position: number
      readonly edit: InvoiceLineEdit
    }

/**
 * Which held idempotency key a step retries under. One per piece of the page,
 * not per click: a step that failed is retried under the key it was sent with,
 * so a request the server committed but whose answer was lost is replayed
 * rather than applied twice.
 */
export const invoiceEditStepKey = (step: InvoiceEditStep): string =>
  step.kind === 'header' || step.kind === 'rates' ? step.kind : `line:${step.key}`

const invoicePaymentTermValues: readonly Invoice['payment_terms'][] = [
  'upon_receipt',
  'net_15',
  'net_30',
  'net_45',
  'net_60',
  'custom',
]

const blankToNull = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim() ?? ''
  return trimmed === '' ? null : trimmed
}

const sameLineFields = (left: Readonly<InvoiceLineDraft>, right: Readonly<InvoiceLineDraft>): boolean =>
  left.kind === right.kind &&
  left.description === right.description &&
  left.quantity === right.quantity &&
  left.rate === right.rate &&
  left.taxed === right.taxed &&
  left.taxed2 === right.taxed2 &&
  left.projectId === right.projectId

/**
 * A row's fields, parsed with the rules the line dialog applied, or an Error
 * naming the row. Numbered from 1 because the page numbers them so.
 */
const invoiceLineEdit = (row: Readonly<InvoiceLineDraft>, position: number): InvoiceLineEdit => {
  const named = (message: string): Error => new Error(`Line ${position}: ${message}`)
  const kind = row.kind.trim()
  if (kind === '') throw named('Enter an item type.')
  if (kind.length > 255) throw named('Item type cannot exceed 255 characters.')
  const description = row.description.trim()
  if (description.length > 100_000) {
    throw named('Description cannot exceed 100,000 characters.')
  }
  let values: InvoiceLineValues
  try {
    values = invoiceLineValues(row.quantity, row.rate)
  } catch (error) {
    throw named(error instanceof Error ? error.message : 'Check the quantity and rate.')
  }
  let projectId: number | null = null
  if (row.projectId !== '') {
    projectId = Number(row.projectId)
    if (!/^[1-9][0-9]*$/u.test(row.projectId) || !Number.isSafeInteger(projectId)) {
      throw named('Choose a project from the list.')
    }
  }
  return {
    kind,
    description: description === '' ? null : description,
    quantity: values.quantity,
    unit_price_cents: values.unitPriceCents,
    taxed: row.taxed,
    taxed2: row.taxed2,
    project_id: projectId,
  }
}

const lineEditChanges = (edit: Readonly<InvoiceLineEdit>, line: Readonly<InvoiceLine>): boolean =>
  edit.kind !== line.kind.trim() ||
  edit.description !== blankToNull(line.description) ||
  edit.quantity !== line.quantity ||
  edit.unit_price_cents !== line.unit_price_cents ||
  edit.taxed !== line.taxed ||
  edit.taxed2 !== line.taxed2 ||
  edit.project_id !== line.project_id

/**
 * Everything a save has to send to bring `invoice` to what the page shows, in
 * the order it is sent -- the document, the rates, then removed, changed and
 * new lines -- or an Error naming the field that stops it.
 *
 * Every field is checked before anything is sent, so a bad quantity on the
 * last line leaves the document and the other lines unsent rather than
 * half-saved. A part of the page nobody touched is not sent at all, and a part
 * that was touched and put back is not either: a write that changes nothing
 * still moves the version, and the next real edit would trip over it.
 *
 * The controller sends the first step and plans again against the invoice the
 * server answered with, so what a retry sends is always what is still left.
 */
export const invoiceEditPlan = (
  invoice: Readonly<Invoice>,
  draft: Readonly<InvoiceDraft>,
): readonly InvoiceEditStep[] => {
  const seed = invoiceDraft(invoice)
  const steps: InvoiceEditStep[] = []
  const headerTouched =
    draft.subject !== seed.subject ||
    draft.purchaseOrder !== seed.purchaseOrder ||
    draft.notes !== seed.notes ||
    draft.issueDate !== seed.issueDate ||
    draft.dueDate !== seed.dueDate ||
    draft.paymentTerms !== seed.paymentTerms
  if (headerTouched) {
    if (draft.issueDate === '' || draft.dueDate === '') {
      throw new Error('Enter both an issue date and a due date.')
    }
    if (draft.dueDate < draft.issueDate) throw new Error('Due date cannot precede the issue date.')
    const paymentTerms = invoicePaymentTermValues.find((terms) => terms === draft.paymentTerms)
    if (paymentTerms === undefined) throw new Error('Choose the payment terms.')
    // Notes are prose the client reads, so the paragraph breaks someone typed
    // are kept; only the surrounding whitespace goes, and an all-whitespace
    // note clears.
    const edit: InvoiceHeaderEdit = {
      subject: blankToNull(draft.subject),
      purchase_order: blankToNull(draft.purchaseOrder),
      notes: blankToNull(draft.notes),
      issue_date: draft.issueDate,
      due_date: draft.dueDate,
      payment_terms: paymentTerms,
    }
    if (
      edit.subject !== blankToNull(invoice.subject) ||
      edit.purchase_order !== blankToNull(invoice.purchase_order) ||
      edit.notes !== blankToNull(invoice.notes) ||
      edit.issue_date !== invoice.issue_date ||
      edit.due_date !== invoice.due_date ||
      edit.payment_terms !== invoice.payment_terms
    ) {
      steps.push({ kind: 'header', edit })
    }
  }
  if (draft.tax !== seed.tax || draft.tax2 !== seed.tax2 || draft.discount !== seed.discount) {
    const edit: InvoiceRatesEdit = {
      tax_rate_ppm: invoiceRatePpm(draft.tax, 'Tax 1'),
      tax2_rate_ppm: invoiceRatePpm(draft.tax2, 'Tax 2'),
      discount_rate_ppm: invoiceRatePpm(draft.discount, 'Discount'),
    }
    if (
      edit.tax_rate_ppm !== invoice.tax_rate_ppm ||
      edit.tax2_rate_ppm !== invoice.tax2_rate_ppm ||
      edit.discount_rate_ppm !== invoice.discount_rate_ppm
    ) {
      steps.push({ kind: 'rates', edit })
    }
  }
  const lines = new Map(invoice.line_items.map((line) => [line.id, line]))
  const removals: InvoiceEditStep[] = []
  const changes: InvoiceEditStep[] = []
  const additions: InvoiceEditStep[] = []
  let nextPosition = invoice.line_items.reduce(
    (next, line) => Math.max(next, line.position + 1),
    0,
  )
  draft.lines.forEach((row, index) => {
    if (row.lineId !== null) {
      const line = lines.get(row.lineId)
      // Gone from the invoice already: nothing left to remove or change.
      if (line === undefined) return
      if (row.removed) {
        removals.push({ kind: 'line-delete', key: row.key, line })
        return
      }
      if (sameLineFields(row, invoiceLineDraft(line))) return
      const edit = invoiceLineEdit(row, index + 1)
      if (lineEditChanges(edit, line)) {
        changes.push({ kind: 'line-update', key: row.key, line, edit })
      }
      return
    }
    if (row.removed) return
    const edit = invoiceLineEdit(row, index + 1)
    if (!Number.isSafeInteger(nextPosition)) throw new Error('No more lines can be added.')
    additions.push({ kind: 'line-create', key: row.key, position: nextPosition, edit })
    nextPosition += 1
  })
  return [...steps, ...removals, ...changes, ...additions]
}

/**
 * The page's edits carried onto an invoice that moved underneath them.
 *
 * A version conflict reloads the invoice, and the page has to show the new one
 * without throwing away what was typed -- and without sending back, on the
 * retry, the old values of everything that was not. So each field is a
 * three-way merge: one the reader left as it was takes the new value, one they
 * changed keeps their change. A line somebody else added appears; one they
 * removed goes, unless it had been edited here, in which case it stays as a
 * new line to review rather than vanishing with the edit.
 */
export const invoiceDraftRebase = (
  draft: Readonly<InvoiceDraft>,
  before: Readonly<Invoice>,
  after: Readonly<Invoice>,
): InvoiceDraft => {
  const was = invoiceDraft(before)
  const now = invoiceDraft(after)
  const merged = <Field extends Exclude<keyof InvoiceDraft, 'lines'>>(field: Field): string =>
    draft[field] === was[field] ? now[field] : draft[field]
  const previous = new Map(before.line_items.map((line) => [line.id, line]))
  const remaining = new Set(after.line_items.map((line) => line.id))
  const lines: InvoiceLineDraft[] = []
  for (const line of invoiceLinesInOrder(after)) {
    const fresh = invoiceLineDraft(line)
    const row = draft.lines.find((candidate) => candidate.lineId === line.id)
    if (row === undefined) {
      lines.push(fresh)
      continue
    }
    const prior = previous.get(line.id)
    const old = prior === undefined ? null : invoiceLineDraft(prior)
    const keep = <Field extends Exclude<keyof InvoiceLineDraft, 'key' | 'lineId' | 'removed'>>(
      field: Field,
    ): InvoiceLineDraft[Field] => (old !== null && row[field] === old[field] ? fresh[field] : row[field])
    lines.push({
      key: row.key,
      lineId: line.id,
      kind: keep('kind'),
      description: keep('description'),
      quantity: keep('quantity'),
      rate: keep('rate'),
      taxed: keep('taxed'),
      taxed2: keep('taxed2'),
      projectId: keep('projectId'),
      removed: row.removed,
    })
  }
  for (const row of draft.lines) {
    if (row.lineId === null || remaining.has(row.lineId) || row.removed) continue
    const prior = previous.get(row.lineId)
    if (prior !== undefined && sameLineFields(row, invoiceLineDraft(prior))) continue
    lines.push({ ...row, lineId: null })
  }
  lines.push(...draft.lines.filter((row) => row.lineId === null))
  return {
    subject: merged('subject'),
    purchaseOrder: merged('purchaseOrder'),
    notes: merged('notes'),
    issueDate: merged('issueDate'),
    dueDate: merged('dueDate'),
    paymentTerms: merged('paymentTerms'),
    tax: merged('tax'),
    tax2: merged('tax2'),
    discount: merged('discount'),
    lines,
  }
}

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

/** One line of a band's fee as the New invoice dialog holds it. */
export interface InvoiceFeeLineValues {
  readonly description: string
  readonly quantity: string
  readonly unitPrice: string
}

/** A band's fee and terms as the New invoice dialog holds them. */
export interface InvoiceBandValues {
  readonly lines: readonly InvoiceFeeLineValues[]
  readonly claimMode: 'all' | 'ceiling'
  readonly ceilingUnit: 'hours' | 'value'
  readonly ceiling: string
  readonly overageSummary: string
}

type BandedGenerationInput = Extract<InvoiceGenerationInput, { kind: 'banded' }>

export type InvoiceBandTerms = Pick<
  BandedGenerationInput,
  | 'line_items'
  | 'claim_mode'
  | 'claim_ceiling_seconds'
  | 'claim_ceiling_cents'
  | 'overage_summary_type'
>

/**
 * A fee line's amount, in exact cents, or null while it does not parse. It is
 * the invoice editor's arithmetic, so the dialog cannot preview a figure the
 * draft will not carry -- and a price typed as cents reads back as money,
 * a hundred times too large, before it is sent.
 */
export const invoiceFeeLineAmountCents = (
  line: Readonly<Pick<InvoiceFeeLineValues, 'quantity' | 'unitPrice'>>,
): number | null => {
  try {
    return invoiceLineValues(line.quantity, line.unitPrice).amountCents
  } catch {
    return null
  }
}

/**
 * Hours for a band's limit: plain hours (`100`, `99.5`) or the forms the
 * recurring editor takes (`100h`, `99h30m`).
 */
export const invoiceBandCeilingSeconds = (raw: string): number => {
  const value = raw.trim()
  try {
    return parseDurationSeconds(/^\d+(?:\.\d+)?$/u.test(value) ? `${value}h` : value)
  } catch {
    throw new Error('Enter the limit in hours, as 100, 99.5 or 99h30m.')
  }
}

const overageSummaries: ReadonlySet<string> = new Set(['project', 'task', 'people', 'detailed'])

/**
 * The fee and terms a banded request carries, from what the dialog holds; a
 * line or a limit that does not parse throws the sentence to show. A value
 * limit is typed as money, the way the fee's own prices are.
 */
export const invoiceBandTerms = (values: Readonly<InvoiceBandValues>): InvoiceBandTerms => {
  if (values.lines.length === 0) throw new Error('Add at least one fee line.')
  const lineItems = values.lines.map((line, index) => {
    let priced: InvoiceLineValues
    try {
      priced = invoiceLineValues(line.quantity, line.unitPrice)
    } catch (error) {
      throw new Error(`Fee line ${index + 1}: ${(error as Error).message}`, { cause: error })
    }
    const description = line.description.trim()
    return {
      kind: 'Service',
      description: description === '' ? null : description,
      quantity: priced.quantity,
      unit_price_cents: priced.unitPriceCents,
    }
  })
  if (values.claimMode === 'all') return { line_items: lineItems, claim_mode: 'all' }
  if (!overageSummaries.has(values.overageSummary)) {
    throw new Error('Choose how the hours past the limit are grouped.')
  }
  const overage = values.overageSummary as NonNullable<
    BandedGenerationInput['overage_summary_type']
  >
  if (values.ceilingUnit === 'hours') {
    return {
      line_items: lineItems,
      claim_mode: 'ceiling',
      claim_ceiling_seconds: invoiceBandCeilingSeconds(values.ceiling),
      overage_summary_type: overage,
    }
  }
  let cents: number
  try {
    cents = invoiceLineUnitPriceCents(values.ceiling)
  } catch {
    throw new Error('Enter the limit as an amount, like 4500.00.')
  }
  if (cents < 1) throw new Error('The limit must be more than zero.')
  return {
    line_items: lineItems,
    claim_mode: 'ceiling',
    claim_ceiling_cents: cents,
    overage_summary_type: overage,
  }
}

/** What the uninvoiced report says the selected projects have waiting. */
export interface InvoiceBandAvailable {
  readonly seconds: number
  /** Null when the report withholds money from this viewer. */
  readonly cents: number | null
  readonly unpricedEntries: number
}

const bandHours = (seconds: number): string => `${(seconds / 3_600).toFixed(2)} h`

/**
 * The band before it is raised, in what the uninvoiced report can stand behind.
 *
 * The report has totals, not entries, and which entries the band takes is the
 * server's rule -- oldest first, whole entries only -- so this says no more
 * than the totals prove: how much is waiting, at most the limit covered, and
 * at least the rest billed. The draft has the exact split.
 */
export const invoiceBandPreview = (
  available: Readonly<InvoiceBandAvailable>,
  claimMode: 'all' | 'ceiling',
  limit: { readonly unit: 'seconds' | 'cents'; readonly value: number } | null,
  money: (cents: number) => string,
): string => {
  if (available.seconds === 0 && available.unpricedEntries === 0 && (available.cents ?? 0) === 0) {
    return 'Nothing is uninvoiced on these projects in the period; the fee stands on its own.'
  }
  const waiting = `${bandHours(available.seconds)} uninvoiced in the period`
  if (claimMode === 'all') return `${waiting}, all of it covered by the fee.`
  if (limit === null) return `${waiting}. Enter the limit to see what the fee covers.`
  if (limit.unit === 'seconds') {
    return available.seconds <= limit.value
      ? `${waiting}, all of it within the ${bandHours(limit.value)} limit.`
      : `${waiting}: up to ${bandHours(limit.value)} covered, oldest first, and at least ${bandHours(
          available.seconds - limit.value,
        )} billed at each person's rate. An entry is never split, so the draft has the exact figures.`
  }
  const unpriced =
    available.unpricedEntries === 0
      ? ''
      : ` ${available.unpricedEntries} ${available.unpricedEntries === 1 ? 'entry has' : 'entries have'} no billable rate, and a value limit stops at the first of them.`
  if (available.cents === null) {
    return `${waiting}; the fee covers work worth up to ${money(limit.value)} at list, oldest first.${unpriced}`
  }
  const worth = `${waiting}, worth ${money(available.cents)} at list`
  return available.cents <= limit.value && available.unpricedEntries === 0
    ? `${worth}, all of it within the ${money(limit.value)} limit.`
    : available.cents <= limit.value
      ? `${worth}.${unpriced}`
      : `${worth}: up to ${money(limit.value)} of it covered, oldest first, and at least ${money(
          available.cents - limit.value,
        )} billed at each person's rate. An entry is never split, so the draft has the exact figures.${unpriced}`
}
