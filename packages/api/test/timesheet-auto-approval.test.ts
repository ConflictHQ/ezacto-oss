import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { ActivityRecorder } from '../src/activity-log.js'
import { errorResponse } from '../src/errors.js'
import {
  createTimesheetAutoApprovalService,
  installTimesheetAutoApprovalRoutes,
  type StoredTimesheetAutoApproval,
} from '../src/timesheet-auto-approval.js'

/**
 * Issue 1009. Letting time that bills clients approve itself is an
 * administrator's decision and nobody else's, it is off until they make it, and
 * the change is on the record.
 */

type Patch = { enabled?: boolean; windowDays?: number }

const app = (profile = 'administrator', moduleEnabled = true) => {
  let stored: StoredTimesheetAutoApproval = {
    enabled: false,
    windowDays: null,
    effectiveFrom: null,
    approvalModuleEnabled: moduleEnabled,
  }
  const store = {
    read: vi.fn(async () => stored),
    update: vi.fn(async (_actor: number, patch: Patch) => {
      const enabled = patch.enabled ?? stored.enabled
      stored = {
        ...stored,
        enabled,
        windowDays: patch.windowDays ?? stored.windowDays,
        effectiveFrom: enabled ? (stored.effectiveFrom ?? '2026-10-18T12:00:00.000Z') : null,
      }
      return stored
    }),
  }
  const activity: ActivityRecorder = { capture: vi.fn(async () => undefined) }
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
  installTimesheetAutoApprovalRoutes(instance as never, {
    service: createTimesheetAutoApprovalService(store),
    activity,
    clock: () => '2026-10-18T12:00:00.000Z',
  })
  return { app: instance as never as Hono<never>, store, activity }
}

const post = (instance: Hono<never>, body: unknown) =>
  instance.request('/settings/timesheet-auto-approval', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })

describe('timesheet auto approval settings', () => {
  it('[api #1009] reads a policy that is off, with no window, until an administrator sets one', async () => {
    const { app: instance } = app()
    const response = await instance.request('/settings/timesheet-auto-approval')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      data: {
        enabled: false,
        window_days: null,
        clock_starts_at: 'submitted_at',
        effective_from: null,
        approval_module_enabled: true,
      },
    })
  })

  it('[api #1009] turns it on with a window, as the signed-in administrator, and records the change', async () => {
    const { app: instance, store, activity } = app()
    const response = await post(instance, { enabled: true, window_days: 7 })
    expect(response.status).toBe(200)
    expect(store.update).toHaveBeenCalledWith(7, { enabled: true, windowDays: 7 })
    expect(await response.json()).toMatchObject({
      data: { enabled: true, window_days: 7, effective_from: '2026-10-18T12:00:00.000Z' },
    })
    expect(activity.capture).toHaveBeenCalledWith({
      eventType: 'timesheet_auto_approval.updated',
      subjectId: 1,
      occurredAt: '2026-10-18T12:00:00.000Z',
      detail: { enabled: true, window_days: 7, effective_from: '2026-10-18T12:00:00.000Z' },
      actor: { type: 'user', id: 7 },
      captureId: 'test-request',
    })
  })

  it('[api #1009] turns it off without losing the window', async () => {
    const { app: instance } = app()
    await post(instance, { enabled: true, window_days: 5 })
    const response = await post(instance, { enabled: false })
    expect(await response.json()).toMatchObject({
      data: { enabled: false, window_days: 5, effective_from: null },
    })
  })

  it('[api #1009] refuses to turn it on without a window, or with the Approval module off', async () => {
    const { app: instance, store, activity } = app()
    const noWindow = await post(instance, { enabled: true })
    expect(noWindow.status).toBe(422)
    expect(JSON.stringify(await noWindow.json())).toContain('window_days')

    const off = app('administrator', false)
    const noModule = await post(off.app, { enabled: true, window_days: 3 })
    expect(noModule.status).toBe(422)
    expect(JSON.stringify(await noModule.json())).toContain('module_disabled')

    expect(store.update).not.toHaveBeenCalled()
    expect(off.store.update).not.toHaveBeenCalled()
    expect(activity.capture).not.toHaveBeenCalled()
  })

  it('[api #1009] rejects a window that is not a whole number of days from 1 to 60, and unknown fields', async () => {
    const { app: instance, store } = app()
    for (const window_days of [0, 61, 1.5, '7', null]) {
      expect((await post(instance, { window_days })).status).toBe(422)
    }
    expect((await post(instance, { enabled: 'yes' })).status).toBe(422)
    expect((await post(instance, { business_days: true })).status).toBe(422)
    expect((await post(instance, {})).status).toBe(422)
    expect(store.update).not.toHaveBeenCalled()
  })

  it('[api #1009] is for administrators only', async () => {
    for (const profile of ['member', 'project_manager', 'accounting', 'executive_manager']) {
      const { app: instance, store } = app(profile)
      expect((await instance.request('/settings/timesheet-auto-approval')).status).toBe(403)
      expect((await post(instance, { enabled: true, window_days: 3 })).status).toBe(403)
      expect(store.update).not.toHaveBeenCalled()
    }
  })
})
