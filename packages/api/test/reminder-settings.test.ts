import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { installReminderSettingsRoutes } from '../src/reminder-settings.js'
import { errorResponse } from '../src/errors.js'

/**
 * Issue 801. The organisation default is what makes reminders a thing an
 * operator switches on once; the validation is what keeps "every 0 days" out
 * of a client's inbox.
 */

const app = (
  overrides: Record<string, ReturnType<typeof vi.fn>> = {},
  profile = 'administrator',
) => {
  const service = {
    readOrganizationReminderPolicy:
      overrides.readOrganizationReminderPolicy ??
      vi.fn(async () => ({ first_after_days: 3, every_days: 7 })),
    setOrganizationReminderPolicy:
      overrides.setOrganizationReminderPolicy ?? vi.fn(async () => 2),
    readInvoiceReminders:
      overrides.readInvoiceReminders ??
      vi.fn(async (invoiceId: number) =>
        invoiceId === 41
          ? {
              invoice: null,
              organizationPolicy: { first_after_days: 3, every_days: 7 },
              effective: true,
              nextReminderAt: '2026-09-18T00:00:00.000Z',
            }
          : null,
      ),
    setInvoiceReminders:
      overrides.setInvoiceReminders ?? vi.fn(async (invoiceId: number) => invoiceId === 41),
  }
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
  installReminderSettingsRoutes(instance as never, service as never)
  return { app: instance as never as Hono<never>, service }
}

const post = (instance: Hono<never>, body: unknown) =>
  instance.request('/settings/invoice-reminders', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })

describe('the organisation reminder policy', () => {
  it('[unit] reads and sets it', async () => {
    const { app: instance, service } = app()
    expect(await (await instance.request('/settings/invoice-reminders')).json()).toEqual({
      data: { reminder_policy: { first_after_days: 3, every_days: 7 } },
    })
    const response = await post(instance, {
      reminder_policy: { first_after_days: 14, every_days: 14 },
    })
    expect(response.status).toBe(200)
    expect(service.setOrganizationReminderPolicy).toHaveBeenCalledWith({
      first_after_days: 14,
      every_days: 14,
    })
  })

  it('[unit] null switches the default off', async () => {
    const { app: instance, service } = app()
    expect((await post(instance, { reminder_policy: null })).status).toBe(200)
    expect(service.setOrganizationReminderPolicy).toHaveBeenCalledWith(null)
  })

  it('[api] refuses a cadence that would mail a client every day forever, or never', async () => {
    const { app: instance, service } = app()
    for (const policy of [
      { first_after_days: -1, every_days: 7 },
      { first_after_days: 3, every_days: 0 },
      { first_after_days: 3.5, every_days: 7 },
      { first_after_days: 3 },
      'weekly',
    ]) {
      const response = await post(instance, { reminder_policy: policy })
      expect(response.status, JSON.stringify(policy)).toBe(422)
    }
    expect((await post(instance, {})).status).toBe(422)
    expect(service.setOrganizationReminderPolicy).not.toHaveBeenCalled()
  })
})

describe('who may change it', () => {
  it('[security] refuses a profile that does not raise invoices', async () => {
    for (const profile of ['member', 'project_manager']) {
      const { app: instance, service } = app({}, profile)
      expect((await post(instance, { reminder_policy: null })).status).toBe(403)
      expect((await instance.request('/settings/invoice-reminders')).status).toBe(403)
      expect(service.setOrganizationReminderPolicy).not.toHaveBeenCalled()
    }
  })

  it('[security] admits accounting and an executive manager', async () => {
    for (const profile of ['accounting', 'executive_manager']) {
      const { app: instance } = app({}, profile)
      expect((await post(instance, { reminder_policy: null })).status).toBe(200)
    }
  })
})

describe('one invoice (issue 850)', () => {
  it('[unit] reads the answer with the next booked reminder', async () => {
    const { app: instance } = app()
    expect(await (await instance.request('/invoices/41/reminder-preference')).json()).toEqual({
      data: {
        invoice_id: 41,
        reminders: null,
        organization_reminder_policy: { first_after_days: 3, every_days: 7 },
        effective: true,
        next_reminder_at: '2026-09-18T00:00:00.000Z',
      },
    })
    expect((await instance.request('/invoices/42/reminder-preference')).status).toBe(404)
  })

  it('[unit] switches them off, and hands them back with null', async () => {
    const { app: instance, service } = app()
    for (const reminders of [false, null, true]) {
      const response = await instance.request('/invoices/41/reminder-preference', {
        method: 'POST',
        body: JSON.stringify({ reminders }),
        headers: { 'content-type': 'application/json' },
      })
      expect(response.status).toBe(200)
      expect(service.setInvoiceReminders).toHaveBeenCalledWith(41, reminders)
    }
  })

  it('[api] refuses a value that is not an answer', async () => {
    const { app: instance } = app()
    for (const body of [{}, { reminders: 'no' }, { reminders: 0 }]) {
      const response = await instance.request('/invoices/41/reminder-preference', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      })
      expect(response.status).toBe(422)
    }
  })

  it('[unit] setting the organisation policy says how many open invoices it reached', async () => {
    const { app: instance } = app()
    const response = await post(instance, { reminder_policy: { first_after_days: 3, every_days: 7 } })
    expect(await response.json()).toMatchObject({ data: { applied_to_open_invoices: 2 } })
  })
})
