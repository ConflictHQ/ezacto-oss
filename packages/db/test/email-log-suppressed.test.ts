import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { executeInvoiceLifecycleCommand, type InvoiceStateDatabase } from '../src/invoice-state.js'
import {
  migrateContainer,
  migrateContainerThrough,
  migrateD1,
  migrateD1Through,
} from '../src/migrate.js'

/**
 * Migration 0100 rebuilds `email_log` to admit `suppressed` (#931). The table
 * is a parent four others point at with ON DELETE RESTRICT, so the rebuild is
 * the risky kind: a copy that lost a row, a child left pointing at nothing, or
 * a trigger that did not come back would each be silent until the day a send
 * relied on it. These hold all three against a database that has really sent.
 */

interface Harness {
  orm: InvoiceStateDatabase
  run(sql: string, ...bindings: unknown[]): Promise<void>
  rows<T>(sql: string, ...bindings: unknown[]): Promise<T[]>
  migrateRest(): Promise<void>
  close(): Promise<void>
}

const at = '2026-10-06T12:00:00.000Z'

const container = async (): Promise<Harness> => {
  const sqlite = new BetterSqlite3(':memory:')
  migrateContainerThrough(sqlite, '0099_invoice_sending')
  return {
    orm: createContainerDatabase(sqlite),
    run: async (sql, ...bindings) => void sqlite.prepare(sql).run(...bindings),
    rows: async <T>(sql: string, ...bindings: unknown[]) =>
      sqlite.prepare(sql).all(...bindings) as T[],
    migrateRest: async () => migrateContainer(sqlite),
    close: async () => void sqlite.close(),
  }
}

const d1 = async (): Promise<Harness> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const database = await miniflare.getD1Database('DB')
  await migrateD1Through(database, '0099_invoice_sending')
  return {
    orm: createD1Database(database),
    run: async (sql, ...bindings) => void (await database.prepare(sql).bind(...bindings).run()),
    rows: async <T>(sql: string, ...bindings: unknown[]) =>
      (await database.prepare(sql).bind(...bindings).all<T>()).results,
    migrateRest: async () => migrateD1(database),
    close: async () => miniflare.dispose(),
  }
}

/** An organisation that has sent an invoice by email, plus a sent and a failed message beside it. */
const seed = async (database: Harness): Promise<void> => {
  await database.run(
    `INSERT INTO organizations (name, modules, created_at, updated_at)
     VALUES ('Fixture Org', '{"invoices":true}', ?, ?)`,
    at,
    at,
  )
  await database.run(
    `INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
     VALUES (1, 'Avery', 'Ng', 'administrator', '[]', ?, ?)`,
    at,
    at,
  )
  await database.run(
    `INSERT INTO clients (id, name, currency, created_at, updated_at)
     VALUES (1, 'Fixture Client', 'USD', ?, ?)`,
    at,
    at,
  )
  await database.run(
    `INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date, state,
       amount_cents, due_amount_cents, created_at, updated_at)
     VALUES (1, 1, 'INV-1', 'USD', '2026-10-01', '2026-10-31', 'draft', 1234, 1234, ?, ?)`,
    at,
    at,
  )
  await database.run(
    `INSERT INTO sender_identities
       (id, email, display_name, provider, provider_identity, is_default, version,
        created_by_user_id, created_at, updated_at)
     VALUES (10, 'billing@example.com', 'Fixture Org', 'mailgun', 'billing@example.com',
       0, 0, 1, ?, ?)`,
    at,
    at,
  )
  await database.run(
    `INSERT INTO sender_identity_evidence
       (sender_identity_id, evidence_version, source, identity_kind, verification_status,
        dkim_status, mail_from_domain, mail_from_status, observed_at)
     VALUES (10, 1, 'deployment_config', 'email_address', 'operator_configured',
       'not_applicable', NULL, 'not_configured', ?)`,
    at,
  )
  // The send writes delivery 700 and the recipient rows that point at it.
  await executeInvoiceLifecycleCommand(database.orm, {
    invoiceId: 1,
    commandId: 'deliver-invoice-1',
    command: 'send',
    actor: { type: 'user', id: 1 },
    authorize: async () => true,
    expectedVersion: 0,
    occurredAt: at,
    messageId: 100,
    eventId: 'evt-delivery-1',
    message: {
      sentBy: 'Avery Ng',
      sentByEmail: null,
      sentFrom: 'Fixture Org',
      sentFromEmail: 'billing@example.com',
      recipients: [{ name: 'Client', email: 'client@example.net' }],
      cc: [{ name: 'Finance', email: 'finance@example.net' }],
      subject: 'Invoice INV-1',
      body: 'Amount $12.34',
      attachPdf: false,
      sendMeACopy: false,
      thankYou: false,
      reminder: false,
      sendReminderOn: null,
    },
    delivery: {
      templateVersion: 1,
      senderIdentityId: 10,
      senderIdentityVersion: 0,
      senderEvidenceVersion: 1,
      fromName: 'Fixture Org',
      fromEmail: 'billing@example.com',
      replyToEmail: null,
      subject: 'Invoice INV-1',
      textBody: 'Amount $12.34',
      htmlBody: null,
      deliveryId: 700,
      recipients: [
        { name: 'Client', email: 'client@example.net', role: 'to' },
        { name: 'Finance', email: 'finance@example.net', role: 'cc' },
      ],
    },
  })
  await database.run(
    `INSERT INTO email_log (id, from_json, to_json, template, subject, provider,
       provider_message_id, provider_request_id, provider_latency_ms, status, attempt_count,
       created_at, updated_at)
     VALUES (701, '{"email":"billing@example.com"}', '[{"email":"owner@example.net"}]',
       'auth_password_reset:v1', 'Reset your password', 'mailgun', '<m-701@example.com>',
       'req-701', 42, 'sent', 1, ?, ?)`,
    at,
    at,
  )
  await database.run(
    `INSERT INTO email_log (id, from_json, to_json, template, subject, provider, status,
       attempt_count, failure_code, failure_reason, created_at, updated_at)
     VALUES (702, '{"email":"billing@example.com"}', '[{"email":"gone@example.net"}]',
       'invoice:1', 'Invoice INV-2', 'mailgun', 'failed', 5, 'provider_rejected',
       'recipient_suppressed:BOUNCE', ?, ?)`,
    at,
    at,
  )
}

interface SchemaObject {
  type: string
  name: string
  sql: string
}

const emailLogObjects = (database: Harness) =>
  database.rows<SchemaObject>(
    `SELECT type, name, sql FROM sqlite_master
     WHERE tbl_name = 'email_log' AND type IN ('index', 'trigger') ORDER BY type, name`,
  )

for (const [runtime, factory] of [
  ['SQLite', container],
  ['D1', d1],
] as const) {
  describe(`migration 0100 rebuilds the email log (${runtime})`, () => {
    let database: Harness | undefined
    afterEach(async () => database?.close())

    it('[unit] keeps every message, every recipient pointing at it, and every guard', async () => {
      database = await factory()
      await seed(database)
      const messages = await database.rows(`SELECT * FROM email_log ORDER BY id`)
      const recipients = await database.rows(
        `SELECT * FROM invoice_email_recipients ORDER BY invoice_message_id, recipient_index`,
      )
      const objects = await emailLogObjects(database)
      expect(messages).toHaveLength(3)
      expect(recipients).toHaveLength(2)

      await database.migrateRest()

      expect(
        await database.rows(`SELECT id FROM _ezacto_migrations WHERE id = '0100_email_log_suppressed'`),
      ).toHaveLength(1)
      // The rows, column for column, and the children still finding them.
      expect(await database.rows(`SELECT * FROM email_log ORDER BY id`)).toEqual(messages)
      expect(
        await database.rows(
          `SELECT * FROM invoice_email_recipients ORDER BY invoice_message_id, recipient_index`,
        ),
      ).toEqual(recipients)
      expect(await database.rows(`PRAGMA foreign_key_check`)).toEqual([])
      expect(
        await database.rows(`SELECT name FROM sqlite_master WHERE name = 'email_log_0099'`),
      ).toEqual([])

      // Every index and trigger is back, word for word, except the one rule
      // this migration exists to change.
      const restored = await emailLogObjects(database)
      expect(restored.map(({ type, name }) => `${type} ${name}`)).toEqual(
        objects.map(({ type, name }) => `${type} ${name}`),
      )
      for (const object of restored) {
        const before = objects.find(({ name }) => name === object.name)!
        if (object.name === 'email_log_status_transition_guard') {
          expect(object.sql).not.toBe(before.sql)
          expect(object.sql).toContain(`NEW.status IN ('sent','failed','suppressed')`)
        } else {
          expect(object.sql).toBe(before.sql)
        }
      }

      // The children's RESTRICT still binds to the rebuilt table.
      await expect(database.run(`DELETE FROM email_log WHERE id = 700`)).rejects.toThrow(
        /FOREIGN KEY/u,
      )
    })

    it('[unit] admits suppressed from queued only, and nothing after it', async () => {
      database = await factory()
      await seed(database)
      await database.migrateRest()

      await database.run(
        `UPDATE email_log SET status = 'suppressed', updated_at = ? WHERE id = 700`,
        at,
      )
      expect(await database.rows(`SELECT status FROM email_log WHERE id = 700`)).toEqual([
        { status: 'suppressed' },
      ])
      // Terminal: a suppressed message is never delivered after the fact.
      await expect(
        database.run(
          `UPDATE email_log SET status = 'sent', provider = 'mailgun',
             provider_message_id = '<late@example.com>' WHERE id = 700`,
        ),
      ).rejects.toThrow(/transition is invalid/u)
      // And a message that already went cannot be relabelled as never sent.
      await expect(
        database.run(
          `UPDATE email_log SET status = 'suppressed', provider_message_id = NULL,
             provider_request_id = NULL, provider_latency_ms = NULL WHERE id = 701`,
        ),
      ).rejects.toThrow(/transition is invalid/u)
      // Nothing about a suppressed message says a transport answered.
      await expect(
        database.run(
          `INSERT INTO email_log (id, from_json, to_json, template, subject, status,
             failure_code, created_at, updated_at)
           VALUES (703, '{"email":"billing@example.com"}', '[{"email":"a@example.net"}]',
             'invoice:1', 'Invoice INV-3', 'suppressed', 'provider_rejected', ?, ?)`,
          at,
          at,
        ),
      ).rejects.toThrow(/CHECK/u)
      await expect(
        database.run(
          `INSERT INTO email_log (id, from_json, to_json, template, subject, status, created_at, updated_at)
           VALUES (704, '{"email":"billing@example.com"}', '[{"email":"a@example.net"}]',
             'invoice:1', 'Invoice INV-4', 'unheard_of', ?, ?)`,
          at,
          at,
        ),
      ).rejects.toThrow(/CHECK/u)
    })
  })
}
