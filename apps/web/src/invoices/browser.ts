import { renderDataTable, type CellContent } from '../components/data-table.js'
import { DEMO_MAIL_NOTE, isDemoDeployment, isDemoMailRestricted } from '../demo.js'
import { markMoney, moneyText } from '../money-display.js'
import {
  type Attachment,
  EzactoApiError,
  type Invoice,
  type InvoiceEmailDeliveryInput,
  type InvoiceMessage,
  type InvoicePayment,
  type InvoicePaymentInput,
  type InvoicePaymentUpdateInput,
  type InvoiceDocumentPreferenceInput,
  type InvoiceRecipient,
  type InvoiceTransitionInput,
  type Whoami,
} from '@conflict-hq/ezacto-client'
import { takePageNotice } from '../page-notice.js'
import {
  interpolateInvoiceTemplate,
  invoiceApiErrorCode,
  invoiceCopies,
  invoiceTemplateProblem,
  invoiceApiMessage,
  invoiceAttachmentChanges,
  invoiceAttachmentsEffective,
  invoiceCanEditLines,
  invoiceCanIssueTransition,
  invoiceCanMarkSent,
  invoiceCanRecordPayment,
  invoiceConflictCodes,
  invoiceEditHref,
  invoiceIdentityCanRead,
  invoiceIdentityCanWrite,
  invoiceLineQuantityForForm,
  invoiceMessageLabel,
  invoiceOverflowTransitions,
  invoicePaymentAmountCents,
  invoicePaymentAmountForForm,
  invoicePaymentCanDelete,
  invoicePaymentCanUpdate,
  invoicePaymentLocalInstant,
  invoicePaymentProviderLabel,
  invoicePagePath,
  invoicePaymentTiming,
  invoicePeriod,
  invoiceRecipientLine,
  invoiceRecipients,
  invoiceReferenceFromPathname,
  invoiceReminderDate,
  invoicePlannedReminder,
  invoiceQuickBooksLine,
  invoiceRemindersLine,
  invoiceSendAttemptFor,
  invoiceSendFailure,
  invoiceSendWork,
  invoiceIsPastDue,
  invoiceStateLabel,
  invoiceStatusPill,
  type InvoiceAttachmentChoice,
  type InvoiceDocumentPreference,
  type InvoiceEmailDefaults,
  type InvoiceEmailPreview,
  type InvoiceHoursReportFormat,
  type InvoiceJournalFormat,
  type InvoiceOverflowCommand,
  type InvoicePageReference,
  type InvoicePaymentApi,
  type InvoiceQuickBooksState,
  type InvoiceReminderPreference,
  type InvoiceSendAttempt,
  type InvoiceSendDelivery,
} from './model.js'

const required = <ElementType extends Element>(selector: string): ElementType => {
  const element = document.querySelector<ElementType>(selector)
  if (element === null) throw new Error(`invoice shell element missing: ${selector}`)
  return element
}

const money = (cents: number, currency: string): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100)

const dateLabel = (value: string | null): string => {
  if (value === null) return '—'
  const date = new Date(`${value.slice(0, 10)}T00:00:00.000Z`)
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date)
}

const instantLabel = (value: string): string => {
  const date = new Date(value)
  if (!Number.isFinite(date.valueOf())) return value
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

const paymentDateLabel = (payment: Readonly<InvoicePayment>): string =>
  payment.paid_at === null ? dateLabel(payment.paid_date) : instantLabel(payment.paid_at)

const invoiceDueLabel = (invoice: Readonly<Invoice>): CellContent => {
  const today = new Date()
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  if (!invoiceIsPastDue(invoice, todayKey)) {
    return dateLabel(invoice.due_date)
  }
  const due = new Date(`${invoice.due_date.slice(0, 10)}T00:00:00.000Z`)
  const now = new Date(`${todayKey}T00:00:00.000Z`)
  const days = Math.floor((now.valueOf() - due.valueOf()) / 86_400_000)
  const label = document.createElement('span')
  label.className = 'invoice-past-due'
  label.textContent = `${dateLabel(invoice.due_date)} · ${days} ${days === 1 ? 'day' : 'days'} past due`
  return label
}

// The API returns client_id, not the client. "Client #12" is an internal
// identifier on a page a client can be sent, so the shell hands over the names
// it has already loaded for the list, the detail page reads the one it shows,
// and this falls back only when it has none.
const clientNames = new Map<number, string>()

export const setInvoiceClientNames = (
  names: Iterable<readonly [number, string]>,
): void => {
  clientNames.clear()
  for (const [id, name] of names) clientNames.set(id, name)
}

const clientLabel = (clientId: number): string =>
  clientNames.get(clientId) ?? `Client #${clientId}`

/**
 * The list route takes cursor and per_page and nothing else, so the search is
 * over what has been loaded. It lives here rather than at the call site because
 * the client name it matches on is this module's private map -- the same one the
 * Client column reads, so what you type is what you can see.
 */
export const invoiceMatchesSearch = (invoice: Readonly<Invoice>, query: string): boolean => {
  const wanted = query.trim().toLocaleLowerCase('en-US')
  if (wanted === '') return true
  return `${invoice.number} ${clientLabel(invoice.client_id)}`
    .toLocaleLowerCase('en-US')
    .includes(wanted)
}

const invoiceStatePill = (invoice: Readonly<Invoice>): HTMLSpanElement => {
  const state = document.createElement('span')
  state.className = 'invoice-state'
  state.dataset.state = invoice.state
  const pill = invoiceStatusPill(invoice, localDate())
  state.dataset.tone = pill.tone
  state.textContent = pill.label
  return state
}

const invoiceNumberLink = (invoice: Readonly<Invoice>): HTMLAnchorElement => {
  const link = document.createElement('a')
  link.href = invoicePagePath(invoice)
  link.textContent = `Invoice ${invoice.number}`
  return link
}

// The old list closes with a bold Total. Summing across currencies would be a
// wrong number rather than a missing one, so a mixed page shows none.
const sharedCurrency = (invoices: readonly Invoice[]): string | null => {
  const [first] = invoices
  if (first === undefined) return null
  return invoices.every((invoice) => invoice.currency === first.currency)
    ? first.currency
    : null
}

const columnTotal = (
  invoices: readonly Invoice[],
  amount: (invoice: Readonly<Invoice>) => number,
): CellContent => {
  const currency = sharedCurrency(invoices)
  // The dash a mixed-currency page shows is the absence of a total, not an
  // amount, so it is left unmarked -- masking it would draw dots over nothing.
  if (currency === null) return '—'
  return moneyText(
    money(
      invoices.reduce((sum, invoice) => sum + amount(invoice), 0),
      currency,
    ),
  )
}

export const renderInvoiceListItems = (
  invoices: readonly Invoice[],
  // A filtered list that empties is not an account with no invoices in it, and
  // the table is the only thing that says so to someone mid-search.
  empty = 'No invoices have been created or imported yet.',
): number => {
  const list = required<HTMLElement>('[data-invoice-list]')
  list.replaceChildren(
    renderDataTable<Readonly<Invoice>>({
      caption: 'Invoices',
      rows: invoices,
      rowKey: (invoice) => String(invoice.id),
      empty,
      columns: [
        { key: 'status', label: 'Status', render: invoiceStatePill },
        { key: 'number', label: 'Invoice', render: invoiceNumberLink },
        { key: 'client', label: 'Client', render: (invoice) => clientLabel(invoice.client_id) },
        { key: 'issued', label: 'Issued', render: (invoice) => dateLabel(invoice.issue_date) },
        { key: 'due-date', label: 'Due', render: invoiceDueLabel },
        {
          key: 'amount',
          label: 'Amount',
          numeric: true,
          render: (invoice) => moneyText(money(invoice.amount_cents, invoice.currency)),
          total: (rows) => columnTotal(rows, (invoice) => invoice.amount_cents),
        },
        {
          key: 'balance',
          label: 'Balance',
          numeric: true,
          render: (invoice) => moneyText(money(invoice.due_amount_cents, invoice.currency)),
          total: (rows) => columnTotal(rows, (invoice) => invoice.due_amount_cents),
        },
      ],
    }),
  )
  return invoices.length
}

const emptyHistory = (message: string): HTMLLIElement => {
  const item = document.createElement('li')
  item.className = 'invoice-history-empty'
  item.textContent = message
  return item
}

export const renderInvoiceDetail = (
  invoice: Readonly<Invoice>,
  messages: readonly InvoiceMessage[],
  payments: readonly InvoicePayment[],
  actions?: {
    readonly canWrite: boolean
    readonly onEditPayment: (payment: InvoicePayment) => void
    readonly onDeletePayment: (payment: InvoicePayment) => void
  },
): void => {
  required<HTMLElement>('[data-invoice-detail-number]').textContent = invoice.number
  const detailState = required<HTMLElement>('[data-invoice-detail-state]')
  const detailPill = invoiceStatusPill(invoice, localDate())
  detailState.dataset.tone = detailPill.tone
  detailState.textContent = detailPill.label
  required<HTMLElement>('[data-invoice-detail-client]').textContent = clientLabel(
    invoice.client_id,
  )
  required<HTMLElement>('[data-invoice-detail-issued]').textContent = dateLabel(invoice.issue_date)
  required<HTMLElement>('[data-invoice-detail-due-date]').textContent = dateLabel(invoice.due_date)
  required<HTMLElement>('[data-invoice-detail-period]').textContent = invoicePeriod(invoice) ?? '—'
  required<HTMLElement>('[data-invoice-detail-purchase-order]').textContent =
    invoice.purchase_order?.trim() || '—'

  const subject = required<HTMLElement>('[data-invoice-detail-subject]')
  subject.textContent = invoice.subject?.trim() ?? ''
  subject.hidden = subject.textContent === ''

  const reminder = invoicePlannedReminder(invoice, messages)
  const reminderLine = required<HTMLElement>('[data-invoice-reminder-line]')
  reminderLine.textContent =
    reminder === null
      ? ''
      : `Payment reminder planned for ${dateLabel(reminder)}; further reminders follow the organization's cadence, or weekly, until paid.`
  reminderLine.hidden = reminder === null

  const lines = required<HTMLTableSectionElement>('[data-invoice-detail-lines]')
  if (invoice.line_items.length === 0) {
    const row = document.createElement('tr')
    const cell = document.createElement('td')
    cell.colSpan = 5
    cell.className = 'invoice-line-empty'
    cell.textContent = 'This invoice has no line items.'
    row.append(cell)
    lines.replaceChildren(row)
  } else {
    lines.replaceChildren(
      ...invoice.line_items.map((line) => {
        const row = document.createElement('tr')
        row.dataset.invoiceLineId = String(line.id)
        const description = document.createElement('th')
        description.scope = 'row'
        const kind = document.createElement('strong')
        kind.textContent = line.kind
        description.append(kind)
        if (line.description?.trim()) {
          const detail = document.createElement('span')
          detail.textContent = line.description.trim()
          description.append(detail)
        }
        const taxes = [line.taxed ? 'Tax 1' : null, line.taxed2 ? 'Tax 2' : null]
          .filter((label): label is string => label !== null)
          .join(' · ')
        if (taxes !== '') {
          const tax = document.createElement('small')
          tax.textContent = taxes
          description.append(tax)
        }
        const quantity = document.createElement('td')
        quantity.dataset.label = 'Quantity'
        quantity.textContent = invoiceLineQuantityForForm(line)
        const rate = document.createElement('td')
        rate.dataset.label = 'Rate'
        rate.append(moneyText(money(line.unit_price_cents, invoice.currency)))
        const amount = document.createElement('td')
        amount.dataset.label = 'Amount'
        amount.append(moneyText(money(line.amount_cents, invoice.currency)))
        const controls = document.createElement('td')
        controls.className = 'invoice-line-actions'
        if (actions?.canWrite === true && invoiceCanEditLines(invoice)) {
          // Lines change on the edit page, with the rest of the document; this
          // opens it on this line. Removing one is done there too, where it can
          // still be undone until the page saves.
          const edit = document.createElement('a')
          edit.href = invoiceEditHref(invoice, { line: line.id })
          edit.dataset.invoiceLineEdit = String(line.id)
          edit.textContent = 'Edit'
          controls.append(edit)
        }
        row.append(description, quantity, rate, amount, controls)
        return row
      }),
    )
  }

  required<HTMLElement>('[data-invoice-detail-discount]').textContent = money(
    invoice.discount_amount_cents,
    invoice.currency,
  )
  required<HTMLElement>('[data-invoice-detail-tax]').textContent = money(
    invoice.tax_amount_cents + invoice.tax2_amount_cents,
    invoice.currency,
  )
  required<HTMLElement>('[data-invoice-detail-total]').textContent = money(
    invoice.amount_cents,
    invoice.currency,
  )
  required<HTMLElement>('[data-invoice-detail-due]').textContent = money(
    invoice.due_amount_cents,
    invoice.currency,
  )

  const notesSection = required<HTMLElement>('[data-invoice-detail-notes-section]')
  const notes = required<HTMLElement>('[data-invoice-detail-notes]')
  notes.textContent = invoice.notes?.trim() ?? ''
  notesSection.hidden = notes.textContent === ''

  const paymentList = required<HTMLUListElement>('[data-invoice-detail-payments]')
  paymentList.replaceChildren(
    ...(payments.length === 0
      ? [emptyHistory('No payments recorded.')]
      : payments.map((payment) => {
          const item = document.createElement('li')
          item.dataset.invoicePaymentId = String(payment.id)
          const summary = document.createElement('strong')
          summary.textContent = money(payment.amount_cents, payment.currency)
          markMoney(summary)
          const date = document.createElement('span')
          date.textContent = paymentDateLabel(payment)
          item.append(summary, date)
          const metadata = document.createElement('small')
          metadata.className = 'invoice-payment-metadata'
          const details = [`Method: ${invoicePaymentProviderLabel(payment)}`]
          if (payment.provider_transaction_id?.trim()) {
            details.push(`Reference: ${payment.provider_transaction_id.trim()}`)
          }
          metadata.textContent = details.join(' · ')
          item.append(metadata)
          if (payment.notes?.trim()) {
            const note = document.createElement('p')
            note.textContent = payment.notes
            item.append(note)
          }
          if (actions?.canWrite === true) {
            const controls = document.createElement('div')
            controls.className = 'invoice-payment-actions'
            if (invoicePaymentCanUpdate(invoice, payment)) {
              const edit = document.createElement('button')
              edit.type = 'button'
              edit.dataset.invoicePaymentEdit = String(payment.id)
              edit.textContent = 'Edit'
              edit.addEventListener('click', () => actions.onEditPayment(payment))
              controls.append(edit)
            }
            if (invoicePaymentCanDelete(invoice, payment)) {
              const remove = document.createElement('button')
              remove.type = 'button'
              remove.dataset.invoicePaymentDelete = String(payment.id)
              remove.textContent = 'Delete'
              remove.addEventListener('click', () => actions.onDeletePayment(payment))
              controls.append(remove)
            }
            if (controls.childElementCount > 0) item.append(controls)
          }
          return item
        })),
  )

  const messageList = required<HTMLUListElement>('[data-invoice-detail-messages]')
  messageList.replaceChildren(
    ...(messages.length === 0
      ? [emptyHistory('No invoice history recorded.')]
      : messages.map((message) => {
          const item = document.createElement('li')
          const event = document.createElement('strong')
          const label = invoiceMessageLabel(message)
          event.textContent = label[0]!.toLocaleUpperCase('en-US') + label.slice(1)
          const date = document.createElement('span')
          date.textContent = dateLabel(message.created_at)
          item.append(event, date)
          const named = (people: readonly { name: string; email: string }[]) =>
            people.map((recipient) => recipient.name.trim() || recipient.email).join(', ')
          const copied = message.cc ?? []
          const recipientText =
            copied.length === 0
              ? named(message.recipients)
              : `To ${named(message.recipients)}; Cc ${named(copied)}`
          const detail = [message.subject?.trim(), recipientText || null]
            .filter((value): value is string => value !== null && value !== undefined && value !== '')
            .join(' · ')
          if (detail !== '') {
            const meta = document.createElement('p')
            meta.textContent = detail
            item.append(meta)
          }
          if (message.body?.trim()) {
            const body = document.createElement('p')
            body.textContent = message.body
            item.append(body)
          }
          if (message.delivery_status?.trim()) {
            const delivery = document.createElement('small')
            delivery.textContent = `Delivery status: ${message.delivery_status}`
            item.append(delivery)
          }
          return item
        })),
  )

  required<HTMLElement>('[data-invoice-detail-status]').textContent = ''
  required<HTMLElement>('[data-invoice-document]').hidden = false
  document.title = `${document.documentElement.dataset.brand ?? 'ezacto'} — Invoice ${invoice.number}`
}

const apiMessage = invoiceApiMessage

/**
 * Harvest's subject, which every organization's invoice template starts with:
 * what the dialog shows until this client's own defaults have been read.
 */
const fallbackSubject = 'Invoice #%invoice_number% from %company_name%'
/** And a short note above the summary the email always carries. */
const fallbackMessage = 'Hello,\n\nPlease find invoice %invoice_number% below.'

const apiErrorCode = invoiceApiErrorCode

const localDate = (): string => {
  const now = new Date()
  return new Date(now.valueOf() - now.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10)
}

interface ActiveSession {
  readonly identity: Whoami
  readonly signal: AbortSignal
  readonly onSessionFailure: (error: unknown) => boolean
  readonly generation: number
}

/**
 * The attachment choices were refused before anything was sent. Kept apart
 * from the send's own failures because it means the opposite thing: nothing
 * left the building, and the held keys are untouched for the retry.
 */
class AttachmentChoicesRefused extends Error {
  constructor(
    readonly reason: unknown,
    /** What was being saved: the attachment choices, the client's defaults, the copy setting. */
    readonly what = 'The attachment choices were',
  ) {
    super(`${what} not saved.`)
  }
}

export interface InvoicePaymentController {
  activate(
    identity: Whoami,
    signal: AbortSignal,
    onSessionFailure: (error: unknown) => boolean,
  ): Promise<void>
}

export const createInvoicePaymentController = (
  api: Partial<InvoicePaymentApi>,
): InvoicePaymentController => {
  const detailPage = document.documentElement.dataset.appView === 'invoice-detail'
  const status = required<HTMLElement>('[data-invoice-detail-status]')
  const retry = required<HTMLButtonElement>('[data-invoice-detail-retry]')
  const article = required<HTMLElement>('[data-invoice-document]')
  const record = required<HTMLButtonElement>('[data-invoice-payment-record]')
  const settle = required<HTMLButtonElement>('[data-invoice-payment-settle]')
  const readonlyNotice = required<HTMLElement>('[data-invoice-payment-readonly]')
  const workflowStatus = required<HTMLElement>('[data-invoice-payment-status]')
  const paymentDialog = required<HTMLDialogElement>('[data-invoice-payment-dialog]')
  const paymentForm = required<HTMLFormElement>('[data-invoice-payment-form]')
  const paymentTitle = required<HTMLElement>('[data-invoice-payment-dialog-title]')
  const amount = required<HTMLInputElement>('[data-invoice-payment-amount]')
  const currency = required<HTMLInputElement>('[data-invoice-payment-currency]')
  const precision = required<HTMLSelectElement>('[data-invoice-payment-precision]')
  const paidDate = required<HTMLInputElement>('[data-invoice-payment-date]')
  const paidDateLabel = required<HTMLElement>('[data-invoice-payment-date-label]')
  const paidAt = required<HTMLInputElement>('[data-invoice-payment-instant]')
  const paidAtLabel = required<HTMLElement>('[data-invoice-payment-instant-label]')
  const notes = required<HTMLTextAreaElement>('[data-invoice-payment-notes]')
  const paymentResult = required<HTMLElement>('[data-invoice-payment-result]')
  const paymentSubmit = required<HTMLButtonElement>('[data-invoice-payment-submit]')
  const deleteDialog = required<HTMLDialogElement>('[data-invoice-payment-delete-dialog]')
  const deleteForm = required<HTMLFormElement>('[data-invoice-payment-delete-form]')
  const deleteSummary = required<HTMLElement>('[data-invoice-payment-delete-summary]')
  const deleteResult = required<HTMLElement>('[data-invoice-payment-delete-result]')
  const deleteSubmit = required<HTMLButtonElement>('[data-invoice-payment-delete-submit]')
  const send = required<HTMLButtonElement>('[data-invoice-send]')
  const quickBooksSync = required<HTMLButtonElement>('[data-invoice-quickbooks-sync]')
  const quickBooksFact = required<HTMLElement>('[data-invoice-quickbooks-fact]')
  const quickBooksLine = required<HTMLElement>('[data-invoice-detail-quickbooks]')
  const remindersFact = required<HTMLElement>('[data-invoice-reminders-fact]')
  const remindersLine = required<HTMLElement>('[data-invoice-detail-reminders]')
  const remindersToggle = required<HTMLInputElement>('[data-invoice-reminders-toggle]')
  const composerDialog = required<HTMLDialogElement>('[data-invoice-composer-dialog]')
  const composerForm = required<HTMLFormElement>('[data-invoice-composer-form]')
  const composerTitle = required<HTMLElement>('[data-invoice-composer-title]')
  const composerRecipients = required<HTMLTextAreaElement>('[data-invoice-composer-recipients]')
  const composerCc = required<HTMLTextAreaElement>('[data-invoice-composer-cc]')
  const composerRecipientsSource = required<HTMLElement>('[data-invoice-composer-recipients-source]')
  const composerAlwaysCc = required<HTMLElement>('[data-invoice-composer-always-cc]')
  const composerCopyLabel = required<HTMLElement>('[data-invoice-composer-copy-label]')
  const composerCopy = required<HTMLInputElement>('[data-invoice-composer-copy]')
  const composerCopyAddress = required<HTMLElement>('[data-invoice-composer-copy-address]')
  const composerAppendLabel = required<HTMLElement>('[data-invoice-composer-append-label]')
  const composerAppend = required<HTMLInputElement>('[data-invoice-composer-append]')
  const composerSaveDefaultLabel = required<HTMLElement>('[data-invoice-composer-save-default-label]')
  const composerSaveDefault = required<HTMLInputElement>('[data-invoice-composer-save-default]')
  const composerPreviewActions = required<HTMLElement>('[data-invoice-composer-preview-actions]')
  const composerPreview = required<HTMLButtonElement>('[data-invoice-composer-preview]')
  const composerPreviewSend = required<HTMLButtonElement>('[data-invoice-composer-preview-send]')
  const composerPreviewResult = required<HTMLElement>('[data-invoice-composer-preview-result]')
  const composerPreviewPanel = required<HTMLElement>('[data-invoice-composer-preview-panel]')
  const composerSubject = required<HTMLInputElement>('[data-invoice-composer-subject]')
  const composerBody = required<HTMLTextAreaElement>('[data-invoice-composer-body]')
  const composerReminderToggle = required<HTMLInputElement>('[data-invoice-composer-reminder-toggle]')
  const composerReminderDateLabel = required<HTMLElement>('[data-invoice-composer-reminder-date-label]')
  const composerReminderDate = required<HTMLInputElement>('[data-invoice-composer-reminder-date]')
  const composerDeliverToggle = required<HTMLInputElement>(
    '[data-invoice-composer-deliver-toggle]',
  )
  const composerNoEmail = required<HTMLElement>('[data-invoice-composer-no-email]')
  const composerDeliveryUnavailable = required<HTMLElement>(
    '[data-invoice-composer-delivery-unavailable]',
  )
  const composerOwed = required<HTMLElement>('[data-invoice-composer-owed]')
  const composerConfirmLabel = required<HTMLElement>('[data-invoice-composer-confirm-label]')
  const composerConfirm = required<HTMLInputElement>('[data-invoice-composer-confirm]')
  const composerResult = required<HTMLElement>('[data-invoice-composer-result]')
  const composerSubmit = required<HTMLButtonElement>('[data-invoice-composer-submit]')
  const composerAttachments = required<HTMLFieldSetElement>('[data-invoice-composer-attachments]')
  const composerAttachPdf = required<HTMLInputElement>('[data-invoice-composer-attach-pdf]')
  const composerAttachJournal = required<HTMLInputElement>('[data-invoice-composer-attach-journal]')
  const composerJournalLevel = required<HTMLSelectElement>('[data-invoice-composer-journal-level]')
  const composerJournalFormats = required<HTMLFieldSetElement>(
    '[data-invoice-composer-journal-formats]',
  )
  const composerAttachFilesLabel = required<HTMLElement>(
    '[data-invoice-composer-attach-files-label]',
  )
  const composerAttachFiles = required<HTMLInputElement>('[data-invoice-composer-attach-files]')
  const composerAttachmentsStatus = required<HTMLElement>(
    '[data-invoice-composer-attachments-status]',
  )
  const overflow = required<HTMLElement>('[data-invoice-overflow]')
  const overflowToggle = required<HTMLButtonElement>('[data-invoice-overflow-toggle]')
  const overflowMenu = required<HTMLElement>('[data-invoice-overflow-menu]')
  const overflowItems = new Map<InvoiceOverflowCommand, HTMLButtonElement>(
    invoiceOverflowTransitions.map((transition) => [
      transition.command,
      required<HTMLButtonElement>(`[data-invoice-transition="${transition.command}"]`),
    ]),
  )
  const transitionDialog = required<HTMLDialogElement>('[data-invoice-transition-dialog]')
  const transitionForm = required<HTMLFormElement>('[data-invoice-transition-form]')
  const transitionTitle = required<HTMLElement>('[data-invoice-transition-title]')
  const transitionSummary = required<HTMLElement>('[data-invoice-transition-summary]')
  const transitionResult = required<HTMLElement>('[data-invoice-transition-result]')
  const transitionSubmit = required<HTMLButtonElement>('[data-invoice-transition-submit]')
  const printInvoice = required<HTMLButtonElement>('[data-invoice-print]')
  const hoursExport = required<HTMLElement>('[data-invoice-hours-export]')
  const hoursToggle = required<HTMLButtonElement>('[data-invoice-hours-toggle]')
  const hoursMenu = required<HTMLElement>('[data-invoice-hours-menu]')
  const editInvoice = required<HTMLAnchorElement>('[data-invoice-edit]')
  const addLine = required<HTMLAnchorElement>('[data-invoice-line-add]')
  const lineReadonlyNotice = required<HTMLElement>('[data-invoice-line-readonly]')
  const attachmentForm = required<HTMLFormElement>('[data-invoice-attachment-form]')
  const attachmentSubmit = required<HTMLButtonElement>('[data-invoice-attachment-submit]')
  const attachmentStatus = required<HTMLElement>('[data-invoice-attachment-status]')
  const attachmentList = required<HTMLUListElement>('[data-invoice-attachments]')
  const attachmentReadonly = required<HTMLElement>('[data-invoice-attachment-readonly]')
  // The public demo takes no files (issue 931): the form is withheld and the
  // note says why, for every profile.
  const attachmentDemo = required<HTMLElement>('[data-invoice-attachment-demo]')
  const demo = isDemoDeployment()
  // And its mail reaches only approved addresses, so the dialog says so
  // before anyone types a client's address into it -- without saying which.
  const mailRestricted = isDemoMailRestricted()
  required<HTMLElement>('[data-invoice-composer-demo]').hidden = !mailRestricted

  let activationGeneration = 0
  let requestGeneration = 0
  let active: ActiveSession | null = null
  let invoice: Invoice | null = null
  let payments: readonly InvoicePayment[] = []
  let attachments: readonly Attachment[] = []
  let attachmentCommandId: string | null = null
  let editingPayment: InvoicePayment | null = null
  let deletingPayment: InvoicePayment | null = null
  let mutationPending = false
  let refreshRequired = false
  let paymentCommandId: string | null = null
  let settleCommandId: string | null = null
  let deleteCommandId: string | null = null
  // The send transition and the email are two commands, so a delivery that
  // fails after the transition committed must retry the email alone. What has
  // been attempted, what is owed and at which version is one value rather than
  // a pair of command ids and a flag: three code paths each had their own
  // reason to reset the flag, and any one of them rearmed the transition.
  let sendAttempt: InvoiceSendAttempt | null = null
  let pendingTransition: InvoiceOverflowCommand | null = null
  let transitionCommandId: string | null = null
  // Null until the state has loaded, and null for good where the deployment
  // has no QuickBooks routes: the line and the button follow it (issue 819).
  let quickBooks: InvoiceQuickBooksState | null = null
  let reminders: InvoiceReminderPreference | null = null
  let remindersSaving = false
  let quickBooksSyncing = false
  // What this invoice's email carries now, as the server resolved it when the
  // Send dialog opened: null until it is read, and when it cannot be.
  let documentPreference: InvoiceDocumentPreference | null = null
  let documentPreferenceLoading = false
  let documentPreferenceGeneration = 0
  // What the dialog opened on: the client's To and Cc, the organization's
  // copies, the template's words and whether the sender is copied. Null until
  // read, and when it cannot be -- the dialog then opens on plain defaults.
  let emailDefaults: InvoiceEmailDefaults | null = null
  let emailDefaultsLoading = false
  let emailDefaultsGeneration = 0
  // Why the email cannot leave, as the server would refuse it; null while it
  // can, or before that is known. Read with the defaults on every opening.
  let deliveryRefusal: string | null = null
  // Whether the operator has set the delivery box in this opening. Their
  // choice stands; the server's answer only moves a box nobody has touched.
  let deliveryChosen = false
  let previewPending = false

  const current = (): ActiveSession | null =>
    active !== null &&
    active.generation === activationGeneration &&
    !active.signal.aborted
      ? active
      : null

  const commandId = (kind: 'record' | 'update' | 'delete'): string =>
    `web.invoice.payment.${kind}:${globalThis.crypto.randomUUID()}`

  const syncPrecision = (): void => {
    const timestamp = precision.value === 'timestamp'
    const controlsLocked = mutationPending || refreshRequired
    paidDateLabel.hidden = timestamp
    paidDate.disabled = timestamp || controlsLocked
    paidDate.required = !timestamp
    paidAtLabel.hidden = !timestamp
    paidAt.disabled = !timestamp || controlsLocked
    paidAt.required = timestamp
  }

  // The one question the composer asks of the attempt: does a committed send
  // still owe its email, and to whom? Every place that used to keep its own
  // copy of that answer -- the submit, the dialog's labels, the retry hint --
  // asks here instead.
  const owedDelivery = (): InvoiceSendDelivery | null => {
    if (invoice === null) return null
    const live = invoiceSendAttemptFor(sendAttempt, invoice.id)
    return live !== null && invoiceSendWork(live, invoice.id, true) === 'delivery'
      ? live.delivery
      : null
  }

  const emailOwed = (): boolean => owedDelivery() !== null

  // Nothing typed in the composer can change an email that is already owed: it
  // leaves on the organization template, to the recipients the committed send
  // confirmed, under the command id that makes the retry a retry. Freeze those
  // fields rather than let an edit look like it will be honored.
  const composerFrozen = (): boolean => emailOwed() || mutationPending || refreshRequired

  const syncReminder = (): void => {
    const scheduled = composerReminderToggle.checked
    composerReminderDateLabel.hidden = !scheduled
    composerReminderDate.disabled = !scheduled || composerFrozen()
    composerReminderDate.required = scheduled
  }

  // The confirmation is the gate on the email leaving the building, so it only
  // exists while the email is being asked for. Recording the sent status is not
  // the irreversible half and never carried one.
  const syncComposer = (): void => {
    const delivering = composerDeliverToggle.checked
    const owed = emailOwed()
    composerOwed.hidden = !owed
    composerTitle.textContent = owed
      ? 'Finish sending invoice'
      : invoice?.state === 'open' && typeof invoice.sent_at === 'string'
        ? 'Send invoice again'
        : 'Send invoice'
    composerConfirmLabel.hidden = !delivering
    composerConfirm.disabled = !delivering || mutationPending || refreshRequired
    // The button names the request this submit will make. With the send already
    // recorded there is no send left to offer, and unticking the email is an
    // operator abandoning it rather than a second thing to record. Recording
    // alone used to be labelled "Send invoice" too, so a submit that emailed
    // nobody read as a send.
    composerSubmit.textContent = owed
      ? delivering
        ? 'Retry the email'
        : 'Skip the email'
      : delivering
        ? 'Send and deliver'
        : 'Mark as sent (no email)'
    composerNoEmail.hidden = owed || delivering
    composerDeliveryUnavailable.hidden = owed || deliveryRefusal === null
    composerDeliveryUnavailable.textContent =
      deliveryRefusal === null ? '' : `Email delivery is unavailable. ${deliveryRefusal}`.trim()
    const frozen = composerFrozen()
    composerRecipients.disabled = frozen
    composerCc.disabled = frozen
    composerCopy.disabled = frozen
    composerSubject.disabled = frozen
    composerBody.disabled = frozen
    composerReminderToggle.disabled = frozen
    // Saving the lists as the client's rules goes with an email being sent; it
    // is a setting, not part of the delivery a retry repeats.
    composerSaveDefaultLabel.hidden = !delivering || api.setClientInvoiceSending === undefined
    composerSaveDefault.disabled = mutationPending || refreshRequired
    // A preview needs nothing but the words on screen, and changes nothing.
    composerPreviewActions.hidden = !delivering || api.previewInvoiceEmail === undefined
    composerPreview.disabled = previewPending || mutationPending || refreshRequired
    composerPreviewSend.disabled =
      previewPending || mutationPending || refreshRequired || api.sendInvoiceEmailPreview === undefined
    composerPreviewSend.hidden = api.sendInvoiceEmailPreview === undefined
    if (!delivering) composerPreviewPanel.hidden = true
    syncAttachments()
  }

  const attachmentsOffered = (): boolean =>
    api.getInvoiceDocumentPreference !== undefined && api.setInvoiceDocumentPreference !== undefined

  const journalFormatBoxes = (): HTMLInputElement[] => [
    ...composerJournalFormats.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  ]

  const chosenAttachments = (): InvoiceAttachmentChoice => ({
    pdf: composerAttachPdf.checked,
    files: composerAttachFiles.checked,
    append: composerAppend.checked,
    journal: composerAttachJournal.checked
      ? composerJournalLevel.value === 'summary'
        ? 'summary'
        : 'detailed'
      : false,
    journalFormats: journalFormatBoxes()
      .filter((box) => box.checked)
      .map((box) => box.value as InvoiceJournalFormat),
  })

  const showAttachments = (choice: InvoiceAttachmentChoice): void => {
    composerAttachPdf.checked = choice.pdf
    composerAttachFiles.checked = choice.files
    composerAppend.checked = choice.append
    composerAttachJournal.checked = choice.journal !== false
    composerJournalLevel.value = choice.journal === false ? 'detailed' : choice.journal
    for (const box of journalFormatBoxes()) {
      box.checked = choice.journalFormats.includes(box.value as InvoiceJournalFormat)
    }
  }

  // Attachments go with the email, so they are offered while it is being
  // sent and read-only otherwise -- and only once the invoice's own answer is
  // in, because each box opens on what the invoice would do anyway, and a box
  // ticked before that answer arrives is a change from nothing anybody saw.
  // Unlike the recipients they stay open while an email is owed: they are
  // the invoice's setting, read when the email is built, not part of the
  // delivery command a retry has to repeat.
  const syncAttachments = (): void => {
    composerAttachments.hidden = !attachmentsOffered()
    const delivering = composerDeliverToggle.checked
    const usable =
      delivering &&
      documentPreference !== null &&
      !documentPreferenceLoading &&
      !mutationPending &&
      !refreshRequired
    composerAttachPdf.disabled = !usable
    composerAttachJournal.disabled = !usable
    composerJournalLevel.disabled = !usable
    composerJournalLevel.hidden = !composerAttachJournal.checked
    composerJournalFormats.hidden = !composerAttachJournal.checked
    for (const box of journalFormatBoxes()) box.disabled = !usable
    // Files only where the invoice has some to send.
    composerAttachFilesLabel.hidden = attachments.length === 0
    composerAttachFiles.disabled = !usable
    // Binding files into the invoice's PDF needs the PDF, and files to bind.
    composerAppendLabel.hidden = attachments.length === 0
    composerAppend.disabled = !usable || !composerAttachPdf.checked
    composerAttachmentsStatus.textContent = documentPreferenceLoading
      ? 'Reading what this invoice attaches…'
      : documentPreference === null
        ? 'What this invoice attaches could not be read, so the email goes with its saved choices.'
        : delivering
          ? ''
          : 'Attachments go with the email, so they are chosen once it is to be delivered.'
    composerAttachmentsStatus.hidden = composerAttachmentsStatus.textContent === ''
  }

  const loadDocumentPreference = async (session: ActiveSession, invoiceId: number): Promise<void> => {
    const generation = ++documentPreferenceGeneration
    documentPreference = null
    documentPreferenceLoading = true
    showAttachments({ pdf: false, files: false, append: false, journal: false, journalFormats: ['pdf'] })
    syncComposer()
    try {
      const preference = await api.getInvoiceDocumentPreference!(invoiceId, session.signal)
      if (current() !== session || generation !== documentPreferenceGeneration) return
      documentPreference = preference
      showAttachments(invoiceAttachmentsEffective(preference))
    } catch (error) {
      if (current() !== session || generation !== documentPreferenceGeneration) return
      if (session.onSessionFailure(error)) {
        clearPrivatePresentation()
        active = null
        return
      }
      documentPreference = null
    } finally {
      if (current() === session && generation === documentPreferenceGeneration) {
        documentPreferenceLoading = false
        syncComposer()
      }
    }
  }

  /**
   * What the dialog opens on for this invoice: the client's To and Cc -- its
   * saved lists, else its contacts' invoice routing -- the organization's
   * copies, the template's subject and message, and whether the person sending
   * is copied. A field somebody has already typed into is left as they left it.
   */
  const loadEmailDefaults = async (
    session: ActiveSession,
    invoiceId: number,
    fill: boolean,
  ): Promise<void> => {
    const generation = ++emailDefaultsGeneration
    emailDefaults = null
    if (api.getInvoiceEmailDefaults === undefined) return
    emailDefaultsLoading = true
    const untouched = {
      to: composerRecipients.value,
      cc: composerCc.value,
      subject: composerSubject.value,
      message: composerBody.value,
    }
    let loaded: InvoiceEmailDefaults
    try {
      loaded = await api.getInvoiceEmailDefaults(invoiceId, session.signal)
    } catch (error) {
      if (current() !== session || generation !== emailDefaultsGeneration) return
      // Unreadable is not a reason to hold the send: the dialog keeps the
      // plain defaults it opened on, and says nothing it does not know.
      emailDefaultsLoading = false
      if (session.onSessionFailure(error)) {
        clearPrivatePresentation()
        active = null
      }
      return
    }
    if (current() !== session || generation !== emailDefaultsGeneration) return
    emailDefaultsLoading = false
    emailDefaults = loaded
    composerAlwaysCc.textContent =
      loaded.always_cc.length === 0
        ? ''
        : `Also copied on every invoice email: ${loaded.always_cc.map(invoiceRecipientLine).join(', ')}.`
    composerAlwaysCc.hidden = loaded.always_cc.length === 0
    if (!fill) return
    // The box opened delivering on the expectation that the email can leave.
    // Where it cannot, it records alone and says why -- unless the operator
    // has already set it, in which case their choice stands.
    deliveryRefusal = loaded.delivery.available ? null : (loaded.delivery.message ?? '')
    if (!deliveryChosen) {
      composerDeliverToggle.checked =
        loaded.delivery.available && api.deliverInvoiceEmail !== undefined
    }
    if (composerRecipients.value === untouched.to) {
      composerRecipients.value = loaded.to.map(invoiceRecipientLine).join('\n')
    }
    if (composerCc.value === untouched.cc) {
      composerCc.value = loaded.cc.map(invoiceRecipientLine).join('\n')
    }
    if (composerSubject.value === untouched.subject) composerSubject.value = loaded.subject
    if (composerBody.value === untouched.message) composerBody.value = loaded.message
    composerRecipientsSource.textContent =
      loaded.recipients_source === 'client'
        ? "From this client's saved recipients."
        : loaded.to.length + loaded.cc.length === 0
          ? 'This client has no invoice recipients yet.'
          : "From the client's contacts marked Recipient (To) and CC."
    const address = loaded.sender.email
    composerCopyLabel.hidden = address === null
    composerCopy.checked = address !== null && loaded.send_me_a_copy
    composerCopyAddress.textContent = address === null ? '' : `(${address})`
    syncComposer()
  }

  /**
   * The email as the Send dialog has it right now -- the To and Cc lines, the
   * subject and message as typed, the copy, and the attachment boxes -- for a
   * preview. Throws the sentence to show when a field cannot be read.
   */
  const previewRequest = (): Parameters<NonNullable<typeof api.previewInvoiceEmail>>[1] => {
    const owed = owedDelivery()
    const to = owed?.recipients ?? invoiceRecipients(composerRecipients.value)
    const cc = owed?.cc ?? invoiceCopies(composerCc.value, to)
    const subject = owed?.subject ?? composerSubject.value.trim()
    const message = owed?.message ?? composerBody.value.trimEnd()
    for (const problem of [
      invoiceTemplateProblem(subject, 'Subject'),
      invoiceTemplateProblem(message, 'Message'),
    ]) {
      if (problem !== null) throw new Error(problem)
    }
    const choice = chosenAttachments()
    return {
      recipients: [...to],
      cc: [...cc],
      subject,
      message,
      send_me_a_copy: owed?.sendMeACopy ?? (!composerCopyLabel.hidden && composerCopy.checked),
      ...(documentPreference === null
        ? {}
        : {
            attach_pdf: choice.pdf,
            append_pdfs: choice.append,
            ...(attachments.length === 0 ? {} : { attach_files: choice.files }),
            attach_journal: choice.journal,
            ...(choice.journal === false || choice.journalFormats.length === 0
              ? {}
              : { journal_formats: [...choice.journalFormats] }),
          }),
    }
  }

  const byteSize = (bytes: number): string =>
    new Intl.NumberFormat('en-US', {
      style: 'unit',
      unit: bytes >= 1_000_000 ? 'megabyte' : 'kilobyte',
      unitDisplay: 'short',
      maximumFractionDigits: 1,
    }).format(bytes >= 1_000_000 ? bytes / 1_000_000 : Math.max(1, bytes / 1_000))

  const notAppendedReason: Readonly<Record<string, string>> = {
    encrypted: 'it is password-protected, so it goes beside the invoice',
    unreadable: 'it could not be read as a PDF, so it goes beside the invoice',
    empty: 'it has no pages, so it goes beside the invoice',
    too_large: 'it is too large to bind in, so it goes beside the invoice',
  }

  const renderPreview = (preview: InvoiceEmailPreview): void => {
    const people = (list: readonly { name: string; email: string }[]) =>
      list.length === 0 ? '—' : list.map(invoiceRecipientLine).join(', ')
    required<HTMLElement>('[data-invoice-preview-from]').textContent = invoiceRecipientLine(preview.email.from)
    required<HTMLElement>('[data-invoice-preview-to]').textContent = people(preview.email.to)
    required<HTMLElement>('[data-invoice-preview-cc]').textContent = people(preview.email.cc)
    required<HTMLElement>('[data-invoice-preview-subject]').textContent = preview.email.subject
    required<HTMLElement>('[data-invoice-preview-text]').textContent = preview.email.text
    const list = required<HTMLUListElement>('[data-invoice-preview-attachments]')
    list.replaceChildren(
      ...(preview.email.attachments.length === 0
        ? [Object.assign(document.createElement('li'), { textContent: 'No attachments.' })]
        : preview.email.attachments.map((attachment) => {
            const item = document.createElement('li')
            const behind =
              attachment.appended.length === 0
                ? ''
                : ` — with ${attachment.appended.join(', ')} at the back`
            const beside =
              attachment.not_appended === null ? '' : ` — ${notAppendedReason[attachment.not_appended]}`
            item.textContent = `${attachment.filename} (${byteSize(attachment.byte_size)})${behind}${beside}`
            return item
          })),
    )
    const download = required<HTMLAnchorElement>('[data-invoice-preview-document]')
    const document_ = preview.email.attachments.find(({ kind }) => kind === 'invoice')
    download.hidden = document_ === undefined
    if (document_ !== undefined) {
      download.href = preview.documentHref
      download.download = document_.filename
    }
    composerPreviewPanel.hidden = false
  }

  const runPreview = (sendToMe: boolean): void => {
    const session = current()
    const selected = invoice
    if (session === null || selected === null || previewPending) return
    let input: ReturnType<typeof previewRequest>
    try {
      input = previewRequest()
    } catch (error) {
      composerPreviewResult.textContent = apiMessage(error)
      return
    }
    previewPending = true
    composerPreviewResult.textContent = sendToMe ? 'Sending a preview to you…' : 'Composing the preview…'
    syncComposer()
    const request = sendToMe
      ? api.sendInvoiceEmailPreview!(selected.id, input, session.signal).then((sent) => {
          if (current() !== session) return
          const to = sent.to.map(({ email }) => email).join(', ')
          composerPreviewResult.textContent = mailRestricted
            ? `A preview for ${to}, stamped PREVIEW, was recorded. ${DEMO_MAIL_NOTE} Nothing was sent to the client.`
            : `A preview went to ${to} only, stamped PREVIEW. Nothing was sent to the client.`
        })
      : api.previewInvoiceEmail!(selected.id, input, session.signal).then((preview) => {
          if (current() !== session) return
          renderPreview(preview)
          composerPreviewResult.textContent = ''
        })
    void request
      .catch((error: unknown) => {
        if (current() !== session) return
        if (session.onSessionFailure(error)) {
          clearPrivatePresentation()
          active = null
          return
        }
        // The server words a 503 for nobody, but on these routes it has one
        // cause: no mail transport, so there is no email to compose or send.
        composerPreviewResult.textContent =
          error instanceof EzactoApiError && error.status === 503
            ? 'Email delivery is not set up on this instance, so there is no email to preview.'
            : apiMessage(error)
      })
      .finally(() => {
        if (current() === session) {
          previewPending = false
          syncComposer()
        }
      })
  }

  const closeOverflow = (): void => {
    overflowMenu.hidden = true
    overflowToggle.setAttribute('aria-expanded', 'false')
  }

  const closeHoursMenu = (): void => {
    hoursMenu.hidden = true
    hoursToggle.setAttribute('aria-expanded', 'false')
  }

  /**
   * A link that is either on offer or says why not. An anchor without an href
   * is not focusable and goes nowhere, which is the disabled state a link has;
   * the title carries the reason the way the old button's did.
   */
  const offerLink = (link: HTMLAnchorElement, href: string | null, refusal: string): void => {
    if (href === null) {
      link.removeAttribute('href')
      link.setAttribute('aria-disabled', 'true')
      link.title = link.hidden ? '' : refusal
      return
    }
    link.href = href
    link.removeAttribute('aria-disabled')
    link.title = ''
  }

  const syncControls = (): void => {
    const session = current()
    const canWrite =
      session !== null && invoice !== null && invoiceIdentityCanWrite(session.identity)
    const canRecord = canWrite && invoice !== null && invoiceCanRecordPayment(invoice)
    const controlsLocked = mutationPending || refreshRequired
    record.hidden = !canWrite
    record.disabled = controlsLocked || !canRecord
    // The same gate as Record payment, because it is the same operation with the
    // three fields already answered. The amount is on the label rather than
    // behind a confirmation: a button that names the sum it is about to settle
    // tells the reader more than a dialog asking whether they meant it, and a
    // payment can be deleted afterwards, which restores the balance.
    settle.hidden = !canWrite
    settle.disabled = controlsLocked || !canRecord
    settle.textContent =
      invoice !== null && canRecord
        ? `Mark paid · ${money(invoice.due_amount_cents, invoice.currency)}`
        : 'Mark paid'
    // One reason, held in one place. Both buttons are refused by the same gate,
    // so reading it off the other button would have made one of them a pass
    // behind whichever was assigned first.
    const paymentRefusal =
      canWrite && !canRecord
        ? invoice?.state === 'draft'
          ? 'Payments can be recorded after this invoice is open.'
          : invoice?.state === 'closed'
            ? 'Payments cannot be recorded on a closed invoice.'
            : 'This invoice has no remaining amount due.'
        : ''
    record.title = paymentRefusal
    settle.title = paymentRefusal
    // Shown only where the state loaded -- a build without the routes, or a
    // deployment without Intuit keys, has nothing to sync into. Disabled while a
    // sync runs, and with a reason where there is nothing to sync: a draft is
    // not a document of record, and the mirror will not put one in somebody's
    // books until it is sent; a closed one was cancelled or written off. The
    // runtime refuses both on its own; the button only says so first.
    const canSync =
      canWrite &&
      invoice !== null &&
      quickBooks !== null &&
      api.syncInvoiceQuickBooks !== undefined
    quickBooksSync.hidden = !canSync
    const syncRefusal = !canSync
      ? ''
      : !quickBooks!.connected
        ? 'Connect QuickBooks under Settings → Integrations first.'
        : invoice!.state === 'draft'
          ? 'Drafts are not mirrored. Send the invoice first.'
          : invoice!.state === 'closed'
            ? 'A closed invoice is not mirrored.'
            : ''
    quickBooksSync.disabled =
      !canSync || controlsLocked || quickBooksSyncing || syncRefusal !== ''
    quickBooksSync.title = syncRefusal
    const canSend = canWrite && invoice !== null && invoiceCanMarkSent(invoice)
    send.hidden = !canSend
    send.disabled = controlsLocked || !canSend
    send.textContent =
      invoice?.state === 'open' && typeof invoice.sent_at === 'string'
        ? 'Send invoice again'
        : 'Send invoice'
    let anyTransition = false
    for (const transition of invoiceOverflowTransitions) {
      const item = overflowItems.get(transition.command)!
      const available =
        canWrite &&
        invoice !== null &&
        invoiceCanIssueTransition(invoice, payments.length, transition.command)
      item.hidden = !available
      item.disabled = controlsLocked || !available
      if (available) anyTransition = true
    }
    overflow.hidden = !anyTransition
    // Reading, not writing: anyone who can see the invoice can export its hours.
    hoursExport.hidden = invoice === null || api.downloadInvoiceHoursReport === undefined
    if (hoursExport.hidden) closeHoursMenu()
    overflowToggle.disabled = controlsLocked || !anyTransition
    if (!anyTransition || controlsLocked) closeOverflow()
    readonlyNotice.hidden = session === null || canWrite
    const canEditLines = canWrite && invoice !== null && invoiceCanEditLines(invoice)
    // Both lead to the edit page, which reads the invoice afresh, so neither
    // waits on a command in flight here. A closed invoice rejects every native
    // edit, so the document and its lines share one gate, and the link says why
    // rather than going anywhere.
    addLine.hidden = !canWrite
    offerLink(
      addLine,
      canEditLines ? invoiceEditHref(invoice!, 'new-line') : null,
      'Line items cannot be changed on a closed invoice.',
    )
    lineReadonlyNotice.hidden = session === null || canWrite
    editInvoice.hidden = !canWrite
    offerLink(
      editInvoice,
      canEditLines ? invoiceEditHref(invoice!) : null,
      'A closed invoice can no longer be edited.',
    )
    for (const control of paymentForm.querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement
    >('input, select, textarea, button')) {
      control.disabled = controlsLocked
    }
    syncPrecision()
    paymentSubmit.disabled = controlsLocked
    deleteSubmit.disabled = controlsLocked
    for (const control of article.querySelectorAll<HTMLButtonElement>(
      '[data-invoice-payment-edit], [data-invoice-payment-delete]',
    )) {
      control.disabled = controlsLocked
    }
    for (const control of composerForm.querySelectorAll<
      HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement
    >('input, textarea, button')) {
      control.disabled = controlsLocked
    }
    for (const control of transitionForm.querySelectorAll<HTMLButtonElement>('button')) {
      control.disabled = controlsLocked
    }
    transitionSubmit.disabled = controlsLocked
    syncReminder()
    syncComposer()
  }

  const closeDialogs = (): void => {
    if (paymentDialog.open) paymentDialog.close()
    if (deleteDialog.open) deleteDialog.close()
    if (composerDialog.open) composerDialog.close()
    if (transitionDialog.open) transitionDialog.close()
    closeOverflow()
  }

  const renderAttachments = (): void => {
    if (attachments.length === 0) {
      const empty = document.createElement('li')
      empty.className = 'invoice-attachment-empty'
      empty.textContent = 'No files are attached to this invoice.'
      attachmentList.replaceChildren(empty)
      return
    }
    attachmentList.replaceChildren(
      ...attachments.map((attachment) => {
        const item = document.createElement('li')
        const link = document.createElement('a')
        link.href = `/api/v1/invoices/${invoice!.id}/attachments/${attachment.id}/content`
        link.textContent = attachment.name
        link.download = attachment.name
        link.dataset.invoiceAttachmentLink = ''
        const size = document.createElement('span')
        size.textContent = new Intl.NumberFormat('en-US', {
          style: 'unit',
          unit: 'byte',
          unitDisplay: 'narrow',
          notation: attachment.byte_size >= 1_000_000 ? 'compact' : 'standard',
          maximumFractionDigits: 1,
        }).format(attachment.byte_size)
        item.append(link, size)
        return item
      }),
    )
  }

  const loadAttachments = async (session: ActiveSession, invoiceId: number): Promise<void> => {
    if (api.listInvoiceAttachments === undefined) {
      attachmentStatus.textContent = 'Attachment storage is unavailable in this build.'
      return
    }
    try {
      attachments = await api.listInvoiceAttachments(invoiceId, session.signal)
      if (current() !== session) return
      attachmentStatus.textContent =
        `${attachments.length} ${attachments.length === 1 ? 'file' : 'files'} attached.`
      renderAttachments()
      // The Send dialog offers the files only once there are some.
      syncAttachments()
    } catch (error) {
      if (current() !== session) return
      if (session.onSessionFailure(error)) return
      attachments = []
      renderAttachments()
      attachmentStatus.textContent = apiMessage(error)
    }
  }

  const renderQuickBooks = (): void => {
    if (quickBooks === null) {
      quickBooksFact.hidden = true
      quickBooksLine.textContent = '—'
      return
    }
    quickBooksLine.textContent = invoiceQuickBooksLine(quickBooks, (value) =>
      dateLabel(value),
    )
    quickBooksFact.hidden = false
  }

  /**
   * Loaded beside the invoice rather than with it, the way attachments are: it
   * is a fact about the invoice, not the invoice, and a deployment without the
   * routes answers 404 -- which is "there is no line here", not an error the
   * page has to show.
   */
  const loadQuickBooks = async (session: ActiveSession, invoiceId: number): Promise<void> => {
    if (api.getInvoiceQuickBooks === undefined) {
      quickBooks = null
      renderQuickBooks()
      syncControls()
      return
    }
    try {
      const state = await api.getInvoiceQuickBooks(invoiceId, session.signal)
      if (current() !== session) return
      quickBooks = state
    } catch (error) {
      if (current() !== session) return
      if (session.onSessionFailure(error)) return
      quickBooks = null
      if (!(error instanceof EzactoApiError && error.status === 404)) {
        quickBooksFact.hidden = false
        quickBooksLine.textContent = apiMessage(error)
        syncControls()
        return
      }
    }
    renderQuickBooks()
    syncControls()
  }

  const renderReminders = (): void => {
    if (reminders === null) {
      remindersFact.hidden = true
      remindersLine.textContent = '—'
      return
    }
    remindersLine.textContent = invoiceRemindersLine(reminders, (value) => dateLabel(value))
    remindersToggle.checked = reminders.reminders !== false
    remindersToggle.disabled = remindersSaving
    remindersFact.hidden = false
  }

  /**
   * The Reminders fact (issue 850), loaded the way the QuickBooks one is: a
   * fact beside the invoice. Only an open invoice can be reminded, so the
   * fact is for those; a route that is missing or refused to this profile is
   * "no fact here", not an error.
   */
  const loadReminders = async (session: ActiveSession, invoiceId: number): Promise<void> => {
    reminders = null
    if (api.getInvoiceReminderPreference === undefined || invoice === null || invoice.state !== 'open') {
      renderReminders()
      return
    }
    try {
      const preference = await api.getInvoiceReminderPreference(invoiceId, session.signal)
      if (current() !== session) return
      reminders = preference
    } catch (error) {
      if (current() !== session) return
      if (session.onSessionFailure(error)) return
      reminders = null
    }
    renderReminders()
  }

  const clearPrivatePresentation = (): void => {
    invoice = null
    payments = []
    attachments = []
    quickBooks = null
    reminders = null
    quickBooksSyncing = false
    attachmentCommandId = null
    editingPayment = null
    deletingPayment = null
    mutationPending = false
    refreshRequired = false
    paymentCommandId = null
    settleCommandId = null
    deleteCommandId = null
    sendAttempt = null
    pendingTransition = null
    transitionCommandId = null
    documentPreference = null
    documentPreferenceLoading = false
    documentPreferenceGeneration += 1
    emailDefaults = null
    emailDefaultsLoading = false
    emailDefaultsGeneration += 1
    previewPending = false
    composerPreviewPanel.hidden = true
    composerPreviewResult.textContent = ''
    closeDialogs()
    paymentForm.reset()
    deleteForm.reset()
    composerForm.reset()
    attachmentForm.reset()
    paymentResult.textContent = ''
    deleteResult.textContent = ''
    composerResult.textContent = ''
    transitionResult.textContent = ''
    workflowStatus.textContent = ''
    attachmentStatus.textContent = ''
    attachmentList.replaceChildren()
    attachmentForm.hidden = true
    renderQuickBooks()
    status.textContent = 'Loading invoice…'
    retry.hidden = true
    article.hidden = true
    article.removeAttribute('aria-busy')
    document.title = document.title.replace(/\s—\sInvoice.*$/u, '')
    for (const selector of [
      '[data-invoice-detail-number]',
      '[data-invoice-detail-state]',
      '[data-invoice-detail-client]',
      '[data-invoice-detail-issued]',
      '[data-invoice-detail-due-date]',
      '[data-invoice-detail-period]',
      '[data-invoice-detail-purchase-order]',
      '[data-invoice-detail-discount]',
      '[data-invoice-detail-tax]',
      '[data-invoice-detail-total]',
      '[data-invoice-detail-due]',
    ]) {
      required<HTMLElement>(selector).textContent = '—'
    }
    const subject = required<HTMLElement>('[data-invoice-detail-subject]')
    subject.textContent = ''
    subject.hidden = true
    const notes = required<HTMLElement>('[data-invoice-detail-notes]')
    notes.textContent = ''
    required<HTMLElement>('[data-invoice-detail-notes-section]').hidden = true
    required<HTMLElement>('[data-invoice-detail-lines]').replaceChildren()
    required<HTMLElement>('[data-invoice-detail-payments]').replaceChildren()
    required<HTMLElement>('[data-invoice-detail-messages]').replaceChildren()
    const reminderLine = required<HTMLElement>('[data-invoice-reminder-line]')
    reminderLine.textContent = ''
    reminderLine.hidden = true
    syncControls()
  }

  const loadDetail = async (
    session: ActiveSession,
    options: {
      readonly hideDocument: boolean
      readonly successMessage?: string
      /** A result the operator is waiting on, shown under the heading rather than in Payments. */
      readonly headlineMessage?: string
    },
  ): Promise<boolean> => {
    // The address names the invoice until it has loaded. From then on the page
    // is that invoice, and a refresh reads it by id rather than looking its
    // number up again.
    const reference: InvoicePageReference | null =
      invoice === null
        ? invoiceReferenceFromPathname(globalThis.location.pathname)
        : { kind: 'id', id: invoice.id }
    const getInvoice = api.getInvoice
    const findInvoiceByNumber = api.findInvoiceByNumber
    const listMessages = api.listInvoiceMessages
    const listPayments = api.listInvoicePayments
    if (
      current() !== session ||
      reference === null ||
      getInvoice === undefined ||
      (reference.kind === 'number' && findInvoiceByNumber === undefined) ||
      listMessages === undefined ||
      listPayments === undefined
    ) {
      if (current() === session) {
        status.textContent = 'Invoice detail is unavailable in this build.'
        article.hidden = true
      }
      return false
    }
    const requested = ++requestGeneration
    status.textContent = options.hideDocument ? 'Loading invoice…' : 'Refreshing invoice…'
    retry.hidden = true
    if (options.hideDocument) article.hidden = true
    else article.setAttribute('aria-busy', 'true')
    try {
      const invoiceId =
        reference.kind === 'id'
          ? reference.id
          : ((await findInvoiceByNumber!(reference.number, session.signal))?.id ?? null)
      if (current() !== session || requested !== requestGeneration) return false
      if (invoiceId === null) {
        // No invoice has that number: the page an id naming nothing shows.
        status.textContent = 'The requested invoice does not exist.'
        retry.hidden = false
        if (options.hideDocument) article.hidden = true
        return false
      }
      const [loadedInvoice, messages, loadedPayments] = await Promise.all([
        getInvoice(invoiceId, session.signal),
        listMessages(invoiceId, session.signal),
        listPayments(invoiceId, session.signal),
      ])
      if (current() !== session || requested !== requestGeneration) return false
      // The one client this page shows, named before the page paints. The
      // page used to race the shell's list of every client for it, and a
      // fresh load -- the editor's Save lands on one -- painted first and
      // never again, so it said "Client #5". A name is a nicety: one that
      // cannot be read leaves the id. Once named, a refresh finds it here.
      const getDirectoryClient = api.getDirectoryClient
      if (getDirectoryClient !== undefined && !clientNames.has(loadedInvoice.client_id)) {
        const named = await getDirectoryClient(loadedInvoice.client_id, session.signal).catch(
          () => null,
        )
        if (current() !== session || requested !== requestGeneration) return false
        if (typeof named?.name === 'string' && named.name.trim() !== '') {
          clientNames.set(loadedInvoice.client_id, named.name.trim())
        }
      }
      invoice = loadedInvoice
      // Opened by id, the page lands on the number: the address somebody
      // copies from here is the one every link in the app draws.
      const canonical = invoicePagePath(loadedInvoice)
      if (globalThis.location.pathname !== canonical) {
        globalThis.history.replaceState(
          globalThis.history.state,
          '',
          `${canonical}${globalThis.location.search}${globalThis.location.hash}`,
        )
      }
      payments = loadedPayments
      const editedId = editingPayment?.id
      const deletedId = deletingPayment?.id
      editingPayment =
        editedId === undefined || editedId === null
          ? null
          : (payments.find((payment) => payment.id === editedId) ?? null)
      deletingPayment =
        deletedId === undefined || deletedId === null
          ? null
          : (payments.find((payment) => payment.id === deletedId) ?? null)
      renderInvoiceDetail(loadedInvoice, messages, loadedPayments, {
        canWrite: invoiceIdentityCanWrite(session.identity),
        onEditPayment: (payment) => openPaymentDialog(payment),
        onDeletePayment: (payment) => openDeleteDialog(payment),
      })
      refreshRequired = false
      article.hidden = false
      status.textContent = options.headlineMessage ?? ''
      workflowStatus.textContent = options.successMessage ?? ''
      const canWrite = invoiceIdentityCanWrite(session.identity)
      attachmentForm.hidden = demo || !canWrite || api.uploadInvoiceAttachment === undefined
      attachmentReadonly.hidden = demo || canWrite || api.uploadInvoiceAttachment === undefined
      attachmentDemo.hidden = !demo || api.uploadInvoiceAttachment === undefined
      attachmentSubmit.disabled = false
      void loadAttachments(session, invoiceId!)
      void loadQuickBooks(session, invoiceId!)
      void loadReminders(session, invoiceId!)
      syncControls()
      return true
    } catch (error) {
      if (current() !== session || requested !== requestGeneration) return false
      if (session.onSessionFailure(error)) {
        clearPrivatePresentation()
        active = null
        return false
      }
      status.textContent = apiMessage(error)
      retry.hidden = false
      if (options.hideDocument) article.hidden = true
      return false
    } finally {
      if (current() === session && requested === requestGeneration) {
        article.removeAttribute('aria-busy')
        syncControls()
      }
    }
  }

  const openPaymentDialog = (payment: InvoicePayment | null): void => {
    const session = current()
    if (
      session === null ||
      invoice === null ||
      mutationPending ||
      refreshRequired ||
      !invoiceIdentityCanWrite(session.identity) ||
      (payment === null
        ? !invoiceCanRecordPayment(invoice)
        : !invoicePaymentCanUpdate(invoice, payment))
    ) {
      return
    }
    editingPayment = payment
    paymentCommandId = null
    paymentForm.reset()
    paymentTitle.textContent = payment === null ? 'Record payment' : 'Edit payment'
    paymentSubmit.textContent = payment === null ? 'Record payment' : 'Save payment'
    currency.value = invoice.currency
    amount.value = invoicePaymentAmountForForm(
      payment === null ? invoice.due_amount_cents : payment.amount_cents,
    )
    notes.value = payment?.notes ?? ''
    if (payment?.paid_at !== null && payment?.paid_at !== undefined) {
      precision.value = 'timestamp'
      paidAt.value = invoicePaymentLocalInstant(payment.paid_at)
      paidDate.value = localDate()
    } else {
      precision.value = 'date'
      paidDate.value = payment?.paid_date ?? localDate()
      paidAt.value = invoicePaymentLocalInstant(new Date().toISOString())
    }
    paymentResult.textContent = ''
    syncControls()
    paymentDialog.showModal()
    amount.focus()
  }

  const openDeleteDialog = (payment: InvoicePayment): void => {
    const session = current()
    if (
      session === null ||
      invoice === null ||
      mutationPending ||
      refreshRequired ||
      !invoiceIdentityCanWrite(session.identity) ||
      !invoicePaymentCanDelete(invoice, payment)
    ) {
      return
    }
    deletingPayment = payment
    deleteCommandId = null
    deleteResult.textContent = ''
    deleteSummary.replaceChildren(
      moneyText(money(payment.amount_cents, payment.currency)),
      ` paid ${paymentDateLabel(payment)}`,
    )
    syncControls()
    deleteDialog.showModal()
    deleteSubmit.focus()
  }

  const openComposer = (): void => {
    const session = current()
    if (
      session === null ||
      invoice === null ||
      mutationPending ||
      refreshRequired ||
      !invoiceIdentityCanWrite(session.identity) ||
      !invoiceCanMarkSent(invoice)
    ) {
      return
    }
    // Reopening the dialog is not a fresh send. An attempt that already
    // committed its `send` stays exactly as it is: the email it owes is what
    // this dialog is now for, and discarding it here would rearm the transition
    // -- a second sent message for one operator intent, reached by pressing
    // Cancel and then Send again.
    const owed = owedDelivery()
    composerForm.reset()
    composerPreviewPanel.hidden = true
    composerPreviewResult.textContent = ''
    // Until the client's own defaults arrive, the dialog opens on Harvest's
    // subject and a short note.
    composerSubject.value = fallbackSubject
    composerBody.value = fallbackMessage
    composerCc.value = ''
    composerAlwaysCc.hidden = true
    composerCopyLabel.hidden = true
    composerRecipientsSource.textContent = ''
    deliveryRefusal = null
    deliveryChosen = false
    const today = localDate()
    if (owed !== null) {
      // The email the committed send confirmed, not whatever the reset left
      // behind: it is what the retry delivers, header for header.
      composerRecipients.value = owed.recipients.map(invoiceRecipientLine).join('\n')
      composerCc.value = owed.cc.map(invoiceRecipientLine).join('\n')
      composerSubject.value = owed.subject
      composerBody.value = owed.message
      composerCopy.checked = owed.sendMeACopy
      composerCopyLabel.hidden = !owed.sendMeACopy
      composerDeliverToggle.checked = true
      composerConfirm.checked = true
      composerReminderToggle.checked = false
      composerReminderDate.value = ''
    } else {
      // Delivering is what Send means. The form reset used to leave it
      // unticked, so pressing the dialog's button as it opened recorded the
      // invoice as sent and emailed nobody. It opens ticked wherever this
      // build can deliver; the defaults read below unticks it, and says why,
      // where the organization cannot send. Recording alone is the deliberate
      // choice, one click away and named on the button.
      composerDeliverToggle.checked = api.deliverInvoiceEmail !== undefined
      composerReminderToggle.checked = invoice.due_date >= today
      composerReminderDate.value = invoice.due_date >= today ? invoice.due_date : ''
    }
    composerResult.textContent = ''
    // syncControls titles the dialog, shows the owed notice and names the
    // submit, all off the attempt, so no entry point sets them independently.
    syncControls()
    composerDialog.showModal()
    // Read afresh on every opening: the invoice's choices are its own state,
    // and an earlier send may have changed them.
    if (attachmentsOffered()) void loadDocumentPreference(session, invoice.id)
    void loadEmailDefaults(session, invoice.id, owed === null)
    // The fields are frozen while the email is owed, so the retry is what the
    // keyboard lands on.
    if (owed !== null) composerSubmit.focus()
    else composerRecipients.focus()
  }

  const openTransition = (command: InvoiceOverflowCommand): void => {
    const session = current()
    if (
      session === null ||
      invoice === null ||
      mutationPending ||
      refreshRequired ||
      !invoiceIdentityCanWrite(session.identity) ||
      !invoiceCanIssueTransition(invoice, payments.length, command)
    ) {
      return
    }
    const transition = invoiceOverflowTransitions.find(
      (candidate) => candidate.command === command,
    )!
    closeOverflow()
    pendingTransition = command
    transitionCommandId = null
    transitionTitle.textContent = transition.label
    transitionSummary.textContent = transition.summary
    transitionResult.textContent = ''
    transitionSubmit.textContent = transition.label
    // A destructive verb is red text, never a red fill: a filled label is body
    // text over the fill and owes 4.5:1, and this one does not need the volume.
    transitionSubmit.className = transition.destructive
      ? 'invoice-destructive-action'
      : 'primary-action'
    syncControls()
    transitionDialog.showModal()
    transitionSubmit.focus()
  }

  const conflictCodes = invoiceConflictCodes

  const handleMutationFailure = async (
    error: unknown,
    session: ActiveSession,
    result: HTMLElement,
  ): Promise<void> => {
    if (current() !== session) return
    if (session.onSessionFailure(error)) {
      clearPrivatePresentation()
      active = null
      return
    }
    const code = apiErrorCode(error)
    if (code !== null && conflictCodes.has(code)) {
      paymentCommandId = null
      settleCommandId = null
      deleteCommandId = null
      // `sendAttempt` is deliberately left standing. A conflict on the delivery
      // half arrives after the `send` has committed -- it is the error class
      // most likely to land between two sequential versioned writes, another
      // operator or the cron writing in between -- and the reload below moves
      // the page to a version the retried transition would be accepted at. The
      // attempt is what makes that retry the email alone. The one conflict code
      // that does retire it is `command_id_reused`, and the Send submission
      // retires it there rather than here: it is the only caller that knows
      // which command the spent key names.
      transitionCommandId = null
      const loaded = await loadDetail(session, { hideDocument: false })
      if (current() !== session) return
      result.textContent = loaded
        ? 'The invoice, line, or payment changed elsewhere. Latest values are loaded; review and try again.'
        : 'The invoice changed elsewhere and the latest values could not be loaded. Retry the invoice.'
      if (editingPayment === null && paymentDialog.open) paymentDialog.close()
      if (deletingPayment === null && deleteDialog.open) deleteDialog.close()
      if (composerDialog.open && (invoice === null || !invoiceCanMarkSent(invoice))) {
        composerDialog.close()
      }
      if (
        transitionDialog.open &&
        (invoice === null ||
          pendingTransition === null ||
          !invoiceCanIssueTransition(invoice, payments.length, pendingTransition))
      ) {
        pendingTransition = null
        transitionDialog.close()
      }
      return
    }
    result.textContent = apiMessage(error)
  }

  precision.addEventListener('change', () => {
    if (!mutationPending) paymentCommandId = null
    syncPrecision()
  })
  send.addEventListener('click', openComposer)
  overflowToggle.addEventListener('click', () => {
    if (overflowToggle.disabled) return
    const opening = overflowMenu.hidden
    overflowMenu.hidden = !opening
    overflowToggle.setAttribute('aria-expanded', opening ? 'true' : 'false')
  })
  // The menu is an overlay on a document surface, so anything outside it that
  // takes a click closes it. Without this it survives navigation inside the page.
  document.addEventListener('click', (event) => {
    if (overflowMenu.hidden) return
    const target = event.target
    if (target instanceof Node && overflow.contains(target)) return
    closeOverflow()
  })
  for (const [command, item] of overflowItems) {
    item.addEventListener('click', () => {
      openTransition(command)
    })
  }
  transitionForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const session = current()
    const selectedInvoice = invoice
    const command = pendingTransition
    const transitionInvoice = api.transitionInvoice
    if (
      session === null ||
      selectedInvoice === null ||
      command === null ||
      transitionInvoice === undefined ||
      mutationPending ||
      refreshRequired ||
      !invoiceIdentityCanWrite(session.identity) ||
      !invoiceCanIssueTransition(selectedInvoice, payments.length, command)
    ) {
      return
    }
    const input: InvoiceTransitionInput = {
      command,
      expected_version: selectedInvoice.version,
    }
    transitionCommandId ??= `web.invoice.${command}:${globalThis.crypto.randomUUID()}`
    const activeCommand = transitionCommandId
    mutationPending = true
    transitionResult.textContent = 'Applying the invoice command…'
    syncControls()
    void transitionInvoice(selectedInvoice.id, activeCommand, input, session.signal)
      .then(async (updatedInvoice) => {
        if (current() !== session) return
        transitionCommandId = null
        pendingTransition = null
        invoice = updatedInvoice
        mutationPending = false
        refreshRequired = true
        transitionResult.textContent = ''
        transitionDialog.close()
        workflowStatus.textContent = 'Invoice state changed. Refreshing invoice…'
        syncControls()
        const loaded = await loadDetail(session, {
          hideDocument: false,
          successMessage: `Invoice is now ${invoiceStateLabel(updatedInvoice).toLocaleLowerCase('en-US')}.`,
        })
        if (!loaded && current() === session && refreshRequired) {
          workflowStatus.textContent =
            'The invoice state changed, but the updated invoice could not be refreshed. Retry invoice; the command will not be submitted again.'
        }
      })
      .catch(async (error: unknown) => {
        if (current() !== session) return
        mutationPending = false
        await handleMutationFailure(error, session, transitionResult)
      })
      .finally(() => {
        if (current() === session) {
          mutationPending = false
          syncControls()
        }
      })
  })
  composerReminderToggle.addEventListener('change', () => {
    syncReminder()
  })
  composerDeliverToggle.addEventListener('change', () => {
    deliveryChosen = true
    syncComposer()
  })
  composerAttachJournal.addEventListener('change', () => {
    syncComposer()
  })
  composerAttachPdf.addEventListener('change', () => {
    syncComposer()
  })
  composerPreview.addEventListener('click', () => {
    runPreview(false)
  })
  composerPreviewSend.addEventListener('click', () => {
    runPreview(true)
  })
  composerForm.addEventListener('input', () => {
    // No command id is minted or dropped here. Once a `send` has been issued its
    // outcome may be unknown, and a fresh id on the next submit would record a
    // second sent message rather than replay the first; the ledger replays an
    // identical retry and refuses a changed one, which is an error the operator
    // can see and act on. Editing the fields is not evidence that nothing was
    // recorded, so it may not be treated as if it were.
    composerResult.textContent = ''
  })
  composerForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const session = current()
    const selectedInvoice = invoice
    const transitionInvoice = api.transitionInvoice
    const deliverInvoiceEmail = api.deliverInvoiceEmail
    if (
      session === null ||
      selectedInvoice === null ||
      transitionInvoice === undefined ||
      mutationPending ||
      refreshRequired ||
      !invoiceIdentityCanWrite(session.identity) ||
      !invoiceCanMarkSent(selectedInvoice)
    ) {
      return
    }
    const delivering = composerDeliverToggle.checked
    // What this submit may issue is read off the attempt, never off the
    // checkbox alone: once the `send` has committed, nothing the dialog can be
    // put into may run it a second time.
    const work = invoiceSendWork(sendAttempt, selectedInvoice.id, delivering)
    if (work === 'nothing') {
      // The email was owed and the operator has taken it off the submit. There
      // is no request left to make, so say what actually happened rather than
      // closing on a success message for zero API calls.
      sendAttempt = null
      composerResult.textContent = ''
      composerDialog.close()
      workflowStatus.textContent =
        'The sent status was already recorded. The email was not sent.'
      syncControls()
      return
    }
    if (delivering && deliverInvoiceEmail === undefined) {
      composerResult.textContent = 'Invoice email delivery is unavailable in this build.'
      return
    }
    let recipients: InvoiceRecipient[] = []
    let copies: InvoiceRecipient[] = []
    let sendReminderOn: string | null = null
    let input: InvoiceTransitionInput | null = null
    let attachmentChange: InvoiceDocumentPreferenceInput | null = null
    let clientDefaults: Parameters<NonNullable<typeof api.setClientInvoiceSending>>[1] | null = null
    const subject = composerSubject.value.trim()
    const body = composerBody.value.trimEnd()
    // Copied on the email itself, the way the client sees it -- only where the
    // person sending has an address to be copied at.
    const sendMeACopy = delivering && !composerCopyLabel.hidden && composerCopy.checked
    // A standing choice: the box shows it and changing it changes it.
    const copyChanged =
      emailDefaults !== null &&
      !composerCopyLabel.hidden &&
      composerCopy.checked !== emailDefaults.send_me_a_copy &&
      api.setInvoiceCopyToSelf !== undefined
    // Recorded on the message the way Harvest recorded it, and only true when
    // the email that would carry the PDF is part of this submit.
    const attachPdf = delivering && documentPreference !== null && composerAttachPdf.checked
    const names = {
      clientName: emailDefaults?.client_name ?? clientLabel(selectedInvoice.client_id),
      companyName: emailDefaults?.company_name ?? '',
    }
    try {
      if (delivering && attachmentsOffered()) {
        if (documentPreferenceLoading) {
          throw new Error('Wait for the attachments to load, then send.')
        }
        if (documentPreference !== null) {
          attachmentChange = invoiceAttachmentChanges(
            documentPreference,
            chosenAttachments(),
            attachments.length > 0,
          )
        }
      }
      if (work === 'send') {
        // The client's lists and the template's words are still on their way;
        // a send made before they land would go to whatever was typed over
        // half of them.
        if (emailDefaultsLoading) throw new Error('Wait for the recipients to load, then send.')
        recipients = invoiceRecipients(composerRecipients.value)
        copies = delivering ? invoiceCopies(composerCc.value, recipients) : []
        if (subject === '') throw new Error('Enter a subject before recording.')
        if (body.trim() === '') throw new Error('Enter a message before recording.')
        // Checked here, before anything is recorded: a send that commits and
        // then has its email refused leaves an email owed that nothing typed
        // here can change.
        for (const problem of [
          invoiceTemplateProblem(subject, 'Subject'),
          invoiceTemplateProblem(body, 'Message'),
        ]) {
          if (problem !== null) throw new Error(problem)
        }
        sendReminderOn = composerReminderToggle.checked
          ? invoiceReminderDate(composerReminderDate.value, localDate())
          : null
        if (delivering && !composerConfirm.checked) {
          throw new Error('Confirm the recipients before sending this invoice email.')
        }
        if (delivering && composerSaveDefault.checked && api.setClientInvoiceSending !== undefined) {
          const choice = chosenAttachments()
          clientDefaults = {
            recipients: { to: [...recipients], cc: [...copies] },
            ...(documentPreference === null
              ? {}
              : {
                  attach_pdf: choice.pdf,
                  append_pdfs: choice.append,
                  ...(attachments.length === 0 ? {} : { attach_files: choice.files }),
                  attach_journal: choice.journal,
                  ...(choice.journal === false ? {} : { journal_formats: [...choice.journalFormats] }),
                }),
          }
        }
        input = {
          command: 'send',
          expected_version: selectedInvoice.version,
          recipients,
          subject: interpolateInvoiceTemplate(subject, selectedInvoice, names),
          body: interpolateInvoiceTemplate(body, selectedInvoice, names),
          attach_pdf: attachPdf,
          send_me_a_copy: sendMeACopy,
          thank_you: false,
          reminder: sendReminderOn !== null,
          send_reminder_on: sendReminderOn,
        }
      } else if (!composerConfirm.checked) {
        // The email is still the irreversible half on a retry, so it still
        // owes the confirmation.
        throw new Error('Confirm the recipients before sending this invoice email.')
      }
    } catch (error) {
      composerResult.textContent = apiMessage(error)
      return
    }
    const live = invoiceSendAttemptFor(sendAttempt, selectedInvoice.id)
    // A `send` that has been issued keeps its command id for the life of the
    // attempt whatever happens in between. While it is still owed the email has
    // not been issued at all, so the checkbox and the fields on screen may
    // still decide it; once it has been, `live` is the whole answer.
    const attempt: InvoiceSendAttempt =
      work === 'delivery'
        ? live!
        : {
            invoiceId: selectedInvoice.id,
            transitionCommandId:
              live?.transitionCommandId ?? `web.invoice.send:${globalThis.crypto.randomUUID()}`,
            sentVersion: null,
            delivery: delivering
              ? {
                  commandId:
                    live?.delivery?.commandId ??
                    `web.invoice.delivery:${globalThis.crypto.randomUUID()}`,
                  recipients,
                  cc: copies,
                  subject,
                  message: body,
                  sendMeACopy,
                }
              : null,
          }
    sendAttempt = attempt
    mutationPending = true
    composerResult.textContent =
      work === 'delivery'
        ? 'Queueing the email…'
        : delivering
          ? 'Recording sent status, then queueing the email…'
          : 'Recording sent status…'
    syncControls()
    // Two commands on rising versions, in the order the operator would have had
    // to guess at: the state change first, then the email. POST /deliveries
    // issues its own send once the mail is accepted, so the history carries both
    // the message written here and the email that went.
    const request = (async (): Promise<Invoice> => {
      // Settings first: they are read when the email is built, so the email
      // cannot be queued before they are saved, and a refusal here has to stop
      // before the sent status is recorded rather than after it. Settings, not
      // commands -- writing one twice writes the same thing -- so they need no
      // key of their own; the held keys below are what keep a retry from
      // sending twice. The client's defaults go first, so the invoice's own
      // choices are written over the rules they will now follow.
      if (clientDefaults !== null) {
        try {
          await api.setClientInvoiceSending!(selectedInvoice.client_id, clientDefaults, session.signal)
        } catch (error) {
          throw new AttachmentChoicesRefused(error, "This client's defaults were")
        }
      }
      if (attachmentChange !== null) {
        try {
          const saved = await api.setInvoiceDocumentPreference!(
            selectedInvoice.id,
            attachmentChange,
            session.signal,
          )
          // Adopted, so a retry after a later failure finds nothing to change.
          if (current() === session) documentPreference = saved
        } catch (error) {
          throw new AttachmentChoicesRefused(error)
        }
      }
      if (copyChanged) {
        try {
          await api.setInvoiceCopyToSelf!(composerCopy.checked, session.signal)
          if (current() === session && emailDefaults !== null) {
            emailDefaults = { ...emailDefaults, send_me_a_copy: composerCopy.checked }
          }
        } catch (error) {
          throw new AttachmentChoicesRefused(error, 'Your copy setting was')
        }
      }
      let saved = selectedInvoice
      if (input !== null) {
        saved = await transitionInvoice(
          saved.id,
          attempt.transitionCommandId,
          input,
          session.signal,
        )
        if (current() === session) {
          invoice = saved
          refreshRequired = true
          // The sent status is committed. What is left is written onto the
          // attempt, which is the one thing every later path consults: a
          // conflict reload, a reopened dialog and an edited field all leave it
          // standing, so none of them can rearm the transition.
          sendAttempt = { ...attempt, sentVersion: saved.version }
        }
      }
      if (attempt.delivery !== null) {
        const deliveryInput: InvoiceEmailDeliveryInput = {
          expected_version: saved.version,
          recipients: [...attempt.delivery.recipients],
          ...(attempt.delivery.cc.length === 0 ? {} : { cc: [...attempt.delivery.cc] }),
          subject: attempt.delivery.subject,
          message: attempt.delivery.message,
          send_me_a_copy: attempt.delivery.sendMeACopy,
          confirmed: true,
        }
        saved = await deliverInvoiceEmail!(
          saved.id,
          attempt.delivery.commandId,
          deliveryInput,
          session.signal,
        )
        if (current() === session) sendAttempt = null
      }
      return saved
    })()
    void request
      .then(async (updatedInvoice) => {
        if (current() !== session) return
        sendAttempt = null
        invoice = updatedInvoice
        mutationPending = false
        refreshRequired = true
        composerDialog.close()
        workflowStatus.textContent = delivering
          ? 'Invoice marked sent and the email queued. Refreshing its history…'
          : 'Invoice marked sent. Refreshing its history…'
        syncControls()
        const reminderNote =
          sendReminderOn === null
            ? ''
            : ` Planned reminder date saved for ${dateLabel(sendReminderOn)}.`
        const loaded = await loadDetail(session, {
          hideDocument: false,
          // The send is what the operator is watching for, so its result goes
          // under the heading. Written to the Payments status line it was off
          // screen, and a send that worked looked like a click that did nothing.
          headlineMessage: delivering
            ? mailRestricted
              ? `Sent. ${DEMO_MAIL_NOTE} Settings › Deliveries shows what went.${reminderNote}`
              : `Sent. The email is queued and goes out within a minute or two; Settings › Deliveries shows it.${reminderNote}`
            : `Marked sent. No email was delivered.${reminderNote}`,
        })
        if (!loaded && current() === session && refreshRequired) {
          workflowStatus.textContent =
            'The invoice was sent, but the updated invoice could not be refreshed. Retry invoice; nothing will be submitted again.'
        }
      })
      .catch(async (error: unknown) => {
        if (current() !== session) return
        mutationPending = false
        if (error instanceof AttachmentChoicesRefused) {
          if (session.onSessionFailure(error.reason)) {
            clearPrivatePresentation()
            active = null
            return
          }
          // Nothing was sent. The attempt and its keys stay exactly as they
          // were, so submitting again is the same send, not a second one.
          composerResult.textContent = `${error.what} not saved, so nothing was sent: ${apiMessage(error.reason)} Submit again to retry.`
          return
        }
        // Holding the key is what keeps a retry from re-sending, and retiring
        // it is what keeps a lost response from bricking the dialog. Both come
        // off the failure: `command_id_reused` is the ledger reporting this
        // key's command committed, so it is spent and the attempt goes; every
        // other failure keeps it. Decided before the shared handler runs, so
        // nothing renders the composer against an attempt already spent.
        const failure = invoiceSendFailure(
          sendAttempt,
          selectedInvoice.id,
          apiErrorCode(error),
        )
        sendAttempt = failure.attempt
        await handleMutationFailure(error, session, composerResult)
        // A conflict already reloaded. A delivery that failed after the sent
        // status committed has not, and the page would otherwise keep rendering
        // a version nobody saved while the composer offers a retry.
        if (current() === session && refreshRequired) {
          await loadDetail(session, { hideDocument: false })
        }
        // A spent key is refused with a conflict code, so the shared handler has
        // just written that somebody else moved the invoice. The operator moved
        // it, and what they need to know is that it went out -- and that the
        // dialog they are looking at would now send it a second time.
        if (current() === session && failure.notice !== null) {
          composerResult.textContent = failure.notice
          // The reload can close the composer under it -- a closed invoice takes
          // no send -- and the truth may not go with it.
          if (!composerDialog.open) workflowStatus.textContent = failure.notice
        }
        // The attempt is what decides whether a retry is on offer, so it also
        // writes the line saying so -- including after a conflict, which is
        // exactly the case where the old flag was cleared out from under this
        // message and the next submit re-sent the invoice.
        if (current() === session && emailOwed()) {
          const reported = composerResult.textContent?.trim() ?? ''
          composerResult.textContent =
            `${reported} The sent status was recorded; submit again to retry the email alone.`.trim()
        }
      })
      .finally(() => {
        if (current() === session) {
          mutationPending = false
          syncControls()
        }
      })
  })
  paymentForm.addEventListener('input', () => {
    if (!mutationPending) paymentCommandId = null
    paymentResult.textContent = ''
  })
  paymentForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const session = current()
    const selectedInvoice = invoice
    const selectedPayment = editingPayment
    const recordPayment = api.recordInvoicePayment
    const updatePayment = api.updateInvoicePayment
    if (
      session === null ||
      selectedInvoice === null ||
      mutationPending ||
      refreshRequired ||
      !invoiceIdentityCanWrite(session.identity) ||
      (selectedPayment === null ? recordPayment === undefined : updatePayment === undefined)
    ) {
      return
    }
    let cents: number
    let timing: ReturnType<typeof invoicePaymentTiming>
    try {
      cents = invoicePaymentAmountCents(amount.value)
      timing = invoicePaymentTiming(
        precision.value === 'timestamp' ? 'timestamp' : 'date',
        precision.value === 'timestamp' ? paidAt.value : paidDate.value,
      )
      const maximum =
        selectedPayment === null
          ? selectedInvoice.due_amount_cents
          : selectedInvoice.due_amount_cents + selectedPayment.amount_cents
      if (cents > maximum) {
        throw new Error(
          `Amount cannot exceed ${money(maximum, selectedInvoice.currency)} available on this invoice.`,
        )
      }
    } catch (error) {
      paymentResult.textContent = apiMessage(error)
      amount.focus()
      return
    }
    const normalizedNotes = notes.value.trim() === '' ? null : notes.value.trim()
    const kind = selectedPayment === null ? 'record' : 'update'
    paymentCommandId ??= commandId(kind)
    const activeCommand = paymentCommandId
    mutationPending = true
    paymentResult.textContent = selectedPayment === null ? 'Recording payment…' : 'Saving payment…'
    syncControls()
    const request =
      selectedPayment === null
        ? recordPayment!(
            selectedInvoice.id,
            activeCommand,
            {
              expected_version: selectedInvoice.version,
              amount_cents: cents,
              currency: selectedInvoice.currency,
              ...timing,
              notes: normalizedNotes,
            } as InvoicePaymentInput,
            session.signal,
          )
        : updatePayment!(
            selectedInvoice.id,
            selectedPayment.id,
            activeCommand,
            {
              expected_version: selectedInvoice.version,
              expected_updated_at: selectedPayment.updated_at,
              amount_cents: cents,
              ...timing,
              notes: normalizedNotes,
            } as InvoicePaymentUpdateInput,
            session.signal,
          )
    void request
      .then(async (updatedInvoice) => {
        if (current() !== session) return
        invoice = updatedInvoice
        refreshRequired = true
        paymentCommandId = null
        editingPayment = null
        paymentResult.textContent = ''
        paymentDialog.close()
        workflowStatus.textContent =
          selectedPayment === null
            ? 'Payment recorded. Refreshing invoice…'
            : 'Payment saved. Refreshing invoice…'
        syncControls()
        const loaded = await loadDetail(session, {
          hideDocument: false,
          successMessage: selectedPayment === null ? 'Payment recorded.' : 'Payment saved.',
        })
        if (!loaded && current() === session && refreshRequired) {
          workflowStatus.textContent =
            selectedPayment === null
              ? 'Payment recorded, but the updated invoice could not be refreshed. Retry invoice; the payment will not be submitted again.'
              : 'Payment saved, but the updated invoice could not be refreshed. Retry invoice; the change will not be submitted again.'
        }
      })
      .catch((error: unknown) => handleMutationFailure(error, session, paymentResult))
      .finally(() => {
        if (current() !== session) return
        mutationPending = false
        syncControls()
      })
  })

  deleteForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const session = current()
    const selectedInvoice = invoice
    const selectedPayment = deletingPayment
    const deletePayment = api.deleteInvoicePayment
    if (
      session === null ||
      selectedInvoice === null ||
      selectedPayment === null ||
      mutationPending ||
      refreshRequired ||
      deletePayment === undefined ||
      !invoiceIdentityCanWrite(session.identity) ||
      !invoicePaymentCanDelete(selectedInvoice, selectedPayment)
    ) {
      return
    }
    deleteCommandId ??= commandId('delete')
    const activeCommand = deleteCommandId
    mutationPending = true
    deleteResult.textContent = 'Deleting payment…'
    syncControls()
    void deletePayment(
      selectedInvoice.id,
      selectedPayment.id,
      activeCommand,
      {
        expected_version: selectedInvoice.version,
        expected_updated_at: selectedPayment.updated_at,
      },
      session.signal,
    )
      .then(async (updatedInvoice) => {
        if (current() !== session) return
        invoice = updatedInvoice
        refreshRequired = true
        deleteCommandId = null
        deletingPayment = null
        deleteResult.textContent = ''
        deleteDialog.close()
        workflowStatus.textContent = 'Payment deleted. Refreshing invoice…'
        syncControls()
        const loaded = await loadDetail(session, {
          hideDocument: false,
          successMessage: 'Payment deleted.',
        })
        if (!loaded && current() === session && refreshRequired) {
          workflowStatus.textContent =
            'Payment deleted, but the updated invoice could not be refreshed. Retry invoice; the deletion will not be submitted again.'
        }
      })
      .catch((error: unknown) => handleMutationFailure(error, session, deleteResult))
      .finally(() => {
        if (current() !== session) return
        mutationPending = false
        syncControls()
      })
  })

  paymentDialog.addEventListener('close', () => {
    if (mutationPending) return
    editingPayment = null
    paymentCommandId = null
    paymentResult.textContent = ''
  })
  deleteDialog.addEventListener('close', () => {
    if (mutationPending) return
    deletingPayment = null
    deleteCommandId = null
    deleteResult.textContent = ''
  })
  record.addEventListener('click', () => openPaymentDialog(null))
  // Mark paid is Record payment with its three fields answered from the invoice
  // itself: the whole remaining balance, today, no note. It goes through the
  // payment route rather than a transition of its own because `paid` is derived
  // from the payments -- an invoice is paid when nothing is left due -- so there
  // is no flag to set, only a payment to record. The command id is held until
  // the write lands, so a click repeated over a timeout settles the balance once.
  // The button lives in the document header, so its feedback goes to the page
  // status line directly above the document, not to the Payments section below
  // the line items, where a conflict or a failed write would land off-screen.
  settle.addEventListener('click', () => {
    const session = current()
    const selectedInvoice = invoice
    const recordPayment = api.recordInvoicePayment
    if (
      session === null ||
      selectedInvoice === null ||
      mutationPending ||
      refreshRequired ||
      recordPayment === undefined ||
      !invoiceIdentityCanWrite(session.identity) ||
      !invoiceCanRecordPayment(selectedInvoice)
    ) {
      return
    }
    settleCommandId ??= commandId('record')
    const activeCommand = settleCommandId
    mutationPending = true
    status.textContent = 'Recording payment…'
    syncControls()
    void recordPayment(
      selectedInvoice.id,
      activeCommand,
      {
        expected_version: selectedInvoice.version,
        amount_cents: selectedInvoice.due_amount_cents,
        currency: selectedInvoice.currency,
        ...invoicePaymentTiming('date', localDate()),
        notes: null,
      } as InvoicePaymentInput,
      session.signal,
    )
      .then(async (updatedInvoice) => {
        if (current() !== session) return
        invoice = updatedInvoice
        refreshRequired = true
        settleCommandId = null
        status.textContent = 'Invoice marked paid. Refreshing invoice…'
        syncControls()
        const loaded = await loadDetail(session, { hideDocument: false })
        if (current() !== session) return
        if (loaded) {
          status.textContent = 'Invoice marked paid.'
        } else if (refreshRequired) {
          status.textContent =
            'Invoice marked paid, but the updated invoice could not be refreshed. Retry invoice; the payment will not be submitted again.'
        }
      })
      .catch((error: unknown) => handleMutationFailure(error, session, status))
      .finally(() => {
        if (current() !== session) return
        mutationPending = false
        syncControls()
      })
  })
  // The Sync button (issue 819). No command id: the mirror is idempotent by
  // construction -- the link tables are what stop a second press filing a
  // second document -- so a retry is just another press. Feedback goes to the
  // page status line, beside the button, like Mark paid; the line under the
  // facts is re-read from the response so what it says is what the server has.
  remindersToggle.addEventListener('change', () => {
    const session = current()
    const selectedInvoice = invoice
    const set = api.setInvoiceReminderPreference
    if (session === null || selectedInvoice === null || set === undefined || remindersSaving) {
      renderReminders()
      return
    }
    // Off is a statement about this invoice; on hands it back to the
    // organization, so a default set later still governs it.
    const wanted: boolean | null = remindersToggle.checked ? null : false
    remindersSaving = true
    remindersToggle.disabled = true
    void set(selectedInvoice.id, wanted, session.signal)
      .then((preference) => {
        if (current() !== session) return
        reminders = preference
      })
      .catch((error: unknown) => {
        if (current() !== session) return
        if (session.onSessionFailure(error)) return
        remindersLine.textContent = apiMessage(error)
      })
      .finally(() => {
        if (current() !== session) return
        remindersSaving = false
        renderReminders()
      })
  })

  quickBooksSync.addEventListener('click', () => {
    const session = current()
    const selectedInvoice = invoice
    const sync = api.syncInvoiceQuickBooks
    if (
      session === null ||
      selectedInvoice === null ||
      sync === undefined ||
      quickBooksSyncing ||
      mutationPending ||
      refreshRequired ||
      !invoiceIdentityCanWrite(session.identity)
    ) {
      return
    }
    quickBooksSyncing = true
    status.textContent = 'Syncing to QuickBooks…'
    syncControls()
    void sync(selectedInvoice.id, session.signal)
      .then((state) => {
        if (current() !== session) return
        quickBooks = state
        renderQuickBooks()
        const receipts = state.payments.length
        status.textContent =
          state.invoice === null
            ? 'Sync finished, but the invoice is not in QuickBooks. See the QuickBooks line for why.'
            : receipts === 0
              ? `Synced to QuickBooks invoice ${state.invoice.quickbooks_id}.`
              : `Synced to QuickBooks invoice ${state.invoice.quickbooks_id} with ${receipts} ${receipts === 1 ? 'payment' : 'payments'}.`
      })
      .catch(async (error: unknown) => {
        if (current() !== session) return
        if (session.onSessionFailure(error)) {
          clearPrivatePresentation()
          active = null
          return
        }
        // A 409 is the mirror's decision, and the reason is the message. The
        // line is re-read so it says the same thing the status does, and keeps
        // saying it after the status moves on.
        status.textContent =
          apiErrorCode(error) === 'quickbooks_refused'
            ? `QuickBooks refused the invoice: ${apiMessage(error)}`
            : apiMessage(error)
        await loadQuickBooks(session, selectedInvoice.id)
      })
      .finally(() => {
        if (current() !== session) return
        quickBooksSyncing = false
        syncControls()
      })
  })
  attachmentForm.addEventListener('input', () => {
    if (!mutationPending) attachmentCommandId = null
  })
  attachmentForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const session = current()
    if (
      session === null ||
      !invoiceIdentityCanWrite(session.identity) ||
      invoice === null ||
      mutationPending ||
      api.uploadInvoiceAttachment === undefined
    ) return
    const fileInput = attachmentForm.querySelector<HTMLInputElement>('input[name="file"]')
    if (fileInput?.files?.[0] === undefined) {
      attachmentStatus.textContent = 'Choose one file to upload.'
      return
    }
    const body = new FormData()
    body.set('file', fileInput.files[0])
    attachmentCommandId ??= `web.invoice-attachment:${crypto.randomUUID()}`
    mutationPending = true
    attachmentSubmit.disabled = true
    attachmentStatus.textContent = 'Uploading file…'
    const invoiceId = invoice.id
    void api.uploadInvoiceAttachment(invoiceId, attachmentCommandId, body, session.signal)
      .then(async () => {
        if (current() !== session) return
        attachmentCommandId = null
        attachmentForm.reset()
        await loadAttachments(session, invoiceId)
      })
      .catch((error: unknown) => {
        if (current() !== session) return
        if (session.onSessionFailure(error)) return
        attachmentStatus.textContent = apiMessage(error)
      })
      .finally(() => {
        if (current() === session) {
          mutationPending = false
          attachmentSubmit.disabled = false
        }
      })
  })
  retry.addEventListener('click', () => {
    const session = current()
    if (session !== null) void loadDetail(session, { hideDocument: invoice === null })
  })
  // The print rules are what make this worth a button: the sheet is the
  // invoice, not the application around it. It needs no invoice state and no
  // write scope -- the button lives inside the document, which is hidden until
  // one is loaded -- so it is never disabled with the editing controls.
  printInvoice.addEventListener('click', () => {
    window.print()
  })
  hoursToggle.addEventListener('click', () => {
    const opening = hoursMenu.hidden
    hoursMenu.hidden = !opening
    hoursToggle.setAttribute('aria-expanded', opening ? 'true' : 'false')
  })
  document.addEventListener('click', (event) => {
    if (hoursMenu.hidden) return
    const target = event.target
    if (target instanceof Node && hoursExport.contains(target)) return
    closeHoursMenu()
  })
  for (const item of hoursMenu.querySelectorAll<HTMLButtonElement>('[data-hours-format]')) {
    item.addEventListener('click', () => {
      closeHoursMenu()
      const session = current()
      const download = api.downloadInvoiceHoursReport
      if (session === null || invoice === null || download === undefined) return
      const format = item.dataset.hoursFormat as InvoiceHoursReportFormat
      const detail = item.dataset.hoursDetail === 'summary' ? 'summary' : 'detailed'
      status.textContent = 'Preparing the hours report…'
      void download(invoice.id, format, detail, session.signal)
        .then(({ blob, filename }) => {
          if (current() !== session) return
          const url = URL.createObjectURL(blob)
          const link = document.createElement('a')
          link.href = url
          link.download = filename
          link.click()
          setTimeout(() => URL.revokeObjectURL(url), 0)
          status.textContent = ''
        })
        .catch((error: unknown) => {
          if (current() !== session) return
          status.textContent = apiMessage(error)
        })
    })
  }

  return {
    async activate(identity, signal, onSessionFailure) {
      activationGeneration += 1
      requestGeneration += 1
      active = null
      clearPrivatePresentation()
      if (!detailPage) return
      const session: ActiveSession = {
        identity,
        signal,
        onSessionFailure,
        generation: activationGeneration,
      }
      active = session
      signal.addEventListener(
        'abort',
        () => {
          if (active !== session) return
          activationGeneration += 1
          requestGeneration += 1
          active = null
          clearPrivatePresentation()
        },
        { once: true },
      )
      if (!invoiceIdentityCanRead(identity)) {
        status.textContent =
          identity.authentication.kind === 'token'
            ? 'This API token does not grant invoice read access.'
            : 'Your profile does not have access to invoices.'
        article.hidden = true
        syncControls()
        return
      }
      // What the edit page saved, if this is where it came back to: said in
      // the status line above the document once the document is up, and not
      // over a failure to load it.
      const notice = takePageNotice(globalThis.location.pathname)
      const loaded = await loadDetail(session, { hideDocument: true })
      if (loaded && notice !== null && current() === session) status.textContent = notice
    },
  }
}
