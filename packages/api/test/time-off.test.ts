import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../../db/src/adapters.js'
import { DrizzleAllocationRepository } from '../../db/src/allocations.js'
import { migrateContainer } from '../../db/src/migrate.js'
import { createApiApp } from '../src/app.js'
import type { ApiAuthentication } from '../src/auth.js'
import type { UserProfile } from '../src/context.js'
import { installAllocationRoutes } from '../src/resources/index.js'

/**
 * Issue 1007, slice 3, over HTTP on a real migrated database: administrator-entered
 * time off, who may write and who reads only their own, a refusal as the right
 * status, and the capacity view subtracting it without refusing a plan.
 */

const t0 = '2026-10-05T12:00:00.000Z'
const hours = (count: number) => count * 3_600

const authentication: ApiAuthentication = {
  ownMoneyVisible: async () => false,
  tokens: {
    authenticate: async (token) =>
      token === 'read-only'
        ? { tokenId: 1, userId: 10, profile: 'administrator', scopes: ['schedule:read'] }
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
      profile: (request.headers.get('x-test-profile') ?? 'member') as UserProfile,
      managerGrants: [],
      authentication: { kind: 'session', sessionId: 'time-off-test' },
    }),
  },
}

interface Harness {
  sqlite: BetterSqlite3.Database
  request(path: string, init?: RequestInit): Promise<Response>
}

const harness = (): Harness => {
  const sqlite = new BetterSqlite3(':memory:')
  migrateContainer(sqlite)
  const run = (sql: string, ...params: unknown[]) => sqlite.prepare(sql).run(...params)
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
  run(`INSERT INTO clients (id, name, currency, created_at, updated_at) VALUES (1, 'Client', 'USD', ?, ?)`, t0, t0)
  run(
    `INSERT INTO projects (id, client_id, name, bill_by, created_at, updated_at)
     VALUES (1, 1, 'Alpha', 'people', ?, ?)`,
    t0,
    t0,
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
      installAllocationRoutes(api, {
        repository: new DrizzleAllocationRepository(orm),
        clock: {
          now: () => ({ instant: '2026-10-06T09:00:00.000Z', date: '2026-10-06', time: '09:00' }),
        },
        cursorSigningKey: new TextEncoder().encode('time-off-cursor-key-32-bytes!!!!'),
      })
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

const as = (userId: number, profile: UserProfile = 'member'): Record<string, string> => ({
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

const away = (overrides: Record<string, unknown> = {}) => ({
  user_id: 1,
  start_date: '2026-10-12',
  end_date: '2026-10-14',
  kind: 'vacation',
  ...overrides,
})

interface TimeOffBody {
  id: number
  user_id: number
  start_date: string
  end_date: string
  kind: string
  seconds_per_day: number | null
}

describe('time off routes (issue 1007)', () => {
  let current: Harness | null = null
  afterEach(() => {
    current?.sqlite.close()
    current = null
  })
  const setup = () => (current = harness())

  it('[api] an administrator enters, reads, updates and removes time off', async () => {
    const h = setup()
    const created = await h.request('/api/v1/time-off', send('POST', admin, away()))
    expect(created.status).toBe(201)
    const { data } = (await created.json()) as { data: TimeOffBody }
    expect(data).toMatchObject({ user_id: 1, kind: 'vacation', seconds_per_day: null })
    expect(created.headers.get('location')).toBe(`/api/v1/time-off/${data.id}`)

    const patched = await h.request(
      `/api/v1/time-off/${data.id}`,
      send('PATCH', admin, { kind: 'sick', seconds_per_day: hours(4) }),
    )
    expect(patched.status).toBe(200)
    expect(((await patched.json()) as { data: TimeOffBody }).data).toMatchObject({
      kind: 'sick',
      seconds_per_day: hours(4),
    })
    // null goes back to a whole day.
    const whole = await h.request(
      `/api/v1/time-off/${data.id}`,
      send('PATCH', admin, { seconds_per_day: null }),
    )
    expect(((await whole.json()) as { data: TimeOffBody }).data.seconds_per_day).toBeNull()

    const listed = (await (await h.request('/api/v1/time-off?user_id=1', { headers: admin })).json()) as {
      data: TimeOffBody[]
    }
    expect(listed.data.map((row) => row.id)).toEqual([data.id])

    expect((await h.request(`/api/v1/time-off/${data.id}`, send('DELETE', admin))).status).toBe(200)
    expect((await h.request(`/api/v1/time-off/${data.id}`, { headers: admin })).status).toBe(404)
    expect(
      h.sqlite.prepare("SELECT event_type FROM event_outbox WHERE aggregate_type = 'time_off' ORDER BY rowid").all(),
    ).toEqual([
      { event_type: 'time_off.created' },
      { event_type: 'time_off.updated' },
      { event_type: 'time_off.updated' },
      { event_type: 'time_off.deleted' },
    ])
    expect(h.sqlite.prepare('SELECT count(*) AS n FROM time_entries').get()).toEqual({ n: 0 })
  })

  it('[api] answers bad time off with the right status', async () => {
    const h = setup()
    const status = async (body: Record<string, unknown>) =>
      (await h.request('/api/v1/time-off', send('POST', admin, body))).status
    expect(await status(away({ end_date: '2026-10-11' }))).toBe(422)
    expect(await status(away({ kind: 'sabbatical' }))).toBe(422)
    expect(await status(away({ seconds_per_day: 0 }))).toBe(422)
    expect(await status(away({ seconds_per_day: 1.5 }))).toBe(422)
    expect(await status(away({ start_date: '2026-13-01' }))).toBe(422)
    expect(await status(away({ user_id: 99 }))).toBe(422)
    expect(await status(away({ surprise: 1 }))).toBe(422)
    expect(await status({ user_id: 1 })).toBe(422)
    expect(await status(away())).toBe(201)
    expect(await status(away({ start_date: '2026-10-14', end_date: '2026-10-20' }))).toBe(409)
  })

  it('[api] a member reads only their own time off and cannot write', async () => {
    const h = setup()
    const own = (await (await h.request('/api/v1/time-off', send('POST', admin, away()))).json()) as {
      data: TimeOffBody
    }
    const other = (await (
      await h.request('/api/v1/time-off', send('POST', admin, away({ user_id: 6 })))
    ).json()) as { data: TimeOffBody }
    const listed = (await (await h.request('/api/v1/time-off', { headers: maya })).json()) as {
      data: TimeOffBody[]
    }
    expect(listed.data.map((row) => row.id)).toEqual([own.data.id])
    expect((await h.request(`/api/v1/time-off/${other.data.id}`, { headers: maya })).status).toBe(404)
    for (const attempt of [
      h.request('/api/v1/time-off', send('POST', maya, away())),
      h.request(`/api/v1/time-off/${own.data.id}`, send('PATCH', maya, { kind: 'sick' })),
      h.request(`/api/v1/time-off/${own.data.id}`, send('DELETE', maya)),
    ]) {
      expect((await attempt).status).toBe(403)
    }
  })

  it('[api] a project manager enters time off only for the people they manage', async () => {
    const h = setup()
    expect((await h.request('/api/v1/time-off', send('POST', pia, away()))).status).toBe(201)
    expect((await h.request('/api/v1/time-off', send('POST', pia, away({ user_id: 6 })))).status).toBe(422)
  })

  it('[api] a token needs the schedule scope', async () => {
    const h = setup()
    const reader = { authorization: 'Bearer read-only' }
    expect((await h.request('/api/v1/time-off', { headers: reader })).status).toBe(200)
    expect((await h.request('/api/v1/time-off', send('POST', reader, away()))).status).toBe(403)
  })

  it('[api] the capacity view subtracts time off and still only flags an over-plan', async () => {
    const h = setup()
    // Maya's week is 20 hours; Mon-Wed off removes 12, leaving 8 for the week of 12 Oct.
    await h.request('/api/v1/time-off', send('POST', admin, away()))
    const planned = await h.request(
      '/api/v1/allocations',
      send('POST', admin, {
        user_id: 1,
        project_id: 1,
        start_date: '2026-10-05',
        end_date: '2026-10-18',
        planned_seconds_per_week: hours(16),
      }),
    )
    expect(planned.status).toBe(201)
    const response = await h.request('/api/v1/capacity?from=2026-10-05&to=2026-10-12', { headers: admin })
    const { data } = (await response.json()) as {
      data: {
        people: {
          user_id: number
          weeks: {
            time_off_seconds: number
            available_capacity_seconds: number
            over_allocated: boolean
          }[]
        }[]
      }
    }
    const row = data.people.find((person) => person.user_id === 1)!
    expect(row.weeks.map((week) => [week.time_off_seconds, week.available_capacity_seconds, week.over_allocated])).toEqual([
      [0, hours(20), false],
      [hours(12), hours(8), true],
    ])
  })
})
