import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import {
  StaffPaymentError,
  type AcceptContractorReview,
  type ContractorAcceptance,
} from '@ezacto/core'
import type { ApiContext } from '../src/context.js'
import { errorResponse } from '../src/errors.js'
import { installContractorReviewRoutes } from '../src/contractor-review.js'
const now = '2026-10-01T12:00:00.000Z'
const fixture = (
  profile = 'administrator',
  kind = 'session',
  writable = false,
) => {
  const api = new Hono<ApiContext<object>>()
  const record: ContractorAcceptance = {
    id: 'accept-1',
    user_id: 2,
    month: '2026-09',
    currency: 'USD',
    review_version: 'a'.repeat(64),
    reason: 'Reviewed credit',
    actor_id: 1,
    recorded_at: now,
    allocation_ids: ['accept-1.a.0'],
    credit_application_ids: [],
    state: 'completed',
  }
  const store = {
    ...(writable
      ? {
          accept: vi.fn(
            async (
              _command: AcceptContractorReview,
              _actor: number,
              _request: string,
              _now: string,
            ) => {
              void _command
              void _actor
              void _request
              void _now
              return record
            },
          ),
          acceptances: vi.fn(async (_month: string) => {
            void _month
            return [record]
          }),
        }
      : {}),
    review: vi.fn(async (month: string) => ({
      month,
      completed: true,
      credit_period: { from: `${month}-01`, to: '2026-10-01' },
      version: 'a'.repeat(64),
      people: [],
    })),
  }
  api.use('*', async (context, next) => {
    context.set('principal', {
      type: 'user',
      userId: 1,
      profile,
      authentication: { kind, sessionId: 'test' },
    } as never)
    context.set('requestId', 'review-request')
    await next()
  })
  api.onError((error, context) => errorResponse(error, context))
  installContractorReviewRoutes(api, store, () => now)
  return { api, store }
}
describe('contractor combined review API', () => {
  it.each([
    ['member', 'session'],
    ['accounting', 'session'],
    ['executive_manager', 'session'],
    ['administrator', 'token'],
  ])('rejects %s/%s before any financial read', async (profile, kind) => {
    const { api, store } = fixture(profile, kind)
    expect(
      (await api.request('/staff-payments/contractor-review?month=2026-09'))
        .status,
    ).toBe(403)
    expect(store.review).not.toHaveBeenCalled()
  })
  it('returns one uncached administrator review with its source version', async () => {
    const { api, store } = fixture()
    const response = await api.request(
      '/staff-payments/contractor-review?month=2026-08',
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      data: {
        month: '2026-08',
        completed: true,
        credit_period: { from: '2026-08-01', to: '2026-10-01' },
        version: 'a'.repeat(64),
        people: [],
      },
    })
    expect(store.review).toHaveBeenCalledWith('2026-08', now)
    await api.request('/staff-payments/contractor-review')
    expect(store.review).toHaveBeenLastCalledWith('2026-09', now)
  })
  it('validates the work month and returns source conflicts without caching a stale review', async () => {
    const { api, store } = fixture()
    expect(
      (await api.request('/staff-payments/contractor-review?month=2026-99'))
        .status,
    ).toBe(422)
    expect(store.review).not.toHaveBeenCalled()
    store.review.mockRejectedValueOnce(
      new StaffPaymentError('conflict', 'Sources disagree. Reload.'),
    )
    const response = await api.request(
      '/staff-payments/contractor-review?month=2026-09',
    )
    expect(response.status).toBe(409)
    expect(response.headers.get('cache-control')).toBe('no-store')
    store.review.mockRejectedValueOnce(
      new StaffPaymentError('invalid', 'Unsupported month.'),
    )
    expect(
      (await api.request('/staff-payments/contractor-review?month=2026-09'))
        .status,
    ).toBe(422)
  })
  it('offers no mutation or execution operation', async () => {
    const { api, store } = fixture()
    expect(
      (
        await api.request('/staff-payments/contractor-review?month=2026-09', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ confirm: true }),
        })
      ).status,
    ).toBe(404)
    expect(store.review).not.toHaveBeenCalled()
  })
})

const command: AcceptContractorReview = {
  id: 'accept-1',
  user_id: 2,
  month: '2026-09',
  currency: 'USD',
  review_version: 'a'.repeat(64),
  source_revision: '[1,2,3]',
  apply_allocations: true,
  apply_credits: false,
  reason: 'Reviewed credit',
}
const confirmation = (body: unknown = command) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
it.each([
  ['member', 'session'],
  ['accounting', 'session'],
  ['executive_manager', 'session'],
  ['administrator', 'token'],
])(
  'denies %s/%s confirmation and history before touching the store',
  async (profile, kind) => {
    const { api, store } = fixture(profile, kind, true)
    expect(
      (
        await api.request(
          '/staff-payments/contractor-review/acceptances',
          confirmation(),
        )
      ).status,
    ).toBe(403)
    expect(
      (
        await api.request(
          '/staff-payments/contractor-review/acceptances?month=2026-09',
        )
      ).status,
    ).toBe(403)
    expect(store.accept).not.toHaveBeenCalled()
    expect(store.acceptances).not.toHaveBeenCalled()
  },
)
it('records a bounded explicit confirmation with authenticated actor, request and clock and reads uncached history', async () => {
  const { api, store } = fixture('administrator', 'session', true)
  const response = await api.request(
    '/staff-payments/contractor-review/acceptances',
    confirmation(),
  )
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(store.accept).toHaveBeenCalledWith(command, 1, 'review-request', now)
  const history = await api.request(
    '/staff-payments/contractor-review/acceptances?month=2026-09',
  )
  expect(history.status).toBe(200)
  expect(history.headers.get('cache-control')).toBe('no-store')
  expect(store.acceptances).toHaveBeenCalledWith('2026-09')
  expect(
    (
      await api.request(
        '/staff-payments/contractor-review/acceptances',
        confirmation({ ...command, actor_id: 99 }),
      )
    ).status,
  ).toBe(422)
  expect(
    (
      await api.request(
        '/staff-payments/contractor-review/acceptances',
        confirmation({ ...command, reason: 'a'.repeat(9000) }),
      )
    ).status,
  ).toBe(413)
  expect(store.accept).toHaveBeenCalledTimes(1)
})
it('surfaces stale confirmation conflicts without caching or initiating another command', async () => {
  const { api, store } = fixture('administrator', 'session', true)
  store.accept!.mockRejectedValueOnce(
    new StaffPaymentError('conflict', 'Review changed'),
  )
  const response = await api.request(
    '/staff-payments/contractor-review/acceptances',
    confirmation(),
  )
  expect(response.status).toBe(409)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(store.accept).toHaveBeenCalledTimes(1)
})
