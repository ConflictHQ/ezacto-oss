import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { installRecurringRepairRoutes } from '../src/recurring-repair.js'
import { errorResponse } from '../src/errors.js'

/** Issue 648. The routes that make a stub visible and repairable. */

const stub = {
  id: 1,
  harvest_id: 466138,
  client_id: 1,
  client_name: 'Kestrel Environmental',
  invoice_count: 41,
  created_at: '2026-09-12T12:00:00.000Z',
  updated_at: '2026-09-12T12:00:00.000Z',
}

const app = (
  overrides: Record<string, ReturnType<typeof vi.fn>> = {},
  profile = 'administrator',
) => {
  const service = {
    listIncomplete: overrides.listIncomplete ?? vi.fn(async () => [stub]),
    complete: overrides.complete ?? vi.fn(async () => ({ outcome: 'completed' as const })),
  }
  const instance = new Hono<{ Bindings: object; Variables: Record<string, unknown> }>()
  instance.use('*', async (context, next) => {
    context.set('requestId', 'test-request')
    context.set('principal', {
      userId: 7,
      profile,
      authentication: { kind: 'session', sessionId: 'session-1' },
    })
    await next()
  })
  instance.onError((error, context) => errorResponse(error, context as never))
  installRecurringRepairRoutes(instance as never, service as never, () => '2026-09-12T13:00:00.000Z')
  return { app: instance as never as Hono<never>, service }
}

const terms = (overrides: Record<string, unknown> = {}) => ({
  client_id: 1,
  subject_template: 'Monthly retainer',
  notes_template: 'Thank you.',
  every_n_months: 1,
  day_of_month: 15,
  next_issue_on: '2026-10-15',
  amount_config: { schema_version: 1, type: 'fixed_lines', line_items: [] },
  can_draw_from_retainer_id: null,
  ...overrides,
})

const post = (instance: Hono<never>, path: string, body: unknown) =>
  instance.request(path, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })

describe('seeing the stubs', () => {
  it('[money] lists them with what rides on each', async () => {
    const { app: instance } = app()
    const response = await instance.request('/recurring-invoices/incomplete')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: [stub] })
  })
})

describe('completing one', () => {
  it('[money] passes the terms through and names who entered them', async () => {
    // The completion record has to name an author; the route is where the
    // signed-in person becomes that author.
    const { app: instance, service } = app()
    const response = await post(instance, '/recurring-invoices/1/completion', terms())
    expect(response.status).toBe(200)
    expect(service.complete).toHaveBeenCalledWith(1, {
      clientId: 1,
      subjectTemplate: 'Monthly retainer',
      notesTemplate: 'Thank you.',
      everyNMonths: 1,
      dayOfMonth: 15,
      nextIssueOn: '2026-10-15',
      amountConfig: { schema_version: 1, type: 'fixed_lines', line_items: [] },
      canDrawFromRetainerId: null,
      actorUserId: 7,
      occurredAt: '2026-09-12T13:00:00.000Z',
    })
  })

  it('[api] answers 409 when the definition already has its terms', async () => {
    const { app: instance } = app({
      complete: vi.fn(async () => ({ outcome: 'already_complete' as const })),
    })
    const response = await post(instance, '/recurring-invoices/1/completion', terms())
    expect(response.status).toBe(409)
    expect((await response.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'definition_already_complete' },
    })
  })

  it('[api] answers 404 for a definition that does not exist', async () => {
    const { app: instance } = app({
      complete: vi.fn(async () => ({ outcome: 'not_found' as const })),
    })
    expect((await post(instance, '/recurring-invoices/9/completion', terms())).status).toBe(404)
  })
})

describe('what it refuses', () => {
  it('[api] reports every missing field at once, and never writes', async () => {
    // Somebody transcribing from an old system should fix one form, not
    // discover the fields one refusal at a time.
    const { app: instance, service } = app()
    const response = await post(instance, '/recurring-invoices/1/completion', {})
    expect(response.status).toBe(422)
    const body = (await response.json()) as { error: { fields: { field: string }[] } }
    expect(body.error.fields.map((field) => field.field).sort()).toEqual([
      'amount_config',
      'client_id',
      'day_of_month',
      'every_n_months',
      'next_issue_on',
      'notes_template',
      'subject_template',
    ])
    expect(service.complete).not.toHaveBeenCalled()
  })

  it('[api] names the one field at fault when the rest are fine', async () => {
    for (const [field, bad] of [
      ['subject_template', { subject_template: '   ' }],
      ['day_of_month', { day_of_month: 32 }],
      ['every_n_months', { every_n_months: 0 }],
      ['next_issue_on', { next_issue_on: '15/10/2026' }],
      ['can_draw_from_retainer_id', { can_draw_from_retainer_id: 0 }],
    ] as const) {
      const { app: instance } = app()
      const response = await post(instance, '/recurring-invoices/1/completion', terms(bad))
      expect(response.status).toBe(422)
      const body = (await response.json()) as { error: { fields: { field: string }[] } }
      expect(body.error.fields.map((entry) => entry.field)).toEqual([field])
    }
  })

  it('[security] refuses a profile that does not raise invoices', async () => {
    // Completing a stub decides what a client is charged every month from now
    // on.
    for (const profile of ['member', 'project_manager']) {
      const { app: instance, service } = app({}, profile)
      expect((await instance.request('/recurring-invoices/incomplete')).status).toBe(403)
      expect((await post(instance, '/recurring-invoices/1/completion', terms())).status).toBe(403)
      expect(service.complete).not.toHaveBeenCalled()
    }
  })

  it('[security] admits accounting and an executive manager', async () => {
    for (const profile of ['accounting', 'executive_manager']) {
      const { app: instance } = app({}, profile)
      expect((await instance.request('/recurring-invoices/incomplete')).status).toBe(200)
    }
  })
})
