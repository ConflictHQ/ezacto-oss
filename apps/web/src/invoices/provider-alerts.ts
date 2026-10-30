import { setRequestBusy } from '../request-feedback.js'
import { invoiceApiMessage } from './model.js'
import type { InvoiceProviderAlertApi } from './provider-alerts-model.js'

interface AlertSession {
  readonly key: object
  readonly signal: AbortSignal
  readonly administrator: boolean
  readonly isCurrent: () => boolean
  readonly onSessionFailure: (error: unknown) => boolean
}

/** Isolated from payment edits: reviewing a provider report never writes a receipt. */
export const createInvoiceProviderAlerts = (api: InvoiceProviderAlertApi) => {
  const root = document.querySelector<HTMLElement>('[data-invoice-provider-alerts]')
  const status = root?.querySelector<HTMLElement>('[data-invoice-provider-alert-status]')
  const list = root?.querySelector<HTMLElement>('[data-invoice-provider-alert-list]')
  const retry = root?.querySelector<HTMLButtonElement>('[data-invoice-provider-alert-retry]')
  let generation = 0
  let pendingReview: symbol | null = null
  let shown: { id: number; session: AlertSession } | null = null
  const clear = () => {
    generation += 1
    pendingReview = null
    shown = null
    if (root) root.hidden = true
    list?.replaceChildren()
    if (status) { status.textContent = ''; setRequestBusy(status, false) }
    if (retry) retry.hidden = true
  }
  const valid = (request: number, session: AlertSession) =>
    generation === request && !session.signal.aborted && session.isCurrent()

  const load = async (id: number, session: AlertSession, message?: string): Promise<void> => {
    if (!root || !status || !list || !retry || !api.listInvoiceProviderAlerts) return
    const request = ++generation
    shown = { id, session }
    root.hidden = false
    list.replaceChildren()
    status.textContent = 'Checking Stripe payment alerts…'
    setRequestBusy(status, true)
    retry.hidden = true
    try {
      const alerts = await api.listInvoiceProviderAlerts(id, session.signal)
      if (!valid(request, session)) return
      status.textContent = pendingReview ? 'Recording administrator review…' : (message ?? (alerts.length ? '' : 'No Stripe payment alerts.'))
      for (const alert of alerts) {
        const row = document.createElement('li')
        const heading = document.createElement('strong')
        const amount = new Intl.NumberFormat('en-US', { style: 'currency', currency: alert.currency }).format(alert.amount_cents / 100)
        heading.textContent = `${alert.kind === 'refund' ? 'Refund total reported' : 'Disputed amount'} · ${amount}`
        const detail = document.createElement('p')
        detail.textContent = `${alert.provider_status} · ${alert.occurred_at}`
        const review = document.createElement('p')
        review.textContent = alert.reviewed_at === null ? 'Needs administrator review' : `Reviewed ${alert.reviewed_at}`
        row.append(heading, detail, review)
        if (alert.reviewed_at === null && session.administrator && api.reviewInvoiceProviderAlert) {
          const button = document.createElement('button')
          button.type = 'button'
          button.textContent = 'Mark reviewed'
          button.disabled = pendingReview !== null
          button.addEventListener('click', () => { void markReviewed(id, alert.id, session, request) })
          row.append(button)
        }
        list.append(row)
      }
    } catch (error) {
      if (!valid(request, session)) return
      if (session.onSessionFailure(error)) { clear(); return }
      status.textContent = `Stripe alerts could not be checked. ${invoiceApiMessage(error)}`
      retry.hidden = false
    } finally {
      if (valid(request, session)) setRequestBusy(status, pendingReview !== null)
    }
  }

  const markReviewed = async (id: number, alertId: string, session: AlertSession, request: number) => {
    if (!status || !list || !retry || pendingReview !== null || !session.administrator || !valid(request, session) || !api.reviewInvoiceProviderAlert) return
    const pending = Symbol('review')
    pendingReview = pending
    const stillShown = () => pendingReview === pending && shown?.id === id && shown.session.key === session.key && !session.signal.aborted && session.isCurrent()
    // Disable every review button so a second click cannot submit another write.
    const buttons = [...list.querySelectorAll<HTMLButtonElement>('button')]
    buttons.forEach((button) => { button.disabled = true })
    retry.hidden = true
    status.textContent = 'Recording administrator review…'
    setRequestBusy(status, true)
    try {
      await api.reviewInvoiceProviderAlert(id, alertId, session.signal)
      if (!stillShown()) return
      pendingReview = null
      await load(id, session, 'Review recorded. Payments and invoice balance are unchanged.')
    } catch (error) {
      if (!stillShown()) return
      if (session.onSessionFailure(error)) { clear(); return }
      list.querySelectorAll<HTMLButtonElement>('button').forEach((button) => { button.disabled = true })
      status.textContent = `Review was not confirmed. Refresh alerts before retrying. ${invoiceApiMessage(error)}`
      retry.hidden = false
      // The result can be uncertain after a lost reply. Require a fresh read.
    } finally {
      if (pendingReview === pending) {
        pendingReview = null
        if (shown?.id === id && shown.session.key === session.key && session.isCurrent()) setRequestBusy(status, false)
      }
    }
  }
  retry?.addEventListener('click', () => { if (shown) void load(shown.id, shown.session) })
  return { load, clear }
}
