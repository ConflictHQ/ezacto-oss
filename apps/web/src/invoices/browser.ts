import type { Invoice, InvoiceMessage, InvoicePayment } from '@ezacto/client'
import {
  invoiceMessageLabel,
  invoicePaymentDate,
  invoicePeriod,
  invoiceStateLabel,
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
          const summary = document.createElement('strong')
          summary.textContent = money(payment.amount_cents, payment.currency)
          const date = document.createElement('span')
          date.textContent = dateLabel(invoicePaymentDate(payment))
          item.append(summary, date)
          if (payment.notes?.trim()) {
            const note = document.createElement('p')
            note.textContent = payment.notes
            item.append(note)
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
