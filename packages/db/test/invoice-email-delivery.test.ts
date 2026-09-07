import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { executeInvoiceLifecycleCommand, type InvoiceStateDatabase } from '../src/invoice-state.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { createMoneyResourceRepository } from '../src/money-resources.js'

interface Harness {
  orm: InvoiceStateDatabase
  run(sql: string, ...bindings: unknown[]): Promise<void>
  rows<T>(sql: string, ...bindings: unknown[]): Promise<T[]>
  close(): Promise<void>
}

const at = '2026-09-02T12:00:00.000Z'

const container = async (): Promise<Harness> => {
  const sqlite = new BetterSqlite3(':memory:')
  migrateContainer(sqlite)
  return {
    orm: createContainerDatabase(sqlite),
    run: async (sql, ...bindings) => void sqlite.prepare(sql).run(...bindings),
    rows: async <T>(sql: string, ...bindings: unknown[]) =>
      sqlite.prepare(sql).all(...bindings) as T[],
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
  await migrateD1(database)
  return {
    orm: createD1Database(database),
    run: async (sql, ...bindings) => void await database.prepare(sql).bind(...bindings).run(),
    rows: async <T>(sql: string, ...bindings: unknown[]) =>
      (await database.prepare(sql).bind(...bindings).all<T>()).results,
    close: async () => miniflare.dispose(),
  }
}

const seed = async (database: Harness, mailgun = false): Promise<void> => {
  await database.run(
    `INSERT INTO organizations (name, modules, created_at, updated_at)
     VALUES ('Delivery Org', '{"invoices":true}', ?, ?)`, at, at,
  )
  await database.run(
    `INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
     VALUES (1, 'Avery', 'Ng', 'administrator', '[]', ?, ?)`, at, at,
  )
  await database.run(
    `INSERT INTO clients (id, name, currency, created_at, updated_at)
     VALUES (1, 'Delivery Client', 'USD', ?, ?)`, at, at,
  )
  await database.run(
    `INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date, state,
       amount_cents, due_amount_cents, created_at, updated_at)
     VALUES (1, 1, 'INV-1', 'USD', '2026-09-01', '2026-09-30', 'draft', 1234, 1234, ?, ?)`,
    at, at,
  )
  await database.run(
    `INSERT INTO sender_identities
       (id, email, display_name, provider, provider_identity, is_default, version,
        created_by_user_id, created_at, updated_at)
     VALUES (10, 'billing@example.com', 'Delivery Org', ?, ?, 0, 0, 1, ?, ?)`,
    mailgun ? 'mailgun' : 'ses',
    mailgun ? 'billing@example.com' : 'example.com',
    at, at,
  )
  await database.run(
    mailgun
      ? `INSERT INTO sender_identity_evidence
           (sender_identity_id, evidence_version, source, identity_kind, verification_status,
            dkim_status, mail_from_domain, mail_from_status, observed_at)
         VALUES (10, 1, 'deployment_config', 'email_address', 'operator_configured',
           'not_applicable', NULL, 'not_configured', ?)`
      : `INSERT INTO sender_identity_evidence
           (sender_identity_id, evidence_version, source, identity_kind, verification_status,
            dkim_status, mail_from_domain, mail_from_status, observed_at)
         VALUES (10, 1, 'provider_api', 'domain', 'verified', 'verified', NULL,
           'not_configured', ?)`,
    at,
  )
}

const command = (database: Harness, evidenceVersion = 1) =>
  executeInvoiceLifecycleCommand(database.orm, {
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
      sentBy: 'Avery Ng', sentByEmail: null,
      sentFrom: 'Delivery Org', sentFromEmail: 'billing@example.com',
      recipients: [{ name: 'Client', email: 'client@example.net' }],
      subject: 'Invoice INV-1', body: 'Amount $12.34', attachPdf: false,
      sendMeACopy: false, thankYou: false, reminder: false, sendReminderOn: null,
    },
    delivery: {
      templateVersion: 1, senderIdentityId: 10, senderIdentityVersion: 0,
      senderEvidenceVersion: evidenceVersion, fromName: 'Delivery Org',
      fromEmail: 'billing@example.com', replyToEmail: null,
      subject: 'Invoice INV-1', textBody: 'Amount $12.34', htmlBody: null,
      recipients: [{ deliveryId: 700, name: 'Client', email: 'client@example.net' }],
    },
  })

for (const [name, factory] of [['SQLite', container], ['real D1', d1]] as const) {
  describe(`invoice email persistence (${name})`, () => {
    let database: Harness | undefined
    afterEach(async () => database?.close())

    it('atomically persists the immutable version snapshot, event, and recipient receipt', async () => {
      database = await factory()
      await seed(database)
      await expect(command(database)).resolves.toMatchObject({ event_count: 1 })
      expect(await database.rows(
        `SELECT template_version, sender_identity_id, sender_identity_version,
           sender_evidence_version, subject FROM invoice_email_intents`,
      )).toEqual([{
        template_version: 1,
        sender_identity_id: 10,
        sender_identity_version: 0,
        sender_evidence_version: 1,
        subject: 'Invoice INV-1',
      }])
      expect(await database.rows(
        `SELECT recipient.delivery_id, recipient.email, log.status, log.related_type
         FROM invoice_email_recipients recipient
         JOIN email_log log ON log.id = recipient.delivery_id`,
      )).toEqual([{
        delivery_id: 700,
        email: 'client@example.net',
        status: 'queued',
        related_type: 'invoice_message',
      }])
      const repository = createMoneyResourceRepository(database.orm)
      await expect(repository.listInvoiceDeliveryJobs('evt-delivery-1')).resolves.toEqual([
        expect.objectContaining({ deliveryId: 700, templateVersion: 1 }),
      ])
    })

    it('persists the intent for a deployment-attested Mailgun sender', async () => {
      database = await factory()
      await seed(database, true)
      await expect(command(database)).resolves.toMatchObject({ event_count: 1 })
      expect(await database.rows(
        `SELECT sender_identity_id, sender_evidence_version FROM invoice_email_intents`,
      )).toEqual([{ sender_identity_id: 10, sender_evidence_version: 1 }])
    })

    it('rolls back the message, state, event, and log if exact evidence is absent', async () => {
      database = await factory()
      await seed(database)
      await expect(command(database, 2)).rejects.toMatchObject({ code: 'command_storage_conflict' })
      expect(await database.rows(`SELECT state, version FROM invoices WHERE id = 1`)).toEqual([
        { state: 'draft', version: 0 },
      ])
      expect(await database.rows(`SELECT count(*) AS count FROM invoice_messages`)).toEqual([
        { count: 0 },
      ])
      expect(await database.rows(`SELECT count(*) AS count FROM email_log`)).toEqual([{ count: 0 }])
      expect(await database.rows(`SELECT count(*) AS count FROM event_outbox`)).toEqual([{ count: 0 }])
    })
  })
}
