import { describe, expect, it, vi } from 'vitest'
import {
  createApiApp,
  installBackupStatusRoutes,
  type ApiAuthentication,
  type BackupRunFilter,
  type BackupStatusReader,
  type BackupStatusRecord,
  type UserProfile,
} from '../src/index.js'

const profiles: readonly UserProfile[] = [
  'member',
  'project_manager',
  'people_admin',
  'accounting',
  'executive_manager',
  'administrator',
]

const authentication: ApiAuthentication = {
  sessions: {
    resolve: async (request) => {
      const profile = request.headers.get('x-test-profile') as UserProfile | null
      if (profile === null || !profiles.includes(profile)) return null
      return {
        type: 'user',
        userId: 1,
        profile,
        managerGrants: [],
        authentication: { kind: 'session', sessionId: 'backup-test' },
      }
    },
  },
}

interface BackupStatusResponse {
  data: {
    last_completed: BackupStatusRecord | null
    last_failed: BackupStatusRecord | null
    recent_runs: BackupStatusRecord[]
    has_failure: boolean
  }
}

const completedRun: BackupStatusRecord = {
  id: 1,
  status: 'completed',
  trigger: 'nightly',
  started_at: '2026-09-01T03:00:00.000Z',
  completed_at: '2026-09-01T03:01:30.000Z',
  r2_prefix: 'backups/2026-09-01/',
  table_count: 55,
  total_rows: 1420,
  error_message: null,
}

const failedRun: BackupStatusRecord = {
  id: 2,
  status: 'failed',
  trigger: 'nightly',
  started_at: '2026-09-02T03:00:00.000Z',
  completed_at: '2026-09-02T03:00:05.000Z',
  r2_prefix: null,
  table_count: null,
  total_rows: null,
  error_message: 'D1 connection lost',
}

const cursorSigningKey = new Uint8Array(32).fill(7)

/** A reader over runs in memory that filters, orders and pages as the store does. */
const readerOver = (runs: BackupStatusRecord[]): BackupStatusReader => {
  const matching = (filter: BackupRunFilter) =>
    runs.filter(
      (run) =>
        (filter.status === undefined || run.status === filter.status) &&
        (filter.trigger === undefined || run.trigger === filter.trigger),
    )
  return {
    latestRuns: async () => runs,
    runsSnapshot: async () =>
      runs.length === 0
        ? null
        : runs
            .map((run) => run.started_at)
            .sort()
            .at(-1)!,
    pageRuns: async (window) =>
      matching(window)
        .filter((run) => run.started_at <= window.startedThrough)
        .filter(
          (run) =>
            window.after === null ||
            run.started_at < window.after.startedAt ||
            (run.started_at === window.after.startedAt && run.id < window.after.id),
        )
        .sort((a, b) =>
          a.started_at === b.started_at ? b.id - a.id : a.started_at < b.started_at ? 1 : -1,
        )
        .slice(0, window.take),
    countRuns: async (filter) => matching(filter).length,
  }
}

const createApp = (runs: BackupStatusRecord[]) =>
  createApiApp({
    authentication,
    installApi(api) {
      installBackupStatusRoutes(api, readerOver(runs), { cursorSigningKey })
    },
  })

describe('backup status API', () => {
  it('[api] surfaces a completed nightly backup', async () => {
    const app = createApp([completedRun])
    const response = await app.request('/api/v1/backup/status', {
      headers: { 'x-test-profile': 'administrator' },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as BackupStatusResponse
    expect(body.data.last_completed).toMatchObject({
      id: 1,
      status: 'completed',
      trigger: 'nightly',
      r2_prefix: 'backups/2026-09-01/',
      table_count: 55,
      total_rows: 1420,
    })
    expect(body.data.has_failure).toBe(false)
  })

  it('[api] failed nightly visible in backup status', async () => {
    const app = createApp([failedRun, completedRun])
    const response = await app.request('/api/v1/backup/status', {
      headers: { 'x-test-profile': 'administrator' },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as BackupStatusResponse
    expect(body.data.has_failure).toBe(true)
    expect(body.data.last_failed).toMatchObject({
      id: 2,
      status: 'failed',
      trigger: 'nightly',
      error_message: 'D1 connection lost',
    })
    expect(body.data.last_completed).toMatchObject({
      id: 1,
      status: 'completed',
    })
    expect(body.data.recent_runs).toHaveLength(2)
  })

  it('rejects non-administrator sessions', async () => {
    const app = createApp([])
    const response = await app.request('/api/v1/backup/status', {
      headers: { 'x-test-profile': 'member' },
    })
    expect(response.status).toBe(403)
  })

  it('rejects unauthenticated requests', async () => {
    const app = createApp([])
    const response = await app.request('/api/v1/backup/status')
    expect(response.status).toBe(401)
  })

  it('returns empty state when no backups exist', async () => {
    const app = createApp([])
    const response = await app.request('/api/v1/backup/status', {
      headers: { 'x-test-profile': 'administrator' },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as BackupStatusResponse
    expect(body.data.last_completed).toBeNull()
    expect(body.data.last_failed).toBeNull()
    expect(body.data.recent_runs).toHaveLength(0)
    expect(body.data.has_failure).toBe(false)
  })

  it('[api] pages the run history newest first, with a total, and walks it by cursor', async () => {
    const runs = [1, 2, 3, 4, 5].map((id): BackupStatusRecord => ({
      ...completedRun,
      id,
      trigger: id % 2 === 0 ? 'manual' : 'nightly',
      started_at: `2026-09-0${String(id)}T03:00:00.000Z`,
    }))
    const app = createApp(runs)
    const get = async (path: string) =>
      (
        await app.request(path, { headers: { 'x-test-profile': 'administrator' } })
      ).json() as Promise<{
        data: { id: number }[]
        links: { next: string | null }
        page: { per_page: number; next_cursor: string | null; total: number }
      }>
    const first = await get('/api/v1/backup/runs?per_page=2')
    expect(first.data.map((run) => run.id)).toEqual([5, 4])
    expect(first.page).toMatchObject({ per_page: 2, total: 5 })
    const second = await get(first.links.next!)
    expect(second.data.map((run) => run.id)).toEqual([3, 2])
    const third = await get(second.links.next!)
    expect(third.data.map((run) => run.id)).toEqual([1])
    expect(third.page.next_cursor).toBeNull()

    const manual = await get('/api/v1/backup/runs?trigger=manual&per_page=10')
    expect(manual.data.map((run) => run.id)).toEqual([4, 2])
    expect(manual.page.total).toBe(2)
  })

  it('[api] refuses a cursor from another filter, an unknown filter value and a non-administrator', async () => {
    const app = createApp([completedRun, failedRun])
    const admin = { 'x-test-profile': 'administrator' }
    const first = (await (
      await app.request('/api/v1/backup/runs?per_page=1', { headers: admin })
    ).json()) as { page: { next_cursor: string } }
    const replayed = await app.request(
      `/api/v1/backup/runs?status=failed&per_page=1&cursor=${first.page.next_cursor}`,
      { headers: admin },
    )
    expect(replayed.status).toBe(422)
    expect(
      (await app.request('/api/v1/backup/runs?status=unknown', { headers: admin })).status,
    ).toBe(422)
    expect(
      (await app.request('/api/v1/backup/runs', { headers: { 'x-test-profile': 'accounting' } }))
        .status,
    ).toBe(403)
  })
})

it('[offsite #38] separates L1 from L2 status and requires an administrator session for a real preflight', async () => {
  const check = vi.fn(async () => ({
    verified: true as const,
    checked_at: '2026-10-01T09:00:00.000Z',
  }))
  const app = createApiApp({
    authentication,
    installApi(api) {
      installBackupStatusRoutes(
        api,
        {
          ...readerOver([completedRun]),
          checkOffsite: check,
          offsiteStatus: async () => ({
            configured: true,
            state: 'failed',
            destination: 's3.example.test/backup',
            last_completed: null,
            latest: null,
            error: { code: 'E14', message: 'Check bucket permissions.' },
          }),
        },
        { cursorSigningKey },
      )
    },
  })
  const status = await app.request('/api/v1/backup/status', {
    headers: { origin: 'http://localhost', 'x-test-profile': 'administrator' },
  })
  expect(await status.json()).toMatchObject({
    data: { last_completed: { id: 1 }, offsite: { state: 'failed', error: { code: 'E14' } } },
  })
  expect(check).not.toHaveBeenCalled()
  for (const profile of profiles.filter((value) => value !== 'administrator')) {
    expect(
      (
        await app.request('/api/v1/backup/offsite/check', {
          method: 'POST',
          headers: { origin: 'http://localhost', 'x-test-profile': profile },
        })
      ).status,
    ).toBe(403)
  }
  expect(
    (
      await app.request('/api/v1/backup/offsite/check', {
        method: 'POST',
        headers: { origin: 'http://localhost', authorization: 'Bearer unelevated-token' },
      })
    ).status,
  ).toBe(401)
  expect(check).not.toHaveBeenCalled()
  expect(
    (
      await app.request('/api/v1/backup/offsite/check', {
        method: 'POST',
        headers: {
          origin: 'http://localhost',
          'x-test-profile': 'administrator',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ access_key: 'never-accept-credentials' }),
      })
    ).status,
  ).toBe(422)
  expect(check).not.toHaveBeenCalled()
  const verified = await app.request('/api/v1/backup/offsite/check', {
    method: 'POST',
    headers: { origin: 'http://localhost', 'x-test-profile': 'administrator' },
  })
  expect(verified.status).toBe(200)
  expect(await verified.json()).toMatchObject({ data: { verified: true } })
  expect(check).toHaveBeenCalledOnce()
})
it('[offsite #38] returns actionable E14 destination failures', async () => {
  const app = createApiApp({
    authentication,
    installApi(api) {
      installBackupStatusRoutes(
        api,
        {
          ...readerOver([]),
          checkOffsite: async () => {
            throw Object.assign(new Error('Check backup bucket read/write permissions.'), {
              code: 'E14',
            })
          },
        },
        { cursorSigningKey },
      )
    },
  })
  const response = await app.request('/api/v1/backup/offsite/check', {
    method: 'POST',
    headers: { origin: 'http://localhost', 'x-test-profile': 'administrator' },
  })
  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({
    error: { code: 'offsite_backup_unavailable', message: 'E14: Check backup bucket read/write permissions.' },
  })
})
