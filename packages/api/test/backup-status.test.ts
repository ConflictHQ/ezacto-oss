import { describe, expect, it } from 'vitest'
import {
  createApiApp,
  installBackupStatusRoutes,
  type ApiAuthentication,
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

const createApp = (runs: BackupStatusRecord[]) => {
  const reader: BackupStatusReader = {
    latestRuns: async () => runs,
  }
  return createApiApp({
    authentication,
    installApi(api) {
      installBackupStatusRoutes(api, reader)
    },
  })
}

describe('backup status API', () => {
  it('[api] surfaces a completed nightly backup', async () => {
    const app = createApp([completedRun])
    const response = await app.request('/api/v1/backup/status', {
      headers: { 'x-test-profile': 'administrator' },
    })

    expect(response.status).toBe(200)
    const body = await response.json()
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
    const body = await response.json()
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
    const body = await response.json()
    expect(body.data.last_completed).toBeNull()
    expect(body.data.last_failed).toBeNull()
    expect(body.data.recent_runs).toHaveLength(0)
    expect(body.data.has_failure).toBe(false)
  })
})
