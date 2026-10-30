import { expect, it, vi } from 'vitest'
import { createApiApp } from '../src/app.js'
import { installMigrationLoadRoutes } from '../src/migration-loads.js'
import type { MigrationLoadStatus } from '@ezacto/core'
const id = '00000000-0000-4000-8000-000000000001',
  now = '2026-10-22T09:00:00.000Z'
const record: MigrationLoadStatus = {
  id,
  status: 'failed',
  snapshotSha256: '1'.repeat(64),
  sourceRows: 200,
  resource: 'time_entries',
  rowsDone: 125,
  sequence: 4,
  attempts: 5,
  errorCode: 'migration_snapshot_changed',
  createdAt: now,
  startedAt: now,
  completedAt: null,
  sourceCleanedAt: null,
  updatedAt: now,
}
const setup = () => {
  const read = vi.fn(async (runId: string) =>
    runId === id
      ? {
          ...record,
          catalog: { credential: 'must-never-be-returned' },
          options: { organizationAddress: 'private address' },
        }
      : null,
  )
  const app = createApiApp({
    authentication: {
      tokens: {
        authenticate: async () => ({ tokenId: 1, userId: 1, profile: 'administrator', scopes: [] }),
        issue: async () => {
          throw new Error('unused')
        },
        list: async () => [],
        revoke: async () => null,
      },
      sessions: {
        resolve: async (request) => {
          const role = request.headers.get('x-role')
          if (!role) return null
          if (role === 'contact')
            return {
              type: 'contact',
              contactId: 1,
              clientId: 1,
              authentication: { kind: 'session', sessionId: 'fixture' },
            }
          return {
            type: 'user',
            userId: 1,
            profile: role === 'administrator' ? 'administrator' : 'member',
            authentication: { kind: 'session', sessionId: 'fixture' },
          }
        },
      },
    },
    installApi: (api) => installMigrationLoadRoutes(api, { status: read }),
  })
  return { app, read }
}
it('returns safe aggregate progress and error codes to administrator sessions only', async () => {
  const { app, read } = setup()
  for (const role of [undefined, 'member', 'contact']) {
    const response = await app.request('/api/v1/migration-loads/' + id, {
      headers: role ? { 'x-role': role } : {},
    })
    expect(response.status).toBe(role ? 403 : 401)
  }
  const response = await app.request('/api/v1/migration-loads/' + id, {
    headers: { 'x-role': 'administrator' },
  })
  expect(response.status).toBe(200)
  const text = await response.text()
  expect(JSON.parse(text).data).toMatchObject({
    resource: 'time_entries',
    rows_done: 125,
    error_code: 'migration_snapshot_changed',
  })
  for (const forbidden of ['catalog', 'options', 'credential', 'private address', 'must-never'])
    expect(text).not.toContain(forbidden)
  expect(read).toHaveBeenCalledTimes(1)
  expect(response.headers.get('cache-control')).toBe('no-store')
})
it('validates the UUID and distinguishes an unknown run without reflecting arbitrary input', async () => {
  const { app } = setup(),
    headers = { 'x-role': 'administrator' }
  const bad = await app.request('/api/v1/migration-loads/arbitrary-value', { headers })
  expect(bad.status).toBe(422)
  expect(((await bad.json()) as { error: { fields: unknown[] } }).error.fields).toHaveLength(1)
  expect(
    (await app.request('/api/v1/migration-loads/00000000-0000-4000-8000-000000000002', { headers }))
      .status,
  ).toBe(404)
})
it('does not accept a bearer token in place of an administrator browser session', async () => {
  const { app, read } = setup()
  const response = await app.request('/api/v1/migration-loads/' + id, {
    headers: { authorization: 'Bearer fixture-token' },
  })
  expect(response.status).toBe(403)
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
    'session_required',
  )
  expect(read).not.toHaveBeenCalled()
})
