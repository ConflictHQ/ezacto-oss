import { renderStaffInvoiceDocuments } from '../staff-payments/invoices-browser.js'
import { EzactoApiError } from '@conflict-hq/ezacto-client'
import { previousPaymentMonth, validPaymentMonth, type MyPayments } from '@ezacto/core'
import { renderDataTable } from '../components/data-table.js'
import {
  myPaymentsHours,
  myPaymentsMoney,
  myPaymentsRefusal,
  myPaymentsStatusText,
  myUpcomingStatusText,
  type MyPaymentsApi,
} from './model.js'

export interface MyPaymentsController {
  activate(signal: AbortSignal): Promise<void>
}

const required = <ElementType extends Element>(selector: string): ElementType => {
  const element = document.querySelector<ElementType>(selector)
  if (element === null) throw new Error(`my payments element missing: ${selector}`)
  return element
}

const errorCode = (error: unknown): string | null =>
  error instanceof EzactoApiError
    ? ((error.body as { error?: { code?: string } } | null)?.error?.code ?? null)
    : null

export const createMyPaymentsController = (api: MyPaymentsApi): MyPaymentsController => {
  const page = document.querySelector<HTMLElement>('[data-my-payments-page]')
  if (page === null) return { activate: async () => {} }
  const month = required<HTMLInputElement>('[data-my-payments-month]')
  const refresh = required<HTMLButtonElement>('[data-my-payments-refresh]')
  const status = required<HTMLElement>('[data-my-payments-status]')
  const content = required<HTMLElement>('[data-my-payments-content]')
  const summary = required<HTMLElement>('[data-my-payments-summary]')
  const receipts = required<HTMLElement>('[data-my-payments-receipts]')
  const upcoming = required<HTMLElement>('[data-my-payments-upcoming]')
  const invoices = required<HTMLElement>('[data-my-staff-invoices]')

  let active: AbortSignal | null = null
  let generation = 0

  // Drawn pay figures do not outlive the session that was allowed to see them.
  const clear = (): void => {
    content.hidden = true
    summary.replaceChildren()
    receipts.replaceChildren()
    upcoming.replaceChildren()
    invoices.replaceChildren()
  }

  const row = (label: string, value: string): HTMLElement[] => {
    const term = document.createElement('dt')
    term.textContent = label
    const detail = document.createElement('dd')
    detail.textContent = value
    return [term, detail]
  }

  const render = (data: MyPayments): void => {
    const owed = data.owed
    summary.replaceChildren(
      ...row('Hours tracked', myPaymentsHours(data.hours_seconds)),
      ...row('Status', myPaymentsStatusText(data.status)),
      ...(owed === null
        ? row('Owed', 'Not yet recorded. It appears after an administrator records it.')
        : [
            ...row('Owed', myPaymentsMoney(owed.amount_cents, owed.currency)),
            ...row('Paid', myPaymentsMoney(data.paid_cents, owed.currency)),
            ...row('Balance', myPaymentsMoney(data.balance_cents ?? 0, owed.currency)),
          ]),
    )
    receipts.replaceChildren(
      renderDataTable<MyPayments['payments'][number]>({
        caption: 'Payments and applied credit recorded for this month',
        table: 'my-payments-recorded',
        defaultSort: { column: 'paid_on', direction: 'descending' },
        rows: [...data.payments],
        rowKey: (payment) => `${payment.paid_on}-${payment.currency}-${payment.amount_cents}`,
        empty: 'No payments recorded for this month.',
        columns: [
          { key: 'kind', label: 'Kind', sortValue: (payment) => payment.kind ?? 'payment', render: (payment) => payment.kind === 'credit_application' ? 'Advance credit applied (no new transfer)' : 'Payment' },
          { key: 'paid_on', label: 'Paid / applied on', sortValue: (payment) => payment.paid_on, render: (payment) => payment.paid_on },
          {
            key: 'amount',
            label: 'Amount',
            numeric: true,
            sortValue: (payment) => [payment.currency, payment.amount_cents],
            render: (payment) => myPaymentsMoney(payment.amount_cents, payment.currency),
          },
        ],
      }),
    )
    upcoming.replaceChildren(
      renderDataTable<MyPayments['upcoming'][number]>({
        caption: 'Upcoming payments',
        table: 'my-payments-upcoming',
        defaultSort: { column: 'scheduled_on', direction: 'ascending' },
        rows: [...data.upcoming],
        rowKey: (payment) => `${payment.scheduled_on}-${payment.currency}-${payment.amount_cents}-${payment.status}`,
        empty: 'No payments are scheduled.',
        columns: [
          {
            key: 'kind', label: 'Kind', sortValue: (payment) => payment.kind ?? 'payment', render: (payment) => payment.kind === 'advance' ? 'Advance deposit' : 'Payment',
          },
          {
            key: 'scheduled_on',
            label: 'Scheduled for',
            sortValue: (payment) => payment.scheduled_on,
            render: (payment) => payment.scheduled_on,
          },
          {
            key: 'amount',
            label: 'Amount',
            numeric: true,
            sortValue: (payment) => [payment.currency, payment.amount_cents],
            render: (payment) => myPaymentsMoney(payment.amount_cents, payment.currency),
          },
          {
            key: 'status',
            label: 'Status',
            sortValue: (payment) => myUpcomingStatusText(payment.status),
            render: (payment) => myUpcomingStatusText(payment.status),
          },
        ],
      }),
    )
    content.hidden = false
  }

  const load = async (): Promise<void> => {
    const signal = active
    if (signal === null || signal.aborted) return
    const request = ++generation
    const current = (): boolean => !signal.aborted && active === signal && generation === request
    clear()
    if (!validPaymentMonth(month.value)) {
      status.textContent = 'Choose a valid month.'
      return
    }
    const requestedMonth = month.value
    invoices.replaceChildren()
    status.textContent = 'Loading your payments…'
    try {
      const response = await api.getMyPayments(requestedMonth, signal)
      if (!current() || month.value !== requestedMonth) return
      render(response.data)
      status.textContent = ''
      if (api.getMyStaffInvoices) {
        try {
          const response = await api.getMyStaffInvoices(requestedMonth, signal)
          if (current() && month.value === requestedMonth) invoices.replaceChildren(renderStaffInvoiceDocuments(response.data))
        } catch {
          if (current() && month.value === requestedMonth) invoices.textContent = 'Contractor invoice documents could not be loaded. Refresh to try again.'
        }
      }
    } catch (error) {
      if (!current() || month.value !== requestedMonth) return
      clear()
      status.textContent =
        myPaymentsRefusal(errorCode(error)) ??
        (error instanceof Error ? error.message : 'Your payments could not be loaded.')
    }
  }

  month.addEventListener('change', () => void load())
  refresh.addEventListener('click', () => void load())

  return {
    async activate(signal) {
      active = signal
      signal.addEventListener('abort', clear, { once: true })
      if (page.hidden) return
      if (month.value === '') month.value = previousPaymentMonth(new Date().toISOString())
      await load()
    },
  }
}
