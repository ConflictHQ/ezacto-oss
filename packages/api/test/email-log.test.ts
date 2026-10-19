import { describe, expect, it, vi } from 'vitest'
import type { EmailLogPageWindow, EmailLogRecord } from '@ezacto/mailer'
import { createApiApp, installEmailLogRoutes } from '../src/index.js'

const delivery: EmailLogRecord = {
  id: 4,
  from: { email: 'billing@example.test', name: 'Billing' },
  replyTo: [{ email: 'reply@example.test' }],
  to: [{ email: 'owner@example.test', name: 'Avery' }],
  cc: [],
  template: 'password_reset',
  subject: 'Reset your ezacto password',
  provider: 'test-http',
  providerMessageId: null,
  providerRequestId: null,
  providerLatencyMs: null,
  status: 'failed',
  relatedType: 'user',
  relatedId: 1,
  attemptCount: 5,
  failureCode: 'provider_timeout',
  failureReason: null,
  createdAt: '2026-08-28T20:00:00.000Z',
  updatedAt: '2026-08-28T20:15:00.000Z',
}

const cursorSigningKey = new Uint8Array(32).fill(9)

/** A pager over one row, which records what the route asked it for. */
const pagerOver = (rows: EmailLogRecord[], timezone = 'UTC') => {
  const page = vi.fn(async (window: EmailLogPageWindow) => rows.slice(0, window.take))
  const count = vi.fn(async () => rows.length)
  const pager = {
    snapshot: async () => rows.map((row) => row.createdAt).sort().at(-1) ?? null,
    page,
    count,
  }
  return { pager, page, count, options: { cursorSigningKey, timezone: async () => timezone } }
}

const harness = (profile: 'administrator' | 'member', timezone = 'UTC') => {
  const { pager, page, count, options } = pagerOver([delivery], timezone)
  const list = page
  const app = createApiApp({
    authentication: {
      sessions: {
        resolve: async () => ({
          type: 'user' as const,
          userId: 1,
          profile,
          managerGrants: [],
          authentication: { kind: 'session' as const, sessionId: 'session-1' },
        }),
      },
    },
    installApi(api) {
      installEmailLogRoutes(api, pager, options)
    },
  })
  return { app, list, count }
}

describe('email log API', () => {
  it('[api] makes terminal send failure visible to an administrator', async () => {
    const { app, list } = harness('administrator')
    const response = await app.request('/api/v1/email-log?status=failed&per_page=25')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      data: [
        {
          id: 4,
          from: { email: 'billing@example.test', name: 'Billing' },
          reply_to: [{ email: 'reply@example.test' }],
          to: [{ email: 'owner@example.test', name: 'Avery' }],
          cc: [],
          template: 'password_reset',
          subject: 'Reset your ezacto password',
          provider: 'test-http',
          provider_message_id: null,
          provider_request_id: null,
          provider_latency_ms: null,
          status: 'failed',
          related_type: 'user',
          related_id: 1,
          attempt_count: 5,
          failure_code: 'provider_timeout',
          failure_reason: null,
          viewed_at: null,
          created_at: '2026-08-28T20:00:00.000Z',
          updated_at: '2026-08-28T20:15:00.000Z',
        },
      ],
      links: { self: '/api/v1/email-log?status=failed&per_page=25', next: null },
      page: { per_page: 25, next_cursor: null, total: 1 },
    })
    // One more than the page, which is how the chassis learns there is a next one.
    expect(list).toHaveBeenCalledWith({
      status: 'failed',
      order: 'newest',
      after: null,
      createdThrough: '2026-08-28T20:00:00.000Z',
      take: 26,
    })
  })

  it('[api] says when an invoice email was first opened, and only for invoice emails', async () => {
    const sent: EmailLogRecord = {
      ...delivery,
      id: 5,
      template: 'invoice:1',
      relatedType: 'invoice_message',
      relatedId: 100,
      status: 'sent',
      createdAt: '2026-08-28T20:03:00.000Z',
    }
    const neverOpened: EmailLogRecord = {
      ...sent,
      id: 6,
      relatedId: 101,
      createdAt: '2026-08-28T20:02:00.000Z',
    }
    // A user whose id happens to be a message id with a receipt.
    const lookalike: EmailLogRecord = {
      ...delivery,
      id: 7,
      relatedType: 'user',
      relatedId: 100,
      createdAt: '2026-08-28T20:01:00.000Z',
    }
    const { pager, options } = pagerOver([sent, neverOpened, lookalike])
    const viewReceipts = vi.fn(async (ids: readonly number[]) => {
      expect(ids).toEqual([100, 101])
      return new Map([[100, '2026-08-29T09:30:00.000Z']])
    })
    const app = createApiApp({
      authentication: {
        sessions: {
          resolve: async () => ({
            type: 'user' as const,
            userId: 1,
            profile: 'administrator' as const,
            managerGrants: [],
            authentication: { kind: 'session' as const, sessionId: 'session-1' },
          }),
        },
      },
      installApi(api) {
        installEmailLogRoutes(api, pager, { ...options, viewReceipts })
      },
    })
    const response = await app.request('/api/v1/email-log')
    const body = (await response.json()) as { data: { id: number; viewed_at: string | null }[] }
    expect(body.data.map(({ id, viewed_at }) => [id, viewed_at])).toEqual([
      [5, '2026-08-29T09:30:00.000Z'],
      [6, null],
      [7, null],
    ])
  })

  it('[api] turns days into the instants they span in the organization timezone', async () => {
    const { app, list } = harness('administrator', 'America/Costa_Rica')
    const response = await app.request(
      '/api/v1/email-log?from=2026-09-08&to=2026-09-09&kind=reminder&q=%20Acme%20&order=oldest',
    )
    expect(response.status).toBe(200)
    expect(list).toHaveBeenCalledWith({
      kind: 'reminder',
      // The 8th began at 06:00 UTC for UTC-6, and the 9th ends where the 10th begins.
      createdFrom: '2026-09-08T06:00:00.000Z',
      createdBefore: '2026-09-10T06:00:00.000Z',
      recipient: 'Acme',
      order: 'oldest',
      after: null,
      createdThrough: '2026-08-28T20:00:00.000Z',
      take: 51,
    })
  })

  it('[api] walks pages with a signed cursor that belongs to its own filters', async () => {
    const rows = [3, 2, 1].map((id) => ({
      ...delivery,
      id,
      createdAt: `2026-08-28T20:00:0${String(id)}.000Z`,
    }))
    const { pager, options } = pagerOver(rows)
    const app = createApiApp({
      authentication: {
        sessions: {
          resolve: async () => ({
            type: 'user' as const,
            userId: 1,
            profile: 'administrator' as const,
            managerGrants: [],
            authentication: { kind: 'session' as const, sessionId: 'session-1' },
          }),
        },
      },
      installApi(api) {
        installEmailLogRoutes(
          api,
          {
            ...pager,
            page: async (window) =>
              rows
                .filter(
                  (row) =>
                    window.after === null ||
                    row.createdAt < window.after.createdAt ||
                    (row.createdAt === window.after.createdAt && row.id < window.after.id),
                )
                .slice(0, window.take),
          },
          options,
        )
      },
    })
    const first = (await (await app.request('/api/v1/email-log?per_page=2')).json()) as {
      data: { id: number }[]
      links: { next: string }
      page: { next_cursor: string; total: number }
    }
    expect(first.data.map((row) => row.id)).toEqual([3, 2])
    expect(first.page.total).toBe(3)
    const second = (await (await app.request(first.links.next)).json()) as {
      data: { id: number }[]
      page: { next_cursor: string | null }
    }
    expect(second.data.map((row) => row.id)).toEqual([1])
    expect(second.page.next_cursor).toBeNull()

    // The same cursor under another filter is refused rather than half-honoured.
    const replayed = await app.request(
      `/api/v1/email-log?status=sent&per_page=2&cursor=${first.page.next_cursor}`,
    )
    expect(replayed.status).toBe(422)
  })

  it('[security] requires an administrator session and rejects bearer tokens', async () => {
    const member = harness('member')
    expect((await member.app.request('/api/v1/email-log')).status).toBe(403)

    const bearerOnly = createApiApp({
      authentication: {
        tokens: {
          authenticate: async () => ({
            tokenId: 1,
            userId: 1,
            profile: 'administrator',
            scopes: ['time_entries:read'],
          }),
          issue: vi.fn(),
          list: vi.fn(),
          revoke: vi.fn(),
        },
      },
      installApi(api) {
        installEmailLogRoutes(api, pagerOver([delivery]).pager, pagerOver([delivery]).options)
      },
    })
    const response = await bearerOnly.request('/api/v1/email-log', {
      headers: { authorization: 'Bearer api-token' },
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      error: { code: 'session_required' },
    })
  })

  it('[api] validates status and page size before querying the log', async () => {
    const { app, list } = harness('administrator')
    expect((await app.request('/api/v1/email-log?status=delivered')).status).toBe(422)
    expect((await app.request('/api/v1/email-log?per_page=0')).status).toBe(422)
    expect((await app.request('/api/v1/email-log?kind=newsletter')).status).toBe(422)
    expect((await app.request('/api/v1/email-log?from=2026-02-30')).status).toBe(422)
    expect((await app.request('/api/v1/email-log?from=2026-09-09&to=2026-09-08')).status).toBe(422)
    expect((await app.request('/api/v1/email-log?status=sent&status=failed')).status).toBe(422)
    expect(list).not.toHaveBeenCalled()
  })
})
