import { describe, expect, it } from 'vitest'
import { renderPortalEstimatesPage } from '../src/portal-estimates/render.js'
import { renderPortalInvoicePage, type PortalInvoicePage } from '../src/portal-invoice/render.js'
import type { PortalBrandChrome } from '../src/portal-brand.js'

/**
 * Issue 1011: the standalone portal pages wear the instance brand the way the
 * shell does, and are the page they always were when none is set.
 */

const token = 'T'.repeat(43)
const invoice: PortalInvoicePage = {
  companyName: 'Northwind Studio',
  clientName: 'Kestrel',
  number: 'INV-1315',
  subject: null,
  currency: 'USD',
  issueDate: '2026-09-01',
  dueDate: '2026-09-30',
  amountCents: 1000,
  dueAmountCents: 1000,
  state: 'open',
  paymentUrl: null,
  hasDocument: false,
}
const chrome: PortalBrandChrome = {
  wordmarkLight: '/brand/wordmark_light/abc123',
  favicon: '/brand/favicon/def456',
  instanceTheme: true,
}

const pages: Record<string, (c?: PortalBrandChrome) => string> = {
  estimates: (c) =>
    renderPortalEstimatesPage({ brand: 'Northwind Studio', ...(c === undefined ? {} : { chrome: c }) }),
  invoice: (c) => renderPortalInvoicePage(invoice, token, c),
}

describe.each(Object.entries(pages))('the %s portal page', (_name, render) => {
  it('[unit] links the instance stylesheet after the built-in one and the palette marker', () => {
    const html = render(chrome)
    const builtIn = html.indexOf('href="/assets/ezacto.css"')
    const instance = html.indexOf('href="/assets/instance-theme.css"')
    expect(builtIn).toBeGreaterThan(-1)
    expect(instance).toBeGreaterThan(builtIn)
    expect(html).toContain('data-ez-palette="instance"')
    expect(html).toContain('<link rel="icon" href="/brand/favicon/def456">')
  })

  it('[unit] draws the light wordmark with the name as alt text', () => {
    expect(render(chrome)).toContain(
      '<img class="brand-mark" src="/brand/wordmark_light/abc123" alt="Northwind Studio">',
    )
  })

  it('[unit] adds nothing when no brand is set', () => {
    const html = render(undefined)
    expect(html).not.toContain('instance-theme')
    expect(html).not.toContain('data-ez-palette')
    expect(html).not.toContain('brand-mark')
    expect(html).not.toContain('rel="icon"')
    expect(render({})).toBe(html)
  })

  it('[unit] refuses a mark or icon that is not same-origin', () => {
    for (const source of ['https://evil.test/m.png', '//evil.test/m.png', 'javascript:1']) {
      const html = render({ wordmarkLight: source, favicon: source, instanceTheme: false })
      expect(html).not.toContain('evil.test')
      expect(html).not.toContain('javascript:')
      expect(html).not.toContain('brand-mark')
      expect(html).not.toContain('rel="icon"')
    }
  })

  it('[unit] escapes the mark source', () => {
    const html = render({ wordmarkLight: '/brand/x"><script>1</script>' })
    expect(html).not.toContain('<script>1</script>')
  })
})
