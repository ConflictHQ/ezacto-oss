import { describe, expect, it, vi } from 'vitest'
import { createApiApp, installInvoiceViewRoutes, type InvoiceViewRouteService } from '../src/index.js'

const token = 'A'.repeat(43)
const secondToken = 'B'.repeat(43)
const now = '2026-09-03T08:30:00.000Z'

interface Page {
  readonly number: string
  readonly hasDocument: boolean
}

const harness = (overrides: Partial<InvoiceViewRouteService<Page>> = {}) => {
  const service = {
    allow: vi.fn(async () => true),
    open: vi.fn(async (presented: string) =>
      presented === token ? { number: 'INV-1', hasDocument: true } : null,
    ),
    shown: vi.fn(async (presented: string) => presented === token),
    download: vi.fn(async (presented: string) =>
      presented === token
        ? { filename: 'INVOICE "1"/é.pdf', bytes: new Uint8Array([37, 80, 68, 70]) }
        : null,
    ),
    ...overrides,
  } satisfies InvoiceViewRouteService<Page>
  const app = createApiApp({
    // No session is configured at all: these routes must not need one.
    installApp(root) {
      installInvoiceViewRoutes(root, {
        service,
        clock: () => now,
        clientKey: (request) => request.headers.get('cf-connecting-ip') ?? 'unknown-client',
        render: (page, presented) => `<p data-number>${page.number}</p><a href="/portal/invoices/${presented}/document">pdf</a>`,
        pageHeaders: { 'content-security-policy': "default-src 'none'" },
      })
    },
  })
  return { app, service }
}

const hardened = (response: Response): void => {
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(response.headers.get('referrer-policy')).toBe('no-referrer')
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  expect(response.headers.get('x-robots-tag')).toContain('noindex')
  expect(response.headers.get('set-cookie')).toBeNull()
}

describe('hosted invoice page routes', () => {
  it('[api] serves the page to a token with no session, hardened, and records nothing', async () => {
    const { app, service } = harness()
    const response = await app.request(`/portal/invoices/${token}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'")
    hardened(response)
    expect(await response.text()).toContain('INV-1')
    // Fetching the address is what a mail scanner does; it is not a view.
    expect(service.shown).not.toHaveBeenCalled()
    expect(service.download).not.toHaveBeenCalled()
  })

  it('[security] answers every token that opens nothing with the same plain 404', async () => {
    const { app } = harness()
    const answers = await Promise.all(
      [secondToken, 'short', 'x'.repeat(500), '%252e%252e', 'a b'].flatMap((presented) =>
        [
          app.request(`/portal/invoices/${presented}`),
          app.request(`/portal/invoices/${presented}/viewed`, { method: 'POST' }),
          app.request(`/portal/invoices/${presented}/document`),
        ],
      ),
    )
    const bodies = new Set<string>()
    for (const answer of answers) {
      expect(answer.status).toBe(404)
      expect(answer.headers.get('content-type')).toContain('text/plain')
      hardened(answer)
      bodies.add(await answer.text())
    }
    // One body: nothing to tell never-issued from expired from malformed.
    expect([...bodies]).toEqual(['Not found'])
  })

  it('[security] never echoes the presented token in what it answers', async () => {
    const { app } = harness()
    const probe = 'Zz9_-'.repeat(8) + 'abc'
    const refused = await app.request(`/portal/invoices/${probe}`)
    const text = await refused.text()
    expect(text).not.toContain(probe)
    expect(JSON.stringify([...refused.headers])).not.toContain(probe)
  })

  it('[security] refuses a caller over its allowance before looking at the token', async () => {
    const { app, service } = harness({ allow: vi.fn(async () => false) })
    for (const request of [
      app.request(`/portal/invoices/${token}`),
      app.request(`/portal/invoices/${token}/viewed`, { method: 'POST' }),
      app.request(`/portal/invoices/${token}/document`),
    ]) {
      const response = await request
      expect(response.status).toBe(429)
      expect(response.headers.get('retry-after')).toBe('60')
      hardened(response)
    }
    expect(service.open).not.toHaveBeenCalled()
    expect(service.shown).not.toHaveBeenCalled()
    expect(service.download).not.toHaveBeenCalled()
  })

  it('[api] counts each caller by the address it presents, never by the token', async () => {
    const { app, service } = harness()
    await app.request(`/portal/invoices/${token}`, { headers: { 'cf-connecting-ip': '203.0.113.7' } })
    await app.request(`/portal/invoices/${token}`)
    expect(service.allow).toHaveBeenNthCalledWith(1, '203.0.113.7', now)
    expect(service.allow).toHaveBeenNthCalledWith(2, 'unknown-client', now)
  })

  it('[api] records a view when the page reports it was shown', async () => {
    const { app, service } = harness()
    const response = await app.request(`/portal/invoices/${token}/viewed`, { method: 'POST' })
    expect(response.status).toBe(204)
    hardened(response)
    expect(service.shown).toHaveBeenCalledWith(token, now)
  })

  it('[api] only a POST reports a view', async () => {
    const { app, service } = harness()
    expect((await app.request(`/portal/invoices/${token}/viewed`)).status).toBe(404)
    expect(service.shown).not.toHaveBeenCalled()
  })

  it('[api] serves the document that was sent as an attachment with a safe filename', async () => {
    const { app, service } = harness()
    const response = await app.request(`/portal/invoices/${token}/document`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/pdf')
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="INVOICE _1___.pdf"')
    expect(response.headers.get('content-length')).toBe('4')
    hardened(response)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([37, 80, 68, 70]))
    expect(service.download).toHaveBeenCalledWith(token, now)
  })
})
