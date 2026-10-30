import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../../db/src/adapters.js'
import {
  DrizzleCalendarProposalRepository,
  proposeCalendarEvents,
} from '../../db/src/calendar-proposals.js'
import { migrateContainer } from '../../db/src/migrate.js'
import { DrizzleTrackedResourceRepository } from '../../db/src/tracked-resource-repository.js'
import { createApiApp } from '../src/app.js'
import type { ApiAuthentication } from '../src/auth.js'
import type { UserProfile } from '../src/context.js'
import { installCalendarProposalRoutes, installTrackedResourceRoutes } from '../src/resources/index.js'

/**
 * Issue 428, slice 1, over HTTP on a real migrated database. The store's own
 * rules are tested beside it; this is what the routes add: the acting person is
 * the only owner, a refusal reads as the right status, and the entry an accept
 * creates is the one the ordinary time-entry routes serve.
 */

const t0 = '2026-09-02T12:00:00.000Z'

const authentication: ApiAuthentication = {
  ownMoneyVisible: async () => false,
  tokens: {
    authenticate: async (token) =>
      token === 'read-only'
        ? { tokenId: 1, userId: 1, profile: 'member', scopes: ['time_entries:read'] }
        : null,
    issue: async () => {
      throw new Error('Not used by this harness')
    },
    list: async () => [],
    revoke: async () => null,
  },
  sessions: {
    resolve: async (request) => {
      const userId = Number(request.headers.get('x-test-user-id') ?? '1')
      return {
        type: 'user',
        userId,
        profile: (request.headers.get('x-test-profile') ?? 'member') as UserProfile,
        managerGrants: [],
        authentication: { kind: 'session', sessionId: 'calendar-proposal-test' },
      }
    },
  },
}

interface Harness {
  sqlite: BetterSqlite3.Database
  request(path: string, init?: RequestInit): Promise<Response>
  locked: Set<string>
}

const harness = (): Harness => {
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
     VALUES (1, 1, 1, ?, ?), (2, 1, 10, ?, ?)`,
    t0, t0, t0, t0,
  )
  run(
    `INSERT INTO task_assignments (id, project_id, task_id, billable, created_at, updated_at)
     VALUES (1, 1, 1, 1, ?, ?)`,
    t0,
    t0,
  )
  const orm = createContainerDatabase(sqlite)
  const locked = new Set<string>()
  const tracked = new DrizzleTrackedResourceRepository(orm, {
    isLocked: async (subject) =>
      subject.entityType === 'tracked_date' && locked.has(subject.spentDate),
  })
  const clock = {
    now: () => ({ instant: '2026-09-02T12:05:00.000Z', date: '2026-09-02', time: '12:05' }),
  }
  const cursorSigningKey = new TextEncoder().encode('calendar-proposal-cursor-key-32-bytes')
  const app = createApiApp({
    authentication,
    installApi: (api) => {
      installTrackedResourceRoutes(api, {
        repository: tracked,
        clock,
        cursorSigningKey,
        isExpensesModuleEnabled: async () => true,
      })
      installCalendarProposalRoutes(api, {
        repository: new DrizzleCalendarProposalRepository(orm, tracked),
        clock,
        cursorSigningKey,
      })
    },
  })
  return {
    sqlite,
    locked,
    request: async (path, init) => {
      const headers = new Headers(init?.headers)
      headers.set('origin', 'http://localhost')
      return app.request(path, { ...init, headers })
    },
  }
}

const seedEvents = async (h: Harness, userId: number, ...ids: string[]) => {
  const orm = createContainerDatabase(h.sqlite)
  for (const [index, id] of ids.entries()) {
    await proposeCalendarEvents(
      orm,
      userId,
      [
        {
          provider: 'google',
          calendarId: 'primary',
          eventId: id,
          summary: `Meeting ${id}`,
          startsAt: `2026-09-01T${String(14 + index).padStart(2, '0')}:00:00Z`,
          endsAt: `2026-09-01T${String(15 + index).padStart(2, '0')}:00:00Z`,
        },
      ],
      t0,
    )
  }
}

const as = (userId: number, profile: UserProfile = 'member'): Record<string, string> => ({
  'x-test-user-id': String(userId),
  'x-test-profile': profile,
})

const post = (userId: number, body?: Record<string, unknown>, profile: UserProfile = 'member'): RequestInit => ({
  method: 'POST',
  headers: { ...as(userId, profile), 'content-type': 'application/json' },
  body: JSON.stringify(body ?? {}),
})

const onlyProposalId = (h: Harness): number =>
  (h.sqlite.prepare('SELECT id FROM calendar_proposals').get() as { id: number }).id

interface ProposalBody {
  id: number
  status: string
  title: string
  time_entry_id: number | null
}

describe('calendar proposal routes (issue 428)', () => {
  let current: Harness | null = null
  afterEach(() => {
    current?.sqlite.close()
    current = null
  })
  const setup = async (...events: [number, string[]][]) => {
    current = harness()
    for (const [userId, ids] of events) await seedEvents(current, userId, ...ids)
    return current
  }

  it('[api] lists only the acting person’s waiting proposals, administrators included', async () => {
    const h = await setup([1, ['a', 'b']], [2, ['c']], [10, ['d']])
    const mine = (await (await h.request('/api/v1/calendar-proposals', { headers: as(1) })).json()) as {
      data: ProposalBody[]
    }
    expect(mine.data.map(({ title }) => title)).toEqual(['Meeting a', 'Meeting b'])
    const admins = (await (
      await h.request('/api/v1/calendar-proposals', { headers: as(10, 'administrator') })
    ).json()) as { data: ProposalBody[] }
    expect(admins.data.map(({ title }) => title)).toEqual(['Meeting d'])
    expect(
      (await h.request('/api/v1/calendar-proposals?user_id=2', { headers: as(1) })).status,
    ).toBe(422)
  })

  it('[api] answers another person’s proposal exactly as one that does not exist', async () => {
    const h = await setup([2, ['c']])
    const id = onlyProposalId(h)
    const missing = await h.request('/api/v1/calendar-proposals/999/discard', post(1))
    for (const action of ['accept', 'discard']) {
      for (const user of [1, 10]) {
        const response = await h.request(
          `/api/v1/calendar-proposals/${id}/${action}`,
          post(user, { project_id: 1, task_id: 1 }, user === 10 ? 'administrator' : 'member'),
        )
        expect(response.status).toBe(404)
        expect(((await response.json()) as { error: unknown }).error).toEqual(
          ((await missing.clone().json()) as { error: unknown }).error,
        )
      }
    }
    expect(h.sqlite.prepare('SELECT status FROM calendar_proposals').all()).toEqual([{ status: 'proposed' }])
    expect(h.sqlite.prepare('SELECT count(*) AS n FROM time_entries').get()).toEqual({ n: 0 })
  })

  it('[api] accept creates the entry the ordinary routes serve, and a second accept is a 409', async () => {
    const h = await setup([1, ['a']])
    const id = onlyProposalId(h)
    const accepted = await h.request(
      `/api/v1/calendar-proposals/${id}/accept`,
      post(1, { project_id: 1, task_id: 1 }),
    )
    expect(accepted.status).toBe(201)
    const body = (await accepted.json()) as { data: ProposalBody }
    expect(body.data).toMatchObject({ status: 'accepted', title: 'Meeting a' })
    expect(accepted.headers.get('location')).toBe(`/api/v1/time-entries/${body.data.time_entry_id}`)

    const entry = (await (
      await h.request(accepted.headers.get('location')!, { headers: as(1) })
    ).json()) as { data: Record<string, unknown> }
    expect(entry.data).toMatchObject({
      user_id: 1,
      spent_date: '2026-09-01',
      seconds: 3_600,
      started_time: null,
      notes: 'Meeting a',
      calendar_event_ref: { provider: 'google', event_id: 'a', calendar_id: 'primary' },
    })

    const again = await h.request(
      `/api/v1/calendar-proposals/${id}/accept`,
      post(1, { project_id: 1, task_id: 1 }),
    )
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ error: { code: 'proposal_not_open' } })
    expect(h.sqlite.prepare('SELECT count(*) AS n FROM time_entries').get()).toEqual({ n: 1 })
    // Decided proposals leave the waiting list and are found by asking for them.
    expect(
      ((await (await h.request('/api/v1/calendar-proposals', { headers: as(1) })).json()) as { data: unknown[] }).data,
    ).toEqual([])
    expect(
      ((await (await h.request('/api/v1/calendar-proposals?status=accepted', { headers: as(1) })).json()) as {
        data: unknown[]
      }).data,
    ).toHaveLength(1)
  })

  it('[api] accept honours timesheet locks and leaves the proposal open', async () => {
    const h = await setup([1, ['a']])
    h.locked.add('2026-09-01')
    const id = onlyProposalId(h)
    const response = await h.request(
      `/api/v1/calendar-proposals/${id}/accept`,
      post(1, { project_id: 1, task_id: 1 }),
    )
    expect(response.status).toBe(422)
    expect(h.sqlite.prepare('SELECT status FROM calendar_proposals').all()).toEqual([{ status: 'proposed' }])
    expect(h.sqlite.prepare('SELECT count(*) AS n FROM time_entries').get()).toEqual({ n: 0 })
  })

  it('[api] accept validates its body and discard decides once', async () => {
    const h = await setup([1, ['a']])
    const id = onlyProposalId(h)
    for (const body of [{}, { project_id: 1 }, { project_id: 1, task_id: 1, user_id: 2 }]) {
      expect((await h.request(`/api/v1/calendar-proposals/${id}/accept`, post(1, body))).status).toBe(422)
    }
    expect((await h.request(`/api/v1/calendar-proposals/${id}/discard`, post(1))).status).toBe(200)
    expect((await h.request(`/api/v1/calendar-proposals/${id}/discard`, post(1))).status).toBe(409)
    expect(
      (await h.request(`/api/v1/calendar-proposals/${id}/accept`, post(1, { project_id: 1, task_id: 1 }))).status,
    ).toBe(409)
    expect(h.sqlite.prepare('SELECT count(*) AS n FROM time_entries').get()).toEqual({ n: 0 })
  })

  it('[api] a read-only token can list but cannot decide', async () => {
    const h = await setup([1, ['a']])
    const id = onlyProposalId(h)
    const headers = { authorization: 'Bearer read-only', 'content-type': 'application/json' }
    expect((await h.request('/api/v1/calendar-proposals', { headers })).status).toBe(200)
    for (const action of ['accept', 'discard']) {
      const response = await h.request(`/api/v1/calendar-proposals/${id}/${action}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ project_id: 1, task_id: 1 }),
      })
      expect(response.status).toBe(403)
    }
    expect(h.sqlite.prepare('SELECT status FROM calendar_proposals').all()).toEqual([{ status: 'proposed' }])
  })
})
