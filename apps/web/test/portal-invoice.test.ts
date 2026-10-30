/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { reportInvoiceShown } from '../src/portal-invoice/browser.js'
import { renderPortalInvoicePage, type PortalInvoicePage } from '../src/portal-invoice/render.js'

/**
 * Issue 936: the hosted invoice page a client reaches from the emailed link.
 * The routes behind it are `packages/api`'s; here is what the page says and
 * what its one script asks of the server.
 */

const token = 'T'.repeat(43)

const page = (overrides: Partial<PortalInvoicePage> = {}): PortalInvoicePage => ({
  companyName: 'Northwind Studio',
  clientName: 'Kestrel & Sons',
  number: 'INV-1315',
  subject: 'September retainer',
  currency: 'USD',
  issueDate: '2026-09-01',
  dueDate: '2026-09-30',
  amountCents: 123_400,
  dueAmountCents: 123_400,
  state: 'open',
  paymentUrl: 'https://pay.example.test/i/abc',
  hasDocument: true,
  ...overrides,
})

describe('the hosted invoice page', () => {
  it('[unit] shows the invoice, its document and a way to pay', () => {
    const html = renderPortalInvoicePage(page(), token)
    expect(html).toContain('<title>Invoice INV-1315 — Northwind Studio</title>')
    expect(html).toContain('Kestrel &amp; Sons')
    expect(html).toContain('$1,234.00 USD')
    expect(html).toContain(`href="/portal/invoices/${token}/document"`)
    expect(html).toContain('href="https://pay.example.test/i/abc"')
    expect(html).toContain('Northwind Studio is told when this invoice is first opened.')
  })

  it('[security] is not indexed, loads only its own script and style, and keeps the address home', () => {
    const html = renderPortalInvoicePage(page(), token)
    expect(html).toContain('<meta name="robots" content="noindex,nofollow,noarchive">')
    expect(html).toContain('<meta name="referrer" content="no-referrer">')
    expect(html).toContain('src="/assets/portal-invoice.js"')
    expect(html).toContain('href="/assets/ezacto.css"')
    // No third party, no tracking image, nothing inline that a CSP would refuse.
    expect(html.match(/(?:src|href)="https?:\/\/[^"]*"/gu)).toEqual(['href="https://pay.example.test/i/abc"'])
    expect(html).not.toMatch(/<img|<iframe|<script(?![^>]*src=)|onclick|onload/iu)
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('[security] escapes everything the company and the client typed', () => {
    const html = renderPortalInvoicePage(
      page({
        companyName: '<script>alert(1)</script>',
        clientName: '"><img src=x onerror=alert(1)>',
        subject: "'; DROP TABLE invoices; --",
        number: '<b>1</b>',
      }),
      token,
    )
    expect(html).not.toContain('<script>alert')
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('<b>1</b>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('[security] offers a way to pay only where one exists and something is owed on an open invoice', () => {
    for (const overrides of [
      { paymentUrl: null },
      { dueAmountCents: 0 },
      { state: 'paid' as const },
      { state: 'closed' as const },
      { paymentUrl: 'javascript:alert(1)' },
      { paymentUrl: 'http://pay.example.test/insecure' },
    ]) {
      expect(renderPortalInvoicePage(page(overrides), token)).not.toContain('data-portal-invoice-pay')
    }
  })

  it('[unit] offers the document only where one was sent, and says the status', () => {
    expect(renderPortalInvoicePage(page({ hasDocument: false }), token)).not.toContain('/document')
    expect(renderPortalInvoicePage(page({ state: 'paid' }), token)).toContain('<dd>Paid</dd>')
    expect(renderPortalInvoicePage(page(), token)).toContain('<dd>Open</dd>')
  })
})

describe('the hosted invoice page script', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  })

  const setVisibility = (state: 'visible' | 'hidden'): void => {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
  }

  it('[browser] reports the page as shown once, to its own address, with nothing in the request', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    window.history.replaceState({}, '', `/portal/invoices/${token}`)
    setVisibility('visible')
    reportInvoiceShown()
    document.dispatchEvent(new Event('visibilitychange'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(`/portal/invoices/${token}/viewed`, {
      method: 'POST',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      keepalive: true,
    })
  })

  it('[browser] waits until the page is actually visible before reporting', () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    window.history.replaceState({}, '', `/portal/invoices/${token}`)
    setVisibility('hidden')
    reportInvoiceShown()
    expect(fetchMock).not.toHaveBeenCalled()
    setVisibility('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('[browser] a failed report is not something the reader is shown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('offline')
      }),
    )
    window.history.replaceState({}, '', `/portal/invoices/${token}`)
    setVisibility('visible')
    expect(() => reportInvoiceShown()).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
})
