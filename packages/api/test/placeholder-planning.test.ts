import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../../db/src/adapters.js'
import { createPlaceholderAllocationRepository } from '../../db/src/placeholder-allocations.js'
import { migrateContainer } from '../../db/src/migrate.js'
import { createApiApp } from '../src/app.js'
import type { ApiAuthentication } from '../src/auth.js'
import type { UserProfile } from '../src/context.js'
import { installPlaceholderPlanningRoutes } from '../src/resources/placeholder-allocations.js'

const t0 = '2026-10-05T12:00:00.000Z'

const authentication: ApiAuthentication = {
  ownMoneyVisible: async () => false,
  tokens: {
    authenticate: async (token) =>
      token === 'read-only'
        ? {
            tokenId: 1,
            userId: 10,
            profile: 'administrator',
            scopes: ['schedule:read'],
          }
        : null,
    issue: async () => {
      throw new Error('Not used by this harness')
    },
    list: async () => [],
    revoke: async () => null,
  },
  sessions: {
    resolve: async (request) => ({
      type: 'user',
      userId: Number(request.headers.get('x-test-user-id') ?? '1'),
      profile: (request.headers.get('x-test-profile') ??
        'member') as UserProfile,
      managerGrants: [],
      authentication: { kind: 'session', sessionId: 'allocation-test' },
    }),
  },
}

interface Harness {
  sqlite: BetterSqlite3.Database
  request(path: string, init?: RequestInit): Promise<Response>
}

const harness = (instant = '2026-10-06T09:00:00.000Z'): Harness => {
  const sqlite = new BetterSqlite3(':memory:')
  migrateContainer(sqlite)
  const run = (sql: string, ...params: unknown[]) =>
    sqlite.prepare(sql).run(...params)
  run(
    `INSERT INTO organizations (name, week_start_day, modules, created_at, updated_at)
     VALUES ('Fictional Studio', 'monday', '{}', ?, ?)`,
    t0,
    t0,
  )
  run(
    `INSERT INTO users (id, first_name, last_name, profile, manager_grants, weekly_capacity, created_at, updated_at) VALUES
      (10, 'Ada', 'Admin', 'administrator', '[]', 126000, ?, ?),
      (2, 'Pia', 'Manager', 'project_manager', '[]', 126000, ?, ?),
      (1, 'Maya', 'Member', 'member', '[]', 72000, ?, ?),
      (6, 'Milo', 'Member', 'member', '[]', 126000, ?, ?)`,
    ...Array(8).fill(t0),
  )
  run(
    `INSERT INTO clients (id, name, currency, created_at, updated_at) VALUES (1, 'Client', 'USD', ?, ?)`,
    t0,
    t0,
  )
  run(
    `INSERT INTO projects (id, client_id, name, bill_by, created_at, updated_at)
     VALUES (1, 1, 'Alpha', 'people', ?, ?), (2, 1, 'Beta', 'people', ?, ?)`,
    ...Array(4).fill(t0),
  )
  run(
    `INSERT INTO user_assignments (id, project_id, user_id, is_project_manager, created_at, updated_at)
     VALUES (1, 1, 2, 1, ?, ?), (2, 1, 1, 0, ?, ?)`,
    ...Array(4).fill(t0),
  )
  const orm = createContainerDatabase(sqlite)
  const app = createApiApp({
    authentication,
    installApi: (api) => {
      installPlaceholderPlanningRoutes(
        api,
        createPlaceholderAllocationRepository(orm),
        {
          clock: () => instant,
          cursorSigningKey: new TextEncoder().encode(
            'placeholder-cursor-key-32-bytes!!',
          ),
        },
      )
    },
  })
  return {
    sqlite,
    request: async (path, init) => {
      const headers = new Headers(init?.headers)
      headers.set('origin', 'http://localhost')
      return app.request(path, { ...init, headers })
    },
  }
}

const as = (
  userId: number,
  profile: UserProfile = 'member',
): Record<string, string> => ({
  'x-test-user-id': String(userId),
  'x-test-profile': profile,
})
const admin = as(10, 'administrator')
const pia = as(2, 'project_manager')
const maya = as(1)

const send = (
  method: string,
  headers: Record<string, string>,
  body?: Record<string, unknown>,
): RequestInit => ({
  method,
  headers: { ...headers, 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

const plan = {
  placeholder_id: 1,
  project_id: 1,
  start_date: '2026-10-05',
  end_date: '2026-10-25',
  planned_seconds_per_week: 3600,
}
describe('native placeholder planning HTTP', () => {
  let current: Harness | undefined
  afterEach(() => current?.sqlite.close())
  const setup = () => (current = harness())
  const seed = async (h: Harness) => {
    expect(
      (
        await h.request(
          '/api/v1/planning-placeholders',
          send('POST', admin, { name: 'Engineer' }),
        )
      ).status,
    ).toBe(201)
    expect(
      (
        await h.request(
          '/api/v1/placeholder-allocations',
          send('POST', admin, plan),
        )
      ).status,
    ).toBe(201)
  }
  it('uses canonical numeric DTOs, mandatory versions and exact durable assignment replay', async () => {
    const h = setup()
    await seed(h)
    const list = await h.request('/api/v1/placeholder-allocations', {
      headers: admin,
    })
    expect(list.status).toBe(200)
    expect(list.headers.get('cache-control')).toBe('no-store')
    expect(await list.json()).toMatchObject({
      data: [
        {
          id: 1,
          placeholder_id: 1,
          name: 'Engineer',
          project_name: 'Alpha',
          version: 0,
          state: 'open',
        },
      ],
      page: { next_cursor: null },
    })
    expect(
      (
        await h.request(
          '/api/v1/placeholder-allocations/1',
          send('PATCH', admin, { planned_seconds_per_week: 7200 }),
        )
      ).status,
    ).toBe(422)
    expect(
      (
        await h.request(
          '/api/v1/placeholder-allocations/1',
          send('PATCH', admin, { version: 0, planned_seconds_per_week: 7200 }),
        )
      ).status,
    ).toBe(200)
    expect(
      (
        await h.request(
          '/api/v1/placeholder-allocations/1',
          send('PATCH', admin, { version: 0, planned_seconds_per_week: 9000 }),
        )
      ).status,
    ).toBe(409)
    const command = {
      version: 1,
      user_id: 1,
      idempotency_key: 'owned-assignment',
    }
    const response = await h.request(
      '/api/v1/placeholder-allocations/1/assign',
      send('POST', admin, command),
    )
    expect(response.status).toBe(200)
    const first = await response.json()
    expect(first).toMatchObject({
      data: {
        allocation: {
          id: 1,
          version: 0,
          user_id: 1,
          planned_seconds_per_week: 7200,
        },
        placeholder: { state: 'assigned', version: 2 },
        warnings: [],
        prerequisites: [],
      },
    })
    expect(
      (
        await h.request(
          '/api/v1/planning-placeholders/1',
          send('PATCH', admin, { version: 0, name: 'Renamed later' }),
        )
      ).status,
    ).toBe(200)
    const replay = await h.request(
      '/api/v1/placeholder-allocations/1/assign',
      send('POST', admin, command),
    )
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual(first)
    expect(
      h.sqlite.prepare('SELECT count(*) AS n FROM allocations').get(),
    ).toEqual({ n: 1 })
    expect(
      h.sqlite
        .prepare('SELECT count(*) AS n FROM placeholder_assignment_keys')
        .get(),
    ).toEqual({ n: 1 })
  })
  it('enforces token scope, management profile and current native role, including on replay', async () => {
    const h = setup()
    await seed(h)
    expect(
      (
        await h.request('/api/v1/planning-placeholders', {
          headers: { authorization: 'Bearer read-only' },
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await h.request(
          '/api/v1/planning-placeholders',
          send(
            'POST',
            { authorization: 'Bearer read-only' },
            { name: 'Denied' },
          ),
        )
      ).status,
    ).toBe(403)
    expect(
      (await h.request('/api/v1/placeholder-allocations', { headers: maya }))
        .status,
    ).toBe(403)
    expect(
      (
        await h.request(
          '/api/v1/placeholder-allocations/1/assign',
          send('POST', pia, {
            version: 0,
            user_id: 6,
            idempotency_key: 'private-person',
          }),
        )
      ).status,
    ).toBe(422)
    expect(
      (
        await h.request(
          '/api/v1/placeholder-allocations/1/assign',
          send('POST', pia, {
            version: 0,
            user_id: 1,
            idempotency_key: 'manager',
          }),
        )
      ).status,
    ).toBe(200)
    h.sqlite.prepare("UPDATE users SET profile='member' WHERE id=2").run()
    expect(
      (
        await h.request(
          '/api/v1/placeholder-allocations/1/assign',
          send('POST', pia, {
            version: 0,
            user_id: 6,
            idempotency_key: 'manager',
          }),
        )
      ).status,
    ).toBe(403)
    expect(
      h.sqlite.prepare('SELECT count(*) AS n FROM allocations').get(),
    ).toEqual({ n: 1 })
  })
  it('paginates without dropping definitions or leaking them across current project scopes', async () => {
    const h = setup()
    await seed(h)
    for (const name of ['Second', 'Third'])
      expect(
        (
          await h.request(
            '/api/v1/planning-placeholders',
            send('POST', admin, { name }),
          )
        ).status,
      ).toBe(201)
    const page = (await (
      await h.request('/api/v1/planning-placeholders?per_page=1', {
        headers: admin,
      })
    ).json()) as {
      data: { id: number }[]
      page: { next_cursor: string | null }
    }
    expect(page.data.map((x) => x.id)).toEqual([1])
    expect(page.page.next_cursor).toBeTypeOf('string')
    const next = await h.request(
      '/api/v1/planning-placeholders?per_page=1&cursor=' +
        encodeURIComponent(page.page.next_cursor!),
      { headers: admin },
    )
    expect(next.status).toBe(200)
    expect(await next.json()).toMatchObject({ data: [{ id: 2 }] })
    const pm = await (
      await h.request('/api/v1/planning-placeholders', { headers: pia })
    ).json()
    expect(pm).toMatchObject({ data: [{ id: 1 }], page: { next_cursor: null } })
    expect(
      (
        await h.request(
          '/api/v1/placeholder-allocations',
          send('POST', pia, { ...plan, placeholder_id: 2 }),
        )
      ).status,
    ).toBe(404)
  })
})
