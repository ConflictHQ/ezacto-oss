import BetterSqlite3 from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../../db/src/adapters.js'
import { migrateContainer } from '../../db/src/migrate.js'
import { DrizzleWorkItemRepository } from '../../db/src/work-items.js'
import type { ActivityCaptureRequest } from '../src/activity-log.js'
import { createApiApp } from '../src/app.js'
import type { ApiAuthentication } from '../src/auth.js'
import type { UserProfile } from '../src/context.js'
import { installWorkItemRoutes } from '../src/work-items.js'

/**
 * Issue 1008, slice 1, over HTTP on a real migrated database. The store's rules
 * are tested beside it; this is what the routes add: connecting is for
 * administrators in a session and is audited, a request cannot name or read a
 * credential, and the status codes say what went wrong.
 */

const t0 = '2026-10-01T12:00:00.000Z'
const secretName = 'GITHUB_WORK_ITEMS_CREDENTIAL'

const authentication: ApiAuthentication = {
  ownMoneyVisible: async () => false,
  tokens: {
    authenticate: async (token) =>
      token === 'read-only'
        ? { tokenId: 1, userId: 1, profile: 'member', scopes: ['time_entries:read'] }
        : token === 'admin-token'
          ? {
              tokenId: 2,
              userId: 10,
              profile: 'administrator',
              scopes: ['time_entries:read', 'time_entries:write'],
            }
          : null,
    issue: async () => {
      throw new Error('Not used by this harness')
    },
    list: async () => [],
    revoke: async () => null,
  },
  sessions: {
    resolve: async (request) => {
      if (request.headers.get('x-test-user-id') === null) return null
      return {
        type: 'user',
        userId: Number(request.headers.get('x-test-user-id')),
        profile: (request.headers.get('x-test-profile') ?? 'member') as UserProfile,
        managerGrants: [],
        authentication: { kind: 'session', sessionId: 'work-item-test' },
      }
    },
  },
}

const ada = { 'x-test-user-id': '10', 'x-test-profile': 'administrator' }
const maya = { 'x-test-user-id': '1' }
const milo = { 'x-test-user-id': '2' }
const json = { 'content-type': 'application/json' }

const harness = (options: { configured?: boolean } = {}) => {
  const sqlite = new BetterSqlite3(':memory:')
  migrateContainer(sqlite)
  const run = (sql: string, ...params: unknown[]) => sqlite.prepare(sql).run(...params)
  run(
    `INSERT INTO organizations (name, modules, time_entry_mode, created_at, updated_at)
     VALUES ('Fictional Studio', '{}', 'duration', ?, ?)`,
    t0,
    t0,
  )
  run(
    `INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at) VALUES
      (1, 'Maya', 'Member', 'member', '[]', ?, ?),
      (2, 'Milo', 'Member', 'member', '[]', ?, ?),
      (10, 'Ada', 'Admin', 'administrator', '[]', ?, ?)`,
    t0, t0, t0, t0, t0, t0,
  )
  run(`INSERT INTO clients (id, name, currency, created_at, updated_at) VALUES (1, 'Client', 'USD', ?, ?)`, t0, t0)
  run(
    `INSERT INTO projects (id, client_id, name, bill_by, created_at, updated_at)
     VALUES (1, 1, 'Project', 'people', ?, ?)`,
    t0,
    t0,
  )
  run(`INSERT INTO tasks (id, name, created_at, updated_at) VALUES (1, 'Task', ?, ?)`, t0, t0)
  run(
    `INSERT INTO user_assignments (id, project_id, user_id, created_at, updated_at)
     VALUES (1, 1, 1, ?, ?), (2, 1, 2, ?, ?)`,
    t0, t0, t0, t0,
  )
  run(
    `INSERT INTO task_assignments (id, project_id, task_id, billable, created_at, updated_at)
     VALUES (1, 1, 1, 1, ?, ?)`,
    t0,
    t0,
  )
  for (const [id, userId] of [[1, 1], [2, 2]] as const) {
    run(
      `INSERT INTO time_entries (id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
         spent_date, seconds, seconds_without_timer, rounded_seconds, billable, created_at, updated_at)
       VALUES (?, ?, 1, 1, ?, 1, '2026-10-01', 3600, 3600, 3600, 1, ?, ?)`,
      id, userId, id, t0, t0,
    )
  }
  const recorded: ActivityCaptureRequest[] = []
  const state = { configured: options.configured ?? true }
  const app = createApiApp({
    authentication,
    installApi: (api) => {
      installWorkItemRoutes(api, {
        repository: new DrizzleWorkItemRepository(createContainerDatabase(sqlite)),
        credentialConfigured: () => state.configured,
        clock: () => '2026-10-02T09:00:00.000Z',
        cursorSigningKey: new TextEncoder().encode('work-item-cursor-key-32-bytes!!!!'),
        activity: { capture: async (request) => void recorded.push(request) },
      })
    },
  })
  return {
    sqlite,
    recorded,
    state,
    request: (path: string, init: RequestInit & { as?: Record<string, string> } = {}) => {
      const { as, ...rest } = init
      const headers = new Headers(rest.headers)
      headers.set('origin', 'http://localhost')
      for (const [key, value] of Object.entries(as ?? {})) headers.set(key, value)
      return app.request(path, { ...rest, headers })
    },
  }
}

type Harness = ReturnType<typeof harness>

const post = (h: Harness, path: string, body: unknown, as: Record<string, string> = ada) =>
  h.request(path, { method: 'POST', body: JSON.stringify(body), headers: json, as })

const connect = async (h: Harness): Promise<number> => {
  const response = await post(h, '/api/v1/settings/work-item-connections', { provider: 'github' })
  expect(response.status).toBe(201)
  return ((await response.json()) as { data: { id: number } }).data.id
}

describe('work item connections', () => {
  it('[unit] lets an administrator connect, records it, and never returns the credential', async () => {
    const h = harness()
    const response = await post(h, '/api/v1/settings/work-item-connections', { provider: 'github' })
    expect(response.status).toBe(201)
    const text = await response.text()
    expect(JSON.parse(text).data).toEqual({
      id: 1,
      provider: 'github',
      status: 'active',
      owner_user_id: 10,
      credential_configured: true,
      connected_at: '2026-10-02T09:00:00.000Z',
      disconnected_at: null,
      created_at: '2026-10-02T09:00:00.000Z',
      updated_at: '2026-10-02T09:00:00.000Z',
    })
    expect(text).not.toContain(secretName)
    const list = await h.request('/api/v1/settings/work-item-connections', { as: ada })
    expect(list.status).toBe(200)
    const listText = await list.text()
    expect(JSON.parse(listText).data).toHaveLength(1)
    expect(listText).not.toContain(secretName)
    expect(listText).not.toContain('credential_ref')
    expect(h.recorded).toMatchObject([
      {
        eventType: 'work_item_connection.connected',
        subjectId: 1,
        actor: { type: 'user', id: 10 },
        detail: { provider: 'github' },
      },
    ])
  })

  it('[security] is for administrators in a session: members, tokens and the signed-out are refused', async () => {
    const h = harness()
    const path = '/api/v1/settings/work-item-connections'
    expect((await post(h, path, { provider: 'github' }, maya)).status).toBe(403)
    expect((await h.request(path, { as: maya })).status).toBe(403)
    const token = await h.request(path, {
      method: 'POST',
      body: JSON.stringify({ provider: 'github' }),
      headers: { ...json, authorization: 'Bearer admin-token' },
    })
    expect(token.status).toBe(403)
    expect(((await token.json()) as { error: { code: string } }).error.code).toBe('session_required')
    expect((await h.request(path)).status).toBe(401)
    expect((await post(h, `${path}/1/disconnect`, {}, maya)).status).toBe(403)
    expect(h.recorded).toEqual([])
    expect(h.sqlite.prepare('SELECT id FROM work_item_connections').all()).toEqual([])
  })

  it('[unit] refuses to connect without a deployment credential, and refuses a request that names its own', async () => {
    const h = harness({ configured: false })
    const path = '/api/v1/settings/work-item-connections'
    const refused = await post(h, path, { provider: 'github' })
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      'credential_not_configured',
    )
    h.state.configured = true
    for (const body of [
      { provider: 'github', credential_ref: 'SESSION_KEY' },
      { provider: 'github', token: 'ghp_x' },
      { provider: 'svn' },
      {},
    ]) {
      expect((await post(h, path, body)).status).toBe(422)
    }
    expect(h.sqlite.prepare('SELECT id FROM work_item_connections').all()).toEqual([])
  })

  it('[unit] disconnects, records it, keeps the links, and reports the credential as not configured', async () => {
    const h = harness()
    const id = await connect(h)
    const link = await post(h, '/api/v1/work-item-links', { connection_id: id, time_entry_id: 1, item_id: 'o/r#1' }, maya)
    expect(link.status).toBe(201)
    const response = await post(h, `/api/v1/settings/work-item-connections/${id}/disconnect`, {})
    expect(response.status).toBe(200)
    expect(((await response.json()) as { data: unknown }).data).toMatchObject({
      status: 'disconnected',
      credential_configured: false,
      disconnected_at: '2026-10-02T09:00:00.000Z',
    })
    expect(h.recorded.map((event) => event.eventType)).toEqual([
      'work_item_connection.connected',
      'work_item_connection.disconnected',
    ])
    expect(h.sqlite.prepare('SELECT credential_ref FROM work_item_connections').all()).toEqual([
      { credential_ref: null },
    ])
    const links = await h.request('/api/v1/work-item-links', { as: ada })
    expect(((await links.json()) as { data: unknown[] }).data).toHaveLength(1)
    expect((await post(h, '/api/v1/settings/work-item-connections/99/disconnect', {})).status).toBe(404)
  })
})

describe('work item links', () => {
  it('[unit] links a person\'s own entry and answers the link back', async () => {
    const h = harness()
    const id = await connect(h)
    const created = await post(
      h,
      '/api/v1/work-item-links',
      { connection_id: id, time_entry_id: 1, item_id: 'o/r#12', url: 'https://github.com/o/r/issues/12' },
      maya,
    )
    expect(created.status).toBe(201)
    expect(created.headers.get('location')).toBe('/api/v1/work-item-links/1')
    expect(((await created.json()) as { data: unknown }).data).toEqual({
      id: 1,
      connection_id: id,
      provider: 'github',
      time_entry_id: 1,
      project_id: null,
      item_id: 'o/r#12',
      url: 'https://github.com/o/r/issues/12',
      created_by: 1,
      created_at: '2026-10-02T09:00:00.000Z',
      updated_at: '2026-10-02T09:00:00.000Z',
    })
    const one = await h.request('/api/v1/work-item-links/1', { as: maya })
    expect(one.status).toBe(200)
    const filtered = await h.request('/api/v1/work-item-links?item_id=o/r%2312&time_entry_id=1', { as: maya })
    expect(((await filtered.json()) as { data: unknown[] }).data).toHaveLength(1)
  })

  it('[security] keeps links to their owner: another member sees none, and an administrator sees all', async () => {
    const h = harness()
    const id = await connect(h)
    await post(h, '/api/v1/work-item-links', { connection_id: id, time_entry_id: 1, item_id: 'o/r#1' }, maya)
    const foreign = await post(h, '/api/v1/work-item-links', { connection_id: id, time_entry_id: 1, item_id: 'o/r#1' }, milo)
    expect(foreign.status).toBe(404)
    expect((await h.request('/api/v1/work-item-links/1', { as: milo })).status).toBe(404)
    expect((await h.request('/api/v1/work-item-links/1', { as: milo, method: 'DELETE' })).status).toBe(404)
    const milos = await h.request('/api/v1/work-item-links', { as: milo })
    expect(((await milos.json()) as { data: unknown[] }).data).toEqual([])
    const adas = await h.request('/api/v1/work-item-links', { as: ada })
    expect(((await adas.json()) as { data: unknown[] }).data).toHaveLength(1)
    // Only an administrator links a project.
    const project = { connection_id: id, project_id: 1, item_id: 'o/r#1' }
    expect((await post(h, '/api/v1/work-item-links', project, maya)).status).toBe(404)
    expect((await post(h, '/api/v1/work-item-links', project, ada)).status).toBe(201)
  })

  it('[security] enforces token scopes: reading needs time_entries:read, writing needs time_entries:write', async () => {
    const h = harness()
    const id = await connect(h)
    const body = JSON.stringify({ connection_id: id, time_entry_id: 1, item_id: 'o/r#1' })
    const readOnly = { authorization: 'Bearer read-only' }
    expect((await h.request('/api/v1/work-item-links', { headers: readOnly })).status).toBe(200)
    const write = await h.request('/api/v1/work-item-links', {
      method: 'POST',
      body,
      headers: { ...json, ...readOnly },
    })
    expect(write.status).toBe(403)
    const allowed = await h.request('/api/v1/work-item-links', {
      method: 'POST',
      body,
      headers: { ...json, authorization: 'Bearer admin-token' },
    })
    expect(allowed.status).toBe(201)
  })

  it('[unit] reports duplicate, inactive and malformed links with distinct statuses', async () => {
    const h = harness()
    const id = await connect(h)
    const link = { connection_id: id, time_entry_id: 1, item_id: 'o/r#1' }
    expect((await post(h, '/api/v1/work-item-links', link, maya)).status).toBe(201)
    const again = await post(h, '/api/v1/work-item-links', { ...link, item_id: 'o/r#2' }, maya)
    expect(again.status).toBe(409)
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe('work_item_link_exists')
    for (const body of [
      { connection_id: id, item_id: 'o/r#1' },
      { connection_id: id, time_entry_id: 1, project_id: 1, item_id: 'o/r#1' },
      { connection_id: id, time_entry_id: 2, item_id: 'two words' },
      { connection_id: id, time_entry_id: 2, item_id: 'x', url: 'ftp://example.test/x' },
      { connection_id: id, time_entry_id: 2, item_id: 'x', provider: 'github' },
      { time_entry_id: 2, item_id: 'x' },
    ]) {
      expect((await post(h, '/api/v1/work-item-links', body, milo)).status).toBe(422)
    }
    await post(h, `/api/v1/settings/work-item-connections/${id}/disconnect`, {})
    const inactive = await post(h, '/api/v1/work-item-links', { ...link, time_entry_id: 2 }, milo)
    expect(inactive.status).toBe(409)
    expect(((await inactive.json()) as { error: { code: string } }).error.code).toBe(
      'work_item_connection_inactive',
    )
    expect((await post(h, '/api/v1/work-item-links', { ...link, connection_id: 99, time_entry_id: 2 }, milo)).status).toBe(404)
  })

  it('[unit] deletes a link', async () => {
    const h = harness()
    const id = await connect(h)
    await post(h, '/api/v1/work-item-links', { connection_id: id, time_entry_id: 1, item_id: 'o/r#1' }, maya)
    expect((await h.request('/api/v1/work-item-links/1', { as: maya, method: 'DELETE' })).status).toBe(204)
    expect((await h.request('/api/v1/work-item-links/1', { as: maya })).status).toBe(404)
  })
})
