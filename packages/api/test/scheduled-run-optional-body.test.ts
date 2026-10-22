import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { ApiContext } from '../src/context.js'
import { errorResponse } from '../src/errors.js'
import { installScheduledRunRoutes } from '../src/scheduled-runs.js'
import type { ScheduledRun, ScheduledRunsService } from '@ezacto/core'
const run: ScheduledRun = {
  id: 7,
  job_id: 1,
  occurrence_key: '2026-09',
  state: 'confirmed',
  proposed_at: '2026-10-01T09:00:00.000Z',
  expires_at: '2026-10-02T09:00:00.000Z',
  confirmed_by: 1,
  confirmed_at: '2026-10-01T10:00:00.000Z',
  settled_reason: null,
  items: [],
}
const fixture = () => {
  const app = new Hono<ApiContext<object>>()
  app.use('*', async (c, next) => {
    c.set('principal', {
      type: 'user',
      userId: 1,
      profile: 'administrator',
      authentication: { kind: 'session', sessionId: 'fixture' },
    } as never)
    c.set('requestId', 'fixture')
    await next()
  })
  app.onError((error, c) => errorResponse(error, c, vi.fn()))
  const confirm = vi.fn<ScheduledRunsService['confirm']>(async () => ({ outcome: 'ok', run }))
  installScheduledRunRoutes(app, {
    confirm,
    read: async () => run,
    cancel: async () => ({ outcome: 'ok', run }),
  })
  const request = (bytes: Uint8Array, headers: Record<string, string> = {}) =>
    app.request(
      new Request('https://app.test/scheduled-runs/7/confirm', {
        method: 'POST',
        headers,
        body: new ReadableStream({
          start(controller) {
            if (bytes.length) controller.enqueue(bytes)
            controller.close()
          },
        }),
        ...{ duplex: 'half' },
      }),
    )
  return { request, confirm }
}
describe('optional scheduled confirmation JSON', () => {
  it('[regression #62] accepts a non-null but empty HTTP body without requiring a media type', async () => {
    const f = fixture()
    expect((await f.request(new Uint8Array())).status).toBe(200)
    expect(f.confirm).toHaveBeenCalledWith(7, 1, expect.any(String), false)
  })
  it.each([
    ['text/plain', '{"acknowledge_report_warnings":true}', 415],
    ['application/json', '{bad', 400],
    ['application/json', '[]', 422],
    ['application/json', '{"actor_id":2}', 422],
  ])('[validation] rejects %s %s before confirmation', async (contentType, text, status) => {
    const f = fixture()
    expect(
      (await f.request(new TextEncoder().encode(text), { 'content-type': contentType })).status,
    ).toBe(status)
    expect(f.confirm).not.toHaveBeenCalled()
  })
  it('[security] enforces the bounded body and declared byte length even for optional input', async () => {
    const f = fixture()
    expect(
      (
        await f.request(new TextEncoder().encode(' '.repeat(4097)), {
          'content-type': 'application/json',
        })
      ).status,
    ).toBe(413)
    expect((await f.request(new Uint8Array(), { 'content-length': 'not-a-length' })).status).toBe(
      400,
    )
    expect(f.confirm).not.toHaveBeenCalled()
  })
})
