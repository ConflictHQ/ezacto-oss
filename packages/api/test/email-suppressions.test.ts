import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { EmailSuppressionError, type EmailSuppressionStore } from '@ezacto/mailer'
import type { ApiContext } from '../src/context.js'
import { errorResponse } from '../src/errors.js'
import { installEmailSuppressionRoutes } from '../src/email-suppressions.js'
const now = '2026-10-21T12:00:00.000Z'
const records = [
  {
    id: 1,
    address: 'a@example.test',
    reason: 'bounce' as const,
    firstSeenAt: now,
    lastSeenAt: now,
    events: 1,
  },
  {
    id: 2,
    address: 'b@example.test',
    reason: 'complaint' as const,
    firstSeenAt: now,
    lastSeenAt: now,
    events: 2,
  },
]
const fixture = (profile = 'administrator', kind = 'session') => {
  const store = {
    snapshot: vi.fn(async () => 2),
    list: vi.fn<EmailSuppressionStore['list']>(async (input) =>
      records
        .filter((record) => record.id <= input.snapshot && record.id > (input.after ?? 0))
        .slice(0, input.take),
    ),
    lookup: vi.fn<EmailSuppressionStore['lookup']>(async () => null),
    lift: vi.fn<EmailSuppressionStore['lift']>(async (input) => ({
      id: 1,
      address: 'a@example.test',
      throughEventId: input.eventId,
      actorId: input.actorId,
      note: input.note,
      complaintAcknowledged: false,
      liftedAt: now,
    })),
  }
  const api = new Hono<ApiContext<object>>()
  api.use('*', async (c, next) => {
    c.set('principal', {
      type: 'user',
      userId: 7,
      profile,
      managerGrants: [],
      authentication: { kind, sessionId: 'session', tokenId: 1, scopes: [] },
    } as never)
    c.set('requestId', 'test-request')
    await next()
  })
  api.onError(errorResponse)
  installEmailSuppressionRoutes(api, store, {
    cursorSigningKey: new Uint8Array(32).fill(31),
    now: () => now,
  })
  const post = (body: unknown, id = '1') =>
    api.request(`/email-suppressions/${id}/lift`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  return { api, store, post }
}
describe('email suppression review API #42', () => {
  it('requires an administrator session for reads and lifts without consulting the store', async () => {
    for (const profile of [
      'member',
      'project_manager',
      'people_admin',
      'accounting',
      'executive_manager',
    ]) {
      const { api, store, post } = fixture(profile)
      expect((await api.request('/email-suppressions')).status).toBe(403)
      expect((await post({ note: 'Untrusted' })).status).toBe(403)
      expect(store.snapshot).not.toHaveBeenCalled()
      expect(store.lift).not.toHaveBeenCalled()
    }
    const { api, store, post } = fixture('administrator', 'token')
    expect((await api.request('/email-suppressions')).status).toBe(403)
    expect((await post({ note: 'Token' })).status).toBe(403)
    expect(store.snapshot).not.toHaveBeenCalled()
    expect(store.lift).not.toHaveBeenCalled()
  })
  it('uses signed snapshot-bound pages and exposes only the review fields', async () => {
    const { api, store } = fixture()
    const first = await api.request('/email-suppressions?per_page=1')
    expect(first.status).toBe(200)
    expect(first.headers.get('cache-control')).toBe('no-store')
    const body = (await first.json()) as {
      data: unknown[]
      page: { next_cursor: string }
      links: { next: string }
    }
    expect(body.data).toEqual([
      {
        id: 1,
        address: 'a@example.test',
        reason: 'bounce',
        first_seen_at: now,
        last_seen_at: now,
        event_count: 1,
      },
    ])
    expect(body.page.next_cursor).toBeTruthy()
    const next = await api.request(body.links.next)
    expect(next.status).toBe(200)
    expect(
      ((await next.json()) as { data: Array<{ id: number }> }).data.map((row) => row.id),
    ).toEqual([2])
    expect(store.snapshot).toHaveBeenCalledTimes(1)
    expect(
      (await api.request(`/email-suppressions?cursor=${body.page.next_cursor}broken`)).status,
    ).toBe(422)
    expect((await api.request('/email-suppressions?unknown=x')).status).toBe(422)
  })
  it('binds the actor to the session and refuses forged actors and invalid notes', async () => {
    const { post, store } = fixture()
    expect((await post({ note: ' ', actor_user_id: 9 })).status).toBe(422)
    expect((await post({ note: 'Reviewed', actor_user_id: 9 })).status).toBe(422)
    expect((await post({ note: 'Reviewed' }, 'invalid')).status).toBe(422)
    expect(store.lift).not.toHaveBeenCalled()
    const saved = await post({ note: 'Recipient confirmed delivery' })
    expect(saved.status).toBe(200)
    expect(store.lift).toHaveBeenCalledWith(
      { eventId: 1, actorId: 7, note: 'Recipient confirmed delivery', confirmation: '' },
      now,
    )
    expect(await saved.json()).toEqual({
      data: {
        id: 1,
        address: 'a@example.test',
        through_event_id: 1,
        actor_user_id: 7,
        note: 'Recipient confirmed delivery',
        complaint_acknowledged: false,
        lifted_at: now,
      },
    })
  })
  it('returns actionable complaint and stale-evidence failures without claiming a lift succeeded', async () => {
    const { post, store } = fixture()
    store.lift.mockRejectedValueOnce(
      new EmailSuppressionError('confirmation_required', 'Type the complaint address.'),
    )
    const confirmation = await post({ note: 'Reviewed' })
    expect(confirmation.status).toBe(422)
    expect(await confirmation.json()).toMatchObject({
      error: { fields: [{ field: 'confirmation', code: 'confirmation_required' }] },
    })
    store.lift.mockRejectedValueOnce(
      new EmailSuppressionError('state_conflict', 'New feedback arrived.'),
    )
    expect((await post({ note: 'Reviewed' })).status).toBe(409)
  })
})
