import { renderDataTable, type CellContent } from '../components/data-table.js'
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
  type InvoiceRecipient,
  type InvoiceTransitionInput,
  type Whoami,
} from '@conflict-hq/ezacto-client'
import { takePageNotice } from '../page-notice.js'
import {
  interpolateInvoiceTemplate,
  invoiceApiErrorCode,
  invoiceApiMessage,
  invoiceCanEditLines,
  invoiceCanIssueTransition,
  invoiceCanMarkSent,
  invoiceCanRecordPayment,
  invoiceConflictCodes,
  invoiceEditHref,
  invoiceIdFromPathname,
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
  type InvoiceHoursReportFormat,
  type InvoiceOverflowCommand,
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
// it has already loaded and this falls back only when it has none.
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
  link.href = invoicePagePath(invoice.id)
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
          edit.href = invoiceEditHref(invoice.id, { line: line.id })
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
          const recipientText = message.recipients
            .map((recipient) => recipient.name.trim() || recipient.email)
            .join(', ')
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
  const composerSubject = required<HTMLInputElement>('[data-invoice-composer-subject]')
  const composerBody = required<HTMLTextAreaElement>('[data-invoice-composer-body]')
  const composerReminderToggle = required<HTMLInputElement>('[data-invoice-composer-reminder-toggle]')
  const composerReminderDateLabel = required<HTMLElement>('[data-invoice-composer-reminder-date-label]')
  const composerReminderDate = required<HTMLInputElement>('[data-invoice-composer-reminder-date]')
  const composerDeliverToggle = required<HTMLInputElement>(
    '[data-invoice-composer-deliver-toggle]',
  )
  const composerOwed = required<HTMLElement>('[data-invoice-composer-owed]')
  const composerConfirmLabel = required<HTMLElement>('[data-invoice-composer-confirm-label]')
  const composerConfirm = required<HTMLInputElement>('[data-invoice-composer-confirm]')
  const composerResult = required<HTMLElement>('[data-invoice-composer-result]')
  const composerSubmit = required<HTMLButtonElement>('[data-invoice-composer-submit]')
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
    // operator abandoning it rather than a second thing to record.
    composerSubmit.textContent = owed
      ? delivering
        ? 'Retry the email'
        : 'Skip the email'
      : delivering
        ? 'Send and deliver'
        : 'Send invoice'
    const frozen = composerFrozen()
    composerRecipients.disabled = frozen
    composerSubject.disabled = frozen
    composerBody.disabled = frozen
    composerReminderToggle.disabled = frozen
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
      canEditLines ? invoiceEditHref(invoice!.id, 'new-line') : null,
      'Line items cannot be changed on a closed invoice.',
    )
    lineReadonlyNotice.hidden = session === null || canWrite
    editInvoice.hidden = !canWrite
    offerLink(
      editInvoice,
      canEditLines ? invoiceEditHref(invoice!.id) : null,
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
    options: { readonly hideDocument: boolean; readonly successMessage?: string },
  ): Promise<boolean> => {
    const invoiceId = invoiceIdFromPathname(globalThis.location.pathname)
    const getInvoice = api.getInvoice
    const listMessages = api.listInvoiceMessages
    const listPayments = api.listInvoicePayments
    if (
      current() !== session ||
      invoiceId === null ||
      getInvoice === undefined ||
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
      const [loadedInvoice, messages, loadedPayments] = await Promise.all([
        getInvoice(invoiceId, session.signal),
        listMessages(invoiceId, session.signal),
        listPayments(invoiceId, session.signal),
      ])
      if (current() !== session || requested !== requestGeneration) return false
      invoice = loadedInvoice
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
      status.textContent = ''
      workflowStatus.textContent = options.successMessage ?? ''
      const canWrite = invoiceIdentityCanWrite(session.identity)
      attachmentForm.hidden = !canWrite || api.uploadInvoiceAttachment === undefined
      attachmentReadonly.hidden = canWrite || api.uploadInvoiceAttachment === undefined
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
    composerSubject.value = 'Invoice %invoice_number%'
    composerBody.value =
      'Hello,\n\nPlease find invoice %invoice_number% for %invoice_amount%. Payment is due %invoice_due_date%.\n\nThank you.'
    const today = localDate()
    if (owed !== null) {
      // The recipients the committed send confirmed, not whatever the reset
      // left behind: they are what the retry delivers to.
      composerRecipients.value = owed.recipients.map(invoiceRecipientLine).join('\n')
      composerDeliverToggle.checked = true
      composerConfirm.checked = true
      composerReminderToggle.checked = false
      composerReminderDate.value = ''
    } else {
      composerReminderToggle.checked = invoice.due_date >= today
      composerReminderDate.value = invoice.due_date >= today ? invoice.due_date : ''
    }
    composerResult.textContent = ''
    // syncControls titles the dialog, shows the owed notice and names the
    // submit, all off the attempt, so no entry point sets them independently.
    syncControls()
    composerDialog.showModal()
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
    syncComposer()
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
    let sendReminderOn: string | null = null
    let input: InvoiceTransitionInput | null = null
    const subject = composerSubject.value.trim()
    const body = composerBody.value.trim()
    try {
      if (work === 'send') {
        recipients = invoiceRecipients(composerRecipients.value)
        if (subject === '') throw new Error('Enter a subject before recording.')
        if (body === '') throw new Error('Enter a message before recording.')
        sendReminderOn = composerReminderToggle.checked
          ? invoiceReminderDate(composerReminderDate.value, localDate())
          : null
        if (delivering && !composerConfirm.checked) {
          throw new Error('Confirm the recipients before sending this invoice email.')
        }
        input = {
          command: 'send',
          expected_version: selectedInvoice.version,
          recipients,
          subject: interpolateInvoiceTemplate(subject, selectedInvoice),
          body: interpolateInvoiceTemplate(body, selectedInvoice),
          attach_pdf: false,
          send_me_a_copy: false,
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
    // not been issued at all, so the checkbox and the recipients on screen may
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
    // the message written here and the one the organization template sent.
    const request = (async (): Promise<Invoice> => {
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
          successMessage: delivering
            ? `Invoice marked sent and the email queued for the confirmed recipients.${reminderNote}`
            : `Invoice marked sent. No email was delivered.${reminderNote}`,
        })
        if (!loaded && current() === session && refreshRequired) {
          workflowStatus.textContent =
            'The invoice was sent, but the updated invoice could not be refreshed. Retry invoice; nothing will be submitted again.'
        }
      })
      .catch(async (error: unknown) => {
        if (current() !== session) return
        mutationPending = false
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
