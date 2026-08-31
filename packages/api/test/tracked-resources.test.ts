import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createContainerDatabase,
  createD1Database,
} from '../../db/src/adapters.js'
import { migrateContainer, migrateD1 } from '../../db/src/migrate.js'
import {
  DrizzleTrackedResourceRepository,
  type PolicySubject,
} from '../../db/src/tracked-resource-repository.js'
import { createApiApp } from '../src/app.js'
import type { ApiAuthentication } from '../src/auth.js'
import type { UserProfile } from '../src/context.js'
import { installTrackedResourceRoutes } from '../src/resources/index.js'
import type {
  ResourceTimeBoundary,
  TrackedResourceRepository,
} from '../src/resources/tracked-repository.js'

type OrmDatabase = ConstructorParameters<
  typeof DrizzleTrackedResourceRepository
>[0]

interface TestDatabase {
  orm: OrmDatabase
  run(sql: string, ...params: unknown[]): Promise<void>
  rows<T>(sql: string, ...params: unknown[]): Promise<T[]>
  close(): Promise<void>
}

const timestamp = '2026-08-28T08:00:00.000Z'
const modules = JSON.stringify({
  expenses: true,
  invoices: true,
  approval: true,
})

const containerDatabase = (): TestDatabase => {
  const sqlite = new BetterSqlite3(':memory:')
  migrateContainer(sqlite)
  return {
    orm: createContainerDatabase(sqlite),
    run: async (statement, ...params) => {
      sqlite.prepare(statement).run(...params)
    },
    rows: async <T>(statement: string, ...params: unknown[]) =>
      sqlite.prepare(statement).all(...params) as T[],
    close: async () => {
      sqlite.close()
    },
  }
}

const d1Database = async (): Promise<TestDatabase> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const d1 = await miniflare.getD1Database('DB')
  await migrateD1(d1)
  return {
    orm: createD1Database(d1),
    run: async (statement, ...params) => {
      await d1
        .prepare(statement)
        .bind(...params)
        .run()
    },
    rows: async <T>(statement: string, ...params: unknown[]) =>
      (
        await d1
          .prepare(statement)
          .bind(...params)
          .all<T>()
      ).results,
    close: async () => miniflare.dispose(),
  }
}

const factories = [
  ['SQLite', async () => containerDatabase()],
  ['D1', d1Database],
] as const

const seed = async (database: TestDatabase): Promise<void> => {
  await database.run(
    `INSERT INTO organizations (
      name, time_entry_mode, time_rounding, modules, created_at, updated_at
    ) VALUES ('Sanitized Organization', 'duration', 'up_6', ?, ?, ?)`,
    modules,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO users (
      id, first_name, last_name, profile, manager_grants, created_at, updated_at
    ) VALUES
      (1, 'Sanitized', 'Member', 'member', '[]', ?, ?),
      (2, 'Other', 'Member', 'member', '[]', ?, ?)`,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO clients (id, name, currency, created_at, updated_at)
     VALUES (1, 'Sanitized Client', 'USD', ?, ?)`,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO projects (
      id, client_id, name, code, hourly_rate_cents, created_at, updated_at
    ) VALUES
      (1, 1, 'Assigned Project', 'ONE', 10000, ?, ?),
      (2, 1, 'Unassigned Project', 'TWO', 12000, ?, ?)`,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO tasks (id, name, created_at, updated_at)
     VALUES
      (1, 'Sanitized Task', ?, ?),
      (2, 'Other Task', ?, ?)`,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO user_assignments (
      id, project_id, user_id, created_at, updated_at
    ) VALUES
      (1, 1, 1, ?, ?),
      (2, 1, 2, ?, ?)`,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO task_assignments (
      id, project_id, task_id, billable, created_at, updated_at
    ) VALUES
      (1, 1, 1, 1, ?, ?),
      (2, 1, 2, 0, ?, ?),
      (3, 2, 1, 1, ?, ?)`,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO user_cost_rates (
      id, user_id, amount_cents, start_date, created_at, updated_at
    ) VALUES (1, 1, 5000, NULL, ?, ?)`,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO expense_categories (
      id, name, unit_name, unit_price_cents, created_at, updated_at
    ) VALUES
      (1, 'Direct cost', NULL, NULL, ?, ?),
      (2, 'Mileage', 'mile', 250, ?, ?)`,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO invoices (
      id, client_id, number, currency, issue_date, due_date, created_at, updated_at
    ) VALUES (1, 1, 'SAFE-1', 'USD', '2026-08-01', '2026-08-31', ?, ?)`,
    timestamp,
    timestamp,
  )
}

const userProfiles: ReadonlySet<string> = new Set([
  'member',
  'project_manager',
  'people_admin',
  'accounting',
  'executive_manager',
  'administrator',
])

const authentication: ApiAuthentication = {
  sessions: {
    resolve: async (request) => {
      const profile = request.headers.get('x-test-profile') ?? 'member'
      if (!userProfiles.has(profile)) return null
      return {
        type: 'user',
        userId: 1,
        profile: profile as UserProfile,
        managerGrants: (request.headers.get('x-test-manager-grants') ?? '')
          .split(',')
          .filter(Boolean),
        authentication: {
          kind: 'session',
          sessionId: 'tracked-resource-test',
        },
      }
    },
  },
}

const policyKey = (subject: Readonly<PolicySubject>): string =>
  subject.entityType === 'running_time_entry_replacement'
    ? `running:${subject.userId}`
    : `${subject.entityType}:${subject.entityId}`

interface Harness {
  database: TestDatabase
  request(path: string, init?: RequestInit): Promise<Response>
  locks: Set<string>
  setBoundary(boundary: ResourceTimeBoundary): void
}

const harness = async (
  factory: () => Promise<TestDatabase>,
): Promise<Harness> => {
  const database = await factory()
  await seed(database)
  const locks = new Set<string>()
  const implementation = new DrizzleTrackedResourceRepository(database.orm, {
    isLocked: async (subject) => locks.has(policyKey(subject)),
  })
  const repository: TrackedResourceRepository = implementation
  let current: ResourceTimeBoundary = {
    instant: '2026-08-28T09:00:00.000Z',
    date: '2026-08-28',
    time: '09:00',
  }
  const app = createApiApp({
    authentication,
    installApi: (api) =>
      installTrackedResourceRoutes(api, {
        repository,
        clock: { now: () => ({ ...current }) },
        cursorSigningKey: new TextEncoder().encode(
          'tracked-resource-cursor-key-32-bytes',
        ),
      }),
  })
  return {
    database,
    request: async (path, init) => {
      const headers = new Headers(init?.headers)
      headers.set('origin', 'http://localhost')
      return app.request(path, { ...init, headers })
    },
    locks,
    setBoundary: (boundary) => {
      current = { ...boundary }
    },
  }
}

const jsonRequest = (
  method: 'POST' | 'PATCH',
  body: Record<string, unknown>,
): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const data = async <T>(response: Response): Promise<T> =>
  ((await response.json()) as { data: T }).data

const asProfile = (
  profile: UserProfile,
  managerGrants: readonly string[] = [],
): RequestInit => ({
  headers: {
    'x-test-profile': profile,
    ...(managerGrants.length === 0
      ? {}
      : { 'x-test-manager-grants': managerGrants.join(',') }),
  },
})

for (const [runtime, factory] of factories) {
  const slowRuntimeTimeout = runtime === 'D1' ? 20_000 : undefined

  describe(`tracked resource API (${runtime})`, () => {
    let active: Harness | undefined

    afterEach(async () => active?.database.close())

    const setup = async (): Promise<Harness> => {
      active = await harness(factory)
      return active
    }

    it('[api] lists only active time-entry project/task options for the member', async () => {
      const test = await setup()
      await test.database.run(
        `INSERT INTO tasks (id, name, created_at, updated_at)
         VALUES (3, 'Unassigned Task', ?, ?)`,
        timestamp,
        timestamp,
      )
      const options = async (): Promise<
        readonly {
          project_id: number
          task_id: number
          minimum_note_length: number
        }[]
      > => {
        const response = await test.request('/api/v1/time-entry-options')
        expect(response.status).toBe(200)
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(await response.clone().json()).toMatchObject({
          links: { self: '/api/v1/time-entry-options' },
        })
        return data(response)
      }

      const initial = await options()
      expect(initial).toEqual([
        { project_id: 1, task_id: 1, minimum_note_length: 0 },
        { project_id: 1, task_id: 2, minimum_note_length: 0 },
      ])
      expect(initial).not.toContainEqual({ project_id: 1, task_id: 3 })
      expect(initial).not.toContainEqual({ project_id: 2, task_id: 1 })

      await test.database.run(
        `UPDATE user_assignments SET is_active = 0 WHERE id = 1`,
      )
      await expect(options()).resolves.toEqual([])
      await test.database.run(
        `UPDATE user_assignments SET is_active = 1 WHERE id = 1`,
      )

      await test.database.run(
        `UPDATE task_assignments SET is_active = 0 WHERE id = 1`,
      )
      await expect(options()).resolves.toEqual([
        { project_id: 1, task_id: 2, minimum_note_length: 0 },
      ])
      await test.database.run(
        `UPDATE task_assignments SET is_active = 1 WHERE id = 1`,
      )

      await test.database.run(`UPDATE tasks SET is_active = 0 WHERE id = 1`)
      await expect(options()).resolves.toEqual([
        { project_id: 1, task_id: 2, minimum_note_length: 0 },
      ])
      await test.database.run(`UPDATE tasks SET is_active = 1 WHERE id = 1`)

      await test.database.run(`UPDATE projects SET is_active = 0 WHERE id = 1`)
      await expect(options()).resolves.toEqual([])
      await test.database.run(`UPDATE projects SET is_active = 1 WHERE id = 1`)

      await test.database.run(`UPDATE clients SET is_active = 0 WHERE id = 1`)
      await expect(options()).resolves.toEqual([])
    }, slowRuntimeTimeout)

    it('[api] exposes organization note settings and restricts changes to organization admins', async () => {
      const test = await setup()
      const initial = await test.request('/api/v1/time-entry-note-settings')
      expect(initial.status).toBe(200)
      expect(await initial.json()).toMatchObject({
        data: { required: false, minimum_length: 1 },
      })

      const forbidden = await test.request(
        '/api/v1/time-entry-note-settings',
        jsonRequest('PATCH', { required: true, minimum_length: 12 }),
      )
      expect(forbidden.status).toBe(403)

      const adminRequest = jsonRequest('PATCH', {
        required: true,
        minimum_length: 12,
      })
      const adminHeaders = new Headers(adminRequest.headers)
      adminHeaders.set('x-test-profile', 'administrator')
      const updated = await test.request('/api/v1/time-entry-note-settings', {
        ...adminRequest,
        headers: adminHeaders,
      })
      expect(updated.status).toBe(200)
      expect(await updated.json()).toMatchObject({
        data: { required: true, minimum_length: 12 },
      })
      expect(
        await test.database.rows<{
          required: number
          minimum_length: number
        }>(
          `SELECT time_entry_notes_required AS required,
            time_entry_notes_minimum_length AS minimum_length
           FROM organizations WHERE id = 1`,
        ),
      ).toEqual([{ required: 1, minimum_length: 12 }])

      const invalidRequest = jsonRequest('PATCH', {
        minimum_length: 10_001,
      })
      const invalidHeaders = new Headers(invalidRequest.headers)
      invalidHeaders.set('x-test-profile', 'administrator')
      const invalid = await test.request('/api/v1/time-entry-note-settings', {
        ...invalidRequest,
        headers: invalidHeaders,
      })
      expect(invalid.status).toBe(422)
    }, slowRuntimeTimeout)

    it('[api] enforces the strongest scoped note rule on every native write path', async () => {
      const test = await setup()
      await test.database.run(
        `UPDATE organizations
         SET time_entry_notes_required = 1, time_entry_notes_minimum_length = 4
         WHERE id = 1`,
      )
      await test.database.run(
        `UPDATE projects SET time_entry_notes_minimum_length = 5 WHERE id = 1`,
      )
      await test.database.run(
        `UPDATE users SET time_entry_notes_minimum_length = 6 WHERE id = 1`,
      )
      await test.database.run(
        `UPDATE user_assignments SET time_entry_notes_minimum_length = 7 WHERE id = 1`,
      )

      expect(
        await data<unknown[]>(await test.request('/api/v1/time-entry-options')),
      ).toEqual([
        { project_id: 1, task_id: 1, minimum_note_length: 7 },
        { project_id: 1, task_id: 2, minimum_note_length: 7 },
      ])

      const sixCodePoints = '😀😀😀😀😀😀'
      const rejectedCreate = await test.request(
        '/api/v1/time-entries',
        jsonRequest('POST', {
          project_id: 1,
          task_id: 1,
          spent_date: '2026-08-28',
          seconds: 60,
          notes: sixCodePoints,
        }),
      )
      expect(rejectedCreate.status).toBe(422)
      expect(await rejectedCreate.json()).toMatchObject({
        error: {
          code: 'validation_failed',
          fields: [
            {
              field: 'notes',
              code: 'minimum_length',
              minimum_length: 7,
            },
          ],
        },
      })
      expect(
        await test.database.rows<{ count: number }>(
          `SELECT count(*) AS count FROM time_entries`,
        ),
      ).toEqual([{ count: 0 }])

      const exactNotes = '  😀😀😀😀😀😀😀  '
      const exactResponse = await test.request(
        '/api/v1/time-entries',
        jsonRequest('POST', {
          project_id: 1,
          task_id: 1,
          spent_date: '2026-08-28',
          seconds: 60,
          notes: exactNotes,
        }),
      )
      expect(exactResponse.status).toBe(201)
      const exact = await data<{
        id: number
        notes: string
        minimum_note_length: number
      }>(exactResponse)
      expect(exact).toMatchObject({
        notes: exactNotes,
        minimum_note_length: 7,
      })

      const rejectedClear = await test.request(
        `/api/v1/time-entries/${exact.id}`,
        jsonRequest('PATCH', { notes: sixCodePoints }),
      )
      expect(rejectedClear.status).toBe(422)
      expect(
        await test.database.rows<{ notes: string }>(
          `SELECT notes FROM time_entries WHERE id = ?`,
          exact.id,
        ),
      ).toEqual([{ notes: exactNotes }])

      await test.database.run(
        `INSERT INTO user_assignments (
          id, project_id, user_id, time_entry_notes_minimum_length, created_at, updated_at
        ) VALUES (3, 2, 1, 9, ?, ?)`,
        timestamp,
        timestamp,
      )
      const rejectedReassignment = await test.request(
        `/api/v1/time-entries/${exact.id}`,
        jsonRequest('PATCH', { project_id: 2, task_id: 1 }),
      )
      expect(rejectedReassignment.status).toBe(422)
      expect(await rejectedReassignment.json()).toMatchObject({
        error: {
          fields: [{ field: 'notes', minimum_length: 9 }],
        },
      })

      const runningResponse = await test.request(
        '/api/v1/time-entries',
        jsonRequest('POST', {
          project_id: 1,
          task_id: 1,
          notes: '1234567',
        }),
      )
      expect(runningResponse.status).toBe(201)
      const running = await data<{ id: number }>(runningResponse)
      await test.database.run(
        `UPDATE user_assignments SET time_entry_notes_minimum_length = 8 WHERE id = 1`,
      )

      const rejectedReplacement = await test.request(
        '/api/v1/time-entries',
        jsonRequest('POST', {
          project_id: 1,
          task_id: 1,
          notes: '1234567',
        }),
      )
      expect(rejectedReplacement.status).toBe(422)
      expect(
        await data<{ is_running: boolean }>(
          await test.request(`/api/v1/time-entries/${running.id}`),
        ),
      ).toMatchObject({ is_running: true })

      const stopped = await test.request(
        `/api/v1/time-entries/${running.id}/stop`,
        { method: 'POST' },
      )
      expect(stopped.status).toBe(200)
      const rejectedRestart = await test.request(
        `/api/v1/time-entries/${running.id}/restart`,
        { method: 'POST' },
      )
      expect(rejectedRestart.status).toBe(422)

      await test.database.run(
        `UPDATE organizations SET time_entry_notes_required = 0 WHERE id = 1`,
      )
      await test.database.run(
        `UPDATE projects SET time_entry_notes_minimum_length = NULL WHERE id = 1`,
      )
      await test.database.run(
        `UPDATE users SET time_entry_notes_minimum_length = NULL WHERE id = 1`,
      )
      await test.database.run(
        `UPDATE user_assignments SET time_entry_notes_minimum_length = NULL WHERE id = 1`,
      )
      expect(
        (
          await test.request(
            '/api/v1/time-entries',
            jsonRequest('POST', {
              project_id: 1,
              task_id: 1,
              spent_date: '2026-08-28',
              seconds: 60,
            }),
          )
        ).status,
      ).toBe(201)
    }, 40_000)

    it('[security] redacts both time-entry rate snapshots across all six profiles', async () => {
      const test = await setup()
      await test.database.run(
        `INSERT INTO time_entries (
          id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
          spent_date, seconds, seconds_without_timer, rounded_seconds, billable,
          billable_rate_cents, cost_rate_cents, created_at, updated_at
        ) VALUES (700, 1, 1, 1, 1, 1, '2026-08-28', 3600, 3600, 3600, 1,
          15000, 9000, ?, ?)`,
        timestamp,
        timestamp,
      )
      const matrix: Readonly<
        Record<UserProfile, Readonly<{ billable: boolean; cost: boolean }>>
      > = {
        member: { billable: false, cost: false },
        project_manager: { billable: false, cost: false },
        people_admin: { billable: false, cost: false },
        accounting: { billable: true, cost: false },
        executive_manager: { billable: true, cost: false },
        administrator: { billable: true, cost: true },
      }
      for (const [profile, expected] of Object.entries(matrix) as Array<
        [UserProfile, { billable: boolean; cost: boolean }]
      >) {
        const serialized = await data<Record<string, unknown>>(
          await test.request('/api/v1/time-entries/700', asProfile(profile)),
        )
        expect(
          Object.hasOwn(serialized, 'billable_rate_cents'),
          `${profile}:billable_rate_cents`,
        ).toBe(expected.billable)
        expect(
          Object.hasOwn(serialized, 'cost_rate_cents'),
          `${profile}:cost_rate_cents`,
        ).toBe(expected.cost)
      }

      const grantedManager = await data<Record<string, unknown>>(
        await test.request(
          '/api/v1/time-entries/700',
          asProfile('project_manager', ['billable_rates_manager']),
        ),
      )
      expect(grantedManager).toHaveProperty('billable_rate_cents', 15_000)
      expect(grantedManager).not.toHaveProperty('cost_rate_cents')
    })

    it('[api] applies implicit duration start, replacement stop, stop, and restart semantics', async () => {
      const test = await setup()
      const firstResponse = await test.request(
        '/api/v1/time-entries',
        jsonRequest('POST', {
          project_id: 1,
          task_id: 1,
          spent_date: '2026-08-28',
          notes: 'first timer',
        }),
      )
      expect(firstResponse.status).toBe(201)
      const first = await data<{ id: number; is_running: boolean }>(
        firstResponse,
      )
      expect(first.is_running).toBe(true)

      test.setBoundary({
        instant: '2026-08-28T10:00:00.000Z',
        date: '2026-08-28',
        time: '10:00',
      })
      const secondResponse = await test.request(
        '/api/v1/time-entries',
        jsonRequest('POST', {
          project_id: 1,
          task_id: 1,
          notes: 'second timer',
        }),
      )
      expect(secondResponse.status).toBe(201)
      const second = await data<{ id: number; is_running: boolean }>(
        secondResponse,
      )
      expect(second.is_running).toBe(true)
      const stoppedFirst = await data<{ seconds: number; is_running: boolean }>(
        await test.request(`/api/v1/time-entries/${first.id}`),
      )
      expect(stoppedFirst).toMatchObject({ seconds: 3_600, is_running: false })

      test.setBoundary({
        instant: '2026-08-28T10:30:00.000Z',
        date: '2026-08-28',
        time: '10:30',
      })
      const stoppedSecond = await data<{
        seconds: number
        is_running: boolean
      }>(
        await test.request(`/api/v1/time-entries/${second.id}/stop`, {
          method: 'POST',
        }),
      )
      expect(stoppedSecond).toMatchObject({
        seconds: 1_800,
        is_running: false,
      })

      test.setBoundary({
        instant: '2026-08-28T11:00:00.000Z',
        date: '2026-08-28',
        time: '11:00',
      })
      const restarted = await data<{ seconds: number; is_running: boolean }>(
        await test.request(`/api/v1/time-entries/${second.id}/restart`, {
          method: 'POST',
        }),
      )
      expect(restarted).toMatchObject({ seconds: 1_800, is_running: true })
    }, slowRuntimeTimeout)

    it('[api] applies implicit and explicit start/end-mode timing', async () => {
      const test = await setup()
      await test.database.run(
        `UPDATE organizations SET time_entry_mode = 'start_end' WHERE id = 1`,
      )
      const first = await data<{
        id: number
        started_time: string
        is_running: boolean
      }>(
        await test.request(
          '/api/v1/time-entries',
          jsonRequest('POST', {
            project_id: 1,
            task_id: 1,
            spent_date: '2026-08-28',
            started_time: '09:00',
          }),
        ),
      )
      expect(first).toMatchObject({ started_time: '09:00', is_running: true })
      const annotated = await test.request(
        `/api/v1/time-entries/${first.id}`,
        jsonRequest('PATCH', { notes: 'running start/end note' }),
      )
      expect(annotated.status).toBe(200)
      expect(
        await data<{ notes: string; is_running: boolean }>(annotated),
      ).toMatchObject({
        notes: 'running start/end note',
        is_running: true,
      })

      test.setBoundary({
        instant: '2026-08-28T10:30:00.000Z',
        date: '2026-08-28',
        time: '10:30',
      })
      await test.request(
        '/api/v1/time-entries',
        jsonRequest('POST', { project_id: 1, task_id: 1 }),
      )
      const stopped = await data<{
        ended_time: string
        seconds: number
        is_running: boolean
      }>(await test.request(`/api/v1/time-entries/${first.id}`))
      expect(stopped).toMatchObject({
        ended_time: '10:30',
        seconds: 5_400,
        is_running: false,
      })

      const explicitResponse = await test.request(
        '/api/v1/time-entries',
        jsonRequest('POST', {
          project_id: 1,
          task_id: 1,
          spent_date: '2026-08-27',
          started_time: '22:00',
          ended_time: '01:00',
        }),
      )
      expect(explicitResponse.status).toBe(201)
      expect(
        await data<{ seconds: number; is_running: boolean }>(explicitResponse),
      ).toMatchObject({
        seconds: 10_800,
        is_running: false,
      })
    })

    it('[api] supports combined time filters, signed cursors, updates, deletes, and row boundaries', async () => {
      const test = await setup()
      const ids: number[] = []
      for (const [date, seconds] of [
        ['2026-08-02', 61],
        ['2026-08-03', 122],
        ['2026-08-04', 183],
      ] as const) {
        const response = await test.request(
          '/api/v1/time-entries',
          jsonRequest('POST', {
            project_id: 1,
            task_id: 1,
            spent_date: date,
            seconds,
            budgeted: true,
            external_ref: { id: 'filtered-batch' },
          }),
        )
        expect(response.status).toBe(201)
        ids.push((await data<{ id: number }>(response)).id)
      }
      const query =
        '?client_id=1&project_id=1&task_id=1&from=2026-08-02&to=2026-08-04' +
        '&approval_status=unsubmitted&is_billed=false&is_running=false' +
        '&billable=true&budgeted=true&external_reference_id=filtered-batch' +
        '&updated_since=2026-08-28T00%3A00%3A00Z&per_page=1'
      const firstPageResponse = await test.request(
        `/api/v1/time-entries${query}`,
      )
      expect(firstPageResponse.status).toBe(200)
      const firstPage = (await firstPageResponse.json()) as {
        data: Array<{
          id: number
          billable_rate_cents?: number
          cost_rate_cents?: number
        }>
        links: { next: string | null }
      }
      expect(firstPage.data).toHaveLength(1)
      expect(firstPage.data[0]).not.toHaveProperty('billable_rate_cents')
      expect(firstPage.data[0]).not.toHaveProperty('cost_rate_cents')
      expect(firstPage.links.next).not.toBeNull()

      const secondPage = await test.request(firstPage.links.next!)
      expect(secondPage.status).toBe(200)
      expect(
        ((await secondPage.json()) as { data: unknown[] }).data,
      ).toHaveLength(1)
      const replay = new URL(firstPage.links.next!, 'https://test.invalid')
      replay.searchParams.set('budgeted', 'false')
      expect(
        (await test.request(`${replay.pathname}${replay.search}`)).status,
      ).toBe(422)

      test.setBoundary({
        instant: '2026-08-28T12:00:00.000Z',
        date: '2026-08-28',
        time: '12:00',
      })
      const updatedResponse = await test.request(
        `/api/v1/time-entries/${ids[0]}`,
        jsonRequest('PATCH', {
          task_id: 2,
          seconds: 601,
          notes: 'updated safely',
        }),
      )
      expect(updatedResponse.status).toBe(200)
      expect(
        await data<{
          task_id: number
          seconds: number
          rounded_seconds: number
          notes: string
          billable: boolean
        }>(updatedResponse),
      ).toMatchObject({
        task_id: 2,
        seconds: 601,
        rounded_seconds: 720,
        notes: 'updated safely',
        billable: false,
      })

      await test.database.run(
        `INSERT INTO time_entries (
          id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
          spent_date, seconds, seconds_without_timer, rounded_seconds, billable,
          created_at, updated_at
        ) VALUES (9999, 2, 1, 1, 2, 1, '2026-08-28', 60, 60, 60, 1, ?, ?)`,
        timestamp,
        timestamp,
      )
      expect((await test.request('/api/v1/time-entries/9999')).status).toBe(404)
      expect(
        (
          await test.request(
            '/api/v1/time-entries',
            jsonRequest('POST', {
              project_id: 2,
              task_id: 1,
              spent_date: '2026-08-28',
              seconds: 60,
            }),
          )
        ).status,
      ).toBe(403)

      expect(
        (
          await test.request(`/api/v1/time-entries/${ids[2]}`, {
            method: 'DELETE',
          })
        ).status,
      ).toBe(200)
      expect(
        (await test.request(`/api/v1/time-entries/${ids[2]}`)).status,
      ).toBe(404)
    }, 20_000)

    it('[api] maps every time-entry locked write through the typed native 422 contract', async () => {
      const test = await setup()
      const stopped = await data<{ id: number }>(
        await test.request(
          '/api/v1/time-entries',
          jsonRequest('POST', {
            project_id: 1,
            task_id: 1,
            spent_date: '2026-08-28',
            seconds: 60,
            notes: 'before',
          }),
        ),
      )
      await test.database.run(
        `UPDATE time_entries SET approval_status = 'approved' WHERE id = ?`,
        stopped.id,
      )
      const lockedPatch = await test.request(
        `/api/v1/time-entries/${stopped.id}`,
        jsonRequest('PATCH', { notes: 'must not persist' }),
      )
      expect(lockedPatch.status).toBe(422)
      expect(await lockedPatch.json()).toMatchObject({
        error: {
          code: 'tracked_mutation_locked',
          fields: [
            { field: 'time_entry', code: 'approved', message: 'Approved' },
          ],
        },
      })
      expect(
        await test.database.rows<{ notes: string }>(
          `SELECT notes FROM time_entries WHERE id = ?`,
          stopped.id,
        ),
      ).toEqual([{ notes: 'before' }])

      const running = await data<{ id: number }>(
        await test.request(
          '/api/v1/time-entries',
          jsonRequest('POST', { project_id: 1, task_id: 1 }),
        ),
      )
      await test.database.run(
        `UPDATE time_entries SET invoice_id = 1 WHERE id = ?`,
        running.id,
      )
      const lockedStop = await test.request(
        `/api/v1/time-entries/${running.id}/stop`,
        {
          method: 'POST',
        },
      )
      expect(lockedStop.status).toBe(422)
      expect(await lockedStop.json()).toMatchObject({
        error: {
          code: 'tracked_mutation_locked',
          fields: [{ code: 'invoiced' }],
        },
      })
      const replacement = await test.request(
        '/api/v1/time-entries',
        jsonRequest('POST', { project_id: 1, task_id: 1 }),
      )
      expect(replacement.status).toBe(422)
      expect(await replacement.json()).toMatchObject({
        error: {
          code: 'tracked_mutation_locked',
          fields: [{ field: 'time_entry', code: 'invoiced' }],
        },
      })
      expect(
        await test.database.rows<{ count: number }>(
          `SELECT count(*) AS count FROM time_entries`,
        ),
      ).toEqual([{ count: 2 }])
    }, 20_000)

    it('[api] supports expense pricing, combined filters, CRUD, and strict input validation', async () => {
      const test = await setup()
      const directResponse = await test.request(
        '/api/v1/expenses',
        jsonRequest('POST', {
          project_id: 1,
          expense_category_id: 1,
          spent_date: '2026-08-20',
          total_cost_cents: 1_200,
        }),
      )
      expect(directResponse.status).toBe(201)
      const direct = await data<{ id: number; total_cost_cents: number }>(
        directResponse,
      )
      expect(direct.total_cost_cents).toBe(1_200)

      const unitResponse = await test.request(
        '/api/v1/expenses',
        jsonRequest('POST', {
          project_id: 1,
          expense_category_id: 2,
          spent_date: '2026-08-21',
          units: 3,
          reimbursable: true,
        }),
      )
      expect(unitResponse.status).toBe(201)
      const unit = await data<{
        id: number
        units: number
        total_cost_cents: number
      }>(unitResponse)
      expect(unit).toMatchObject({ units: 3, total_cost_cents: 750 })

      const list = await test.request(
        '/api/v1/expenses?client_id=1&project_id=1&expense_category_id=2' +
          '&from=2026-08-20&to=2026-08-22&approval_status=unsubmitted' +
          '&is_billed=false&billable=true&reimbursable=true&reimbursement_status=none' +
          '&updated_since=2026-08-28T00%3A00%3A00Z',
      )
      expect(list.status).toBe(200)
      expect(
        (await list.json()) as { data: Array<{ id: number }> },
      ).toMatchObject({
        data: [{ id: unit.id }],
      })

      test.setBoundary({
        instant: '2026-08-28T13:00:00.000Z',
        date: '2026-08-28',
        time: '13:00',
      })
      const repriced = await test.request(
        `/api/v1/expenses/${unit.id}`,
        jsonRequest('PATCH', { units: 4, notes: 'four units' }),
      )
      expect(repriced.status).toBe(200)
      expect(
        await data<{ total_cost_cents: number; notes: string }>(repriced),
      ).toMatchObject({
        total_cost_cents: 1_000,
        notes: 'four units',
      })
      const recategorized = await test.request(
        `/api/v1/expenses/${unit.id}`,
        jsonRequest('PATCH', { expense_category_id: 1, total_cost_cents: 900 }),
      )
      expect(recategorized.status).toBe(200)
      expect(
        await data<{ units: null; total_cost_cents: number }>(recategorized),
      ).toMatchObject({
        units: null,
        total_cost_cents: 900,
      })

      await test.database.run(
        `INSERT INTO expenses (
          id, user_id, project_id, expense_category_id, spent_date,
          total_cost_cents, created_at, updated_at
        ) VALUES (9999, 2, 1, 1, '2026-08-21', 100, ?, ?)`,
        timestamp,
        timestamp,
      )
      expect((await test.request('/api/v1/expenses/9999')).status).toBe(404)

      const mismatch = await test.request(
        '/api/v1/expenses',
        jsonRequest('POST', {
          project_id: 1,
          expense_category_id: 2,
          spent_date: '2026-08-22',
          total_cost_cents: 500,
        }),
      )
      expect(mismatch.status).toBe(422)
      expect(await mismatch.json()).toMatchObject({
        error: {
          code: 'validation_failed',
          fields: [{ code: 'category_pricing_mismatch' }],
        },
      })

      expect(
        (
          await test.request(`/api/v1/expenses/${direct.id}`, {
            method: 'DELETE',
          })
        ).status,
      ).toBe(200)
      expect((await test.request(`/api/v1/expenses/${direct.id}`)).status).toBe(
        404,
      )
    }, slowRuntimeTimeout)

    it('[api] uses the shared three-axis guard for expense writes and rejects malformed filters', async () => {
      const test = await setup()
      const approved = await data<{ id: number }>(
        await test.request(
          '/api/v1/expenses',
          jsonRequest('POST', {
            project_id: 1,
            expense_category_id: 1,
            spent_date: '2026-08-28',
            total_cost_cents: 500,
            notes: 'before',
          }),
        ),
      )
      await test.database.run(
        `UPDATE expenses SET approval_status = 'approved' WHERE id = ?`,
        approved.id,
      )
      const locked = await test.request(
        `/api/v1/expenses/${approved.id}`,
        jsonRequest('PATCH', { notes: 'must not persist' }),
      )
      expect(locked.status).toBe(422)
      expect(await locked.json()).toMatchObject({
        error: {
          code: 'tracked_mutation_locked',
          fields: [{ field: 'expense', code: 'approved', message: 'Approved' }],
        },
      })
      expect(
        await test.database.rows<{ notes: string }>(
          `SELECT notes FROM expenses WHERE id = ?`,
          approved.id,
        ),
      ).toEqual([{ notes: 'before' }])

      const invoiced = await data<{ id: number }>(
        await test.request(
          '/api/v1/expenses',
          jsonRequest('POST', {
            project_id: 1,
            expense_category_id: 1,
            spent_date: '2026-08-28',
            total_cost_cents: 550,
          }),
        ),
      )
      await test.database.run(
        `UPDATE expenses SET invoice_id = 1 WHERE id = ?`,
        invoiced.id,
      )
      const invoiceResponse = await test.request(
        `/api/v1/expenses/${invoiced.id}`,
        jsonRequest('PATCH', { notes: 'must remain invoiced' }),
      )
      expect(invoiceResponse.status).toBe(422)
      expect(await invoiceResponse.json()).toMatchObject({
        error: {
          code: 'tracked_mutation_locked',
          fields: [{ code: 'invoiced' }],
        },
      })

      const policyLocked = await data<{ id: number }>(
        await test.request(
          '/api/v1/expenses',
          jsonRequest('POST', {
            project_id: 1,
            expense_category_id: 1,
            spent_date: '2026-08-28',
            total_cost_cents: 600,
          }),
        ),
      )
      test.locks.add(`expense:${policyLocked.id}`)
      const policyResponse = await test.request(
        `/api/v1/expenses/${policyLocked.id}`,
        {
          method: 'DELETE',
        },
      )
      expect(policyResponse.status).toBe(422)
      expect(await policyResponse.json()).toMatchObject({
        error: {
          code: 'tracked_mutation_locked',
          fields: [{ code: 'policy_locked' }],
        },
      })

      test.locks.delete(`expense:${policyLocked.id}`)
      await test.database.run(`UPDATE projects SET is_active = 0 WHERE id = 1`)
      const archivedResponse = await test.request(
        `/api/v1/expenses/${policyLocked.id}`,
        {
          method: 'DELETE',
        },
      )
      expect(archivedResponse.status).toBe(422)
      expect(await archivedResponse.json()).toMatchObject({
        error: {
          code: 'tracked_mutation_locked',
          fields: [{ code: 'project_archived' }],
        },
      })

      expect(
        (await test.request('/api/v1/expenses?project_id=1&project_id=2'))
          .status,
      ).toBe(422)
      expect((await test.request('/api/v1/expenses?unknown=true')).status).toBe(
        422,
      )
      expect(
        (await test.request('/api/v1/time-entries?user_id=2')).status,
      ).toBe(403)
      const unknownBody = await test.request(
        '/api/v1/time-entries',
        jsonRequest('POST', { project_id: 1, task_id: 1, invented: true }),
      )
      expect(unknownBody.status).toBe(422)
      expect(await unknownBody.json()).toMatchObject({
        error: { fields: [{ field: 'invented', code: 'unknown' }] },
      })
    })
  })
}
