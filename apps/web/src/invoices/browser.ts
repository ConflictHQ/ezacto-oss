import {
  EzactoApiError,
  type Invoice,
  type InvoiceMessage,
  type InvoicePayment,
  type InvoicePaymentInput,
  type InvoicePaymentUpdateInput,
  type Whoami,
} from '@ezacto/client'
import {
  invoiceCanRecordPayment,
  invoiceIdFromPathname,
  invoiceIdentityCanRead,
  invoiceIdentityCanWrite,
  invoiceMessageLabel,
  invoicePaymentAmountCents,
  invoicePaymentAmountForForm,
  invoicePaymentCanDelete,
  invoicePaymentCanUpdate,
  invoicePaymentLocalInstant,
  invoicePaymentProviderLabel,
  invoicePaymentTiming,
  invoicePeriod,
  invoiceStateLabel,
  type InvoicePaymentApi,
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

const listCard = (invoice: Readonly<Invoice>): HTMLElement => {
  const card = document.createElement('article')
  card.className = 'invoice-list-card'
  card.dataset.invoiceId = String(invoice.id)
  const heading = document.createElement('div')
  heading.className = 'invoice-list-heading'
  const title = document.createElement('h2')
  const link = document.createElement('a')
  link.href = `/invoices/${invoice.id}`
  link.textContent = `Invoice ${invoice.number}`
  title.append(link)
  const state = document.createElement('span')
  state.className = 'invoice-state'
  state.dataset.state = invoice.state
  state.textContent = invoiceStateLabel(invoice)
  heading.append(title, state)
  const facts = document.createElement('p')
  facts.className = 'invoice-list-facts'
  facts.textContent = `Client #${invoice.client_id} · Issued ${dateLabel(invoice.issue_date)} · Due ${dateLabel(invoice.due_date)}`
  const amounts = document.createElement('div')
  amounts.className = 'invoice-list-amounts'
  const total = document.createElement('strong')
  total.textContent = money(invoice.amount_cents, invoice.currency)
  const due = document.createElement('span')
  due.textContent = `${money(invoice.due_amount_cents, invoice.currency)} due`
  amounts.append(total, due)
  card.append(heading, facts, amounts)
  return card
}

export const renderInvoiceListItems = (
  invoices: readonly Invoice[],
  append: boolean,
): number => {
  const list = required<HTMLElement>('[data-invoice-list]')
  if (!append) list.replaceChildren()
  if (invoices.length === 0 && list.childElementCount === 0) {
    const empty = document.createElement('p')
    empty.className = 'invoice-list-empty'
    empty.textContent = 'No invoices have been created or imported yet.'
    list.replaceChildren(empty)
    return 0
  }
  if (list.querySelector('.invoice-list-empty') !== null) list.replaceChildren()
  list.append(...invoices.map(listCard))
  return list.querySelectorAll('[data-invoice-id]').length
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
    readonly onEdit: (payment: InvoicePayment) => void
    readonly onDelete: (payment: InvoicePayment) => void
  },
): void => {
  required<HTMLElement>('[data-invoice-detail-number]').textContent = invoice.number
  required<HTMLElement>('[data-invoice-detail-state]').textContent = invoiceStateLabel(invoice)
  required<HTMLElement>('[data-invoice-detail-client]').textContent = `Client #${invoice.client_id}`
  required<HTMLElement>('[data-invoice-detail-issued]').textContent = dateLabel(invoice.issue_date)
  required<HTMLElement>('[data-invoice-detail-due-date]').textContent = dateLabel(invoice.due_date)
  required<HTMLElement>('[data-invoice-detail-period]').textContent = invoicePeriod(invoice) ?? '—'
  required<HTMLElement>('[data-invoice-detail-purchase-order]').textContent =
    invoice.purchase_order?.trim() || '—'

  const subject = required<HTMLElement>('[data-invoice-detail-subject]')
  subject.textContent = invoice.subject?.trim() ?? ''
  subject.hidden = subject.textContent === ''

  const lines = required<HTMLTableSectionElement>('[data-invoice-detail-lines]')
  if (invoice.line_items.length === 0) {
    const row = document.createElement('tr')
    const cell = document.createElement('td')
    cell.colSpan = 4
    cell.className = 'invoice-line-empty'
    cell.textContent = 'This invoice has no line items.'
    row.append(cell)
    lines.replaceChildren(row)
  } else {
    lines.replaceChildren(
      ...invoice.line_items.map((line) => {
        const row = document.createElement('tr')
        const description = document.createElement('th')
        description.scope = 'row'
        description.textContent = line.description?.trim() || line.kind
        const quantity = document.createElement('td')
        quantity.textContent = new Intl.NumberFormat('en-US', {
          maximumFractionDigits: 4,
        }).format(line.quantity)
        const rate = document.createElement('td')
        rate.textContent = money(line.unit_price_cents, invoice.currency)
        const amount = document.createElement('td')
        amount.textContent = money(line.amount_cents, invoice.currency)
        row.append(description, quantity, rate, amount)
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
              edit.addEventListener('click', () => actions.onEdit(payment))
              controls.append(edit)
            }
            if (invoicePaymentCanDelete(invoice, payment)) {
              const remove = document.createElement('button')
              remove.type = 'button'
              remove.dataset.invoicePaymentDelete = String(payment.id)
              remove.textContent = 'Delete'
              remove.addEventListener('click', () => actions.onDelete(payment))
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
  document.title = `ezacto — Invoice ${invoice.number}`
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

  let activationGeneration = 0
  let requestGeneration = 0
  let active: ActiveSession | null = null
  let invoice: Invoice | null = null
  let payments: readonly InvoicePayment[] = []
  let editingPayment: InvoicePayment | null = null
  let deletingPayment: InvoicePayment | null = null
  let mutationPending = false
  let refreshRequired = false
  let paymentCommandId: string | null = null
  let deleteCommandId: string | null = null

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

  const syncControls = (): void => {
    const session = current()
    const canWrite =
      session !== null && invoice !== null && invoiceIdentityCanWrite(session.identity)
    const canRecord = canWrite && invoice !== null && invoiceCanRecordPayment(invoice)
    const controlsLocked = mutationPending || refreshRequired
    record.hidden = !canWrite
    record.disabled = controlsLocked || !canRecord
    record.title =
      canWrite && !canRecord
        ? invoice?.state === 'draft'
          ? 'Payments can be recorded after this invoice is open.'
          : invoice?.state === 'closed'
            ? 'Payments cannot be recorded on a closed invoice.'
            : 'This invoice has no remaining amount due.'
        : ''
    readonlyNotice.hidden = session === null || canWrite
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
  }

  const closeDialogs = (): void => {
    if (paymentDialog.open) paymentDialog.close()
    if (deleteDialog.open) deleteDialog.close()
  }

  const clearPrivatePresentation = (): void => {
    invoice = null
    payments = []
    editingPayment = null
    deletingPayment = null
    mutationPending = false
    refreshRequired = false
    paymentCommandId = null
    deleteCommandId = null
    closeDialogs()
    paymentForm.reset()
    deleteForm.reset()
    paymentResult.textContent = ''
    deleteResult.textContent = ''
    workflowStatus.textContent = ''
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
        onEdit: (payment) => openPaymentDialog(payment),
        onDelete: (payment) => openDeleteDialog(payment),
      })
      refreshRequired = false
      article.hidden = false
      status.textContent = ''
      workflowStatus.textContent = options.successMessage ?? ''
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
    deleteSummary.textContent = `${money(payment.amount_cents, payment.currency)} paid ${paymentDateLabel(payment)}`
    syncControls()
    deleteDialog.showModal()
    deleteSubmit.focus()
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
      deleteCommandId = null
      const loaded = await loadDetail(session, { hideDocument: false })
      if (current() !== session) return
      result.textContent = loaded
        ? 'The invoice or payment changed elsewhere. Latest values are loaded; review and try again.'
        : 'The invoice changed elsewhere and the latest values could not be loaded. Retry the invoice.'
      if (editingPayment === null && paymentDialog.open) paymentDialog.close()
      if (deletingPayment === null && deleteDialog.open) deleteDialog.close()
      return
    }
    result.textContent = apiMessage(error)
  }

  precision.addEventListener('change', () => {
    if (!mutationPending) paymentCommandId = null
    syncPrecision()
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
  retry.addEventListener('click', () => {
    const session = current()
    if (session !== null) void loadDetail(session, { hideDocument: invoice === null })
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
