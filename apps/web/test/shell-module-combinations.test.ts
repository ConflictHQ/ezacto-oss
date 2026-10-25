/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { browserApi, identity, mountShell, renderBrowserShell, resource, unmount } from './support/shell-harness.js'
import { loadShellSnapshot } from '../src/shell/model.js'
import { EzactoApiError } from '@conflict-hq/ezacto-client'
import { createClientDirectoryController } from '../src/clients/browser.js'

const modules = ['sso', 'backups', 'invoices', 'accounting'] as const
const cases = [...modules.map((module) => [module]), [...modules]].map((off) => ({ label: off.join('+'), off }))
const page = { data: [], page: { next_cursor: null } }
const hidden = (selector: string): boolean => {
  const element = document.querySelector<HTMLElement>(selector)
  return element === null || element.closest('[hidden]') !== null
}

// Read the real rendered flags; spies below are the network boundary, not replacement gates.
describe('dependent surfaces with operator modules off (#1259)', () => {
  afterEach(() => {
    for (const module of modules) document.documentElement.removeAttribute(`data-${module}-unavailable`)
    vi.unstubAllGlobals()
  })

  const prepare = (off: readonly string[]) => {
    renderBrowserShell({ view: 'settings-company' })
    for (const module of off) document.documentElement.setAttribute(`data-${module}-unavailable`, '')
    const fetched: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input)
      fetched.push(url)
      const data = url.includes('sign-in-methods')
        ? ['password', 'magic_link', 'google', 'github', 'apple'].map((method) => ({ method, configured: true, enabled: true }))
        : []
      return new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json' } })
    }))
    return fetched
  }

  it.each(cases)('[browser] settings reject dependent reads with $label off', async ({ off }) => {
    const fetched = prepare(off)
    const getQuickBooksConnection = vi.fn(async () => ({ configured: true, connection: null }))
    const getInvoiceDefaults = vi.fn(async () => ({}))
    const getInvoiceReminders = vi.fn(async () => ({}))
    const listSsoDomains = vi.fn(async () => ({ data: [] }))
    const api = { ...browserApi(), getQuickBooksConnection, getInvoiceDefaults, getInvoiceReminders, listSsoDomains }
    await mountShell(api as never)
    for (const [section, module] of Object.entries({ sso: 'sso', backup: 'backups', integrations: 'accounting', invoices: 'invoices', reminders: 'invoices', 'sign-in': '' })) {
      globalThis.location.hash = `#${section}`
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (off.includes(module as never)) {
        expect(hidden(`[data-settings-section="${section}"]`)).toBe(true)
        expect(hidden(`[data-settings-section-link="${section}"]`)).toBe(true)
      }
    }
    if (off.includes('sso')) {
      expect(document.querySelector('[data-sign-in-card="google"]')).toBeNull()
      expect(document.querySelector('[data-sign-in-card="password"]')).not.toBeNull()
      expect(listSsoDomains).not.toHaveBeenCalled()
    }
    if (off.includes('invoices')) {
      expect(getInvoiceDefaults).not.toHaveBeenCalled()
      expect(getInvoiceReminders).not.toHaveBeenCalled()
      expect(hidden('[data-money-nav]')).toBe(true)
    }
    if (off.includes('accounting')) expect(getQuickBooksConnection).not.toHaveBeenCalled()
    if (off.includes('backups')) expect(fetched.filter((url) => /\/api\/v1\/backup(?:\/|$)/u.test(url))).toEqual([])
    await unmount()
  })

  it.each(cases)('[browser] client dependencies make no withdrawn requests with $label off', async ({ off }) => {
    prepare(off)
    // Mount the real client controller using the shell markup and a client route.
    document.documentElement.dataset.appView = 'client-detail'
    // This controller test supplies its authenticated principal directly.
    for (let parent: HTMLElement | null = document.querySelector('[data-client-detail-page]'); parent !== null; parent = parent.parentElement) parent.hidden = false
    history.replaceState(null, '', '/clients/11')
    const client = { ...resource(11, 'Example client'), currency: 'USD', is_active: true }
    const updateDirectoryClient = vi.fn(async (_id: number, patch: Record<string, unknown>) => ({ ...client, ...patch }))
    const getBillStatus = vi.fn(async () => ({ configured: true, can_send_from_bill: true }))
    const getBillClientDelivery = vi.fn(async () => ({ deliver_via_bill: true }))
    const getClientInvoiceSending = vi.fn()
    const listClientOpenInvoices = vi.fn(async () => page)
    const getClientRollupReport = vi.fn(async () => ({ nodes: [] }))
    const controller = createClientDirectoryController({
      listDirectoryClients: vi.fn(async () => ({ ...page, data: [client] })),
      getDirectoryClient: vi.fn(async () => client), updateDirectoryClient,
      createDirectoryClient: vi.fn(),
      listClientContacts: vi.fn(async () => page), listClientProjects: vi.fn(async () => page),
      listClientSubtree: vi.fn(async () => [{ ancestor_id: 11, descendant_id: 11, depth: 0 }]),
      listClientRetainers: vi.fn(async () => page), getClientRollupReport,
      getBillStatus, getBillClientDelivery, getClientInvoiceSending,
      setClientInvoiceSending: vi.fn(), listClientOpenInvoices,
    } as never)
    const abort = new AbortController()
    await controller.activate(identity, abort.signal, () => false)
    await vi.waitFor(() => expect(document.querySelector('[data-client-360-status]')!.textContent).toBe('Rollup loaded.'))
    if (off.includes('invoices')) {
      expect(getClientInvoiceSending).not.toHaveBeenCalled()
      expect(listClientOpenInvoices).not.toHaveBeenCalled()
      expect(hidden('[data-client-sending]')).toBe(true)
      expect(hidden('[data-client-360-invoices]')).toBe(true)
      expect(hidden('#ez-contact-recipient')).toBe(true)
    } else expect(listClientOpenInvoices).toHaveBeenCalled()
    if (off.includes('invoices') || off.includes('accounting')) {
      expect(getBillStatus).not.toHaveBeenCalled()
      expect(getBillClientDelivery).not.toHaveBeenCalled()
      expect(hidden('[data-client-delivery]')).toBe(true)
    } else expect(getBillStatus).toHaveBeenCalled()
    expect(hidden('[data-client-360-burn]')).toBe(false)
    if (off.includes('invoices')) {
      document.querySelector<HTMLButtonElement>('[data-client-edit]')!.click()
      expect(document.querySelector<HTMLSelectElement>('#ez-client-bill-to')!.disabled).toBe(true)
      const form = document.querySelector<HTMLFormElement>('[data-client-form]')!
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await vi.waitFor(() => expect(updateDirectoryClient).toHaveBeenCalled())
      expect(updateDirectoryClient.mock.calls[0]![1]).not.toHaveProperty('bill_to_client_id')
    }
    abort.abort()
  })
  it('[browser] removes a disabled expense source even when report discovery is unavailable', async () => {
    renderBrowserShell({ view: 'invoice-generation' })
    const api = browserApi()
    api.listExpenses = vi.fn(async () => {
      throw new EzactoApiError(403, { error: { code: 'module_disabled' } }, null)
    })
    await mountShell({ ...api, getUninvoicedReport: vi.fn(async () => { throw new Error('offline') }) } as never)
    const source = document.querySelector<HTMLSelectElement>('[data-invoice-expense-summary]')!
    expect(source.disabled).toBe(true)
    expect(source.closest('label')!.hidden).toBe(true)
    expect(source.value).toBe('')
    expect(api.listExpenses).toHaveBeenCalledTimes(1)
  })

  it('[browser] does not re-request withdrawn expenses on week navigation, and rechecks on a new activation', async () => {
    const api = browserApi()
    api.listExpenses = vi.fn(async () => {
      throw new EzactoApiError(403, { error: { code: 'module_disabled' } }, null)
    })
    const activation = new AbortController()
    expect((await loadShellSnapshot(api, new Date('2026-08-28T12:00:00Z'), activation.signal)).expensesAvailable).toBe(false)
    expect((await loadShellSnapshot(api, new Date('2026-09-04T12:00:00Z'), activation.signal)).expensesAvailable).toBe(false)
    expect(api.listExpenses).toHaveBeenCalledTimes(1)
    activation.abort()
    expect((await loadShellSnapshot(api, new Date('2026-09-04T12:00:00Z'), new AbortController().signal)).expensesAvailable).toBe(false)
    expect(api.listExpenses).toHaveBeenCalledTimes(2)
  })

})
