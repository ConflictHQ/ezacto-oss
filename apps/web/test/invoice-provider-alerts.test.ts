/** @vitest-environment happy-dom */
import { afterEach, expect, it, vi } from 'vitest'
import {
  createInvoiceProviderAlerts,
  renderInvoiceProviderAlerts,
  type InvoiceProviderAlert,
  type InvoiceProviderAlertApi,
} from '../src/invoices/provider-alerts.js'

const alert: InvoiceProviderAlert = {
  id: 'evt_test', event_type: 'charge.refunded', kind: 'refund', amount_cents: 4500,
  currency: 'USD', provider_status: 'refunded', occurred_at: '2026-10-26T00:00:00Z',
  reviewed_at: null, reviewed_by: null,
}
const mount = (api: InvoiceProviderAlertApi, administrator = true) => {
  document.body.innerHTML = renderInvoiceProviderAlerts()
  const abort = new AbortController()
  const session = { key: {}, signal: abort.signal, administrator, isCurrent: () => true, onSessionFailure: vi.fn(() => false) }
  return { panel: createInvoiceProviderAlerts(api), session, abort }
}
const flush = async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }
afterEach(() => { document.body.replaceChildren() })

it('shows safe provider text and reviewed history; only administrators can review', async () => {
  const review = vi.fn()
  const { panel, session } = mount({
    listInvoiceProviderAlerts: async () => [
      { ...alert, provider_status: '<img src=x onerror=alert(1)>' },
      { ...alert, id: 'evt_reviewed', reviewed_at: '2026-10-26T01:00:00Z', reviewed_by: 2 },
    ], reviewInvoiceProviderAlert: review,
  }, false)
  await panel.load(7, session)
  expect(document.body.textContent).toContain('Refund total reported · $45.00')
  expect(document.body.textContent).toContain('Needs administrator review')
  expect(document.body.textContent).toContain('Reviewed 2026-10-26T01:00:00Z')
  expect(document.querySelector('img')).toBeNull()
  expect([...document.querySelectorAll('button')].some((button) => button.textContent === 'Mark reviewed')).toBe(false)
  expect(review).not.toHaveBeenCalled()
})

it('shows progress and prevents duplicate review; reloads provider state after success', async () => {
  let finish!: (value: InvoiceProviderAlert) => void
  const review = vi.fn(() => new Promise<InvoiceProviderAlert>((resolve) => { finish = resolve }))
  const read = vi.fn().mockResolvedValueOnce([alert]).mockResolvedValueOnce([{ ...alert, reviewed_at: '2026-10-26T01:00:00Z' }])
  const { panel, session } = mount({ listInvoiceProviderAlerts: read, reviewInvoiceProviderAlert: review })
  await panel.load(7, session)
  const button = document.querySelector<HTMLButtonElement>('[data-invoice-provider-alert-list] button')!
  button.click(); button.click()
  button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  expect(review).toHaveBeenCalledTimes(1)
  expect(review).toHaveBeenCalledWith(7, 'evt_test', session.signal)
  expect(button.disabled).toBe(true)
  expect(document.querySelector('[data-request-busy]')).not.toBeNull()
  finish({ ...alert, reviewed_at: '2026-10-26T01:00:00Z' })
  await flush()
  expect(read).toHaveBeenCalledTimes(2)
  expect(document.body.textContent).toContain('Payments and invoice balance are unchanged')
  expect(document.querySelector('[data-request-busy]')).toBeNull()
})

it('keeps review admission locked across concurrent alert refreshes', async () => {
  let finish!: (value: InvoiceProviderAlert) => void
  const review = vi.fn(() => new Promise<InvoiceProviderAlert>((resolve) => { finish = resolve }))
  const { panel, session } = mount({ listInvoiceProviderAlerts: async () => [alert], reviewInvoiceProviderAlert: review })
  await panel.load(7, session)
  document.querySelector<HTMLButtonElement>('[data-invoice-provider-alert-list] button')!.click()
  await panel.load(7, { ...session })
  const fresh = document.querySelector<HTMLButtonElement>('[data-invoice-provider-alert-list] button')!
  expect(fresh.disabled).toBe(true)
  // Exercise admission independently of presentation (e.g. a replaced button).
  fresh.disabled = false
  fresh.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  expect(review).toHaveBeenCalledTimes(1)
  expect(document.querySelector('[data-request-busy]')).not.toBeNull()
  finish({ ...alert, reviewed_at: '2026-10-26T01:00:00Z' }); await flush()
  expect(document.body.textContent).toContain('Review recorded')
})

it('requires refresh after uncertain review and preserves read failures as errors', async () => {
  const read = vi.fn().mockResolvedValueOnce([alert]).mockRejectedValueOnce(new Error('Network unavailable'))
  const { panel, session } = mount({
    listInvoiceProviderAlerts: read,
    reviewInvoiceProviderAlert: async () => { throw new Error('Lost reply') },
  })
  await panel.load(7, session)
  const button = document.querySelector<HTMLButtonElement>('[data-invoice-provider-alert-list] button')!
  button.click(); await flush()
  expect(button.disabled).toBe(true)
  expect(document.body.textContent).toContain('Review was not confirmed')
  const retry = document.querySelector<HTMLButtonElement>('[data-invoice-provider-alert-retry]')!
  expect(retry.hidden).toBe(false)
  retry.click(); await flush()
  expect(document.body.textContent).toContain('Stripe alerts could not be checked')
  expect(document.body.textContent).not.toContain('No Stripe payment alerts')
})

it('clears private alerts on logout and ignores a late response from an old session', async () => {
  let finish!: (value: InvoiceProviderAlert[]) => void
  const { panel, session, abort } = mount({
    listInvoiceProviderAlerts: () => new Promise((resolve) => { finish = resolve }),
  })
  const pending = panel.load(7, session)
  abort.abort(); panel.clear(); finish([alert]); await pending
  expect(document.querySelector<HTMLElement>('[data-invoice-provider-alerts]')!.hidden).toBe(true)
  expect(document.querySelector('[data-invoice-provider-alert-list]')!.textContent).toBe('')
})
