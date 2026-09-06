import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EMAIL_RETRY_POLICY,
  processQueuedEmail,
  type EmailLogStore,
  type EmailMessage,
  type HttpEmailProvider,
  type QueuedEmailJob,
} from '@ezacto/mailer'
import { createContainerEmailLogStore, createD1EmailLogStore } from '../src/email-log.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'

interface Harness {
  store: EmailLogStore
  rows<T>(query: string, ...bindings: unknown[]): Promise<T[]>
  run(query: string, ...bindings: unknown[]): Promise<void>
  migrateAgain(): Promise<void>
  setNow(value: string): void
  close(): Promise<void>
}

const now = '2026-08-28T20:00:00.000Z'
const message: EmailMessage = {
  from: { email: 'billing@example.test', name: 'Billing' },
  replyTo: [{ email: 'accounts@example.test' }],
  to: [{ email: 'owner@example.test', name: 'Avery' }],
  template: 'verify_email',
  subject: 'Verify your ezacto email',
  text: 'Bearer material belongs only in the queued job: ezacto_verify_secret',
  related: { type: 'user', id: 1 },
}

const containerHarness = async (): Promise<Harness> => {
  const database = new BetterSqlite3(':memory:')
  migrateContainer(database)
  let currentNow = now
  return {
    store: createContainerEmailLogStore(database, { now: () => currentNow }),
    rows: async <T>(query: string, ...bindings: unknown[]) =>
      database.prepare(query).all(...bindings) as T[],
    run: async (query, ...bindings) => {
      database.prepare(query).run(...bindings)
    },
    migrateAgain: async () => migrateContainer(database),
    setNow: (value) => {
      currentNow = value
    },
    close: async () => {
      database.close()
    },
  }
}

const d1Harness = async (): Promise<Harness> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const database = await miniflare.getD1Database('DB')
  await migrateD1(database)
  let currentNow = now
  return {
    store: createD1EmailLogStore(database, { now: () => currentNow }),
    rows: async <T>(query: string, ...bindings: unknown[]) =>
      (
        await database
          .prepare(query)
          .bind(...bindings)
          .all<T>()
      ).results,
    run: async (query, ...bindings) => {
      await database
        .prepare(query)
        .bind(...bindings)
        .run()
    },
    migrateAgain: async () => migrateD1(database),
    setNow: (value) => {
      currentNow = value
    },
    close: async () => miniflare.dispose(),
  }
}

const factories = [
  ['container', containerHarness],
  ['D1', d1Harness],
] as const

for (const [runtime, factory] of factories) {
  describe(`email log (${runtime})`, () => {
    let harness: Harness | undefined

    afterEach(async () => harness?.close())

    const setup = async () => (harness = await factory())

    it('[unit] registers 0015 through 0018 in order and migrates idempotently', async () => {
      const current = await setup()
      await current.migrateAgain()
      const ledger = await current.rows<{ id: string }>(
        `SELECT id FROM _ezacto_migrations WHERE id >= '0014' ORDER BY id`,
      )
      expect(ledger).toEqual([
        { id: '0014_sessions' },
        { id: '0015_oidc_transactions' },
        { id: '0016_email_log' },
        { id: '0017_email_delivery_details' },
        { id: '0018_estimates' },
        { id: '0019_attachments' },
        { id: '0020_argon2_passwords' },
        { id: '0021_estimate_commands' },
        { id: '0022_resource_create_commands' },
        { id: '0023_migration_import_authority' },
        { id: '0024_migration_worksheet_completions' },
        { id: '0025_time_entry_note_requirements' },
        { id: '0026_invoice_generation' },
        { id: '0027_timesheet_approvals' },
        { id: '0028_timesheet_lock_policy' },
        { id: '0029_outbox_delivery' },
        { id: '0030_email_templates' },
        { id: '0031_team_people' },
        { id: '0032_invoice_email_delivery' },
        { id: '0033_contact_portal' },
      ])
    })

    it('[unit] backfills 0015 when a database already registered sparse 0016', async () => {
      const current = await setup()
      const queued = await current.store.createQueued(message)
      await current.run(`DROP TABLE oidc_transactions`)
      await current.run(`DELETE FROM _ezacto_migrations WHERE id = '0015_oidc_transactions'`)

      await current.migrateAgain()

      expect(
        await current.rows<{ id: string }>(
          `SELECT id FROM _ezacto_migrations WHERE id >= '0015' ORDER BY id`,
        ),
      ).toEqual([
        { id: '0015_oidc_transactions' },
        { id: '0016_email_log' },
        { id: '0017_email_delivery_details' },
        { id: '0018_estimates' },
        { id: '0019_attachments' },
        { id: '0020_argon2_passwords' },
        { id: '0021_estimate_commands' },
        { id: '0022_resource_create_commands' },
        { id: '0023_migration_import_authority' },
        { id: '0024_migration_worksheet_completions' },
        { id: '0025_time_entry_note_requirements' },
        { id: '0026_invoice_generation' },
        { id: '0027_timesheet_approvals' },
        { id: '0028_timesheet_lock_policy' },
        { id: '0029_outbox_delivery' },
        { id: '0030_email_templates' },
        { id: '0031_team_people' },
        { id: '0032_invoice_email_delivery' },
        { id: '0033_contact_portal' },
      ])
      expect(
        await current.rows<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'table'
           AND name IN ('oidc_transactions', 'email_log') ORDER BY name`,
        ),
      ).toEqual([{ name: 'email_log' }, { name: 'oidc_transactions' }])
      await expect(current.store.get(queued.id)).resolves.toMatchObject({
        id: queued.id,
        status: 'queued',
      })
    })

    it('[unit] records queued, attempted, sent, and failed outcomes without message body secrets', async () => {
      const current = await setup()
      const queued = await current.store.createQueued(message)
      expect(queued).toMatchObject({
        id: 1,
        status: 'queued',
        attemptCount: 0,
        from: { email: 'billing@example.test', name: 'Billing' },
        replyTo: [{ email: 'accounts@example.test' }],
        to: [{ email: 'owner@example.test', name: 'Avery' }],
      })
      await expect(
        current.store.claimAttempt(queued.id, 'http-provider', 'attempt-one', 30),
      ).resolves.toBe(1)
      await expect(
        current.store.markSent(
          queued.id,
          'http-provider',
          {
            messageId: 'provider-1',
            requestId: 'request-1',
            latencyMs: 17,
          },
          'attempt-one',
        ),
      ).resolves.toMatchObject({
        status: 'sent',
        attemptCount: 1,
        providerMessageId: 'provider-1',
        providerRequestId: 'request-1',
        providerLatencyMs: 17,
      })

      const second = await current.store.createQueued({
        ...message,
        template: 'password_reset',
      })
      await current.store.claimAttempt(second.id, 'http-provider', 'attempt-two', 30)
      await expect(
        current.store.markProviderFailed(
          second.id,
          'http-provider',
          'provider_rejected',
          'attempt-two',
          'recipient_suppressed:BOUNCE',
        ),
      ).resolves.toMatchObject({
        status: 'failed',
        failureCode: 'provider_rejected',
        failureReason: 'recipient_suppressed:BOUNCE',
      })
      expect(await current.store.list({ status: 'failed' })).toHaveLength(1)
      expect(JSON.stringify(await current.rows(`SELECT * FROM email_log`))).not.toContain(
        'ezacto_verify_secret',
      )
    })

    it('[concurrency] leases one provider attempt and fences stale terminal writers', async () => {
      const current = await setup()
      const queued = await current.store.createQueued(message)
      await expect(
        current.store.claimAttempt(queued.id, 'http-provider', 'attempt-one', 30),
      ).resolves.toBe(1)
      await expect(
        current.store.claimAttempt(queued.id, 'http-provider', 'attempt-two', 30),
      ).resolves.toBeNull()
      await expect(
        current.store.markSent(
          queued.id,
          'http-provider',
          { messageId: 'forged-receipt' },
          'attempt-two',
        ),
      ).rejects.toThrow(/state transition did not match/i)

      current.setNow('2026-08-28T20:00:31.000Z')
      await expect(
        current.store.claimAttempt(queued.id, 'http-provider', 'attempt-two', 30),
      ).resolves.toBe(2)
      await expect(
        current.store.markSent(
          queued.id,
          'http-provider',
          { messageId: 'stale-receipt' },
          'attempt-one',
        ),
      ).rejects.toThrow(/state transition did not match/i)
      await expect(
        current.store.markSent(
          queued.id,
          'http-provider',
          { messageId: 'provider-1' },
          'attempt-two',
        ),
      ).resolves.toMatchObject({
        status: 'sent',
        providerMessageId: 'provider-1',
        attemptCount: 2,
      })
    })

    it('[concurrency] overlapping consumers invoke the provider exactly once', async () => {
      const current = await setup()
      const queued = await current.store.createQueued(message)
      const job: QueuedEmailJob = {
        schemaVersion: 1,
        deliveryId: queued.id,
        message,
      }
      let providerCalls = 0
      let providerStartedResolve: (() => void) | undefined
      const providerStarted = new Promise<void>((resolve) => {
        providerStartedResolve = resolve
      })
      let providerRelease: (() => void) | undefined
      const providerBlocked = new Promise<void>((resolve) => {
        providerRelease = resolve
      })
      const provider: HttpEmailProvider = {
        name: 'http-provider',
        send: async () => {
          providerCalls += 1
          providerStartedResolve?.()
          await providerBlocked
          return { messageId: 'provider-1' }
        },
      }

      const first = processQueuedEmail(job, 1, current.store, provider, {
        createAttemptId: () => 'attempt-one',
      })
      await providerStarted
      await expect(
        processQueuedEmail(job, 1, current.store, provider, {
          createAttemptId: () => 'attempt-two',
        }),
      ).resolves.toEqual({
        action: 'retry',
        delaySeconds: EMAIL_RETRY_POLICY.claimedRetryDelaySeconds,
      })
      expect(providerCalls).toBe(1)
      providerRelease?.()
      await expect(first).resolves.toEqual({ action: 'ack' })
      await expect(current.store.get(queued.id)).resolves.toMatchObject({
        status: 'sent',
        attemptCount: 1,
        providerMessageId: 'provider-1',
      })
    })

    it('[concurrency] excludes claim contention from the provider retry budget', async () => {
      const current = await setup()
      const queued = await current.store.createQueued(message)
      const job: QueuedEmailJob = {
        schemaVersion: 1,
        deliveryId: queued.id,
        message,
      }
      await expect(
        current.store.claimAttempt(queued.id, 'http-provider', 'abandoned-attempt', 30),
      ).resolves.toBe(1)

      let providerCalls = 0
      const provider: HttpEmailProvider = {
        name: 'http-provider',
        send: async () => {
          providerCalls += 1
          throw new Error('transient provider failure')
        },
      }
      for (let queueAttempt = 1; queueAttempt <= 4; queueAttempt += 1) {
        await expect(
          processQueuedEmail(job, queueAttempt, current.store, provider, {
            createAttemptId: () => `contender-${queueAttempt}`,
          }),
        ).resolves.toEqual({
          action: 'retry',
          delaySeconds: EMAIL_RETRY_POLICY.claimedRetryDelaySeconds,
        })
      }
      expect(providerCalls).toBe(0)
      await expect(current.store.get(queued.id)).resolves.toMatchObject({
        status: 'queued',
        attemptCount: 1,
      })

      await expect(
        current.store.releaseAttempt(queued.id, 'http-provider', 'abandoned-attempt'),
      ).resolves.toBe(true)
      await expect(
        processQueuedEmail(job, 5, current.store, provider, {
          createAttemptId: () => 'provider-attempt-two',
        }),
      ).resolves.toEqual({
        action: 'retry',
        delaySeconds: EMAIL_RETRY_POLICY.delaySeconds[1],
      })
      expect(providerCalls).toBe(1)
      await expect(current.store.get(queued.id)).resolves.toMatchObject({
        status: 'queued',
        attemptCount: 2,
        failureCode: null,
      })
    })

    it('[security] rejects replacement and metadata rewrites of a delivery log', async () => {
      const current = await setup()
      await current.store.createQueued(message)
      await expect(
        current.run(
          `INSERT OR REPLACE INTO email_log (
             id, from_json, to_json, template, subject, created_at, updated_at
           ) VALUES (1, ?, ?, 'attacker', 'attacker', ?, ?)`,
          JSON.stringify({ email: 'attacker@example.test' }),
          JSON.stringify([{ email: 'attacker@example.test' }]),
          now,
          now,
        ),
      ).rejects.toThrow(/identity collision/i)
      await expect(
        current.run(`UPDATE email_log SET subject = 'changed' WHERE id = 1`),
      ).rejects.toThrow(/metadata is immutable/i)
      await expect(
        current.run(
          `UPDATE email_log SET from_json = ? WHERE id = 1`,
          JSON.stringify({ email: 'attacker@example.test' }),
        ),
      ).rejects.toThrow(/sender metadata is immutable/i)
    })

    it('[security] rejects missing, duplicate, and wrong-typed recipient fields', async () => {
      const current = await setup()
      for (const recipients of [
        '[{}]',
        '[{"name":"No Email"}]',
        '[{"email":"owner@example.test","email":123}]',
        '[{"email":"owner@example.test","name":"Avery","name":123}]',
        '[{"email":123}]',
        '[{"email":"owner@example.test","name":123}]',
      ]) {
        await expect(
          current.run(
            `INSERT INTO email_log (
               from_json, to_json, template, subject, created_at, updated_at
             ) VALUES (?, ?, 'verify_email', 'Verify', ?, ?)`,
            JSON.stringify({ email: 'billing@example.test' }),
            recipients,
            now,
            now,
          ),
        ).rejects.toThrow(/recipients are invalid/i)
      }
      await expect(
        current.run(
          `INSERT INTO email_log (
             to_json, template, subject, created_at, updated_at
           ) VALUES (?, 'verify_email', 'Verify', ?, ?)`,
          JSON.stringify([{ email: 'owner@example.test' }]),
          now,
          now,
        ),
      ).rejects.toThrow(/sender metadata is invalid/i)
      await expect(
        current.run(
          `INSERT INTO email_log (
             from_json, reply_to_json, to_json, template, subject, created_at, updated_at
           ) VALUES (?, ?, ?, 'verify_email', 'Verify', ?, ?)`,
          JSON.stringify({ email: 'billing@example.test' }),
          JSON.stringify([{ name: 'missing address' }]),
          JSON.stringify([{ email: 'owner@example.test' }]),
          now,
          now,
        ),
      ).rejects.toThrow(/sender metadata is invalid/i)
    })
  })
}
