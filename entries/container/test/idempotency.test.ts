import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApiTokenStore, createContainerDatabase } from '@ezacto/db'
import { createQueuedMailer, type EmailMessage, type HttpEmailProvider } from '@ezacto/mailer'
import { createApp } from '../../worker/src/app.js'
import type { ContainerConfig } from '../src/config.js'
import { createContainerHandler } from '../src/handler.js'
import { ContainerEmailQueue } from '../src/email-queue.js'
import { createContainerRuntime, type ContainerRuntime } from '../src/runtime.js'

/**
 * Idempotency keys through the container (#952): the real runtime, its
 * repositories writing through better-sqlite3 transactions, and the handler
 * `index.ts` serves with.
 */

const timestamp = '2026-10-07T12:00:00.000Z'
let root: string
let runtime: ContainerRuntime
let handle: (request: Request) => Promise<Response>
let bearer: string

const provider = (messages: EmailMessage[]): HttpEmailProvider => ({
  name: 'smtp',
  async send(message, options) {
    messages.push(message)
    return { messageId: `<${options.idempotencyKey}@capture.test>`, latencyMs: 1 }
  },
})

beforeAll(async () => {
  // realpath: the runtime refuses a symlinked path, and macOS's $TMPDIR is one.
  root = await realpath(await mkdtemp(join(tmpdir(), 'ezacto-idempotency-')))
  const config: ContainerConfig = {
    host: '127.0.0.1',
    port: 3000,
    trustedProxyHops: 0,
    dataDirectory: root,
    databasePath: join(root, 'db.sqlite'),
    attachmentDirectory: join(root, 'attachments'),
    brandDirectory: join(root, 'brand'),
    appBaseUrl: 'http://localhost:3000',
    cursorSigningKey: new Uint8Array(32).fill(0x43),
    smtp: { url: 'smtp://127.0.0.1:2525', from: 'billing@example.test' },
    appEnv: {
      ENVIRONMENT: 'test-container',
      RELEASE: 'container-idempotency-test',
      APP_BASE_URL: 'http://localhost:3000',
    },
  }
  runtime = await createContainerRuntime(config, { emailProvider: provider([]) })
  handle = createContainerHandler(
    runtime.services,
    createApp(runtime.services, runtime.brandAssets, runtime.instanceTheme),
    config.appEnv,
  )
  const seed = (sql: string, ...params: unknown[]) => runtime.database.prepare(sql).run(...params)
  seed(
    `INSERT INTO organizations (id, name, time_entry_mode, time_rounding, modules, created_at, updated_at)
     VALUES (1, 'Container Organization', 'duration', 'none', ?, ?, ?)`,
    JSON.stringify({ expenses: false, invoices: false, approval: false }),
    timestamp,
    timestamp,
  )
  seed(
    `INSERT INTO users (id, first_name, last_name, profile, manager_grants,
       has_access_to_all_future_projects, created_at, updated_at)
     VALUES (2, 'Container', 'Owner', 'administrator', '[]', 1, ?, ?)`,
    timestamp,
    timestamp,
  )
  seed(
    `INSERT INTO users (id, first_name, last_name, profile, manager_grants,
       has_access_to_all_future_projects, created_at, updated_at)
     VALUES (1, 'Container', 'Member', 'member', '[]', 0, ?, ?)`,
    timestamp,
    timestamp,
  )
  seed(
    `INSERT INTO clients (id, name, currency, created_at, updated_at)
     VALUES (1, 'Container Client', 'USD', ?, ?)`,
    timestamp,
    timestamp,
  )
  seed(
    `INSERT INTO projects (id, client_id, name, code, hourly_rate_cents, budget_by, budget_seconds,
       created_at, updated_at)
     VALUES (1, 1, 'Container Project', 'CON', 10000, 'none', NULL, ?, ?)`,
    timestamp,
    timestamp,
  )
  seed(`INSERT INTO tasks (id, name, created_at, updated_at) VALUES (1, 'Container Task', ?, ?)`, timestamp, timestamp)
  seed(
    `INSERT INTO user_assignments (id, project_id, user_id, created_at, updated_at) VALUES (1, 1, 1, ?, ?)`,
    timestamp,
    timestamp,
  )
  seed(
    `INSERT INTO task_assignments (id, project_id, task_id, billable, created_at, updated_at)
     VALUES (1, 1, 1, 1, ?, ?)`,
    timestamp,
    timestamp,
  )
  bearer = (
    await createApiTokenStore(createContainerDatabase(runtime.database), { now: () => timestamp }).issue({
      userId: 1,
      name: 'Container idempotency test',
      scopes: ['time_entries:read', 'time_entries:write'],
    })
  ).token
})

afterAll(async () => {
  await runtime.close()
  await rm(root, { recursive: true, force: true })
})

const logTime = (key: string | null, notes: string, credential = bearer): Promise<Response> =>
  handle(
    new Request('http://localhost:3000/api/v1/time-entries', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credential}`,
        'content-type': 'application/json',
        ...(key === null ? {} : { 'idempotency-key': key }),
      },
      body: JSON.stringify({ project_id: 1, task_id: 1, spent_date: '2026-10-06', seconds: 1800, notes }),
    }),
  )

const entriesNoted = (notes: string): number =>
  (runtime.database.prepare('SELECT count(*) AS n FROM time_entries WHERE notes = ?').get(notes) as { n: number }).n

describe('Idempotency-Key through the container (#952)', () => {
  it('[api] creates a keyed time entry once and replays its exact answer to the retry', async () => {
    const first = await logTime('container-952-once', 'container 952 once')
    expect(first.status).toBe(201)
    expect(first.headers.get('idempotency-key-lifetime')).toBe('86400')
    const created = await first.text()

    const retry = await logTime('container-952-once', 'container 952 once')
    expect(retry.status).toBe(201)
    expect(retry.headers.get('idempotent-replayed')).toBe('true')
    expect(await retry.text()).toBe(created)
    expect(entriesNoted('container 952 once')).toBe(1)
    expect(
      runtime.database
        .prepare(`SELECT state, sealed IS NOT NULL AS kept FROM idempotency_keys WHERE state = 'done'`)
        .all(),
    ).toContainEqual({ state: 'done', kept: 1 })
  })

  it('[api] lands concurrent copies of one keyed write exactly once', async () => {
    const answers = await Promise.all(
      Array.from({ length: 3 }, () => logTime('container-952-race', 'container 952 race')),
    )
    for (const answer of answers) expect([201, 503]).toContain(answer.status)
    expect(entriesNoted('container 952 race')).toBe(1)
    const settled = await logTime('container-952-race', 'container 952 race')
    expect(settled.headers.get('idempotent-replayed')).toBe('true')
    expect(entriesNoted('container 952 race')).toBe(1)
  })

  it('[security] holds a key to the request it first carried', async () => {
    expect((await logTime('container-952-bound', 'container 952 bound')).status).toBe(201)
    const reused = await logTime('container-952-bound', 'container 952 other')
    expect(reused.status).toBe(422)
    expect(await reused.json()).toMatchObject({ error: { code: 'idempotency_key_reused' } })
    expect(entriesNoted('container 952 other')).toBe(0)
  })

  it('[security] refuses a cached response after its API token is revoked', async () => {
    const tokens = createApiTokenStore(createContainerDatabase(runtime.database))
    const issued = await tokens.issue({
      userId: 1,
      name: 'Revoked replay credential',
      scopes: ['time_entries:read', 'time_entries:write'],
    })
    const key = 'container-952-revoked'
    const notes = 'container 952 revoked'
    expect((await logTime(key, notes, issued.token)).status).toBe(201)
    await tokens.revoke(1, issued.id)

    const retry = await logTime(key, notes, issued.token)
    expect(retry.status).toBe(401)
    expect(retry.headers.get('idempotent-replayed')).toBeNull()
    expect(await retry.json()).toMatchObject({ error: { code: 'authentication_required' } })
    expect(entriesNoted(notes)).toBe(1)
  })

  it('[security] refuses a cached response after the token owner is disabled', async () => {
    const key = 'container-952-disabled'
    const notes = 'container 952 disabled'
    expect((await logTime(key, notes)).status).toBe(201)
    runtime.database.prepare('UPDATE users SET is_active = 0 WHERE id = 1').run()
    try {
      const retry = await logTime(key, notes)
      expect(retry.status).toBe(401)
      expect(retry.headers.get('idempotent-replayed')).toBeNull()
      expect(entriesNoted(notes)).toBe(1)
    } finally {
      runtime.database.prepare('UPDATE users SET is_active = 1 WHERE id = 1').run()
    }
  })

  it('[security] checks session CSRF and revocation before a replay', async () => {
    const issued = await runtime.services.sessions.issue(1)
    const cookie = issued.setCookie.split(';')[0]!
    const notes = 'container 952 session'
    const send = (origin: string) => handle(new Request('http://localhost:3000/api/v1/time-entries', {
      method: 'POST',
      headers: { cookie, origin, 'content-type': 'application/json', 'idempotency-key': 'container-952-session' },
      body: JSON.stringify({ project_id: 1, task_id: 1, spent_date: '2026-10-06', seconds: 1800, notes }),
    }))
    expect((await send('http://localhost:3000')).status).toBe(201)
    const csrf = await send('https://stranger.test')
    expect(csrf.status).toBe(403)
    expect(await csrf.json()).toMatchObject({ error: { code: 'csrf_origin_mismatch' } })
    expect((await send('http://localhost:3000')).headers.get('idempotent-replayed')).toBe('true')
    await runtime.services.sessions.revoke(1, issued.session.id)
    expect((await send('http://localhost:3000')).status).toBe(401)
    expect(entriesNoted(notes)).toBe(1)
  })

  it('[security] returns a rotated session without replaying the old privilege response', async () => {
    const issued = await runtime.services.sessions.issue(1)
    const cookie = issued.setCookie.split(';')[0]!
    const notes = 'container 952 privilege'
    const send = (credential: string, key = 'container-952-privilege') => handle(new Request('http://localhost:3000/api/v1/time-entries', {
      method: 'POST',
      headers: { cookie: credential, origin: 'http://localhost:3000', 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ project_id: 1, task_id: 1, spent_date: '2026-10-06', seconds: 1800, notes }),
    }))
    expect((await send(cookie)).status).toBe(201)
    runtime.database.prepare("UPDATE users SET profile = 'administrator' WHERE id = 1").run()
    try {
      const retry = await send(cookie)
      expect(retry.status).toBe(409)
      expect(await retry.json()).toMatchObject({ error: { code: 'authentication_changed' } })
      const replacement = retry.headers.getSetCookie()[0]!.split(';')[0]!
      expect(replacement).not.toBe(cookie)
      expect((await send(replacement)).status).toBe(409)
      expect(entriesNoted(notes)).toBe(1)
      expect((await send(replacement, 'container-952-new-privilege')).status).toBe(201)
      expect(entriesNoted(notes)).toBe(2)
    } finally {
      runtime.database.prepare("UPDATE users SET profile = 'member' WHERE id = 1").run()
    }
  })

  it('[api] finishes queued mail after its keyed request closes and replays without another delivery', async () => {
    const messages: EmailMessage[] = []
    let started!: () => void
    const sending = new Promise<void>((resolve) => { started = resolve })
    const queue = new ContainerEmailQueue(runtime.services.emailLog, {
      name: 'smtp',
      send: async (message) => {
        messages.push(message)
        started()
        return { messageId: '<idempotency-queue@capture.test>', latencyMs: 1 }
      },
    })
    const mailer = createQueuedMailer(runtime.services.emailLog, queue)
    const mailHandle = createContainerHandler(runtime.services, {
      fetch: async () => Response.json(await mailer.enqueue({
        from: { email: 'billing@example.test' },
        to: [{ email: 'owner@example.test' }],
        template: 'verify_email', subject: 'Queued after the response', text: 'Delivery test',
      }), { status: 201 }),
    }, { ENVIRONMENT: 'test-container', RELEASE: 'idempotency-mail-test' })
    const request = () => new Request('http://localhost:3000/api/v1/mail-test', {
      method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'idempotency-key': 'container-952-mail' },
    })
    try {
      const first = await mailHandle(request())
      expect(first.status).toBe(201)
      const record = await first.json() as { id: number }
      // Let the timer inherit the now-closed HTTP scope; do not accelerate it
      // with close(), which is called from the test's independent scope.
      await sending
      await queue.close(2_000)
      expect((await runtime.services.emailLog.get(record.id))?.status).toBe('sent')
      const retry = await mailHandle(request())
      expect(retry.headers.get('idempotent-replayed')).toBe('true')
      expect(messages).toHaveLength(1)
    } finally {
      await queue.close(2_000)
    }
  })

  it('[security] does not replay a team assignment after manager access is removed', async () => {
    runtime.database.prepare("UPDATE organizations SET modules = ? WHERE id = 1").run(JSON.stringify({ expenses: false, invoices: false, approval: false, team: true }))
    runtime.database.prepare("INSERT INTO users (id, first_name, last_name, profile, manager_grants, has_access_to_all_future_projects, created_at, updated_at) VALUES (3, 'Scope', 'Manager', 'project_manager', '[]', 0, ?, ?)").run(timestamp, timestamp)
    runtime.database.prepare("INSERT INTO user_assignments (id, project_id, user_id, is_project_manager, created_at, updated_at) VALUES (2, 1, 3, 1, ?, ?)").run(timestamp, timestamp)
    const issued = await runtime.services.sessions.issue(3)
    const cookie = issued.setCookie.split(';')[0]!
    const request = (method: string, keyed = false) => handle(new Request('http://localhost:3000/api/v1/user-assignments/1', {
      method, headers: { cookie, origin: 'http://localhost:3000', 'content-type': 'application/json', ...(keyed ? {'idempotency-key':'manager-scope-change'} : {}) },
      ...(method === 'PATCH' ? { body: JSON.stringify({budget_seconds:7200}) } : {}),
    }))
    const first = await request('PATCH', true)
    expect(first.status, await first.clone().text()).toBe(200)
    expect((await request('PATCH', true)).headers.get('idempotent-replayed')).toBe('true')
    runtime.database.prepare('UPDATE user_assignments SET is_active = 0 WHERE id = 2').run()
    const read = await request('GET')
    expect(read.status, await read.clone().text()).toBe(404)
    const retry = await request('PATCH', true)
    expect(retry.status, await retry.clone().text()).toBe(409)
    expect(retry.headers.get('idempotent-replayed')).toBeNull()
  })

  it('[api] runs an unkeyed write every time, and leaves the shell alone', async () => {
    expect((await logTime(null, 'container 952 unkeyed')).status).toBe(201)
    expect((await logTime(null, 'container 952 unkeyed')).status).toBe(201)
    expect(entriesNoted('container 952 unkeyed')).toBe(2)
    const page = await handle(new Request('http://localhost:3000/'))
    expect(page.headers.get('idempotency-key-lifetime')).toBeNull()
  })
})
