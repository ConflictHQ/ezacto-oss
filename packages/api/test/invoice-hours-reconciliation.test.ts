import { reconcileInvoiceHours, type InvoiceHoursReconciliation } from '@ezacto/core'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { errorResponse } from '../src/errors.js'
import { installInvoiceHoursReconciliationRoutes } from '../src/invoice-hours-reconciliation.js'

/**
 * Issue 924. The comparison is core's and the figures are the store's; what is
 * pinned here is the route: who may read it, what it answers, its wire shape.
 */

const result = (): InvoiceHoursReconciliation =>
  reconcileInvoiceHours({
    entries: [{ projectId: 1, projectName: 'Phase 1', seconds: 7200 }],
    lines: [
      { id: 5, position: 0, description: 'Advisory', projectId: 1, projectName: 'Phase 1', quantity: 1 },
      { id: 6, position: 1, description: 'Fee', projectId: null, projectName: null, quantity: 1 },
    ],
  })

type Authentication =
  | { kind: 'session'; sessionId: string }
  | { kind: 'token'; tokenId: number; scopes: string[] }

const app = (
  options: {
    read?: (invoiceId: number) => Promise<InvoiceHoursReconciliation | null>
    profile?: string
    authentication?: Authentication
  } = {},
) => {
  const readHoursReconciliation = vi.fn(options.read ?? (async () => result()))
  const instance = new Hono<{ Bindings: object; Variables: Record<string, unknown> }>()
  instance.use('*', async (context, next) => {
    context.set('requestId', 'test-request')
    context.set('principal', {
      userId: 1,
      profile: options.profile ?? 'administrator',
      authentication: options.authentication ?? { kind: 'session', sessionId: 'session-1' },
    })
    await next()
  })
  instance.onError((error, context) => errorResponse(error, context as never))
  installInvoiceHoursReconciliationRoutes(instance as never, { readHoursReconciliation })
  return { request: (path: string) => instance.request(path), readHoursReconciliation }
}

describe('reading the hours reconciliation', () => {
  it('[api] answers the comparison in the wire shape', async () => {
    const { request, readHoursReconciliation } = app()
    const response = await request('/invoices/77/hours-reconciliation')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(readHoursReconciliation).toHaveBeenCalledWith(77)
    expect(await response.json()).toEqual({
      data: {
        invoice_id: 77,
        linked_seconds: 7200,
        billed_seconds: 3600,
        difference_seconds: -3600,
        status: 'billed_below_linked',
        tolerance_seconds: 36,
        total_tolerance_seconds: 36, comparison_complete: true, has_mismatch: true,
        invoice_version: null, invoice_state: null, not_compared_entry_ids: [], lines: [],
        entries: [{ entry_id: null, user_id: null, user_name: null, spent_date: null, project_id: 1, project_name: 'Phase 1', seconds: 7200 }],
        projects: [
          {
            project_id: 1,
            project_name: 'Phase 1',
            tolerance_seconds: 36,
            linked_seconds: 7200,
            billed_seconds: 3600,
            difference_seconds: -3600,
            status: 'billed_below_linked',
          },
        ],
        not_compared: [{ line_id: 6, position: 1, description: 'Fee', quantity: 1 }],
      },
    })
  })

  it('[api] answers an empty, non-error result for an invoice with no linked time', async () => {
    const { request } = app({ read: async () => reconcileInvoiceHours({ entries: [], lines: [] }) })
    const response = await request('/invoices/1/hours-reconciliation')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      data: { status: 'matched', projects: [], not_compared: [] },
    })
  })

  it('[api] answers 404 for an invoice that does not exist', async () => {
    const { request } = app({ read: async () => null })
    expect((await request('/invoices/404/hours-reconciliation')).status).toBe(404)
  })

  it('[api] answers 422 for a bad id, and reads nothing', async () => {
    for (const id of ['0', '-1', 'abc', '1.5']) {
      const { request, readHoursReconciliation } = app()
      expect((await request(`/invoices/${id}/hours-reconciliation`)).status).toBe(422)
      expect(readHoursReconciliation).not.toHaveBeenCalled()
    }
  })
})

describe('who may read it', () => {
  it('[security] admits the profiles that read invoices, by session', async () => {
    for (const profile of ['administrator', 'accounting', 'executive_manager']) {
      const { request } = app({ profile })
      expect((await request('/invoices/1/hours-reconciliation')).status).toBe(200)
    }
  })

  it('[security] refuses a profile that cannot read invoices, before reading anything', async () => {
    for (const profile of ['member', 'project_manager', 'people_admin']) {
      const { request, readHoursReconciliation } = app({ profile })
      expect((await request('/invoices/1/hours-reconciliation')).status).toBe(403)
      expect(readHoursReconciliation).not.toHaveBeenCalled()
    }
  })

  it('[security] takes a token only when it grants invoices:read', async () => {
    const granted = app({ authentication: { kind: 'token', tokenId: 1, scopes: ['invoices:read'] } })
    expect((await granted.request('/invoices/1/hours-reconciliation')).status).toBe(200)
    const refused = app({
      authentication: { kind: 'token', tokenId: 2, scopes: ['reports:read', 'time_entries:read'] },
    })
    const response = await refused.request('/invoices/1/hours-reconciliation')
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'insufficient_scope' } })
    expect(refused.readHoursReconciliation).not.toHaveBeenCalled()
  })
})
