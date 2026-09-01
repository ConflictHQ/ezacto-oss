import { Miniflare } from 'miniflare'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createD1Database } from '../../db/src/adapters.js'
import { migrateD1 } from '../../db/src/migrate.js'
import { createTimesheetApprovalRepository } from '../../db/src/timesheet-approvals.js'
import { createTimesheetLockPolicyRepository } from '../../db/src/timesheet-lock-policy.js'
import { createApiApp } from '../src/app.js'
import type { ApiAuthentication } from '../src/auth.js'
import type { UserProfile } from '../src/context.js'
import { installTimesheetApprovalRoutes } from '../src/timesheet-approvals.js'
import { installTimesheetLockPolicyRoutes } from '../src/timesheet-lock-policy.js'

const now = '2026-09-07T21:00:00.000Z'
const cursorSigningKey = new Uint8Array(32).fill(0x18)

const authentication: ApiAuthentication = {
  tokens: {
    authenticate: async (token) => token === 'limited'
      ? { tokenId: 18, userId: 1, profile: 'administrator', scopes: [] }
      : null,
    issue: async () => { throw new Error('not used') },
    list: async () => [],
    revoke: async () => null,
  },
  sessions: {
    resolve: async (request) => {
      const rawUserId = request.headers.get('x-test-user')
      const profile = request.headers.get('x-test-profile') as UserProfile | null
      if (rawUserId === null || profile === null) return null
      return {
        type: 'user',
        userId: Number(rawUserId),
        profile,
        authentication: { kind: 'session', sessionId: 'lock-policy-api-test' },
      }
    },
  },
}

interface Harness {
  submissionId: number
  request(
    path: string,
    init?: RequestInit,
    principal?: { userId: number; profile: UserProfile },
  ): Promise<Response>
  setApprovalEnabled(enabled: boolean): Promise<void>
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
  const run = async (sql: string, ...params: unknown[]): Promise<void> => {
    await d1.prepare(sql).bind(...params).run()
  }
  await run(
    `INSERT INTO organizations (name, modules, created_at, updated_at)
     VALUES ('Lock API org', '{"approval":true}', ?, ?)`,
    now,
    now,
  )
  await run(
    `INSERT INTO users
      (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
     VALUES
      (1, 'Ada', 'Admin', 'administrator', '[]', ?, ?),
      (2, 'Eve', 'Executive', 'executive_manager', '[]', ?, ?),
      (3, 'Pat', 'Manager', 'project_manager', '[]', ?, ?),
      (4, 'Maya', 'Member', 'member', '[]', ?, ?)`,
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
     VALUES (1, 'Lock client', 'USD', ?, ?)`,
    now,
    now,
  )
  await run(
    `INSERT INTO projects (id, client_id, name, created_at, updated_at)
     VALUES (1, 1, 'Lock project', ?, ?)`,
    now,
    now,
  )
  await run(
    `INSERT INTO tasks (id, name, created_at, updated_at)
     VALUES (1, 'Lock task', ?, ?)`,
    now,
    now,
  )
  await run(
    `INSERT INTO user_assignments (id, project_id, user_id, created_at, updated_at)
     VALUES (1, 1, 4, ?, ?)`,
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
    `INSERT INTO time_entries (
      id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
      spent_date, seconds, seconds_without_timer, rounded_seconds, billable,
      created_at, updated_at
    ) VALUES (1, 4, 1, 1, 1, 1, '2026-08-25', 3600, 3600, 3600, 1, ?, ?)`,
    now,
    now,
  )

  const database = createD1Database(d1)
  const approvals = createTimesheetApprovalRepository(database)
  const submitted = await approvals.submit(4, '2026-08-24', '2026-08-30', now)
  await approvals.approve(
    { userId: 1, profile: 'administrator' },
    submitted.id,
    now,
  )
  await run(`UPDATE organizations SET modules = '{"approval":false}' WHERE id = 1`)
  const service = createTimesheetLockPolicyRepository(database, {
    clock: () => now,
  })
  const app = createApiApp({
    authentication,
    installApi: (api) => {
      installTimesheetApprovalRoutes(api, {
        service: approvals,
        cursorSigningKey,
        clock: () => now,
      })
      installTimesheetLockPolicyRoutes(api, {
        service,
        cursorSigningKey,
        clock: () => now,
      })
    },
  })
  return {
    submissionId: submitted.id,
    request: (path, init = {}, principal = { userId: 1, profile: 'administrator' }) => {
      const headers = new Headers(init.headers)
      headers.set('origin', 'https://api.test')
      headers.set('x-test-user', String(principal.userId))
      headers.set('x-test-profile', principal.profile)
      return Promise.resolve(
        app.request(`https://api.test/api/v1${path}`, { ...init, headers }),
      )
    },
    setApprovalEnabled: (enabled) => run(
      `UPDATE organizations SET modules = json_set(modules, '$.approval', json(?)) WHERE id = 1`,
      enabled ? 'true' : 'false',
    ),
    close: () => miniflare.dispose(),
  }
}

describe('timesheet lock policy API', () => {
  let harness: Harness

  beforeEach(async () => {
    harness = await createHarness()
  })

  afterEach(async () => harness.close())

  it('[api][e2e:lock-policy] manages durable weekly and manual locks over real D1', async () => {
    const denied = await harness.request(
      '/timesheet-lock-policy',
      {},
      { userId: 3, profile: 'project_manager' },
    )
    expect(denied.status).toBe(403)

    const updated = await harness.request('/timesheet-lock-policy', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        auto_lock: true,
        timesheet_deadline: { day: 'monday', time: '17:00' },
        timezone: 'America/New_York',
      }),
    })
    expect(updated.status).toBe(200)
    expect(await updated.json()).toMatchObject({
      data: {
        auto_lock: true,
        timesheet_deadline: { day: 'monday', time: '17:00' },
        timezone: 'America/New_York',
        week_start_day: 'monday',
      },
    })

    const automatic = await harness.request('/timesheet-locks?active=true&kind=auto')
    expect(automatic.status).toBe(200)
    expect(await automatic.json()).toMatchObject({
      data: [
        {
          kind: 'auto',
          period_start: '2026-08-24',
          period_end: '2026-08-30',
          active: true,
        },
      ],
    })

    const disabledWithdrawal = await harness.request(
      `/timesheet-submissions/${harness.submissionId}/withdraw`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'Correct an approved expense' }),
      },
      { userId: 2, profile: 'executive_manager' },
    )
    expect(disabledWithdrawal.status).toBe(404)
    const disabledMemberWithdrawal = await harness.request(
      `/timesheet-submissions/${harness.submissionId}/withdraw`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'Must remain hidden' }),
      },
      { userId: 4, profile: 'member' },
    )
    expect(disabledMemberWithdrawal.status).toBe(404)
    const disabledTokenWithdrawal = await harness.request(
      `/timesheet-submissions/${harness.submissionId}/withdraw`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer limited',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ reason: 'Must remain hidden' }),
      },
    )
    expect(disabledTokenWithdrawal.status).toBe(404)

    await harness.setApprovalEnabled(true)
    const withdrawn = await harness.request(
      `/timesheet-submissions/${harness.submissionId}/withdraw`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'Correct an approved expense' }),
      },
      { userId: 2, profile: 'executive_manager' },
    )
    expect(withdrawn.status).toBe(200)
    const withdrawnBody = await withdrawn.json() as {
      data: { id: number }
      links: { self: string }
    }
    expect(withdrawnBody).toMatchObject({
      data: {
        id: harness.submissionId,
        status: 'unsubmitted',
        rejection_reason: 'Correct an approved expense',
      },
    })
    const withdrawalSelf = await harness.request(
      withdrawnBody.links.self.replace('/api/v1', ''),
      {},
      { userId: 2, profile: 'executive_manager' },
    )
    expect(withdrawalSelf.status).toBe(200)
    expect(await withdrawalSelf.json()).toMatchObject({
      data: { id: harness.submissionId, status: 'unsubmitted' },
    })

    const missingCommand = await harness.request('/timesheet-locks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        locked_through: '2026-08-31',
        reason: 'Month-end close',
      }),
    })
    expect(missingCommand.status).toBe(422)

    const created = await harness.request('/timesheet-locks', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'lock-api-retry',
      },
      body: JSON.stringify({
        locked_through: '2026-08-31',
        reason: 'Month-end close',
      }),
    })
    expect(created.status).toBe(201)
    const manual = (await created.json()) as {
      data: { id: number; kind: string; reason: string; active: boolean }
      links: { self: string }
    }
    expect(manual.data).toMatchObject({
      kind: 'manual',
      reason: 'Month-end close',
      active: true,
    })
    const replay = await harness.request('/timesheet-locks', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'lock-api-retry',
      },
      body: JSON.stringify({
        locked_through: '2026-08-31',
        reason: 'Month-end close',
      }),
    })
    expect(replay.status).toBe(201)
    expect(await replay.json()).toEqual(manual)
    const reused = await harness.request('/timesheet-locks', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'lock-api-retry',
      },
      body: JSON.stringify({
        locked_through: '2026-08-30',
        reason: 'Different close',
      }),
    })
    expect(reused.status).toBe(409)
    expect(await reused.json()).toMatchObject({
      error: { code: 'command_id_reused' },
    })
    expect(manual.links.self).toBe(`/api/v1/timesheet-locks/${manual.data.id}`)

    const fetched = await harness.request(manual.links.self.replace('/api/v1', ''))
    expect(fetched.status).toBe(200)
    expect(await fetched.json()).toEqual(manual)

    const forbidden = await harness.request(
      manual.links.self.replace('/api/v1', ''),
      {},
      { userId: 3, profile: 'project_manager' },
    )
    expect(forbidden.status).toBe(403)

    const absent = await harness.request('/timesheet-locks/999999')
    expect(absent.status).toBe(404)
    expect(await absent.json()).toMatchObject({ error: { code: 'not_found' } })

    const unlocked = await harness.request(`/timesheet-locks/${manual.data.id}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'Correction window' }),
    })
    expect(unlocked.status).toBe(200)
    expect(await unlocked.json()).toMatchObject({
      data: {
        id: manual.data.id,
        active: false,
        unlock_reason: 'Correction window',
      },
    })

    const fetchedUnlocked = await harness.request(
      manual.links.self.replace('/api/v1', ''),
    )
    expect(fetchedUnlocked.status).toBe(200)
    expect(await fetchedUnlocked.json()).toMatchObject({
      data: { id: manual.data.id, active: false },
    })

    const invalid = await harness.request('/timesheet-lock-policy', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timezone: 'Mars/Olympus' }),
    })
    expect(invalid.status).toBe(422)
  })
})
