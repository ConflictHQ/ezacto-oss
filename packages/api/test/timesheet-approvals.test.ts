import { Miniflare } from 'miniflare'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createD1Database } from '../../db/src/adapters.js'
import { migrateD1 } from '../../db/src/migrate.js'
import { createTimesheetApprovalRepository } from '../../db/src/timesheet-approvals.js'
import { DrizzleTrackedResourceRepository } from '../../db/src/tracked-resource-repository.js'
import { createApiApp } from '../src/app.js'
import type { ApiAuthentication } from '../src/auth.js'
import type { UserProfile } from '../src/context.js'
import { installTrackedResourceRoutes } from '../src/resources/index.js'
import { installTimesheetApprovalRoutes } from '../src/timesheet-approvals.js'

const now = '2026-08-31T12:00:00.000Z'
const cursorSigningKey = new Uint8Array(32).fill(0x19)
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
      const rawUserId = request.headers.get('x-test-user')
      if (profile === null || !profiles.includes(profile) || rawUserId === null) return null
      return {
        type: 'user',
        userId: Number(rawUserId),
        profile,
        authentication: { kind: 'session', sessionId: 'approval-api-test' },
      }
    },
  },
}

interface Harness {
  d1: D1Database
  request(
    path: string,
    init?: RequestInit,
    principal?: { userId: number; profile: UserProfile },
  ): Promise<Response>
  close(): Promise<void>
}

const createHarness = async (): Promise<Harness> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const d1 = await miniflare.getD1Database('DB')
  await migrateD1(d1)
  const run = async (sql: string, ...params: unknown[]) => {
    await d1.prepare(sql).bind(...params).run()
  }
  await run(
    `INSERT INTO organizations (name, modules, created_at, updated_at)
     VALUES ('Approval API org', '{"approval":true}', ?, ?)`,
    now,
    now,
  )
  await run(
    `INSERT INTO users
      (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
     VALUES
      (10, 'Ada', 'Admin', 'administrator', '[]', ?, ?),
      (1, 'Maya', 'Member', 'member', '[]', ?, ?),
      (2, 'Priya', 'Manager', 'project_manager', '[]', ?, ?),
      (3, 'Pia', 'People', 'people_admin', '[]', ?, ?)`,
    now,
    now,
    now,
    now,
    now,
    now,
    now,
    now,
  )
  await run(
    `INSERT INTO clients (id, name, currency, created_at, updated_at)
     VALUES (1, 'Approval client', 'USD', ?, ?)`,
    now,
    now,
  )
  await run(
    `INSERT INTO projects (id, client_id, name, created_at, updated_at)
     VALUES (1, 1, 'Approval project', ?, ?)`,
    now,
    now,
  )
  await run(
    `INSERT INTO tasks (id, name, created_at, updated_at)
     VALUES (1, 'Approval task', ?, ?)`,
    now,
    now,
  )
  await run(
    `INSERT INTO user_assignments (id, project_id, user_id, created_at, updated_at)
     VALUES (1, 1, 1, ?, ?)`,
    now,
    now,
  )
  await run(
    `INSERT INTO task_assignments
      (id, project_id, task_id, billable, created_at, updated_at)
     VALUES (1, 1, 1, 1, ?, ?)`,
    now,
    now,
  )
  await run(
    `INSERT INTO teammate_assignments (manager_id, user_id, created_at, updated_at)
     VALUES (2, 1, ?, ?)`,
    now,
    now,
  )
  await run(
    `INSERT INTO time_entries (
      id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
      spent_date, seconds, seconds_without_timer, rounded_seconds, notes,
      billable, created_at, updated_at
    ) VALUES (1, 1, 1, 1, 1, 1, '2026-08-25', 3600, 3600, 3600,
      'Initial work', 1, ?, ?)`,
    now,
    now,
  )

  const database = createD1Database(d1)
  const tracked = new DrizzleTrackedResourceRepository(database, {
    isLocked: async () => false,
  })
  const approvals = createTimesheetApprovalRepository(database)
  const app = createApiApp({
    authentication,
    installApi: (api) => {
      installTrackedResourceRoutes(api, {
        repository: tracked,
        cursorSigningKey,
        clock: { now: () => ({ instant: now, date: '2026-08-31', time: '12:00' }) },
      })
      installTimesheetApprovalRoutes(api, {
        service: approvals,
        cursorSigningKey,
        clock: () => now,
      })
    },
  })
  return {
    d1,
    request: (path, init = {}, principal = { userId: 1, profile: 'member' }) => {
      const headers = new Headers(init.headers)
      headers.set('origin', 'https://api.test')
      headers.set('x-test-user', String(principal.userId))
      headers.set('x-test-profile', principal.profile)
      return Promise.resolve(
        app.request(`https://api.test/api/v1${path}`, { ...init, headers }),
      )
    },
    close: () => miniflare.dispose(),
  }
}

describe('timesheet approval API', () => {
  let harness: Harness

  beforeEach(async () => {
    harness = await createHarness()
  })

  afterEach(async () => harness.close())

  it('[api][e2e:approve-lock] rejects visibly, resubmits, approves, and locks over real D1', async () => {
    const submit = await harness.request('/timesheet-submissions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ period_start: '2026-08-24', period_end: '2026-08-30' }),
    })
    expect(submit.status).toBe(201)
    const submitted = (await submit.json()) as { data: { id: number; status: string } }
    expect(submitted.data.status).toBe('submitted')

    const ownerRead = await harness.request(`/timesheet-submissions/${submitted.data.id}`)
    expect(ownerRead.status).toBe(200)
    expect((await ownerRead.json()) as object).toMatchObject({
      data: {
        id: submitted.data.id,
        user_id: 1,
        entries: [
          {
            id: 1,
            spent_date: '2026-08-25',
            project_id: 1,
            project_name: 'Approval project',
            task_id: 1,
            task_name: 'Approval task',
            seconds: 3600,
            notes: 'Initial work',
          },
        ],
      },
      links: { self: `/api/v1/timesheet-submissions/${submitted.data.id}` },
    })

    const approverRead = await harness.request(
      `/timesheet-submissions/${submitted.data.id}`,
      {},
      { userId: 2, profile: 'project_manager' },
    )
    expect(approverRead.status).toBe(200)

    const deniedRead = await harness.request(
      `/timesheet-submissions/${submitted.data.id}`,
      {},
      { userId: 3, profile: 'people_admin' },
    )
    expect(deniedRead.status).toBe(403)

    const unassignedManagerRead = await harness.request(
      `/timesheet-submissions/${submitted.data.id}`,
      {},
      { userId: 10, profile: 'project_manager' },
    )
    expect(unassignedManagerRead.status).toBe(403)

    const queue = await harness.request(
      '/timesheet-submissions/pending',
      {},
      { userId: 2, profile: 'project_manager' },
    )
    expect(queue.status).toBe(200)
    expect((await queue.json()) as object).toMatchObject({
      data: [{ id: submitted.data.id, user_id: 1, status: 'submitted', total_seconds: 3600 }],
    })

    const reject = await harness.request(
      `/timesheet-submissions/${submitted.data.id}/reject`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'Add a client-facing outcome.' }),
      },
      { userId: 2, profile: 'project_manager' },
    )
    expect(reject.status).toBe(200)
    expect((await reject.json()) as object).toMatchObject({
      data: { status: 'unsubmitted', rejection_reason: 'Add a client-facing outcome.' },
    })

    const edit = await harness.request('/time-entries/1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ notes: 'Delivered the client-facing outcome.' }),
    })
    expect(edit.status).toBe(200)
    expect((await edit.json()) as object).toMatchObject({
      data: { approval_status: 'unsubmitted', is_locked: false },
    })

    const resubmit = await harness.request('/timesheet-submissions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ period_start: '2026-08-24', period_end: '2026-08-30' }),
    })
    expect(resubmit.status).toBe(200)
    expect((await resubmit.json()) as object).toMatchObject({
      data: { status: 'submitted', rejection_reason: null, version: 2 },
    })

    const approve = await harness.request(
      `/timesheet-submissions/${submitted.data.id}/approve`,
      { method: 'POST' },
      { userId: 10, profile: 'administrator' },
    )
    expect(approve.status).toBe(200)
    expect((await approve.json()) as object).toMatchObject({ data: { status: 'approved' } })

    const entry = await harness.request('/time-entries/1')
    expect(entry.status).toBe(200)
    expect((await entry.json()) as object).toMatchObject({
      data: {
        approval_status: 'approved',
        is_locked: true,
        locked_reason_code: 'approved',
        locked_reason: 'Approved',
      },
    })
    const lockedEdit = await harness.request('/time-entries/1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ notes: 'Cannot change this.' }),
    })
    expect(lockedEdit.status).toBe(422)
    expect((await lockedEdit.json()) as object).toMatchObject({
      error: {
        code: 'tracked_mutation_locked',
        fields: [{ field: 'time_entry', code: 'approved' }],
      },
    })
  })

  it('[api] module off makes every endpoint indistinguishable from missing before validation', async () => {
    await harness.d1
      .prepare(`UPDATE organizations SET modules = '{"approval":false}' WHERE id = 1`)
      .run()
    const cases: Array<[string, RequestInit]> = [
      ['/timesheet-submissions?period_start=not-a-date', {}],
      ['/timesheet-submissions/pending', {}],
      ['/timesheet-submissions/not-an-id', {}],
      ['/timesheet-submissions', { method: 'POST', body: 'not-json' }],
      ['/timesheet-submissions/not-an-id/approve', { method: 'POST' }],
      ['/timesheet-submissions/not-an-id/reject', { method: 'POST' }],
    ]
    for (const [path, init] of cases) {
      const response = await harness.request(path, init, {
        userId: 10,
        profile: 'administrator',
      })
      expect(response.status, path).toBe(404)
      expect((await response.json()) as object).toMatchObject({ error: { code: 'not_found' } })
    }
    expect(
      await harness.d1
        .prepare(
          `SELECT approval_status, timesheet_submission_id FROM time_entries WHERE id = 1`,
        )
        .first(),
    ).toEqual({ approval_status: 'unsubmitted', timesheet_submission_id: null })
    expect(
      await harness.d1.prepare(`SELECT count(*) AS count FROM timesheet_submissions`).first(),
    ).toEqual({ count: 0 })
  })

  it('[api] accepts inclusive periods through 31 days and rejects longer ranges', async () => {
    const tooLong = await harness.request('/timesheet-submissions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ period_start: '2026-07-31', period_end: '2026-08-31' }),
    })
    expect(tooLong.status).toBe(422)
    expect((await tooLong.json()) as object).toMatchObject({
      error: {
        code: 'validation_failed',
        fields: [{ field: 'period_end', code: 'invalid_range' }],
      },
    })

    const maximum = await harness.request('/timesheet-submissions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ period_start: '2026-08-01', period_end: '2026-08-31' }),
    })
    expect(maximum.status).toBe(201)
    expect((await maximum.json()) as object).toMatchObject({
      data: { period_start: '2026-08-01', period_end: '2026-08-31' },
    })
  })

  it('[api] exposes and reviews a truthful post-migration Harvest submission over real D1', async () => {
    await harness.d1
      .prepare(
        `INSERT INTO time_entries (
          id, harvest_id, user_id, project_id, task_id, user_assignment_id,
          task_assignment_id, spent_date, seconds, seconds_without_timer,
          rounded_seconds, notes, billable, approval_status, source_approval_status,
          created_at, updated_at
        ) VALUES (2, 'harvest-submitted', 1, 1, 1, 1, 1, '2026-08-18',
          1800, 1800, 1800, 'Imported review detail', 1,
          'unsubmitted', 'submitted', ?, ?)`,
      )
      .bind(now, now)
      .run()
    const aggregate = await harness.d1
      .prepare(`SELECT id FROM timesheet_submissions WHERE period_start = '2026-08-17'`)
      .first<{ id: number }>()
    expect(aggregate).not.toBeNull()

    const detail = await harness.request(`/timesheet-submissions/${aggregate!.id}`)
    expect(detail.status).toBe(200)
    expect((await detail.json()) as object).toMatchObject({
      data: {
        origin: 'harvest_import',
        source_status: 'submitted',
        source_observed_at: now,
        submitted_by_user_id: null,
        submitted_at: null,
        status: 'submitted',
        entries: [{ id: 2, notes: 'Imported review detail' }],
      },
    })
    const approve = await harness.request(
      `/timesheet-submissions/${aggregate!.id}/approve`,
      { method: 'POST' },
      { userId: 10, profile: 'administrator' },
    )
    expect(approve.status).toBe(200)
    expect((await approve.json()) as object).toMatchObject({
      data: {
        origin: 'harvest_import',
        submitted_by_user_id: null,
        submitted_at: null,
        reviewed_by_user_id: 10,
        reviewed_at: now,
        status: 'approved',
      },
    })
  })

  it('[security] rejects non-approver profiles and requires a rejection reason', async () => {
    const submit = await harness.request('/timesheet-submissions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ period_start: '2026-08-24', period_end: '2026-08-30' }),
    })
    const id = ((await submit.json()) as { data: { id: number } }).data.id
    for (const profile of ['member', 'people_admin', 'accounting'] as const) {
      const response = await harness.request(
        '/timesheet-submissions/pending',
        {},
        { userId: profile === 'member' ? 1 : 3, profile },
      )
      expect(response.status).toBe(403)
    }
    const missingReason = await harness.request(
      `/timesheet-submissions/${id}/reject`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: '  ' }),
      },
      { userId: 10, profile: 'administrator' },
    )
    expect(missingReason.status).toBe(422)
    expect((await missingReason.json()) as object).toMatchObject({
      error: { code: 'validation_failed', fields: [{ field: 'reason' }] },
    })
  })
})
