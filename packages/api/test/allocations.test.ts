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
 * Issue 1007, slices 1 and 2, over HTTP on a real migrated database. The store's
 * rules are tested beside it; this is what the routes add: who may write, who
 * reads only their own, a refusal as the right status, and over-allocation as a
 * flag and never a refusal.
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
      authentication: { kind: 'session', sessionId: 'allocation-test' },
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
      installAllocationRoutes(api, {
        repository: new DrizzleAllocationRepository(orm),
        clock: {
          now: () => ({ instant: '2026-10-06T09:00:00.000Z', date: '2026-10-06', time: '09:00' }),
        },
        cursorSigningKey: new TextEncoder().encode('allocation-cursor-key-32-bytes!!!'),
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

const plan = (overrides: Record<string, unknown> = {}) => ({
  user_id: 1,
  project_id: 1,
  start_date: '2026-10-05',
  end_date: '2026-10-25',
  planned_seconds_per_week: hours(16),
  ...overrides,
})

interface AllocationBody {
  id: number
  user_id: number
  project_id: number
  start_date: string
  end_date: string
  planned_seconds_per_week: number
}

describe('allocation routes (issue 1007)', () => {
  let current: Harness | null = null
  afterEach(() => {
    current?.sqlite.close()
    current = null
  })
  const setup = () => (current = harness())

  it('[api] an administrator plans, reads, updates and removes a plan', async () => {
    const h = setup()
    const created = await h.request('/api/v1/allocations', send('POST', admin, plan()))
    expect(created.status).toBe(201)
    const { data } = (await created.json()) as { data: AllocationBody }
    expect(data).toMatchObject({ user_id: 1, project_id: 1, planned_seconds_per_week: hours(16) })
    expect(created.headers.get('location')).toBe(`/api/v1/allocations/${data.id}`)

    const patched = await h.request(
      `/api/v1/allocations/${data.id}`,
      send('PATCH', admin, { planned_seconds_per_week: hours(8) }),
    )
    expect(patched.status).toBe(200)
    expect(((await patched.json()) as { data: AllocationBody }).data.planned_seconds_per_week).toBe(hours(8))

    const listed = (await (await h.request('/api/v1/allocations?project_id=1', { headers: admin })).json()) as {
      data: AllocationBody[]
    }
    expect(listed.data.map((row) => row.id)).toEqual([data.id])

    const removed = await h.request(`/api/v1/allocations/${data.id}`, send('DELETE', admin))
    expect(removed.status).toBe(200)
    expect((await h.request(`/api/v1/allocations/${data.id}`, { headers: admin })).status).toBe(404)
  })

  it('[api] a plan writes the activity log event and nothing in time entries or invoices', async () => {
    const h = setup()
    await h.request('/api/v1/allocations', send('POST', admin, plan()))
    expect(h.sqlite.prepare("SELECT event_type FROM event_outbox WHERE aggregate_type = 'allocation'").all()).toEqual([
      { event_type: 'allocation.created' },
    ])
    expect(h.sqlite.prepare('SELECT count(*) AS n FROM time_entries').get()).toEqual({ n: 0 })
    expect(h.sqlite.prepare('SELECT count(*) AS n FROM invoices').get()).toEqual({ n: 0 })
  })

  it('[api] answers a bad plan with the right status', async () => {
    const h = setup()
    const status = async (body: Record<string, unknown>) =>
      (await h.request('/api/v1/allocations', send('POST', admin, body))).status
    expect(await status(plan({ end_date: '2026-10-04' }))).toBe(422)
    expect(await status(plan({ planned_seconds_per_week: 0 }))).toBe(422)
    expect(await status(plan({ planned_seconds_per_week: hours(169) }))).toBe(422)
    expect(await status(plan({ start_date: '2026-13-01' }))).toBe(422)
    expect(await status(plan({ project_id: 99 }))).toBe(422)
    expect(await status(plan({ surprise: 1 }))).toBe(422)
    expect(await status({ user_id: 1 })).toBe(422)
    expect(await status(plan())).toBe(201)
    expect(await status(plan({ start_date: '2026-10-20', end_date: '2026-11-01' }))).toBe(409)
  })

  it('[api] a member reads only their own plan and cannot write', async () => {
    const h = setup()
    const own = (await (await h.request('/api/v1/allocations', send('POST', admin, plan()))).json()) as {
      data: AllocationBody
    }
    const other = (await (
      await h.request('/api/v1/allocations', send('POST', admin, plan({ user_id: 6, project_id: 2 })))
    ).json()) as { data: AllocationBody }
    const listed = (await (await h.request('/api/v1/allocations', { headers: maya })).json()) as {
      data: AllocationBody[]
    }
    expect(listed.data.map((row) => row.id)).toEqual([own.data.id])
    expect((await h.request(`/api/v1/allocations/${other.data.id}`, { headers: maya })).status).toBe(404)
    for (const attempt of [
      h.request('/api/v1/allocations', send('POST', maya, plan())),
      h.request(`/api/v1/allocations/${own.data.id}`, send('PATCH', maya, { planned_seconds_per_week: 1 })),
      h.request(`/api/v1/allocations/${own.data.id}`, send('DELETE', maya)),
    ]) {
      expect((await attempt).status).toBe(403)
    }
  })

  it('[api] a project manager plans only for what they manage', async () => {
    const h = setup()
    expect((await h.request('/api/v1/allocations', send('POST', pia, plan()))).status).toBe(201)
    expect((await h.request('/api/v1/allocations', send('POST', pia, plan({ project_id: 2 })))).status).toBe(422)
    expect((await h.request('/api/v1/allocations', send('POST', pia, plan({ user_id: 6 })))).status).toBe(422)
  })

  it('[api] a token needs the schedule scope', async () => {
    const h = setup()
    const reader = { authorization: 'Bearer read-only' }
    expect((await h.request('/api/v1/allocations', { headers: reader })).status).toBe(200)
    expect(
      (await h.request('/api/v1/allocations', send('POST', reader, plan()))).status,
    ).toBe(403)
  })
})

describe('capacity route (issue 1007)', () => {
  let current: Harness | null = null
  afterEach(() => {
    current?.sqlite.close()
    current = null
  })

  interface CapacityBody {
    week_start_day: string
    weeks: string[]
    people: {
      user_id: number
      weekly_capacity_seconds: number
      weeks: { week_start: string; planned_seconds: number; tracked_seconds: number; over_allocated: boolean }[]
    }[]
  }

  it('[api] flags over-allocation without refusing it, from the week start day, against part-time capacity', async () => {
    const h = (current = harness())
    // Maya works 20 hours a week; 16 + 8 planned in the second week is over.
    await h.request('/api/v1/allocations', send('POST', admin, plan({ end_date: '2026-10-18' })))
    const second = await h.request(
      '/api/v1/allocations',
      send('POST', admin, plan({ project_id: 2, planned_seconds_per_week: hours(8), start_date: '2026-10-12', end_date: '2026-10-18' })),
    )
    expect(second.status).toBe(201)
    const response = await h.request('/api/v1/capacity?from=2026-10-07&to=2026-10-14', { headers: admin })
    expect(response.status).toBe(200)
    const { data } = (await response.json()) as { data: CapacityBody }
    expect(data.week_start_day).toBe('monday')
    expect(data.weeks).toEqual(['2026-10-05', '2026-10-12'])
    const row = data.people.find((person) => person.user_id === 1)!
    expect(row.weekly_capacity_seconds).toBe(hours(20))
    expect(row.weeks.map((week) => [week.planned_seconds, week.over_allocated])).toEqual([
      [hours(16), false],
      [hours(24), true],
    ])
  })

  it('[api] shows a member only themselves', async () => {
    const h = (current = harness())
    const response = await h.request('/api/v1/capacity?from=2026-10-05&to=2026-10-11', { headers: maya })
    const { data } = (await response.json()) as { data: CapacityBody }
    expect(data.people.map((person) => person.user_id)).toEqual([1])
  })

  it('[api] is read-only and asks for a sane range', async () => {
    const h = (current = harness())
    expect((await h.request('/api/v1/capacity', { headers: admin })).status).toBe(422)
    expect((await h.request('/api/v1/capacity?from=2026-10-12&to=2026-10-05', { headers: admin })).status).toBe(422)
    expect((await h.request('/api/v1/capacity?from=2026-01-01&to=2027-12-31', { headers: admin })).status).toBe(422)
    expect((await h.request('/api/v1/capacity?from=2026-10-05&to=2026-10-11&x=1', { headers: admin })).status).toBe(422)
    expect(
      (await h.request('/api/v1/capacity?from=2026-10-05&to=2026-10-11', send('POST', admin, {}))).status,
    ).toBe(404)
  })
})
