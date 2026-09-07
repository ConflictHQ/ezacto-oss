import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { migrationIds } from '@ezacto/db'
import { apiContractOperations } from '@ezacto/api'
import type { EmailMessage, HttpEmailProvider } from '@ezacto/mailer'
import { createApp } from '../../worker/src/app.js'
import type { ContainerConfig } from '../src/config.js'
import { createContainerRuntime } from '../src/runtime.js'

const roots: string[] = []
const temporary = async (): Promise<string> => {
  // realpath because macOS puts $TMPDIR under /var, itself a symlink to
  // /private/var. The code under test refuses a symlinked path on purpose, so
  // the fixture has to hand it a canonical one rather than the check be relaxed.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ezacto-container-')))
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
    ).toEqual({ id: migrationIds.at(-1) })

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
    expect(captured[0]).toMatchObject({
      from: { email: 'billing@example.test' },
      template: 'auth_email_verification:v1',
      subject: 'Verify your Container Studio email',
    })
    const token = /ezacto_verify_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{43}/u.exec(
      captured[0]!.text,
    )?.[0]
    expect(token).toBeTruthy()

    expect(
      (
        await request('/auth/verify-email', body({ token }))
      ).status,
    ).toBe(200)
    await first.services.emailConfiguration.createSenderIdentity({
      id: 41,
      email: 'billing@example.test',
      displayName: 'Container Billing',
      provider: 'smtp',
      providerIdentity: 'billing@example.test',
      actorUserId: 1,
      commandId: 'container-unverified-sender',
      occurredAt: '2026-09-02T06:00:00.000Z',
    })
    await first.services.emailConfiguration.createSenderIdentity({
      id: 42,
      email: 'other@example.test',
      displayName: 'Mismatched Container Billing',
      provider: 'smtp',
      providerIdentity: 'other@example.test',
      actorUserId: 1,
      commandId: 'container-mismatched-sender',
      occurredAt: '2026-09-02T06:00:01.000Z',
    })
    const reset = await request(
      '/auth/password/forgot',
      body({ email: 'owner@example.test' }),
    )
    expect(reset.status).toBe(202)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(captured).toHaveLength(2)

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

    const logCountBeforeTest = (await first.services.emailLog.list()).length
    const testSendRequest = authenticated({
      template_kind: 'invoice',
      template_version: 1,
      variables: {
        company_name: 'Container Studio',
        invoice_id: '41',
        invoice_number: 'INV-41',
        invoice_amount: '$100.00',
        invoice_due_date: '2026-09-30',
      },
      confirmed: true,
    })
    const testHeaders = new Headers(testSendRequest.headers)
    testHeaders.set('idempotency-key', 'container-unverified-test-send')
    const blockedTest = await request('/api/v1/sender-identities/41/test-send', {
      ...testSendRequest,
      headers: testHeaders,
    })
    expect(blockedTest.status).toBe(409)
    expect(await blockedTest.json()).toMatchObject({
      error: { code: 'sender_deployment_configuration_missing' },
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(captured).toHaveLength(2)
    expect(await first.services.emailLog.list()).toHaveLength(logCountBeforeTest)

    const mismatchRefreshRequest = authenticated({ expected_evidence_version: 0 })
    const mismatchRefreshHeaders = new Headers(mismatchRefreshRequest.headers)
    mismatchRefreshHeaders.set('idempotency-key', 'container-mismatch-refresh')
    const mismatchRefresh = await request('/api/v1/sender-identities/42/refresh', {
      ...mismatchRefreshRequest,
      headers: mismatchRefreshHeaders,
    })
    expect(mismatchRefresh.status).toBe(409)
    expect(await mismatchRefresh.json()).toMatchObject({
      error: { code: 'sender_identity_binding_mismatch' },
    })
    expect(
      (await first.services.emailConfiguration.getSenderIdentity(42))?.evidence,
    ).toBeNull()
    expect(await first.services.emailLog.list()).toHaveLength(logCountBeforeTest)
    expect(captured).toHaveLength(2)

    const refreshRequest = authenticated({ expected_evidence_version: 0 })
    const refreshHeaders = new Headers(refreshRequest.headers)
    refreshHeaders.set('idempotency-key', 'container-smtp-refresh')
    const refreshed = await request('/api/v1/sender-identities/41/refresh', {
      ...refreshRequest,
      headers: refreshHeaders,
    })
    expect(refreshed.status).toBe(200)
    expect(await refreshed.json()).toMatchObject({
      data: {
        id: 41,
        evidence: {
          version: 1,
          source: 'deployment_config',
          identity_kind: 'email_address',
          verification_status: 'operator_configured',
          dkim_status: 'not_applicable',
          mail_from_domain: null,
          mail_from_status: 'not_configured',
        },
      },
    })

    const defaultRequest = authenticated({ expected_version: 0 })
    const defaultHeaders = new Headers(defaultRequest.headers)
    defaultHeaders.set('idempotency-key', 'container-smtp-default')
    const selected = await request('/api/v1/sender-identities/41/default', {
      ...defaultRequest,
      headers: defaultHeaders,
    })
    expect(selected.status).toBe(200)
    expect(await selected.json()).toMatchObject({
      data: { id: 41, is_default: true, version: 1 },
    })

    const successfulRequest = authenticated({
      template_kind: 'invoice',
      template_version: 1,
      variables: {
        company_name: 'Container Studio',
        invoice_id: '41',
        invoice_number: 'INV-41',
        invoice_amount: '$100.00',
        invoice_due_date: '2026-09-30',
      },
      confirmed: true,
    })
    const successfulHeaders = new Headers(successfulRequest.headers)
    successfulHeaders.set('idempotency-key', 'container-smtp-test-send')
    const sendOnce = () => request('/api/v1/sender-identities/41/test-send', {
      ...successfulRequest,
      headers: successfulHeaders,
    })
    const sent = await sendOnce()
    const replayed = await sendOnce()
    expect(sent.status).toBe(202)
    expect(replayed.status).toBe(202)
    expect(await sent.json()).toEqual(await replayed.json())
    for (let attempt = 0; captured.length < 3 && attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(captured).toHaveLength(3)
    expect(captured[2]).toMatchObject({
      from: { email: 'billing@example.test', name: 'Container Billing' },
      to: [{ email: 'owner@example.test' }],
      template: 'invoice:v1:test',
    })
    expect(await first.services.emailLog.list()).toHaveLength(logCountBeforeTest + 1)

    const client = await data<{ id: number }>(
      await request('/api/v1/clients', authenticated({ name: 'Client' })),
    )
    const invoiceAt = '2026-09-02T07:00:00.000Z'
    first.database.prepare(
      `INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date,
         state, amount_cents, due_amount_cents, created_at, updated_at)
       VALUES (801, ?, 'CONTAINER-801', 'USD', '2026-09-01', '2026-09-30',
         'draft', 2500, 2500, ?, ?)`,
    ).run(client.id, invoiceAt, invoiceAt)
    const deliveryRequest = authenticated({
      expected_version: 0,
      recipients: [{ name: 'Client', email: 'client@example.net' }],
      confirmed: true,
    })
    const deliveryHeaders = new Headers(deliveryRequest.headers)
    deliveryHeaders.set('idempotency-key', 'container-invoice-delivery')
    const delivered = await request('/api/v1/invoices/801/deliveries', {
      ...deliveryRequest,
      headers: deliveryHeaders,
    })
    expect(delivered.status).toBe(202)
    expect(captured).toHaveLength(3)
    await first.drainOutbox()
    for (let attempt = 0; captured.length < 4 && attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(captured[3]).toMatchObject({
      from: { email: 'billing@example.test', name: 'Container Billing' },
      to: [{ email: 'client@example.net', name: 'Client' }],
      template: 'invoice:1',
    })
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

  // The Worker entry has the same guard over its own composition. Both are
  // needed: the app is shared but the services are not, and a service this
  // runtime leaves out is a documented operation this deployment 404s.
  it('[contract] answers every documented operation the container composes', async () => {
    const root = await temporary()
    const runtime = await createContainerRuntime(config(root), {
      emailProvider: provider([]),
    })
    try {
      const mounted = new Set(
        createApp(runtime.services)
          .routes.filter((route) => route.method !== 'ALL')
          .map((route) => `${route.method.toLowerCase()} ${route.path}`),
      )
      const unreachable = apiContractOperations
        .map((operation) => `${operation.method} ${operation.path}`)
        .filter((operation) => !mounted.has(operation))
        .sort()

      expect(unreachable).toEqual([])
    } finally {
      await runtime.close()
    }
  })

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
    await runtime.services.deploymentAuthMailer!.enqueue({
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
