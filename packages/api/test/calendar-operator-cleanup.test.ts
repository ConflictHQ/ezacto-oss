import { CalendarConnectionError } from '@ezacto/core'
import { afterEach, expect, it, vi } from 'vitest'
import { calendarOperatorFixture } from '../../db/test/support/calendar-operator-fixture.js'
import { createApiApp } from '../src/app.js'
import { createApiSessionService } from '../src/sessions.js'
import { installCalendarOperatorCleanupRoutes } from '../src/calendar-operator-cleanup.js'
const closing: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(closing.splice(0).map((close) => close()))
})
const setup = async () => {
  const f = await calendarOperatorFixture('sqlite')
  closing.push(f.close)
  await f.seed()
  const app = createApiApp({
    authentication: {
      sessions: createApiSessionService(f.sessions),
      tokens: {
        authenticate: async () => ({
          tokenId: 1,
          userId: 1,
          profile: 'administrator' as const,
          scopes: ['time_entries:read' as const],
        }),
        issue: async () => {
          throw new Error('unused')
        },
        list: async () => [],
        revoke: async () => null,
      },
    },
    installApi: (api) => installCalendarOperatorCleanupRoutes(api, f.store),
  })
  const request = (
    path = '',
    body?: unknown,
    cookie = f.issued.token,
    origin = 'https://owned.example',
  ) =>
    app.request('https://owned.example/api/v1/admin/calendar-cleanup' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        cookie: cookie ? '__Host-ezacto_session=' + cookie : '',
        origin,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  return { ...f, app, request }
}
it('requires native administrator authority and serializes no provider credentials', async () => {
  const f = await setup()
  expect((await f.request('', undefined, '')).status).toBe(401)
  expect((await f.request('', undefined, f.member.token)).status).toBe(403)
  expect(
    (
      await f.app.request('https://owned.example/api/v1/admin/calendar-cleanup', {
        headers: { authorization: 'Bearer token' },
      })
    ).status,
  ).toBe(403)
  const response = await f.request()
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  const text = await response.text()
  expect(text).not.toContain('PRIVATE_SEALED_GRANT')
  expect(text).not.toContain('sealed_grant')
  expect(JSON.parse(text).data).toHaveLength(1)
})
it('rejects origin/input drift and confirms exact custody with a non-secret receipt', async () => {
  const f = await setup(),
    list = (await (await f.request()).json()) as { data: Record<string, unknown>[] },
    row = list.data[0]!
  const { status, created_at, provider_cleanup_in_progress, ...identity } = row
  void created_at
  void provider_cleanup_in_progress
  const input = {
    ...identity,
    expected_status: status,
    evidence_reference: 'Protected evidence CAL-1316: grant removal checked.',
    confirm_provider_removed: true,
  }
  expect(
    (await f.request('/confirm', input, f.issued.token, 'https://foreign.example')).status,
  ).toBe(403)
  expect((await f.request('/confirm', { ...input, sealed_grant: 'secret' })).status).toBe(422)
  expect((await f.request('/confirm', { ...input, request_id: 'wrong' })).status).toBe(409)
  expect((await f.request('?after=a&after=b')).status).toBe(422)
  const response = await f.request('/confirm', input)
  expect(response.status).toBe(200)
  const text = await response.text()
  expect(text).not.toContain(input.evidence_reference)
  expect(text).not.toContain('PRIVATE')
  expect(JSON.parse(text).data).toMatchObject({
    kind: 'operator_attestation',
    provider_verified: false,
  })
  expect((await f.request('/confirm', input)).status).toBe(200)
})

it('keeps invalid-input responses deliberate and preserves unexpected faults for diagnostics', async () => {
  const f = await setup(),
    row = (await f.store.list(f.actor)).data[0]!
  const { status, created_at: _, provider_cleanup_in_progress: __, ...identity } = row
  void _
  void __
  const input = {
    ...identity,
    expected_status: status,
    evidence_reference: 'Protected evidence CAL-1316: exact removal checked.',
    confirm_provider_removed: true,
  }
  const fault = new Error('PRIVATE_DATABASE_FAULT'),
    report = vi.fn(),
    logged = vi.spyOn(console, 'error').mockImplementation(() => {})
  const original = f.store.confirm
  f.store.confirm = vi
    .fn()
    .mockRejectedValueOnce(new CalendarConnectionError('invalid'))
    .mockRejectedValueOnce(fault)
  const app = createApiApp({
    authentication: { sessions: createApiSessionService(f.sessions) },
    reportError: report,
    installApi: (api) => installCalendarOperatorCleanupRoutes(api, f.store),
  })
  const call = () =>
    app.request('https://owned.example/api/v1/admin/calendar-cleanup/confirm', {
      method: 'POST',
      headers: {
        cookie: '__Host-ezacto_session=' + f.issued.token,
        origin: 'https://owned.example',
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
    })
  try {
    expect((await call()).status).toBe(400)
    const failed = await call()
    expect(failed.status).toBe(503)
    expect(await failed.text()).not.toContain('PRIVATE_DATABASE_FAULT')
    expect(report).toHaveBeenCalledOnce()
    expect(report.mock.calls[0]![0].cause).toBe(fault)
  } finally {
    f.store.confirm = original
    logged.mockRestore()
  }
})
