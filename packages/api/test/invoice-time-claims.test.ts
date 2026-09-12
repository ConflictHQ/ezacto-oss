import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { installInvoiceTimeClaimRoutes, type ReleaseTimeOutcome } from '../src/invoice-time-claims.js'
import { errorResponse } from '../src/errors.js'

/**
 * Issue 496. Releasing decides whether hours can be billed a second time, so
 * the route has to say which rule refused it rather than letting a constraint
 * abort reach the caller as a 500.
 */

const app = (
  outcome: ReleaseTimeOutcome,
  profile = 'administrator',
): { app: Hono<never>; release: ReturnType<typeof vi.fn> } => {
  const release = vi.fn(async () => outcome)
  const instance = new Hono<{ Bindings: object; Variables: Record<string, unknown> }>()
  instance.use('*', async (context, next) => {
    context.set('requestId', 'test-request')
    context.set('principal', {
      userId: 1,
      profile,
      authentication: { kind: 'session', sessionId: 'session-1' },
    })
    await next()
  })
  instance.onError((error, context) => errorResponse(error, context as never))
  installInvoiceTimeClaimRoutes(instance as never, { releaseInvoicedTime: release })
  return { app: instance as never, release }
}

const post = (instance: Hono<never>, path: string) =>
  instance.request(path, { method: 'POST' })

describe('releasing an invoice’s time through the API', () => {
  it('[money] reports how many entries were handed back', async () => {
    const { app: instance, release } = app({ kind: 'released', released: 352 })
    const response = await post(instance, '/invoices/1315/released-time')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { invoice_id: 1315, released: 352 } })
    expect(release).toHaveBeenCalledWith(1315)
  })

  it('[money] answers 409 while the invoice still stands, and says what to do', async () => {
    // The caller can act on this: close the invoice first, then release. A 500
    // from a trigger abort would tell them nothing.
    const { app: instance } = app({ kind: 'refused', reason: 'invoice_still_stands' })
    const response = await post(instance, '/invoices/1315/released-time')
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('invoice_still_stands')
    expect(body.error.message).toMatch(/Cancel or write it off first/u)
  })

  it('[api] answers 404 for an invoice that does not exist', async () => {
    const { app: instance } = app({ kind: 'refused', reason: 'invoice_not_found' })
    expect((await post(instance, '/invoices/1315/released-time')).status).toBe(404)
  })

  it('[api] names the field at fault for a bad id, and never asks the service', async () => {
    const { app: instance, release } = app({ kind: 'released', released: 0 })
    const response = await post(instance, '/invoices/0/released-time')
    expect(response.status).toBe(422)
    const body = (await response.json()) as { error: { fields: { field: string }[] } }
    expect(body.error.fields.map((field) => field.field)).toEqual(['id'])
    expect(release).not.toHaveBeenCalled()
  })

  it('[security] refuses a profile that does not raise invoices', async () => {
    // Releasing decides whether hours can be billed again, so it sits with the
    // profiles that already raise invoices rather than with everyone who can
    // edit their own time.
    for (const profile of ['member', 'project_manager']) {
      const { app: instance, release } = app({ kind: 'released', released: 1 }, profile)
      expect((await post(instance, '/invoices/1315/released-time')).status).toBe(403)
      expect(release).not.toHaveBeenCalled()
    }
  })

  it('[security] admits accounting and an executive manager', async () => {
    for (const profile of ['accounting', 'executive_manager']) {
      const { app: instance } = app({ kind: 'released', released: 1 }, profile)
      expect((await post(instance, '/invoices/1315/released-time')).status).toBe(200)
    }
  })
})
