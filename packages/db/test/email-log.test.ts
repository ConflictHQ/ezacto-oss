import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EMAIL_LOG_KIND_TEMPLATES,
  EMAIL_RETRY_POLICY,
  processQueuedEmail,
  type EmailLogPager,
  type EmailLogStore,
  type EmailMessage,
  type HttpEmailProvider,
  type QueuedEmailJob,
} from '@ezacto/mailer'
import { createContainerEmailLogStore, createD1EmailLogStore } from '../src/email-log.js'
import { migrateContainer, migrateD1, migrationIds } from '../src/migrate.js'

interface Harness {
  store: EmailLogStore & EmailLogPager
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
    store: createContainerEmailLogStore(database, {
      now: () => currentNow,
      kindTemplates: EMAIL_LOG_KIND_TEMPLATES,
    }),
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
    store: createD1EmailLogStore(database, {
      now: () => currentNow,
      kindTemplates: EMAIL_LOG_KIND_TEMPLATES,
    }),
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
      expect(ledger).toEqual(migrationIds.filter((id) => id >= '0014').map((id) => ({ id })))
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
      ).toEqual(migrationIds.filter((id) => id >= '0015').map((id) => ({ id })))
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

    // The public demo's mail to a domain it may not email (#931): ended before
    // any provider saw it, in the columns the schema already has.
    it('[unit] refuses a queued message once, idempotently, and never one that went', async () => {
      const current = await setup()
      const queued = await current.store.createQueued(message)
      current.setNow('2026-08-28T20:00:01.000Z')
      await expect(
        current.store.markRefused(queued.id, 'demo_recipient_not_allowed'),
      ).resolves.toMatchObject({
        id: queued.id,
        status: 'failed',
        provider: null,
        failureCode: 'provider_rejected',
        failureReason: 'demo_recipient_not_allowed',
        attemptCount: 0,
        updatedAt: '2026-08-28T20:00:01.000Z',
      })
      // The outbox re-enqueues a persisted delivery on every retry.
      current.setNow('2026-08-28T20:00:02.000Z')
      await expect(
        current.store.markRefused(queued.id, 'demo_recipient_not_allowed'),
      ).resolves.toMatchObject({ status: 'failed', updatedAt: '2026-08-28T20:00:01.000Z' })
      // Terminal: nothing can claim it for a provider afterwards.
      await expect(
        current.store.claimAttempt(queued.id, 'http-provider', 'attempt-late', 30),
      ).resolves.toBeNull()

      const delivered = await current.store.createQueued({ ...message, template: 'reset' })
      await current.store.claimAttempt(delivered.id, 'http-provider', 'attempt-one', 30)
      await current.store.markSent(delivered.id, 'http-provider', { messageId: 'm-1' }, 'attempt-one')
      await expect(
        current.store.markRefused(delivered.id, 'demo_recipient_not_allowed'),
      ).rejects.toThrow(/did not match a queued log/u)
      // The column's own vocabulary, said by the caller rather than the database.
      await expect(current.store.markRefused(queued.id, 'not allowed.')).rejects.toThrow(
        RangeError,
      )
    })

    it('[concurrency] does not refuse under a live provider lease, only an expired one', async () => {
      const current = await setup()
      const queued = await current.store.createQueued(message)
      await current.store.claimAttempt(queued.id, 'http-provider', 'attempt-one', 30)
      await expect(
        current.store.markRefused(queued.id, 'demo_recipient_not_allowed'),
      ).rejects.toThrow(/did not match a queued log/u)
      current.setNow('2026-08-28T20:00:31.000Z')
      await expect(
        current.store.markRefused(queued.id, 'demo_recipient_not_allowed'),
      ).resolves.toMatchObject({ status: 'failed', provider: 'http-provider' })
    })

    it('[unit] leaves out of the health counts only what no provider ever saw', async () => {
      const current = await setup()
      const refused = await current.store.createQueued(message)
      await current.store.markRefused(refused.id, 'demo_recipient_not_allowed')
      const rejected = await current.store.createQueued({ ...message, template: 'reset' })
      await current.store.claimAttempt(rejected.id, 'http-provider', 'attempt-one', 30)
      await current.store.markProviderFailed(
        rejected.id,
        'http-provider',
        'provider_rejected',
        'attempt-one',
        'recipient_suppressed:BOUNCE',
      )
      const unqueued = await current.store.createQueued({ ...message, template: 'verify' })
      await current.store.markQueueFailed(unqueued.id)

      // The provider's rejection and the queue's failure count as they always
      // did; the refusal is the only failure left out.
      await expect(current.store.countByStatus()).resolves.toEqual({
        queued: 0,
        sent: 0,
        bounced: 0,
        complained: 0,
        failed: 2,
      })
      // And the log still lists it, where an operator looks.
      expect((await current.store.list({ status: 'failed' })).map((record) => record.id)).toContain(
        refused.id,
      )
    })

    describe('paged reads (issue 929)', () => {
      const send = async (
        current: Harness,
        at: string,
        overrides: Partial<EmailMessage>,
      ) => {
        current.setNow(at)
        return current.store.createQueued({ ...message, ...overrides })
      }

      const seed = async (current: Harness) => {
        const ids: Record<string, number> = {}
        ids.invoice = (
          await send(current, '2026-09-01T10:00:00.000Z', {
            template: 'invoice:3',
            to: [{ email: 'ap@acme.test', name: 'Acme Payables' }],
            cc: [{ email: 'boss@acme.test' }],
          })
        ).id
        ids.preview = (
          await send(current, '2026-09-02T10:00:00.000Z', { template: 'invoice_preview:3' })
        ).id
        ids.reminder = (
          await send(current, '2026-09-03T10:00:00.000Z', {
            template: 'reminder:1',
            to: [{ email: 'ap@acme.test' }],
          })
        ).id
        ids.signIn = (
          await send(current, '2026-09-03T10:00:00.000Z', {
            template: 'staff_magic_link_signin:v1',
          })
        ).id
        ids.reset = (
          await send(current, '2026-09-04T10:00:00.000Z', {
            template: 'auth_password_reset:v2',
            to: [{ email: 'owner@example.test', name: 'Avery' }],
          })
        ).id
        return ids
      }

      const idsOf = (records: readonly { id: number }[]) => records.map((record) => record.id)

      it('[unit] reads newest first, then oldest first, on a keyset that ties on the instant', async () => {
        const current = await setup()
        const ids = await seed(current)
        const through = (await current.store.snapshot())!
        expect(through).toBe('2026-09-04T10:00:00.000Z')

        const newest = await current.store.page({
          order: 'newest',
          after: null,
          createdThrough: through,
          take: 10,
        })
        // The two rows made at the same instant fall back to id, descending.
        expect(idsOf(newest)).toEqual([ids.reset, ids.signIn, ids.reminder, ids.preview, ids.invoice])

        const second = await current.store.page({
          order: 'newest',
          after: { createdAt: '2026-09-03T10:00:00.000Z', id: ids.signIn! },
          createdThrough: through,
          take: 10,
        })
        expect(idsOf(second)).toEqual([ids.reminder, ids.preview, ids.invoice])

        const oldest = await current.store.page({
          order: 'oldest',
          after: { createdAt: '2026-09-02T10:00:00.000Z', id: ids.preview! },
          createdThrough: through,
          take: 2,
        })
        expect(idsOf(oldest)).toEqual([ids.reminder, ids.signIn])
      })

      it('[unit] leaves out rows created after the traversal began', async () => {
        const current = await setup()
        const ids = await seed(current)
        const through = (await current.store.snapshot())!
        await send(current, '2026-09-05T10:00:00.000Z', { template: 'invoice:4' })
        const page = await current.store.page({
          order: 'newest',
          after: null,
          createdThrough: through,
          take: 10,
        })
        expect(idsOf(page)[0]).toBe(ids.reset)
        expect(page).toHaveLength(5)
        await expect(current.store.snapshot()).resolves.toBe('2026-09-05T10:00:00.000Z')
      })

      it('[unit] narrows by kind on the whole template name, not a prefix of it', async () => {
        const current = await setup()
        const ids = await seed(current)
        const through = (await current.store.snapshot())!
        const ofKind = async (kind: 'invoice' | 'invoice_preview' | 'sign_in' | 'account') =>
          idsOf(
            await current.store.page({
              kind,
              order: 'newest',
              after: null,
              createdThrough: through,
              take: 10,
            }),
          )
        expect(await ofKind('invoice')).toEqual([ids.invoice])
        expect(await ofKind('invoice_preview')).toEqual([ids.preview])
        expect(await ofKind('sign_in')).toEqual([ids.signIn])
        expect(await ofKind('account')).toEqual([ids.reset])
        await expect(current.store.count({ kind: 'invoice' })).resolves.toBe(1)
      })

      it('[unit] narrows by day range and by status, and combines them', async () => {
        const current = await setup()
        const ids = await seed(current)
        await current.store.markRefused(ids.reminder!, 'demo_recipient_not_allowed')
        const through = (await current.store.snapshot())!
        const read = async (filter: object) =>
          idsOf(
            await current.store.page({
              ...filter,
              order: 'oldest',
              after: null,
              createdThrough: through,
              take: 10,
            }),
          )
        expect(
          await read({
            createdFrom: '2026-09-02T00:00:00.000Z',
            createdBefore: '2026-09-04T00:00:00.000Z',
          }),
        ).toEqual([ids.preview, ids.reminder, ids.signIn])
        expect(await read({ status: 'failed' })).toEqual([ids.reminder])
        expect(
          await read({
            status: 'failed',
            createdFrom: '2026-09-04T00:00:00.000Z',
          }),
        ).toEqual([])
        await expect(
          current.store.count({
            createdFrom: '2026-09-02T00:00:00.000Z',
            createdBefore: '2026-09-04T00:00:00.000Z',
          }),
        ).resolves.toBe(3)
      })

      it('[unit] searches the address or the name in To and Cc, ignoring case and key names', async () => {
        const current = await setup()
        const ids = await seed(current)
        const found = async (recipient: string) =>
          idsOf(
            await current.store.page({
              recipient,
              order: 'oldest',
              after: null,
              createdThrough: (await current.store.snapshot())!,
              take: 10,
            }),
          )
        // To, by address; and the Cc-only match on the first invoice.
        expect(await found('AP@ACME')).toEqual([ids.invoice, ids.reminder])
        expect(await found('boss@acme')).toEqual([ids.invoice])
        // By name.
        expect(await found('payables')).toEqual([ids.invoice])
        // The words the JSON is written with are not recipients.
        expect(await found('email')).toEqual([])
        await expect(current.store.count({ recipient: 'avery' })).resolves.toBe(3)
      })
    })
  })
}
