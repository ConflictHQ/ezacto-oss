import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import type { EmailMessage, HttpEmailProvider } from '@ezacto/mailer'
import { createApp } from '../../worker/src/app.js'
import type { ContainerConfig } from '../src/config.js'
import { createContainerRuntime } from '../src/runtime.js'

const roots: string[] = []
const temporary = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'ezacto-container-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

const config = (root: string): ContainerConfig => ({
  host: '127.0.0.1',
  port: 3000,
  dataDirectory: root,
  databasePath: join(root, 'db.sqlite'),
  attachmentDirectory: join(root, 'attachments'),
  appBaseUrl: 'http://localhost:3000',
  cursorSigningKey: new Uint8Array(32).fill(0x43),
  smtp: {
    url: 'smtp://127.0.0.1:2525',
    from: 'billing@example.test',
  },
  appEnv: {
    ENVIRONMENT: 'test-container',
    RELEASE: 'container-test',
    APP_BASE_URL: 'http://localhost:3000',
  },
})

const provider = (messages: EmailMessage[]): HttpEmailProvider => ({
  name: 'smtp',
  async send(message, options) {
    messages.push(message)
    return {
      messageId: `<${options.idempotencyKey}@capture.test>`,
      latencyMs: 1,
    }
  },
})

const body = (value: unknown): RequestInit => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    origin: 'http://localhost:3000',
  },
  body: JSON.stringify(value),
})

const data = async <T>(response: Response): Promise<T> => {
  const payload = (await response.json()) as { data?: T; error?: unknown }
  expect(response.status, JSON.stringify(payload)).toBeLessThan(300)
  return payload.data as T
}

describe('container runtime composition', () => {
  it('[e2e:first-run] signs up, verifies, signs in, tracks, and reads after a restart', async () => {
    const root = await temporary()
    const captured: EmailMessage[] = []
    const configuration = config(root)
    const first = await createContainerRuntime(configuration, {
      emailProvider: provider(captured),
    })
    const firstApp = createApp(first.services)
    const request = (path: string, init: RequestInit = {}) =>
      firstApp.request(
        `${configuration.appBaseUrl}${path}`,
        init,
        configuration.appEnv,
      )

    expect(first.database.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(first.database.pragma('synchronous', { simple: true })).toBe(2)
    expect(first.database.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(first.database.pragma('busy_timeout', { simple: true })).toBe(5_000)
    expect(first.database.pragma('wal_autocheckpoint', { simple: true })).toBe(
      1_000,
    )
    expect(
      first.database
        .prepare('SELECT id FROM _ezacto_migrations ORDER BY id DESC LIMIT 1')
        .get(),
    ).toEqual({ id: '0029_outbox_delivery' })

    await first.drainOutbox()
    const eventAt = '2026-01-02T03:04:05.000Z'
    first.database
      .prepare(
        `INSERT INTO event_outbox (
          id, aggregate_type, aggregate_id, aggregate_sequence,
          event_type, payload_json, occurred_at, available_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'container-event-1',
        'fixture',
        92,
        1,
        'fixture.committed',
        JSON.stringify({ schema_version: 1, event_type: 'fixture.committed' }),
        eventAt,
        eventAt,
      )
    await first.drainOutbox()
    expect(
      first.database
        .prepare(
          `SELECT receipt.status, activity.recorded_at AS recordedAt
           FROM outbox_delivery_receipts receipt
           JOIN activity_log activity ON activity.event_id = receipt.event_id
           WHERE receipt.event_id = ?`,
        )
        .get('container-event-1'),
    ).toMatchObject({ status: 'delivered', recordedAt: expect.any(String) })

    const signup = await request(
      '/auth/signup',
      body({
        organization_name: 'Container Studio',
        first_name: 'Avery',
        last_name: 'Ng',
        email: 'owner@example.test',
        password: 'correct horse battery staple',
      }),
    )
    expect(signup.status).toBe(202)
    for (let attempt = 0; captured.length === 0 && attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(captured).toHaveLength(1)
    const token = /ezacto_verify_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{43}/u.exec(
      captured[0]!.text,
    )?.[0]
    expect(token).toBeTruthy()

    expect(
      (
        await request('/auth/verify-email', body({ token }))
      ).status,
    ).toBe(200)
    const signedIn = await request(
      '/auth/sign-in',
      body({
        email: 'owner@example.test',
        password: 'correct horse battery staple',
      }),
    )
    expect(signedIn.status).toBe(200)
    const cookie = signedIn.headers.get('set-cookie')!.split(';', 1)[0]!
    const authenticated = (value: unknown): RequestInit => {
      const request = body(value)
      const headers = new Headers(request.headers)
      headers.set('cookie', cookie)
      return { ...request, headers }
    }

    const client = await data<{ id: number }>(
      await request('/api/v1/clients', authenticated({ name: 'Client' })),
    )
    const task = await data<{ id: number }>(
      await request('/api/v1/tasks', authenticated({ name: 'Development' })),
    )
    const project = await data<{ id: number }>(
      await request(
        '/api/v1/projects',
        authenticated({ client_id: client.id, name: 'Launch' }),
      ),
    )
    await data(
      await request(
        '/api/v1/task-assignments',
        authenticated({ project_id: project.id, task_id: task.id }),
      ),
    )
    expect(
      await data<Array<{ project_id: number; user_id: number; is_active: boolean }>>(
        await request(
          `/api/v1/user-assignments?project_id=${project.id}&user_id=1`,
          { headers: { cookie } },
        ),
      ),
    ).toEqual(
      [expect.objectContaining({ project_id: project.id, user_id: 1, is_active: true })],
    )
    const entry = await data<{ id: number; seconds: number; notes: string }>(
      await request(
        '/api/v1/time-entries',
        authenticated({
          project_id: project.id,
          task_id: task.id,
          spent_date: '2026-08-31',
          seconds: 1_800,
          notes: 'Container acceptance entry',
        }),
      ),
    )
    expect(entry).toMatchObject({
      seconds: 1_800,
      notes: 'Container acceptance entry',
    })
    await first.close()

    const second = await createContainerRuntime(configuration, {
      emailProvider: provider(captured),
    })
    const secondApp = createApp(second.services)
    const restored = await secondApp.request(
      `${configuration.appBaseUrl}/api/v1/time-entries/${entry.id}`,
      { headers: { cookie } },
      configuration.appEnv,
    )
    expect(restored.status).toBe(200)
    expect(await restored.json()).toMatchObject({
      data: {
        id: entry.id,
        seconds: 1_800,
        notes: 'Container acceptance entry',
      },
    })
    await second.close()
  }, 30_000)

  it('[security] refuses a db.sqlite symlink before opening it', async () => {
    const root = await temporary()
    const outside = join(await temporary(), 'outside.sqlite')
    new BetterSqlite3(outside).close()
    await symlink(outside, join(root, 'db.sqlite'))
    await expect(
      createContainerRuntime(config(root), {
        emailProvider: provider([]),
      }),
    ).rejects.toThrow('regular file')
  })

  it('[unit] closes a failed migration database handle', async () => {
    const root = await temporary()
    const database = new BetterSqlite3(join(root, 'db.sqlite'))
    database.exec('CREATE TABLE organizations (broken INTEGER)')
    database.close()
    await expect(
      createContainerRuntime(config(root), {
        emailProvider: provider([]),
      }),
    ).rejects.toThrow()

    const reopened = new BetterSqlite3(join(root, 'db.sqlite'))
    expect(reopened.prepare('SELECT broken FROM organizations').all()).toEqual([])
    reopened.close()
  })

  it('[unit] closes SQLite when an email provider prevents a clean drain', async () => {
    const root = await temporary()
    let startedProvider!: () => void
    let resolveProvider!: () => void
    const started = new Promise<void>((resolve) => {
      startedProvider = resolve
    })
    const finished = new Promise<void>((resolve) => {
      resolveProvider = resolve
    })
    const runtime = await createContainerRuntime(config(root), {
      emailProvider: {
        name: 'smtp',
        send: async () => {
          startedProvider()
          await finished
          return { messageId: 'eventually-finished' }
        },
      },
    })
    await runtime.services.authMailer!.enqueue({
      kind: 'verify_email',
      to: 'owner@example.test',
      token: `ezacto_verify_${'a'.repeat(16)}_${'b'.repeat(43)}`,
      expiresAt: '2026-08-31T13:00:00.000Z',
    })
    await started

    await expect(runtime.close(25)).rejects.toThrow('did not drain')
    expect(runtime.database.open).toBe(false)
    resolveProvider()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
})
