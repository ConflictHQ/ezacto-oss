/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { QuickBooksReconciliationView } from '../src/module-settings/model.js'
import { browserApi, mountShell, renderBrowserShell } from './support/shell-harness.js'

/**
 * Settings > Accounting > Compare with QuickBooks (issue 1013). In its own
 * file for the reason shell-company-settings-notifications.test.ts gives:
 * shell-company-settings.test.ts is close to the heap cap.
 */
describe('QuickBooks reconciliation', () => {
  const stubModulesEndpoint = (): void => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const data = String(input).includes('/admin/sign-in-methods')
          ? [{ method: 'password', configured: true, enabled: true }]
          : [{ module: 'expenses', enabled: true }]
        return new Response(JSON.stringify({ data }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )
  }

  const connected = {
    configured: true,
    connection: {
      realm_id: 'realm-a',
      company_name: 'Sandbox Company',
      scope: 'com.intuit.quickbooks.accounting',
      allow_online_payment: false,
      connected_at: '2026-10-01T12:00:00.000Z',
    },
  }

  const report: QuickBooksReconciliationView = {
    generated_at: '2026-10-18T12:00:00.000Z',
    counts: { matched: 4, amount_differs: 1 },
    payment_divergences: [],
    recovery: null,
    rows: [
      {
        status: 'matched',
        number: '1001',
        detail: '',
        ezacto_amount_cents: 100_000,
        quickbooks_amount_cents: 100_000,
      },
      {
        status: 'amount_differs',
        number: '1002',
        detail: 'total is 500.00 here and 450.00 in QuickBooks',
        ezacto_amount_cents: 50_000,
        quickbooks_amount_cents: 45_000,
      },
    ],
  }

  afterEach(async () => {
    globalThis.location.hash = ''
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0))
    vi.unstubAllGlobals()
  })

  const open = async (api: Record<string, unknown>) => {
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    globalThis.location.hash = '#integrations'
    await mountShell({ ...browserApi(), ...api } as never)
  }

  it('[browser #1013] lists only the differences and says how many matched', async () => {
    const getQuickBooksReconciliation = vi.fn(async () => report)
    await open({
      getQuickBooksConnection: vi.fn(async () => connected),
      getQuickBooksReconciliation,
    })
    const panel = document.querySelector<HTMLElement>('[data-quickbooks-reconcile-panel]')!
    await vi.waitFor(() => expect(panel.hidden).toBe(false))
    // A read happens on the press, not when the section opens.
    expect(getQuickBooksReconciliation).not.toHaveBeenCalled()

    document.querySelector<HTMLButtonElement>('[data-quickbooks-reconcile]')!.click()
    const result = document.querySelector<HTMLElement>('[data-quickbooks-reconcile-result]')!
    await vi.waitFor(() => expect(result.textContent).toBe('1 to look at, 4 matched.'))
    const table = document.querySelector<HTMLElement>('[data-quickbooks-reconcile-table]')!
    expect(table.hidden).toBe(false)
    expect(table.textContent).toContain('1002')
    expect(table.textContent).toContain('amount differs')
    expect(table.textContent).toContain('500.00')
    expect(table.textContent).toContain('450.00')
    expect(table.textContent).not.toContain('1001')
    // Nothing on a row corrects anything.
    expect(table.querySelector('tbody button')).toBeNull()
  })

  it('[browser #1013] lists a payment voided in QuickBooks and the state of catch-up', async () => {
    await open({
      getQuickBooksConnection: vi.fn(async () => connected),
      getQuickBooksReconciliation: vi.fn(async () => ({
        ...report,
        rows: [report.rows[0]!],
        counts: { matched: 4 },
        payment_divergences: [
          {
            quickbooks_payment_id: '501',
            kind: 'voided' as const,
            receipts: [{ invoice_number: '1003', amount_cents: 30_000 }],
          },
        ],
        recovery: { last_outcome: 'full_reconcile_needed' as const },
      })),
    })
    const panel = document.querySelector<HTMLElement>('[data-quickbooks-reconcile-panel]')!
    await vi.waitFor(() => expect(panel.hidden).toBe(false))
    document.querySelector<HTMLButtonElement>('[data-quickbooks-reconcile]')!.click()
    const result = document.querySelector<HTMLElement>('[data-quickbooks-reconcile-result]')!
    await vi.waitFor(() => expect(result.textContent).toContain('1 to look at, 4 matched.'))
    expect(result.textContent).toContain('could not prove a complete history')
    const table = document.querySelector<HTMLElement>('[data-quickbooks-reconcile-table]')!
    expect(table.textContent).toContain('1003')
    expect(table.textContent).toContain('payment voided in QuickBooks')
    expect(table.textContent).toContain('300.00')
    expect(table.querySelector('tbody button')).toBeNull()
  })

  it('[browser #1013] says so when everything agrees', async () => {
    await open({
      getQuickBooksConnection: vi.fn(async () => connected),
      getQuickBooksReconciliation: vi.fn(async () => ({
        ...report,
        counts: { matched: 2 },
        rows: [report.rows[0]!],
      })),
    })
    const panel = document.querySelector<HTMLElement>('[data-quickbooks-reconcile-panel]')!
    await vi.waitFor(() => expect(panel.hidden).toBe(false))
    document.querySelector<HTMLButtonElement>('[data-quickbooks-reconcile]')!.click()
    const result = document.querySelector<HTMLElement>('[data-quickbooks-reconcile-result]')!
    await vi.waitFor(() =>
      expect(result.textContent).toBe('Everything agrees (2 invoices matched).'),
    )
  })

  it('[browser #1013] offers nothing before QuickBooks is connected', async () => {
    await open({
      getQuickBooksConnection: vi.fn(async () => ({ configured: true, connection: null })),
      getQuickBooksReconciliation: vi.fn(async () => report),
    })
    const status = document.querySelector<HTMLElement>('[data-settings-quickbooks-status]')!
    await vi.waitFor(() => expect(status.textContent).toBe('Not connected.'))
    expect(
      document.querySelector<HTMLElement>('[data-quickbooks-reconcile-panel]')!.hidden,
    ).toBe(true)
  })

  it('[browser #1013] shows the failure rather than an empty table', async () => {
    await open({
      getQuickBooksConnection: vi.fn(async () => connected),
      getQuickBooksReconciliation: vi.fn(async () => {
        throw new Error('QuickBooks request failed with status 429')
      }),
    })
    const panel = document.querySelector<HTMLElement>('[data-quickbooks-reconcile-panel]')!
    await vi.waitFor(() => expect(panel.hidden).toBe(false))
    document.querySelector<HTMLButtonElement>('[data-quickbooks-reconcile]')!.click()
    const result = document.querySelector<HTMLElement>('[data-quickbooks-reconcile-result]')!
    await vi.waitFor(() => expect(result.textContent).toContain('429'))
    expect(document.querySelector<HTMLElement>('[data-quickbooks-reconcile-table]')!.hidden).toBe(
      true,
    )
  })
  it('[browser #852] sorts natural invoice numbers and cents, keeping absent amounts last without repair actions', async () => {
    const rows = [
      { ...report.rows[1]!, number: '10', ezacto_amount_cents: 900 },
      { ...report.rows[1]!, number: '9', ezacto_amount_cents: 10000 },
      { ...report.rows[1]!, number: '1315', ezacto_amount_cents: null },
    ]
    await open({ getQuickBooksConnection: async () => connected, getQuickBooksReconciliation: async () => ({ ...report, rows }) })
    const compare = document.querySelector<HTMLButtonElement>('[data-quickbooks-reconcile]')!
    await vi.waitFor(() => expect(compare.disabled).toBe(false))
    compare.click()
    const table = document.querySelector<HTMLElement>('[data-quickbooks-reconcile-table]')!
    await vi.waitFor(() => expect(table.hidden).toBe(false))
    const numbers = () => [...table.querySelectorAll('tbody [data-column="number"]')].map(cell => cell.textContent)
    const sort = (column: string) => table.querySelector<HTMLButtonElement>(`button[data-sort-column="${column}"]`)!.click()
    expect(numbers()).toEqual(['9', '10', '1315'])
    sort('number')
    expect(numbers()).toEqual(['1315', '10', '9'])
    sort('ezacto')
    expect(numbers()).toEqual(['10', '9', '1315'])
    sort('ezacto')
    expect(numbers()).toEqual(['9', '10', '1315'])
    expect(table.querySelector('tbody button')).toBeNull()
  })

})
