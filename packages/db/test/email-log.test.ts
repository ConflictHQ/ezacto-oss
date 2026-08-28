import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import type { EmailLogStore, EmailMessage } from '@ezacto/mailer'
import {
  createContainerEmailLogStore,
  createD1EmailLogStore,
} from '../src/email-log.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'

interface Harness {
  store: EmailLogStore
  rows<T>(query: string, ...bindings: unknown[]): Promise<T[]>
  run(query: string, ...bindings: unknown[]): Promise<void>
  migrateAgain(): Promise<void>
  close(): Promise<void>
}

const now = '2026-08-28T20:00:00.000Z'
const message: EmailMessage = {
  to: [{ email: 'owner@example.test', name: 'Avery' }],
  template: 'verify_email',
  subject: 'Verify your ezacto email',
  text: 'Bearer material belongs only in the queued job: ezacto_verify_secret',
  related: { type: 'user', id: 1 },
}

const containerHarness = async (): Promise<Harness> => {
  const database = new BetterSqlite3(':memory:')
  migrateContainer(database)
  return {
    store: createContainerEmailLogStore(database, { now: () => now }),
    rows: async <T>(query: string, ...bindings: unknown[]) =>
      database.prepare(query).all(...bindings) as T[],
    run: async (query, ...bindings) => {
      database.prepare(query).run(...bindings)
    },
    migrateAgain: async () => migrateContainer(database),
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
  return {
    store: createD1EmailLogStore(database, { now: () => now }),
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

    it('[unit] supports sparse 0016 registration and idempotent migration', async () => {
      const current = await setup()
      await current.migrateAgain()
      const ledger = await current.rows<{ id: string }>(
        `SELECT id FROM _ezacto_migrations WHERE id >= '0014' ORDER BY id`,
      )
      expect(ledger).toEqual([
        { id: '0014_sessions' },
        { id: '0016_email_log' },
      ])
    })

    it('[unit] records queued, attempted, sent, and failed outcomes without message body secrets', async () => {
      const current = await setup()
      const queued = await current.store.createQueued(message)
      expect(queued).toMatchObject({
        id: 1,
        status: 'queued',
        attemptCount: 0,
        to: [{ email: 'owner@example.test', name: 'Avery' }],
      })
      await expect(current.store.recordAttempt(queued.id, 'http-provider')).resolves.toMatchObject({
        attemptCount: 1,
        provider: 'http-provider',
      })
      await expect(
        current.store.markSent(queued.id, 'http-provider', 'provider-1'),
      ).resolves.toMatchObject({
        status: 'sent',
        providerMessageId: 'provider-1',
      })

      const second = await current.store.createQueued({
        ...message,
        template: 'password_reset',
      })
      await current.store.recordAttempt(second.id, 'http-provider')
      await expect(
        current.store.markFailed(
          second.id,
          'http-provider',
          'provider_rejected',
        ),
      ).resolves.toMatchObject({
        status: 'failed',
        failureCode: 'provider_rejected',
      })
      expect(await current.store.list({ status: 'failed' })).toHaveLength(1)
      expect(JSON.stringify(await current.rows(`SELECT * FROM email_log`))).not.toContain(
        'ezacto_verify_secret',
      )
    })

    it('[security] rejects replacement and metadata rewrites of a delivery log', async () => {
      const current = await setup()
      await current.store.createQueued(message)
      await expect(
        current.run(
          `INSERT OR REPLACE INTO email_log (
             id, to_json, template, subject, created_at, updated_at
           ) VALUES (1, ?, 'attacker', 'attacker', ?, ?)`,
          JSON.stringify([{ email: 'attacker@example.test' }]),
          now,
          now,
        ),
      ).rejects.toThrow(/identity collision/i)
      await expect(
        current.run(`UPDATE email_log SET subject = 'changed' WHERE id = 1`),
      ).rejects.toThrow(/metadata is immutable/i)
    })
  })
}
