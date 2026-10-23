import { describe, expect, it, vi } from 'vitest'
import { createApiApp, installGeneralResourceRoutes } from '../src/index.js'
import type { GeneralResourceRouteOptions } from '../src/general-resources.js'

const report = {
  project_id: 7,
  hourly_rate_cents: 1000,
  currency: 'USD',
  entry_count: 2,
  seconds: 7200,
  earliest_date: '2026-09-01',
  latest_date: '2026-09-02',
  fingerprint: 'a'.repeat(64),
  applied_entries: 0,
}
const setup = () => {
  const recover = vi.fn().mockResolvedValue(report)
  const app = createApiApp({
    authentication: {
      sessions: {
        resolve: async (request) => ({
          type: 'user',
          userId: 1,
          profile: request.headers.get('x-profile') === 'member' ? 'member' : 'administrator',
          managerGrants: [],
          authentication: { kind: 'session', sessionId: 'rate-repair' },
        }),
      },
    },
    installApi: (api) =>
      installGeneralResourceRoutes(api, {
        repository: {} as GeneralResourceRouteOptions['repository'],
        teamRepository: {} as GeneralResourceRouteOptions['teamRepository'],
        cursorSigningKey: new Uint8Array(32),
        isExpensesModuleEnabled: async () => true,
        missingRates: { recover },
      }),
  })
  const request = (body: unknown, profile = 'administrator') =>
    app.request('https://app.test/api/v1/projects/7/missing-rates', {
      method: 'POST',
      headers: {
        origin: 'https://app.test',
        'content-type': 'application/json',
        'x-profile': profile,
      },
      body: JSON.stringify(body),
    })
  return { recover, request }
}
describe('missing project-rate recovery', () => {
  it('[money] previews by default and passes only a confirmed fingerprint', async () => {
    const { request, recover } = setup()
    expect((await request({})).status).toBe(200)
    expect(recover.mock.calls[0]?.[0]).not.toHaveProperty('fingerprint')
    expect((await request({ fingerprint: report.fingerprint })).status).toBe(200)
    expect(recover.mock.calls[1]?.[0]).toMatchObject({
      projectId: 7,
      actorUserId: 1,
      fingerprint: report.fingerprint,
    })
  })
  it('[security] denies non-administrators before calling the recovery service', async () => {
    const { request, recover } = setup()
    expect((await request({}, 'member')).status).toBe(403)
    expect(recover).not.toHaveBeenCalled()
  })
  it('[reliability] rejects malformed confirmations and reports stale previews', async () => {
    const { request, recover } = setup()
    expect((await request({ fingerprint: 'bad' })).status).toBe(422)
    expect((await request({ apply: true })).status).toBe(422)
    expect(recover).not.toHaveBeenCalled()
    recover.mockRejectedValueOnce(new Error('missing_rate_preview_stale'))
    expect((await request({ fingerprint: report.fingerprint })).status).toBe(409)
  })
})
