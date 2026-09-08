import { describe, expect, it } from 'vitest'
import {
  captureRequestActivity,
  type ActivityCaptureRequest,
  type ActivityRecorder,
} from '../src/activity-log.js'
import { createApiApp, type ApiAuthentication, type UserProfile } from '../src/index.js'

const authentication: ApiAuthentication = {
  sessions: {
    resolve: async (request) => {
      const userId = Number(request.headers.get('x-test-user') ?? '')
      if (!Number.isSafeInteger(userId) || userId < 1) return null
      return {
        type: 'user',
        userId,
        profile: 'administrator' as UserProfile,
        managerGrants: [],
        authentication: { kind: 'session', sessionId: 'activity-test' },
      }
    },
  },
}

const exportedAt = '2026-09-08T03:00:00.000Z'
const restoredAt = '2026-09-08T04:00:00.000Z'

const createApp = (recorder: ActivityRecorder) =>
  createApiApp({
    authentication,
    installApi(api) {
      api.post('/backup/exports', async (context) => {
        await captureRequestActivity(context, recorder, {
          eventType: 'backup.exported',
          subjectId: 12,
          occurredAt: exportedAt,
          detail: { trigger: 'manual' },
        })
        return context.json({ data: { id: 12 } }, 201)
      })
      api.post('/backup/restores', async (context) => {
        await captureRequestActivity(context, recorder, {
          eventType: 'backup.restored',
          subjectId: 1,
          occurredAt: restoredAt,
          detail: { bundle_version: '0031' },
        })
        return context.json({ data: { id: 1 } }, 201)
      })
    },
  })

const collectingRecorder = (): ActivityRecorder & { captured: ActivityCaptureRequest[] } => {
  const captured: ActivityCaptureRequest[] = []
  return {
    captured,
    capture: async (request) => void captured.push(request),
  }
}

describe('API activity capture', () => {
  it('[api] records an export and a restore against the user who ran them', async () => {
    const recorder = collectingRecorder()
    const app = createApp(recorder)

    const exported = await app.request('/api/v1/backup/exports', {
      method: 'POST',
      headers: { 'x-test-user': '4', origin: 'http://localhost' },
    })
    const restored = await app.request('/api/v1/backup/restores', {
      method: 'POST',
      headers: { 'x-test-user': '9', origin: 'http://localhost' },
    })

    expect([exported.status, restored.status]).toEqual([201, 201])
    expect(recorder.captured).toEqual([
      {
        eventType: 'backup.exported',
        subjectId: 12,
        occurredAt: exportedAt,
        detail: { trigger: 'manual' },
        actor: { type: 'user', id: 4 },
        captureId: exported.headers.get('x-request-id'),
      },
      {
        eventType: 'backup.restored',
        subjectId: 1,
        occurredAt: restoredAt,
        detail: { bundle_version: '0031' },
        actor: { type: 'user', id: 9 },
        captureId: restored.headers.get('x-request-id'),
      },
    ])
  })

  it('[api] keys each capture to its own request so a retry cannot double-record', async () => {
    const recorder = collectingRecorder()
    const app = createApp(recorder)

    const first = await app.request('/api/v1/backup/exports', {
      method: 'POST',
      headers: { 'x-test-user': '4', origin: 'http://localhost' },
    })
    const second = await app.request('/api/v1/backup/exports', {
      method: 'POST',
      headers: { 'x-test-user': '4', origin: 'http://localhost' },
    })

    const [firstCapture, secondCapture] = recorder.captured
    expect(firstCapture?.captureId).toBe(first.headers.get('x-request-id'))
    expect(secondCapture?.captureId).toBe(second.headers.get('x-request-id'))
    expect(firstCapture?.captureId).not.toBe(secondCapture?.captureId)
  })

  it('[api] fails the request when the event could not be recorded', async () => {
    const app = createApp({
      capture: async () => {
        throw new Error('activity log unavailable')
      },
    })

    const response = await app.request('/api/v1/backup/exports', {
      method: 'POST',
      headers: { 'x-test-user': '4', origin: 'http://localhost' },
    })

    expect(response.status).toBe(500)
  })

  it('[api] records nothing for a request that never authenticated', async () => {
    const recorder = collectingRecorder()
    const app = createApp(recorder)

    const response = await app.request('/api/v1/backup/exports', {
      method: 'POST',
      headers: { origin: 'http://localhost' },
    })

    expect(response.status).toBe(401)
    expect(recorder.captured).toEqual([])
  })
})
