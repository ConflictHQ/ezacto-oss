import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { errorResponse } from '../src/errors.js'
import {
  createNotificationSettingsService,
  installNotificationSettingsRoutes,
} from '../src/notification-settings.js'

/**
 * Issue 934. The one switch behind "and admins if configured": who the
 * instance emails is an administrator's decision and nobody else's.
 */

const app = (profile = 'administrator') => {
  const store = {
    read: vi.fn(async () => ({ budgetAlertsIncludeAdmins: false })),
    update: vi.fn(async (patch: { budgetAlertsIncludeAdmins?: boolean }) => ({
      budgetAlertsIncludeAdmins: patch.budgetAlertsIncludeAdmins ?? false,
    })),
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
  installNotificationSettingsRoutes(
    instance as never,
    createNotificationSettingsService(store),
  )
  return { app: instance as never as Hono<never>, store }
}

const post = (instance: Hono<never>, body: unknown) =>
  instance.request('/settings/notifications', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })

describe('notification settings (issue 934)', () => {
  it('[api] reads the setting, off until an administrator turns it on', async () => {
    const { app: instance } = app()
    const response = await instance.request('/settings/notifications')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ data: { budget_alerts_include_admins: false } })
  })

  it('[api] sets it', async () => {
    const { app: instance, store } = app()
    const response = await post(instance, { budget_alerts_include_admins: true })
    expect(response.status).toBe(200)
    expect(store.update).toHaveBeenCalledWith({ budgetAlertsIncludeAdmins: true })
    expect(await response.json()).toEqual({ data: { budget_alerts_include_admins: true } })
  })

  it('[security] is for administrators only, to read and to change', async () => {
    for (const profile of ['member', 'project_manager', 'accounting', 'executive_manager']) {
      const { app: instance, store } = app(profile)
      expect((await instance.request('/settings/notifications')).status).toBe(403)
      expect((await post(instance, { budget_alerts_include_admins: true })).status).toBe(403)
      expect(store.update).not.toHaveBeenCalled()
    }
  })

  it('[api] refuses a value that is not a boolean, an unknown setting, and an empty change', async () => {
    const { app: instance, store } = app()
    expect((await post(instance, { budget_alerts_include_admins: 'yes' })).status).toBe(422)
    expect((await post(instance, { budget_alerts_include_admin: true })).status).toBe(422)
    expect((await post(instance, {})).status).toBe(422)
    expect(store.update).not.toHaveBeenCalled()
  })
})
