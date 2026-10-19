/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { browserApi, mountShell, renderBrowserShell } from './support/shell-harness.js'

/**
 * Settings > Company > Invoices: the view receipts setting (issue 936). Its own
 * file, not shell-company-settings.test.ts, for the heap reason given in
 * shell-company-settings-notifications.test.ts.
 */
describe('company settings: invoice view receipts', () => {
  const stubModulesEndpoint = (): void => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const path = String(input)
        const data = path.includes('/admin/sign-in-methods')
          ? [{ method: 'password', configured: true, enabled: true }]
          : [{ module: 'expenses', enabled: true }]
        return new Response(JSON.stringify({ data }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )
  }

  const stored = (viewReceipts: boolean) => ({
    company_name: 'Northwind Studio',
    company_address: '1 Example Way',
    notes: null,
    subject: null,
    view_receipts: viewReceipts,
  })

  const companyApi = (viewReceipts: boolean) => ({
    ...browserApi(),
    getInvoiceDefaults: vi.fn(async () => stored(viewReceipts)),
    updateInvoiceDefaults: vi.fn(async (patch: Record<string, unknown>) => ({
      ...stored(viewReceipts),
      ...patch,
    })),
  })

  afterEach(async () => {
    globalThis.location.hash = ''
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0))
    vi.unstubAllGlobals()
  })

  const open = async (api: ReturnType<typeof companyApi>, demo = false) => {
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company', demo })
    globalThis.location.hash = '#invoices'
    await mountShell(api)
    const form = document.querySelector<HTMLFormElement>('[data-invoice-defaults-form]')!
    await vi.waitFor(() => expect(form.hidden).toBe(false))
    return {
      form,
      box: document.querySelector<HTMLInputElement>('[data-invoice-defaults-view-receipts]')!,
      result: document.querySelector<HTMLElement>('[data-invoice-defaults-result]')!,
    }
  }

  it('[browser #936] is off until it is turned on, and says what it does', async () => {
    const { box } = await open(companyApi(false))
    expect(box.checked).toBe(false)
    const hint = document.querySelector('#settings-invoice-view-receipts-hint')!.textContent!
    expect(hint).toContain('no tracking image')
    expect(hint).toContain('not by whom')
    expect(box.getAttribute('aria-describedby')).toBe('settings-invoice-view-receipts-hint')
  })

  it('[browser #936] saves the choice with the rest of the invoice settings', async () => {
    const api = companyApi(false)
    const { form, box, result } = await open(api)
    box.checked = true
    form.requestSubmit()
    await vi.waitFor(() => expect(result.textContent).toBe('Saved.'))
    expect(api.updateInvoiceDefaults).toHaveBeenLastCalledWith(
      expect.objectContaining({ view_receipts: true }),
      expect.any(AbortSignal),
    )
  })

  it('[browser #936] shows a running setting and turns it off', async () => {
    const api = companyApi(true)
    const { form, box, result } = await open(api)
    expect(box.checked).toBe(true)
    box.checked = false
    form.requestSubmit()
    await vi.waitFor(() => expect(result.textContent).toBe('Saved.'))
    expect(api.updateInvoiceDefaults).toHaveBeenLastCalledWith(
      expect.objectContaining({ view_receipts: false }),
      expect.any(AbortSignal),
    )
  })

  it('[security #936] is read-only on the public demo, which cannot link a real client to a page', async () => {
    const { box } = await open(companyApi(false), true)
    expect(box.disabled).toBe(true)
  })
})
