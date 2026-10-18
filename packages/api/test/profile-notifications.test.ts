import type { TeamNotificationPatch, TeamNotificationPreference } from '@ezacto/core'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { errorResponse } from '../src/errors.js'
import {
  installProfileNotificationRoutes,
  parseNotificationPreferences,
} from '../src/notification-preferences.js'

/**
 * Issue 935. A person's own reminder preferences: the same rules the Team page
 * applies to somebody else's, on the session's own user and never one the
 * request names.
 */

const preference = (over: Partial<TeamNotificationPreference> = {}): TeamNotificationPreference => ({
  deliveryActive: true,
  dailyReminderEnabled: false,
  reminderTime: null,
  reminderDays: [],
  emailEnabled: false,
  desktopEnabled: false,
  slackEnabled: false,
  includeInTeamReminders: true,
  weeklyDigest: false,
  notifyProjectDeleted: false,
  updatedAt: '2026-10-14T12:00:00.000Z',
  ...over,
})

const app = (userId = 7, kind: 'session' | 'token' = 'session') => {
  const port = {
    read: vi.fn(async () => preference()),
    update: vi.fn(async (_userId: number, patch: Readonly<TeamNotificationPatch>) =>
      preference({
        dailyReminderEnabled: patch.dailyReminderEnabled,
        reminderTime: patch.reminderTime,
        reminderDays: patch.reminderDays,
        emailEnabled: patch.emailEnabled,
        includeInTeamReminders: patch.includeInTeamReminders,
        weeklyDigest: patch.weeklyDigest,
      }),
    ),
  }
  const instance = new Hono<{ Bindings: object; Variables: Record<string, unknown> }>()
  instance.use('*', async (context, next) => {
    context.set('requestId', 'test-request')
    context.set('principal', {
      userId,
      profile: 'member',
      authentication:
        kind === 'session' ? { kind: 'session', sessionId: 'session-1' } : { kind: 'token', tokenId: 't', scopes: [] },
    })
    await next()
  })
  instance.onError((error, context) => errorResponse(error, context as never))
  installProfileNotificationRoutes(instance as never, port)
  return { app: instance as never as Hono<never>, port }
}

const valid = {
  daily_reminder_enabled: true,
  reminder_time: '17:00',
  reminder_days: ['monday', 'friday'],
  channels: { email: true, desktop: false, slack: false },
  include_in_team_reminders: false,
  weekly_digest: true,
  notify_project_deleted: false,
}

const post = (instance: Hono<never>, body: unknown) =>
  instance.request('/profile/notifications', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })

describe('your own notification preferences (issue 935)', () => {
  it('[api] reads them, with delivery active', async () => {
    const { app: instance, port } = app(7)
    const response = await instance.request('/profile/notifications')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(port.read).toHaveBeenCalledWith(7)
    expect(await response.json()).toMatchObject({
      data: { delivery_active: true, include_in_team_reminders: true, channels: { email: false } },
    })
  })

  it('[api] saves them for the person signed in, whatever else the request says', async () => {
    const { app: instance, port } = app(7)
    const response = await post(instance, valid)
    expect(response.status).toBe(200)
    expect(port.update).toHaveBeenCalledWith(7, {
      dailyReminderEnabled: true,
      reminderTime: '17:00',
      reminderDays: ['monday', 'friday'],
      emailEnabled: true,
      desktopEnabled: false,
      slackEnabled: false,
      includeInTeamReminders: false,
      weeklyDigest: true,
      notifyProjectDeleted: false,
    })
    // There is no way to name somebody else.
    const other = await post(instance, { ...valid, user_id: 1 })
    expect(other.status).toBe(422)
    expect(port.update).toHaveBeenCalledTimes(1)
  })

  it('[security] is for a signed-in person, not a token', async () => {
    const { app: instance, port } = app(7, 'token')
    expect((await instance.request('/profile/notifications')).status).toBeGreaterThanOrEqual(401)
    expect((await post(instance, valid)).status).toBeGreaterThanOrEqual(401)
    expect(port.update).not.toHaveBeenCalled()
  })

  it('[api] refuses what has no delivery, and a daily reminder with nowhere to go', async () => {
    const { app: instance, port } = app()
    const cases: [string, unknown, string][] = [
      ['desktop', { ...valid, channels: { email: true, desktop: true, slack: false } }, 'unavailable'],
      ['slack', { ...valid, channels: { email: true, desktop: false, slack: true } }, 'unavailable'],
      ['project deletion', { ...valid, notify_project_deleted: true }, 'unavailable'],
      ['no mail channel', { ...valid, channels: { email: false, desktop: false, slack: false } }, 'incomplete'],
      ['no time', { ...valid, reminder_time: null }, 'incomplete'],
      ['no days', { ...valid, reminder_days: [] }, 'incomplete'],
      ['a half-sent form', { daily_reminder_enabled: false }, 'required'],
      ['a bad time', { ...valid, reminder_time: '25:00' }, 'invalid_time'],
      ['a repeated day', { ...valid, reminder_days: ['monday', 'monday'] }, 'invalid_array'],
    ]
    for (const [label, body, code] of cases) {
      const response = await post(instance, body)
      expect(response.status, label).toBe(422)
      expect(JSON.stringify(await response.json()), label).toContain(code)
    }
    expect(port.update).not.toHaveBeenCalled()
  })

  it('[unit] leaves the daily reminder switched off with nothing else to say', async () => {
    const errors: never[] = []
    expect(
      parseNotificationPreferences(
        { ...valid, daily_reminder_enabled: false, reminder_time: null, reminder_days: [] },
        errors,
      ),
    ).toMatchObject({ dailyReminderEnabled: false, reminderTime: null, emailEnabled: true })
    expect(errors).toEqual([])
  })
})
