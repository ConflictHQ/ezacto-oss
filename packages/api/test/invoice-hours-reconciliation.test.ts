import { InvoiceTimeReleaseError, reconcileInvoiceHours, type InvoiceLineTimeReleaseResult, type InvoiceHoursReconciliation } from '@ezacto/core'
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
    writable?: boolean
    profile?: string
    authentication?: Authentication
  } = {},
) => {
  const readHoursReconciliation = vi.fn(options.read ?? (async () => result()))
  const releaseLineTime=vi.fn(async (_command:unknown,_actor:number,_now:string):Promise<InvoiceLineTimeReleaseResult>=>{void _command;void _actor;void _now;return {commandId:'release',invoiceId:77,lineId:5,expectedVersion:1,hoursVersion:'a'.repeat(64),releasedEntryIds:[10],releasedSeconds:1800,recordedAt:'2026-09-12T12:00:00.000Z',replayed:false}})
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
  installInvoiceHoursReconciliationRoutes(instance as never, { readHoursReconciliation,...(options.writable?{releaseLineTime}:{}) },()=> '2026-09-12T12:00:00.000Z')
  return { request: (path: string, init?: RequestInit) => instance.request(path,init), readHoursReconciliation, releaseLineTime }
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
        hours_version: null, invoice_version: null, invoice_state: null, not_compared_entry_ids: [], lines: [],
        entries: [{ entry_id: null, user_id: null, user_name: null, spent_date: null, project_id: 1, project_name: 'Phase 1', seconds: 7200, eligible_for_release: false }],
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

const releaseBody={command_id:'release',line_id:5,expected_version:1,hours_version:'a'.repeat(64),entry_ids:[10],confirmed:true}
const releaseRequest=(body:unknown=releaseBody):RequestInit=>({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
it.each(['member','project_manager','people_admin'])('denies release to %s before the store is called',async profile=>{
 const api=app({profile,writable:true});expect((await api.request('/invoices/77/hours-reconciliation/release',releaseRequest())).status).toBe(403);expect(api.releaseLineTime).not.toHaveBeenCalled()
})
it('refuses token release even with all scopes and requires browser confirmation',async()=>{
 const denied=app({writable:true,authentication:{kind:'token',tokenId:1,scopes:['reports:read','invoices:write']}})
 expect((await denied.request('/invoices/77/hours-reconciliation/release',releaseRequest())).status).toBe(403)
 expect(denied.releaseLineTime).not.toHaveBeenCalled()
 const token=app({writable:true,authentication:{kind:'token',tokenId:1,scopes:['reports:read','time_entries:write','invoices:write']}})
 expect((await token.request('/invoices/77/hours-reconciliation/release',releaseRequest())).status).toBe(403)
 expect(token.releaseLineTime).not.toHaveBeenCalled()
 const api=app({writable:true})
 expect((await api.request('/invoices/77/hours-reconciliation/release',releaseRequest({...releaseBody,confirmed:false}))).status).toBe(422)
 expect((await api.request('/invoices/77/hours-reconciliation/release',releaseRequest({...releaseBody,actor_id:2}))).status).toBe(422)
 const response=await api.request('/invoices/77/hours-reconciliation/release',releaseRequest())
 expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store')
 expect(api.releaseLineTime).toHaveBeenCalledWith({commandId:'release',invoiceId:77,lineId:5,expectedVersion:1,hoursVersion:'a'.repeat(64),entryIds:[10]},1,'2026-09-12T12:00:00.000Z')
})
it('surfaces a stale draft/selection as an uncached conflict',async()=>{
 const api=app({writable:true});api.releaseLineTime.mockRejectedValueOnce(new InvoiceTimeReleaseError('conflict','Draft changed'))
 const response=await api.request('/invoices/77/hours-reconciliation/release',releaseRequest())
 expect(response.status).toBe(409);expect(response.headers.get('cache-control')).toBe('no-store')
})
