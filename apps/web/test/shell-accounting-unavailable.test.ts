/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { browserApi, mountShell, renderBrowserShell } from './support/shell-harness.js'

/**
 * A deployment with accounting off or unconfigured offers no Accounting
 * section and makes no request to the integration endpoints (#1217). In its
 * own file because shell-company-settings.test.ts is close to the heap cap.
 */
describe('accounting unavailable', () => {
  afterEach(async () => {
    document.documentElement.removeAttribute('data-accounting-unavailable')
    globalThis.location.hash = ''
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0))
    vi.unstubAllGlobals()
  })

  const open = async (unavailable: boolean, api: Record<string, unknown>) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [{ module: 'expenses', enabled: true }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    )
    renderBrowserShell({ view: 'settings-company' })
    if (unavailable) document.documentElement.setAttribute('data-accounting-unavailable', '')
    globalThis.location.hash = '#integrations'
    await mountShell({ ...browserApi(), ...api } as never)
  }

  const link = (): HTMLElement =>
    document.querySelector<HTMLElement>('[data-settings-section-link="integrations"]')!
  const section = (): HTMLElement =>
    document.querySelector<HTMLElement>('[data-settings-section="integrations"]')!

  it('[browser #1217] hides the Accounting section and never reads QuickBooks', async () => {
    const api = {
      getQuickBooksConnection: vi.fn(async () => ({ configured: true, connection: null })),
      getQuickBooksReconciliation: vi.fn(),
    }
    await open(true, api)
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0))

    expect(link().hidden).toBe(true)
    expect(section().hidden).toBe(true)
    expect(api.getQuickBooksConnection).not.toHaveBeenCalled()
    expect(api.getQuickBooksReconciliation).not.toHaveBeenCalled()
  })

  it('[browser #1217] leaves the connect flow unchanged when accounting is available', async () => {
    const api = {
      getQuickBooksConnection: vi.fn(async () => ({ configured: true, connection: null })),
    }
    await open(false, api)

    await vi.waitFor(() => expect(api.getQuickBooksConnection).toHaveBeenCalledTimes(1))
    expect(link().hidden).toBe(false)
    expect(section().hidden).toBe(false)
  })
})
