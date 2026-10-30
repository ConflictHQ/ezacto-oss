import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { errorResponse } from '../src/errors.js'
import {
  createNotificationSettingsService,
  installNotificationSettingsRoutes,
  type StoredNotificationSettings,
} from '../src/notification-settings.js'

/**
 * Issues 934 and 935. Who the instance emails, and when it reminds everyone to
 * submit their week, are an administrator's decisions and nobody else's.
 */

type Patch = Parameters<Parameters<typeof createNotificationSettingsService>[0]['update']>[0]

const app = (profile = 'administrator') => {
  let stored: StoredNotificationSettings = {
    budgetAlertsIncludeAdmins: false,
    submissionReminder: null,
  }
  const store = {
    read: vi.fn(async () => stored),
    update: vi.fn(async (patch: Patch) => {
      stored = { ...stored, ...patch }
      return stored
    }),
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

describe('notification settings', () => {
  it('[api] reads the settings, both off until an administrator turns them on', async () => {
    const { app: instance } = app()
    const response = await instance.request('/settings/notifications')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      data: { budget_alerts_include_admins: false, submission_reminder: null },
    })
  })

  it('[api #934] sets whether administrators are copied on budget alerts', async () => {
    const { app: instance, store } = app()
    const response = await post(instance, { budget_alerts_include_admins: true })
    expect(response.status).toBe(200)
    expect(store.update).toHaveBeenCalledWith({ budgetAlertsIncludeAdmins: true })
    expect(await response.json()).toEqual({
      data: { budget_alerts_include_admins: true, submission_reminder: null },
    })
  })

  it('[api #935] sets, and clears, the week-end submission reminder, leaving the other setting alone', async () => {
    const { app: instance, store } = app()
    const set = await post(instance, { submission_reminder: { day: 'monday', time: '09:00' } })
    expect(set.status).toBe(200)
    expect(store.update).toHaveBeenCalledWith({
      submissionReminder: { day: 'monday', time: '09:00' },
    })
    expect(await set.json()).toEqual({
      data: {
        budget_alerts_include_admins: false,
        submission_reminder: { day: 'monday', time: '09:00' },
      },
    })
    const cleared = await post(instance, { submission_reminder: null })
    expect(store.update).toHaveBeenLastCalledWith({ submissionReminder: null })
    expect((await cleared.json()) as unknown).toEqual({
      data: { budget_alerts_include_admins: false, submission_reminder: null },
    })
  })

  it('[security] is for administrators only, to read and to change', async () => {
    for (const profile of ['member', 'project_manager', 'accounting', 'executive_manager']) {
      const { app: instance, store } = app(profile)
      expect((await instance.request('/settings/notifications')).status).toBe(403)
      expect((await post(instance, { budget_alerts_include_admins: true })).status).toBe(403)
      expect(store.update).not.toHaveBeenCalled()
    }
  })

  it('[api] refuses what is not a setting, not a boolean, not a weekday and time, and an empty change', async () => {
    const { app: instance, store } = app()
    expect((await post(instance, { budget_alerts_include_admins: 'yes' })).status).toBe(422)
    expect((await post(instance, { budget_alerts_include_admin: true })).status).toBe(422)
    expect((await post(instance, {})).status).toBe(422)
    for (const bad of [
      { day: 'someday', time: '09:00' },
      { day: 'monday', time: '9:00' },
      { day: 'monday', time: '24:00' },
      { day: 'monday' },
      { day: 'monday', time: '09:00', zone: 'UTC' },
      'monday 09:00',
    ]) {
      expect((await post(instance, { submission_reminder: bad })).status).toBe(422)
    }
    expect(store.update).not.toHaveBeenCalled()
  })
})
