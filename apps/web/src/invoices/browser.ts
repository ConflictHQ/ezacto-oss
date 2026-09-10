import { renderDataTable, type CellContent } from '../components/data-table.js'
import { markMoney, moneyText } from '../money-display.js'
import {
  type Attachment,
  EzactoApiError,
  type Invoice,
  type InvoiceEditInput,
  type InvoiceEmailDeliveryInput,
  type InvoiceLine,
  type InvoiceLineInput,
  type InvoiceLineUpdateInput,
  type InvoiceMessage,
  type InvoicePayment,
  type InvoicePaymentInput,
  type InvoicePaymentUpdateInput,
  type InvoiceRecipient,
  type InvoiceTransitionInput,
  type Whoami,
} from '@ezacto/client'
import {
  interpolateInvoiceTemplate,
  invoiceCanEditLines,
  invoiceCanIssueTransition,
  invoiceCanMarkSent,
  invoiceCanRecordPayment,
  invoiceIdFromPathname,
  invoiceIdentityCanRead,
  invoiceIdentityCanWrite,
  invoiceLineQuantityForForm,
  invoiceLineUnitPriceForForm,
  invoiceLineValues,
  invoiceMessageLabel,
  invoiceOverflowTransitions,
  invoicePaymentAmountCents,
  invoicePaymentAmountForForm,
  invoicePaymentCanDelete,
  invoicePaymentCanUpdate,
  invoicePaymentLocalInstant,
  invoicePaymentProviderLabel,
  invoicePaymentTiming,
  invoicePeriod,
  invoiceRatePercentForForm,
  invoiceRatePpm,
  invoiceRecipientLine,
  invoiceRecipients,
  invoiceReminderDate,
  invoicePlannedReminder,
  invoiceSendAttemptFor,
  invoiceSendFailure,
  invoiceSendWork,
  invoiceStateLabel,
  type InvoiceOverflowCommand,
  type InvoicePaymentApi,
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
  state.textContent = invoiceStateLabel(invoice)
  return state
}

const invoiceNumberLink = (invoice: Readonly<Invoice>): HTMLAnchorElement => {
  const link = document.createElement('a')
  link.href = `/invoices/${invoice.id}`
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
        { key: 'due-date', label: 'Due', render: (invoice) => dateLabel(invoice.due_date) },
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
    readonly onEditLine: (line: InvoiceLine) => void
    readonly onDeleteLine: (line: InvoiceLine) => void
  },
): void => {
  required<HTMLElement>('[data-invoice-detail-number]').textContent = invoice.number
  required<HTMLElement>('[data-invoice-detail-state]').textContent = invoiceStateLabel(invoice)
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
      : `Planned payment reminder date: ${dateLabel(reminder)}. Delivery is not scheduled yet.`
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
          const edit = document.createElement('button')
          edit.type = 'button'
          edit.dataset.invoiceLineEdit = String(line.id)
          edit.textContent = 'Edit'
          edit.addEventListener('click', () => actions.onEditLine(line))
          const remove = document.createElement('button')
          remove.type = 'button'
          remove.dataset.invoiceLineDelete = String(line.id)
          remove.textContent = 'Delete'
          remove.addEventListener('click', () => actions.onDeleteLine(line))
          controls.append(edit, remove)
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

const apiMessage = (error: unknown): string => {
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

const apiErrorCode = (error: unknown): string | null => {
  if (!(error instanceof EzactoApiError) || typeof error.body !== 'object' || error.body === null) {
    return null
  }
  const detail = Reflect.get(error.body, 'error')
  if (typeof detail !== 'object' || detail === null) return null
  const code = Reflect.get(detail, 'code')
  return typeof code === 'string' ? code : null
}

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
  const editInvoice = required<HTMLButtonElement>('[data-invoice-edit]')
  const editDialog = required<HTMLDialogElement>('[data-invoice-edit-dialog]')
  const editForm = required<HTMLFormElement>('[data-invoice-edit-form]')
  const editSubject = required<HTMLInputElement>('[data-invoice-edit-subject]')
  const editPurchaseOrder = required<HTMLInputElement>('[data-invoice-edit-purchase-order]')
  const editNotes = required<HTMLTextAreaElement>('[data-invoice-edit-notes]')
  const editIssueDate = required<HTMLInputElement>('[data-invoice-edit-issue-date]')
  const editDueDate = required<HTMLInputElement>('[data-invoice-edit-due-date]')
  const editPaymentTerms = required<HTMLSelectElement>('[data-invoice-edit-payment-terms]')
  const editTax = required<HTMLInputElement>('[data-invoice-edit-tax]')
  const editTax2 = required<HTMLInputElement>('[data-invoice-edit-tax2]')
  const editDiscount = required<HTMLInputElement>('[data-invoice-edit-discount]')
  const editResult = required<HTMLElement>('[data-invoice-edit-result]')
  const editSubmit = required<HTMLButtonElement>('[data-invoice-edit-submit]')
  const addLine = required<HTMLButtonElement>('[data-invoice-line-add]')
  const lineReadonlyNotice = required<HTMLElement>('[data-invoice-line-readonly]')
  const lineWorkflowStatus = required<HTMLElement>('[data-invoice-line-status]')
  const lineDialog = required<HTMLDialogElement>('[data-invoice-line-dialog]')
  const lineForm = required<HTMLFormElement>('[data-invoice-line-form]')
  const lineTitle = required<HTMLElement>('[data-invoice-line-dialog-title]')
  const lineKind = required<HTMLInputElement>('[data-invoice-line-kind]')
  const lineDescription = required<HTMLTextAreaElement>('[data-invoice-line-description]')
  const lineQuantity = required<HTMLInputElement>('[data-invoice-line-quantity]')
  const lineRate = required<HTMLInputElement>('[data-invoice-line-rate]')
  const lineRateLabel = required<HTMLElement>('[data-invoice-line-rate-label]')
  const lineTaxed = required<HTMLInputElement>('[data-invoice-line-taxed]')
  const lineTaxed2 = required<HTMLInputElement>('[data-invoice-line-taxed2]')
  const linePreview = required<HTMLElement>('[data-invoice-line-preview]')
  const lineResult = required<HTMLElement>('[data-invoice-line-result]')
  const lineSubmit = required<HTMLButtonElement>('[data-invoice-line-submit]')
  const lineDeleteDialog = required<HTMLDialogElement>('[data-invoice-line-delete-dialog]')
  const lineDeleteForm = required<HTMLFormElement>('[data-invoice-line-delete-form]')
  const lineDeleteSummary = required<HTMLElement>('[data-invoice-line-delete-summary]')
  const lineDeleteResult = required<HTMLElement>('[data-invoice-line-delete-result]')
  const lineDeleteSubmit = required<HTMLButtonElement>('[data-invoice-line-delete-submit]')
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
  let editingLine: InvoiceLine | null = null
  let deletingLine: InvoiceLine | null = null
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
  let lineCommandId: string | null = null
  let lineDeleteCommandId: string | null = null
  let editHeaderCommandId: string | null = null
  let editFinancialsCommandId: string | null = null

  const current = (): ActiveSession | null =>
    active !== null &&
    active.generation === activationGeneration &&
    !active.signal.aborted
      ? active
      : null

  const commandId = (kind: 'record' | 'update' | 'delete'): string =>
    `web.invoice.payment.${kind}:${globalThis.crypto.randomUUID()}`

  const lineMutationCommandId = (kind: 'create' | 'update' | 'delete'): string =>
    `web.invoice.line.${kind}:${globalThis.crypto.randomUUID()}`

  const syncLinePreview = (): void => {
    // The dash stands for a quantity or rate that does not parse yet, which is
    // not an amount, so the marker comes and goes with the figure.
    const preview = (value: string | null): void => {
      linePreview.textContent = value ?? '—'
      markMoney(linePreview, value !== null)
    }
    if (invoice === null) {
      preview(null)
      return
    }
    try {
      preview(
        money(
          invoiceLineValues(lineQuantity.value, lineRate.value).amountCents,
          invoice.currency,
        ),
      )
    } catch {
      preview(null)
    }
  }

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
    overflowToggle.disabled = controlsLocked || !anyTransition
    if (!anyTransition || controlsLocked) closeOverflow()
    readonlyNotice.hidden = session === null || canWrite
    const canEditLines = canWrite && invoice !== null && invoiceCanEditLines(invoice)
    addLine.hidden = !canWrite
    addLine.disabled = controlsLocked || !canEditLines
    addLine.title =
      canWrite && !canEditLines ? 'Line items cannot be changed on a closed invoice.' : ''
    lineReadonlyNotice.hidden = session === null || canWrite
    // A closed invoice rejects every native edit, so the header shares the line gate.
    editInvoice.hidden = !canWrite
    editInvoice.disabled = controlsLocked || !canEditLines
    editInvoice.title =
      canWrite && !canEditLines ? 'A closed invoice can no longer be edited.' : ''
    for (const control of paymentForm.querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement
    >('input, select, textarea, button')) {
      control.disabled = controlsLocked
    }
    syncPrecision()
    paymentSubmit.disabled = controlsLocked
    deleteSubmit.disabled = controlsLocked
    for (const control of article.querySelectorAll<HTMLButtonElement>(
      '[data-invoice-payment-edit], [data-invoice-payment-delete], [data-invoice-line-edit], [data-invoice-line-delete]',
    )) {
      control.disabled = controlsLocked
    }
    for (const control of composerForm.querySelectorAll<
      HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement
    >('input, textarea, button')) {
      control.disabled = controlsLocked
    }
    for (const control of lineForm.querySelectorAll<
      HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement
    >('input, textarea, button')) {
      control.disabled = controlsLocked
    }
    for (const control of editForm.querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLButtonElement
    >('input, select, button')) {
      control.disabled = controlsLocked
    }
    for (const control of transitionForm.querySelectorAll<HTMLButtonElement>('button')) {
      control.disabled = controlsLocked
    }
    transitionSubmit.disabled = controlsLocked
    lineSubmit.disabled = controlsLocked
    editSubmit.disabled = controlsLocked
    lineDeleteSubmit.disabled = controlsLocked
    syncReminder()
    syncComposer()
  }

  const closeDialogs = (): void => {
    if (paymentDialog.open) paymentDialog.close()
    if (deleteDialog.open) deleteDialog.close()
    if (composerDialog.open) composerDialog.close()
    if (lineDialog.open) lineDialog.close()
    if (lineDeleteDialog.open) lineDeleteDialog.close()
    if (editDialog.open) editDialog.close()
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

  const clearPrivatePresentation = (): void => {
    invoice = null
    payments = []
    attachments = []
    attachmentCommandId = null
    editingPayment = null
    deletingPayment = null
    editingLine = null
    deletingLine = null
    mutationPending = false
    refreshRequired = false
    paymentCommandId = null
    settleCommandId = null
    deleteCommandId = null
    sendAttempt = null
    pendingTransition = null
    transitionCommandId = null
    lineCommandId = null
    lineDeleteCommandId = null
    editHeaderCommandId = null
    editFinancialsCommandId = null
    closeDialogs()
    paymentForm.reset()
    deleteForm.reset()
    composerForm.reset()
    lineForm.reset()
    lineDeleteForm.reset()
    editForm.reset()
    attachmentForm.reset()
    paymentResult.textContent = ''
    deleteResult.textContent = ''
    composerResult.textContent = ''
    transitionResult.textContent = ''
    lineResult.textContent = ''
    lineDeleteResult.textContent = ''
    editResult.textContent = ''
    lineWorkflowStatus.textContent = ''
    linePreview.textContent = '—'
    workflowStatus.textContent = ''
    attachmentStatus.textContent = ''
    attachmentList.replaceChildren()
    attachmentForm.hidden = true
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
      const editedLineId = editingLine?.id
      const deletedLineId = deletingLine?.id
      editingPayment =
        editedId === undefined || editedId === null
          ? null
          : (payments.find((payment) => payment.id === editedId) ?? null)
      deletingPayment =
        deletedId === undefined || deletedId === null
          ? null
          : (payments.find((payment) => payment.id === deletedId) ?? null)
      editingLine =
        editedLineId === undefined || editedLineId === null
          ? null
          : (loadedInvoice.line_items.find((line) => line.id === editedLineId) ?? null)
      deletingLine =
        deletedLineId === undefined || deletedLineId === null
          ? null
          : (loadedInvoice.line_items.find((line) => line.id === deletedLineId) ?? null)
      renderInvoiceDetail(loadedInvoice, messages, loadedPayments, {
        canWrite: invoiceIdentityCanWrite(session.identity),
        onEditPayment: (payment) => openPaymentDialog(payment),
        onDeletePayment: (payment) => openDeleteDialog(payment),
        onEditLine: (line) => openLineDialog(line),
        onDeleteLine: (line) => openLineDeleteDialog(line),
      })
      refreshRequired = false
      article.hidden = false
      status.textContent = ''
      workflowStatus.textContent = options.successMessage ?? ''
      lineWorkflowStatus.textContent = ''
      const canWrite = invoiceIdentityCanWrite(session.identity)
      attachmentForm.hidden = !canWrite || api.uploadInvoiceAttachment === undefined
      attachmentReadonly.hidden = canWrite || api.uploadInvoiceAttachment === undefined
      attachmentSubmit.disabled = false
      void loadAttachments(session, invoiceId!)
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

  const openLineDialog = (line: InvoiceLine | null): void => {
    const session = current()
    if (
      session === null ||
      invoice === null ||
      mutationPending ||
      refreshRequired ||
      !invoiceIdentityCanWrite(session.identity) ||
      !invoiceCanEditLines(invoice)
    ) {
      return
    }
    editingLine = line
    lineCommandId = null
    lineForm.reset()
    lineTitle.textContent = line === null ? 'Add line item' : 'Edit line item'
    lineSubmit.textContent = line === null ? 'Add line' : 'Save line'
    lineKind.value = line?.kind ?? 'Service'
    lineDescription.value = line?.description ?? ''
    lineQuantity.value = line === null ? '1' : invoiceLineQuantityForForm(line)
    lineRate.value = line === null ? '0.00' : invoiceLineUnitPriceForForm(line.unit_price_cents)
    lineTaxed.checked = line?.taxed ?? false
    lineTaxed2.checked = line?.taxed2 ?? false
    lineRateLabel.textContent = `Rate (${invoice.currency})`
    lineResult.textContent = ''
    syncLinePreview()
    syncControls()
    lineDialog.showModal()
    lineKind.focus()
  }

  const openLineDeleteDialog = (line: InvoiceLine): void => {
    const session = current()
    if (
      session === null ||
      invoice === null ||
      mutationPending ||
      refreshRequired ||
      !invoiceIdentityCanWrite(session.identity) ||
      !invoiceCanEditLines(invoice)
    ) {
      return
    }
    deletingLine = line
    lineDeleteCommandId = null
    lineDeleteResult.textContent = ''
    lineDeleteSummary.replaceChildren(
      `${line.description?.trim() || line.kind} (`,
      moneyText(money(line.amount_cents, invoice.currency)),
      ')',
    )
    syncControls()
    lineDeleteDialog.showModal()
    lineDeleteSubmit.focus()
  }

  const openEditDialog = (): void => {
    const session = current()
    if (
      session === null ||
      invoice === null ||
      mutationPending ||
      refreshRequired ||
      !invoiceIdentityCanWrite(session.identity) ||
      !invoiceCanEditLines(invoice)
    ) {
      return
    }
    editHeaderCommandId = null
    editFinancialsCommandId = null
    editForm.reset()
    editSubject.value = invoice.subject ?? ''
    editPurchaseOrder.value = invoice.purchase_order ?? ''
    editNotes.value = invoice.notes ?? ''
    editIssueDate.value = invoice.issue_date
    editDueDate.value = invoice.due_date
    editPaymentTerms.value = invoice.payment_terms
    editTax.value = invoiceRatePercentForForm(invoice.tax_rate_ppm)
    editTax2.value = invoiceRatePercentForForm(invoice.tax2_rate_ppm)
    editDiscount.value = invoiceRatePercentForForm(invoice.discount_rate_ppm)
    editResult.textContent = ''
    syncControls()
    editDialog.showModal()
    editSubject.focus()
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

  const conflictCodes = new Set([
    'invoice_version_conflict',
    'trigger_row_conflict',
    'command_id_reused',
  ])

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
      lineCommandId = null
      lineDeleteCommandId = null
      editHeaderCommandId = null
      editFinancialsCommandId = null
      const loaded = await loadDetail(session, { hideDocument: false })
      if (current() !== session) return
      result.textContent = loaded
        ? 'The invoice, line, or payment changed elsewhere. Latest values are loaded; review and try again.'
        : 'The invoice changed elsewhere and the latest values could not be loaded. Retry the invoice.'
      if (editingPayment === null && paymentDialog.open) paymentDialog.close()
      if (deletingPayment === null && deleteDialog.open) deleteDialog.close()
      if (editingLine === null && lineDialog.open) lineDialog.close()
      if (deletingLine === null && lineDeleteDialog.open) lineDeleteDialog.close()
      if (
        lineDialog.open &&
        (invoice === null || !invoiceCanEditLines(invoice))
      ) {
        lineDialog.close()
      }
      if (
        lineDeleteDialog.open &&
        (invoice === null || !invoiceCanEditLines(invoice))
      ) {
        lineDeleteDialog.close()
      }
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
      if (editDialog.open && (invoice === null || !invoiceCanEditLines(invoice))) {
        editDialog.close()
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
  editInvoice.addEventListener('click', openEditDialog)
  editForm.addEventListener('input', () => {
    if (!mutationPending) {
      editHeaderCommandId = null
      editFinancialsCommandId = null
    }
    editResult.textContent = ''
  })
  editForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const session = current()
    const selectedInvoice = invoice
    const updateInvoice = api.updateInvoice
    if (
      session === null ||
      selectedInvoice === null ||
      updateInvoice === undefined ||
      mutationPending ||
      refreshRequired ||
      !invoiceIdentityCanWrite(session.identity) ||
      !invoiceCanEditLines(selectedInvoice)
    ) {
      return
    }
    const subject = editSubject.value.trim()
    const purchaseOrder = editPurchaseOrder.value.trim()
    // Not trimmed to a single line: notes are prose the client reads, and the
    // paragraph breaks someone typed are part of what they wrote. Only the
    // surrounding whitespace goes, so an all-whitespace note still clears.
    const notes = editNotes.value.trim()
    let rates: Pick<InvoiceEditInput, 'tax_rate_ppm' | 'tax2_rate_ppm' | 'discount_rate_ppm'>
    try {
      if (editIssueDate.value === '' || editDueDate.value === '') {
        throw new Error('Enter both an issue date and a due date.')
      }
      if (editDueDate.value < editIssueDate.value) {
        throw new Error('Due date cannot precede the issue date.')
      }
      rates = {
        tax_rate_ppm: invoiceRatePpm(editTax.value, 'Tax 1'),
        tax2_rate_ppm: invoiceRatePpm(editTax2.value, 'Tax 2'),
        discount_rate_ppm: invoiceRatePpm(editDiscount.value, 'Discount'),
      }
    } catch (error) {
      editResult.textContent = apiMessage(error)
      return
    }
    const header = {
      subject: subject === '' ? null : subject,
      purchase_order: purchaseOrder === '' ? null : purchaseOrder,
      notes: notes === '' ? null : notes,
      issue_date: editIssueDate.value,
      due_date: editDueDate.value,
      payment_terms: editPaymentTerms.value as Invoice['payment_terms'],
    }
    const headerChanged =
      header.subject !== selectedInvoice.subject ||
      header.purchase_order !== selectedInvoice.purchase_order ||
      header.notes !== selectedInvoice.notes ||
      header.issue_date !== selectedInvoice.issue_date ||
      header.due_date !== selectedInvoice.due_date ||
      header.payment_terms !== selectedInvoice.payment_terms
    const ratesChanged =
      rates.tax_rate_ppm !== selectedInvoice.tax_rate_ppm ||
      rates.tax2_rate_ppm !== selectedInvoice.tax2_rate_ppm ||
      rates.discount_rate_ppm !== selectedInvoice.discount_rate_ppm
    if (!headerChanged && !ratesChanged) {
      editResult.textContent = 'Nothing changed.'
      return
    }
    editHeaderCommandId ??= `web.invoice.header:${globalThis.crypto.randomUUID()}`
    editFinancialsCommandId ??= `web.invoice.financials:${globalThis.crypto.randomUUID()}`
    const headerCommand = editHeaderCommandId
    const financialsCommand = editFinancialsCommandId
    mutationPending = true
    editResult.textContent = 'Saving invoice…'
    syncControls()
    // The API takes exactly one edit kind per request, so changing both the
    // document and the rates is two commands on rising versions.
    const request = (async (): Promise<Invoice> => {
      let saved = selectedInvoice
      if (headerChanged) {
        saved = await updateInvoice(
          selectedInvoice.id,
          headerCommand,
          { expected_version: saved.version, ...header },
          session.signal,
        )
        // The document is committed even if the rates fail below. Adopting it
        // now leaves a retry sending only the rates, at the version it returned.
        // From here the rendered document is behind the server whatever happens
        // next, so it is already stale: say so, rather than letting a rates
        // failure leave the page showing a version nobody saved.
        if (current() === session) {
          invoice = saved
          editHeaderCommandId = null
          refreshRequired = true
        }
      }
      if (ratesChanged) {
        saved = await updateInvoice(
          selectedInvoice.id,
          financialsCommand,
          { expected_version: saved.version, ...rates },
          session.signal,
        )
      }
      return saved
    })()
    void request
      .then(async (updatedInvoice) => {
        if (current() !== session) return
        invoice = updatedInvoice
        refreshRequired = true
        editHeaderCommandId = null
        editFinancialsCommandId = null
        editResult.textContent = ''
        editDialog.close()
        workflowStatus.textContent = 'Invoice saved. Refreshing invoice…'
        syncControls()
        const loaded = await loadDetail(session, {
          hideDocument: false,
          successMessage: 'Invoice saved.',
        })
        if (!loaded && current() === session && refreshRequired) {
          workflowStatus.textContent =
            'Invoice saved, but the updated invoice could not be refreshed. Retry invoice; the change will not be submitted again.'
        }
      })
      .catch(async (error: unknown) => {
        await handleMutationFailure(error, session, editResult)
        // A conflict already reloaded inside handleMutationFailure. Any other
        // failure that arrives with the document half-saved has not, and the
        // page would otherwise keep rendering the header the user typed as
        // though the whole edit had failed.
        if (current() === session && refreshRequired) {
          await loadDetail(session, { hideDocument: false })
        }
      })
      .finally(() => {
        if (current() !== session) return
        mutationPending = false
        syncControls()
      })
  })
  addLine.addEventListener('click', () => openLineDialog(null))
  lineForm.addEventListener('input', () => {
    if (!mutationPending) lineCommandId = null
    lineResult.textContent = ''
    syncLinePreview()
  })
  lineForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const session = current()
    const selectedInvoice = invoice
    const selectedLine = editingLine
    const createLine = api.createInvoiceLine
    const updateLine = api.updateInvoiceLine
    if (
      session === null ||
      selectedInvoice === null ||
      mutationPending ||
      refreshRequired ||
      !invoiceIdentityCanWrite(session.identity) ||
      !invoiceCanEditLines(selectedInvoice) ||
      (selectedLine === null ? createLine === undefined : updateLine === undefined)
    ) {
      return
    }
    const kind = lineKind.value.trim()
    const description = lineDescription.value.trim()
    let values: ReturnType<typeof invoiceLineValues>
    let position: number
    try {
      if (kind === '') throw new Error('Enter an item type.')
      if (kind.length > 255) throw new Error('Item type cannot exceed 255 characters.')
      if (description.length > 100_000) {
        throw new Error('Description cannot exceed 100,000 characters.')
      }
      values = invoiceLineValues(lineQuantity.value, lineRate.value)
      position =
        selectedLine?.position ??
        selectedInvoice.line_items.reduce(
          (next, line) => Math.max(next, line.position + 1),
          0,
        )
      if (!Number.isSafeInteger(position)) throw new Error('No more lines can be added.')
    } catch (error) {
      lineResult.textContent = apiMessage(error)
      return
    }
    const common = {
      expected_version: selectedInvoice.version,
      position,
      kind,
      description: description === '' ? null : description,
      quantity: values.quantity,
      unit_price_cents: values.unitPriceCents,
      taxed: lineTaxed.checked,
      taxed2: lineTaxed2.checked,
    }
    const input: InvoiceLineInput | InvoiceLineUpdateInput =
      selectedLine === null
        ? common
        : {
            ...common,
            expected_updated_at: selectedLine.updated_at,
            project_id: selectedLine.project_id,
          }
    const kindOfMutation = selectedLine === null ? 'create' : 'update'
    lineCommandId ??= lineMutationCommandId(kindOfMutation)
    const activeCommand = lineCommandId
    mutationPending = true
    lineResult.textContent = selectedLine === null ? 'Adding line…' : 'Saving line…'
    syncControls()
    const request =
      selectedLine === null
        ? createLine!(
            selectedInvoice.id,
            activeCommand,
            input as InvoiceLineInput,
            session.signal,
          )
        : updateLine!(
            selectedInvoice.id,
            selectedLine.id,
            activeCommand,
            input as InvoiceLineUpdateInput,
            session.signal,
          )
    void request
      .then(async (updatedInvoice) => {
        if (current() !== session) return
        invoice = updatedInvoice
        refreshRequired = true
        lineCommandId = null
        editingLine = null
        lineResult.textContent = ''
        lineDialog.close()
        lineWorkflowStatus.textContent =
          selectedLine === null
            ? 'Line added. Refreshing invoice…'
            : 'Line saved. Refreshing invoice…'
        syncControls()
        const loaded = await loadDetail(session, {
          hideDocument: false,
        })
        if (loaded && current() === session) {
          lineWorkflowStatus.textContent = selectedLine === null ? 'Line added.' : 'Line saved.'
        }
        if (!loaded && current() === session && refreshRequired) {
          lineWorkflowStatus.textContent =
            selectedLine === null
              ? 'Line added, but the updated invoice could not be refreshed. Retry invoice; the line will not be submitted again.'
              : 'Line saved, but the updated invoice could not be refreshed. Retry invoice; the change will not be submitted again.'
        }
      })
      .catch((error: unknown) => handleMutationFailure(error, session, lineResult))
      .finally(() => {
        if (current() !== session) return
        mutationPending = false
        syncControls()
      })
  })
  lineDeleteForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const session = current()
    const selectedInvoice = invoice
    const selectedLine = deletingLine
    const deleteLine = api.deleteInvoiceLine
    if (
      session === null ||
      selectedInvoice === null ||
      selectedLine === null ||
      mutationPending ||
      refreshRequired ||
      deleteLine === undefined ||
      !invoiceIdentityCanWrite(session.identity) ||
      !invoiceCanEditLines(selectedInvoice)
    ) {
      return
    }
    lineDeleteCommandId ??= lineMutationCommandId('delete')
    const activeCommand = lineDeleteCommandId
    mutationPending = true
    lineDeleteResult.textContent = 'Deleting line…'
    syncControls()
    void deleteLine(
      selectedInvoice.id,
      selectedLine.id,
      activeCommand,
      {
        expected_version: selectedInvoice.version,
        expected_updated_at: selectedLine.updated_at,
      },
      session.signal,
    )
      .then(async (updatedInvoice) => {
        if (current() !== session) return
        invoice = updatedInvoice
        refreshRequired = true
        lineDeleteCommandId = null
        deletingLine = null
        lineDeleteResult.textContent = ''
        lineDeleteDialog.close()
        lineWorkflowStatus.textContent = 'Line deleted. Refreshing invoice…'
        syncControls()
        const loaded = await loadDetail(session, {
          hideDocument: false,
        })
        if (loaded && current() === session) lineWorkflowStatus.textContent = 'Line deleted.'
        if (!loaded && current() === session && refreshRequired) {
          lineWorkflowStatus.textContent =
            'Line deleted, but the updated invoice could not be refreshed. Retry invoice; the deletion will not be submitted again.'
        }
      })
      .catch((error: unknown) =>
        handleMutationFailure(error, session, lineDeleteResult),
      )
      .finally(() => {
        if (current() !== session) return
        mutationPending = false
        syncControls()
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
  lineDialog.addEventListener('close', () => {
    if (mutationPending) return
    editingLine = null
    lineCommandId = null
    lineResult.textContent = ''
  })
  editDialog.addEventListener('close', () => {
    if (mutationPending) return
    editHeaderCommandId = null
    editFinancialsCommandId = null
    editResult.textContent = ''
  })
  lineDeleteDialog.addEventListener('close', () => {
    if (mutationPending) return
    deletingLine = null
    lineDeleteCommandId = null
    lineDeleteResult.textContent = ''
  })
  record.addEventListener('click', () => openPaymentDialog(null))
  // Mark paid is Record payment with its three fields answered from the invoice
  // itself: the whole remaining balance, today, no note. It goes through the
  // payment route rather than a transition of its own because `paid` is derived
  // from the payments -- an invoice is paid when nothing is left due -- so there
  // is no flag to set, only a payment to record. The command id is held until
  // the write lands, so a click repeated over a timeout settles the balance once.
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
    workflowStatus.textContent = 'Recording payment…'
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
        workflowStatus.textContent = 'Invoice marked paid. Refreshing invoice…'
        syncControls()
        const loaded = await loadDetail(session, {
          hideDocument: false,
          successMessage: 'Invoice marked paid.',
        })
        if (!loaded && current() === session && refreshRequired) {
          workflowStatus.textContent =
            'Invoice marked paid, but the updated invoice could not be refreshed. Retry invoice; the payment will not be submitted again.'
        }
      })
      .catch((error: unknown) => handleMutationFailure(error, session, workflowStatus))
      .finally(() => {
        if (current() !== session) return
        mutationPending = false
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
      await loadDetail(session, { hideDocument: true })
    },
  }
}
