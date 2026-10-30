import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { ApiContext } from '../src/context.js'
import { errorResponse } from '../src/errors.js'
import { installDeelSyncRoutes, type DeelSyncApiDependencies } from '../src/deel-sync.js'

const dependencies = (overrides: Partial<DeelSyncApiDependencies['runtime']> = {}) => {
  const runtime = {
    status: vi.fn(() => ({ configured: true, reason: null })),
    preview: vi.fn(async () => ({
      status: 'ready',
      window: { from: '2026-09-02', to: '2026-09-03' },
      entryIds: [1, 2],
      timesheets: 1,
      alreadyTransferred: 0,
      conflicts: [],
      unsyncable: [],
      unmatched: [],
    })),
    run: vi.fn(async () => ({
      status: 'completed',
      runId: 9,
      timesheetsSubmitted: 1,
      entriesTransferred: 2,
      failed: [],
      reconciliation: null,
      error: null,
    })),
    ...overrides,
  }
  const settings = {
    get: vi.fn(async () => ({
      mode: 'manual' as const,
      runTime: '03:00',
      updatedAt: '2026-10-19T00:00:00.000Z',
      updatedByUserId: null,
    })),
    save: vi.fn(async () => {}),
  }
  return {
    runtime,
    settings,
    recentRuns: vi.fn(async () => []),
    clock: () => '2026-10-20T00:00:00.000Z',
  }
}

const fixture = (profile = 'administrator', deps = dependencies()) => {
  const api = new Hono<ApiContext<object>>()
  api.use('*', async (context, next) => {
    context.set('principal', {
      type: 'user',
      userId: 1,
      profile,
      authentication: { kind: 'session', sessionId: 'test' },
    } as never)
    context.set('requestId', 'audit-request')
    await next()
  })
  api.onError((error, context) => errorResponse(error, context))
  installDeelSyncRoutes(api, deps)
  return { api, deps }
}

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
const patch = (body: unknown) => ({
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
const window = { from: '2026-09-02', to: '2026-09-03' }

describe('Deel sync routes: administrators only', () => {
  it.each(['member', 'accounting', 'executive_manager', 'project_manager'])(
    'refuses %s before reading or changing anything',
    async (profile) => {
      const { api, deps } = fixture(profile)
      expect((await api.request('/deel-sync')).status).toBe(403)
      expect((await api.request('/deel-sync/preview', json(window))).status).toBe(403)
      expect(
        (await api.request('/deel-sync/runs', json({ ...window, entry_ids: [1] }))).status,
      ).toBe(403)
      expect(
        (await api.request('/deel-sync/settings', patch({ mode: 'automatic', run_time: '03:00' })))
          .status,
      ).toBe(403)
      expect(deps.runtime.run).not.toHaveBeenCalled()
      expect(deps.settings.save).not.toHaveBeenCalled()
    },
  )
})

describe('selected-hour command privacy',()=>{
 it('keeps private staging envelopes out of legacy run history',async()=>{
  const {api,deps}=fixture()
  deps.recentRuns.mockResolvedValue([{id:1,startedAt:'2026-10-20T00:00:00.000Z',finishedAt:null,outcome:'running',timesheetsSubmitted:0,entriesTransferred:0,detail:{staging_command:{id:'private-command',userIds:[12345],fingerprint:'private-fingerprint'},staging_contracts:[{contractId:'private-contract'}]}}] as never)
  const response=await api.request('/deel-sync')
  expect(response.status).toBe(200)
  const body=await response.text()
  expect(body).toContain('selected_hours')
  for(const value of ['private-command','12345','private-fingerprint','private-contract','staging_command'])expect(body).not.toContain(value)
 })
})

describe('Deel sync routes: settings', () => {
  it('reports the mode, schedule and recent runs in snake_case', async () => {
    const { api } = fixture()
    const response = await api.request('/deel-sync')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      configured: true,
      mode: 'manual',
      run_time: '03:00',
      runs: [],
    })
  })

  it('saves a valid mode and time, recording the administrator', async () => {
    const { api, deps } = fixture()
    expect(
      (await api.request('/deel-sync/settings', patch({ mode: 'automatic', run_time: '21:15' })))
        .status,
    ).toBe(204)
    expect(deps.settings.save).toHaveBeenCalledWith(
      { mode: 'automatic', runTime: '21:15', userId: 1 },
      '2026-10-20T00:00:00.000Z',
    )
  })

  it.each([
    [{ mode: 'hourly', run_time: '03:00' }],
    [{ mode: 'automatic', run_time: '24:00' }],
    [{ mode: 'automatic', run_time: '3:00' }],
    [{ mode: 'automatic' }],
  ])('refuses %j without saving', async (body) => {
    const { api, deps } = fixture()
    expect((await api.request('/deel-sync/settings', patch(body))).status).toBe(422)
    expect(deps.settings.save).not.toHaveBeenCalled()
  })
})

describe('Deel sync routes: preview, then confirm', () => {
  it('previews the entries without sending', async () => {
    const { api, deps } = fixture()
    const response = await api.request('/deel-sync/preview', json(window))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: 'ready',
      entry_ids: [1, 2],
      timesheets: 1,
    })
    expect(deps.runtime.run).not.toHaveBeenCalled()
  })

  it('sends the previewed entries and records the administrator who confirmed', async () => {
    const { api, deps } = fixture()
    const response = await api.request('/deel-sync/runs', json({ ...window, entry_ids: [1, 2] }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: 'completed',
      run_id: 9,
      entries_transferred: 2,
    })
    expect(deps.runtime.run).toHaveBeenCalledWith({
      window,
      expectedEntryIds: [1, 2],
      trigger: 'manual',
      userId: 1,
    })
  })

  it('reports a changed plan as a conflict, not a success', async () => {
    const { api } = fixture(
      'administrator',
      dependencies({
        run: vi.fn(async () => ({
          status: 'stale',
          runId: 10,
          reason: 'changed since the preview',
        })),
      }) as never,
    )
    expect((await api.request('/deel-sync/runs', json({ ...window, entry_ids: [1] }))).status).toBe(
      409,
    )
  })

  it('refuses a sync that is not configured, rather than reporting an empty success', async () => {
    const { api } = fixture(
      'administrator',
      dependencies({
        preview: vi.fn(async () => ({
          status: 'unconfigured',
          reason: 'no Deel token is configured',
        })),
      }) as never,
    )
    expect((await api.request('/deel-sync/preview', json(window))).status).toBe(409)
  })

  it('refuses malformed windows and entry lists before reaching the runtime', async () => {
    const { api, deps } = fixture()
    expect(
      (await api.request('/deel-sync/preview', json({ from: 'Sept 2', to: '2026-09-03' }))).status,
    ).toBe(422)
    expect(
      (await api.request('/deel-sync/runs', json({ ...window, entry_ids: ['1'] }))).status,
    ).toBe(422)
    expect((await api.request('/deel-sync/runs', json({ ...window }))).status).toBe(422)
    expect(deps.runtime.run).not.toHaveBeenCalled()
  })
})

describe('Deel sync routes over the managed runtime (#1238)', () => {
  it('consumes the tenant-bound runtime: unconfigured and no provider request while no connection exists', async () => {
    const { createManagedDeelSyncRuntime } = await import('../../integrations/src/index.js')
    const fetchSpy = vi.fn(async () => new Response('{}'))
    const never = async () => {
      throw new Error('storage must not be read without a connection')
    }
    const runtime = createManagedDeelSyncRuntime({
      credentials: { current: async () => null, generation: async () => 0 },
      source: {
        directory: never,
        entries: never,
        log: never,
        logged: never,
        record: never,
        beginRun: never,
        finishRun: never,
      },
      settings: { get: never, claimAutomaticDay: never, organizationTimezone: never },
      fetch: fetchSpy,
      now: () => new Date('2026-10-20T00:00:00.000Z'),
    })
    const base = dependencies()
    const { api } = fixture('administrator', { ...base, runtime })

    const status = await api.request('/deel-sync')
    expect(status.status).toBe(200)
    expect(await status.json()).toMatchObject({
      configured: false,
      reason: 'no Deel connection is configured',
    })
    const preview = await api.request('/deel-sync/preview', json(window))
    expect(preview.status).toBe(409)
    expect(await preview.json()).toMatchObject({ error: { code: 'deel_sync_unconfigured' } })
    const run = await api.request('/deel-sync/runs', json({ ...window, entry_ids: [1] }))
    expect(run.status).toBe(409)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
