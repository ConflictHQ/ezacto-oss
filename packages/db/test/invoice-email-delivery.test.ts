import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { executeInvoiceLifecycleCommand, type InvoiceStateDatabase } from '../src/invoice-state.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { createMoneyResourceRepository } from '../src/money-resources.js'
import { followUpAudienceGuard, readThankYouRecipients } from '../src/automatic-thank-you.js'
import { createReminderPort, recordReminderDelivery } from '../src/reminder-port.js'
import { createContainerEmailFeedbackLedger, createD1EmailFeedbackLedger, type InvoiceFeedbackRecoveryLedger } from '../src/email-feedback-events.js'

interface Harness {
  orm: InvoiceStateDatabase
  ledger: InvoiceFeedbackRecoveryLedger
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
    ledger: createContainerEmailFeedbackLedger(sqlite),
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
    ledger: createD1EmailFeedbackLedger(database),
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

const command = (
  database: Harness,
  evidenceVersion = 1,
  cc: readonly { name: string; email: string }[] = [],
) =>
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
      ...(cc.length === 0 ? {} : { cc }),
      subject: 'Invoice INV-1', body: 'Amount $12.34', attachPdf: false,
      sendMeACopy: false, thankYou: false, reminder: false, sendReminderOn: null,
    },
    delivery: {
      templateVersion: 1, senderIdentityId: 10, senderIdentityVersion: 0,
      senderEvidenceVersion: evidenceVersion, fromName: 'Delivery Org',
      fromEmail: 'billing@example.com', replyToEmail: null,
      subject: 'Invoice INV-1', textBody: 'Amount $12.34', htmlBody: null,
      deliveryId: 700,
      recipients: [
        { name: 'Client', email: 'client@example.net', role: 'to' },
        ...cc.map((person) => ({ ...person, role: 'cc' as const })),
      ],
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
        expect.objectContaining({
          deliveryId: 700,
          templateVersion: 1,
          to: [{ name: 'Client', email: 'client@example.net' }],
          cc: [],
        }),
      ])
    })

    it('sends one email To the client and Cc everyone copied, each recorded against it', async () => {
      database = await factory()
      await seed(database)
      await database.run(`INSERT INTO invoice_line_items
        (invoice_id, position, kind, description, quantity, unit_price_cents, amount_cents, created_at, updated_at)
        VALUES (1, 0, 'Service', 'Fixture work', 1, 1234, 1234, ?, ?)`, at, at)
      const cc = [
        { name: 'Pat Example', email: 'pat@example.net' },
        { name: '', email: 'finance@example.com' },
      ]
      await expect(command(database, 1, cc)).resolves.toMatchObject({ event_count: 1 })
      // One email, not one per address: the To and the Cc headers are the same
      // message, so accounts payable and the people copied can answer all of it.
      expect(await database.rows(
        `SELECT id, to_json, cc_json, status FROM email_log`,
      )).toEqual([{
        id: 700,
        to_json: JSON.stringify([{ email: 'client@example.net', name: 'Client' }]),
        cc_json: JSON.stringify([
          { email: 'pat@example.net', name: 'Pat Example' },
          { email: 'finance@example.com' },
        ]),
        status: 'queued',
      }])
      expect(await database.rows(
        `SELECT recipient_index, delivery_id, role, name, email
         FROM invoice_email_recipients ORDER BY recipient_index`,
      )).toEqual([
        { recipient_index: 0, delivery_id: 700, role: 'to', name: 'Client', email: 'client@example.net' },
        { recipient_index: 1, delivery_id: 700, role: 'cc', name: 'Pat Example', email: 'pat@example.net' },
        { recipient_index: 2, delivery_id: 700, role: 'cc', name: '', email: 'finance@example.com' },
      ])
      const repository = createMoneyResourceRepository(database.orm)
      await expect(repository.listInvoiceDeliveryJobs('evt-delivery-1')).resolves.toEqual([
        expect.objectContaining({
          deliveryId: 700,
          to: [{ name: 'Client', email: 'client@example.net' }],
          cc,
        }),
      ])
      // The message carries both headers, and reads its status off the email.
      const [message] = (await repository.listMessages(1))!
      expect(message).toMatchObject({
        recipients: [{ name: 'Client', email: 'client@example.net' }],
        cc,
        delivery_status: 'queued',
      })
      // The same command again is the same send, not a second one.
      await expect(command(database, 1, cc)).resolves.toMatchObject({ event_count: 1 })
      expect(await database.rows(`SELECT count(*) AS count FROM email_log`)).toEqual([{ count: 1 }])
      // The same key with a different copy list is a different command.
      await expect(
        command(database, 1, [{ name: 'Pat Example', email: 'pat@example.net' }]),
      ).rejects.toMatchObject({ code: 'command_id_reused' })

      // #1352: a planned date records a later message but sends no email.
      // Run the real audience query on both SQLite and D1; that history row
      // must never replace the immutable To/Cc delivery snapshot.
      await executeInvoiceLifecycleCommand(database.orm, {
        invoiceId: 1, commandId: 'planned-reminder', command: 'send',
        actor: { type: 'user', id: 1 }, authorize: async () => true,
        expectedVersion: 1, occurredAt: at, messageId: 9000, eventId: 'evt-planned',
        message: {
          sentBy: 'Avery Ng', sentByEmail: null, sentFrom: 'Delivery Org', sentFromEmail: 'billing@example.com',
          recipients: [{ name: 'Client', email: 'client@example.net' }],
          subject: null, body: null, attachPdf: false, sendMeACopy: false,
          thankYou: false, reminder: true, sendReminderOn: '2026-10-15',
        },
      })
      expect(await readThankYouRecipients(database.orm, 1)).toEqual([])
      await database.run(`UPDATE email_log SET status = 'sent', provider = 'mailgun', provider_message_id = 'fixture-accepted' WHERE id = 700`)
      const audience = [{ name: 'Client', email: 'client@example.net', role: 'to' as const },
        ...cc.map(person => ({ ...person, role: 'cc' as const }))]
      expect(await readThankYouRecipients(database.orm, 1)).toEqual(audience)
      const binding = JSON.stringify(audience)
      expect(await database.rows(`SELECT CASE WHEN ${followUpAudienceGuard} THEN 1 ELSE 0 END AS allowed`, 1, 1, binding, binding)).toEqual([{ allowed: 1 }])
      await database.run(`INSERT INTO scheduled_reminders (id, invoice_id, scheduled_at, interval_days, causation_event_id, created_at, updated_at)
        VALUES (87, 1, ?, 7, 'recovery-fixture', ?, ?)`, at, at, at)
      expect(await recordReminderDelivery(database.orm, {
        scheduledReminderId: 87, invoiceId: 1, deliveryId: 702, recipients: audience,
        templateVersion: 1, senderIdentityId: 10, senderIdentityVersion: 0, senderEvidenceVersion: 1,
        fromName: 'Delivery Org', fromEmail: 'billing@example.com', replyToEmail: null,
        subject: 'Reminder', textBody: 'Please review.', htmlBody: null, daysPastDue: 0, now: at,
      })).toBe('recorded')
      expect(await database.rows(`SELECT i.state, i.due_amount_cents AS due, r.status AS reminder_status, l.status AS delivery_status
        FROM invoices i JOIN scheduled_reminders r ON r.invoice_id = i.id JOIN invoice_reminder_deliveries d ON d.scheduled_reminder_id = r.id
        JOIN email_log l ON l.id = d.delivery_id WHERE r.id = 87`)).toEqual([{ state: 'open', due: 1234, reminder_status: 'pending', delivery_status: 'queued' }])
      const port = createReminderPort({ database: database.orm, configuration: {
        getTemplate: async () => { throw new Error('unexpected template read') },
        listSenderIdentities: async () => { throw new Error('unexpected sender read') },
      }, invoices: { read: async () => { throw new Error('unexpected invoice read') }, paymentUrl: async () => null }, now: () => at })
      expect(await port.prepare({ id: 87, invoiceId: 1, scheduledAt: at, intervalDays: 7, status: 'pending',
        template: 'reminder', causationEventId: 'recovery-fixture', createdAt: at, updatedAt: at })).toMatchObject({
        deliveryId: 702, to: [{ name: 'Client', email: 'client@example.net' }], cc,
      })
      await database.run(`UPDATE email_log SET status = 'bounced' WHERE id = 700`)
      expect(await database.rows(`SELECT CASE WHEN ${followUpAudienceGuard} THEN 1 ELSE 0 END AS allowed`, 1, 1, binding, binding)).toEqual([{ allowed: 0 }])
      await database.run(`INSERT INTO scheduled_reminders (id, invoice_id, scheduled_at, interval_days, causation_event_id, created_at, updated_at)
        VALUES (88, 1, ?, 7, 'fixture', ?, ?)`, at, at, at)
      await expect(recordReminderDelivery(database.orm, {
        scheduledReminderId: 88, invoiceId: 1, deliveryId: 701, recipients: audience,
        templateVersion: 1, senderIdentityId: 10, senderIdentityVersion: 0, senderEvidenceVersion: 1,
        fromName: 'Delivery Org', fromEmail: 'billing@example.com', replyToEmail: null,
        subject: 'Reminder', textBody: 'Please review.', htmlBody: null, daysPastDue: 0, now: at,
      })).rejects.toThrow()
      expect(await database.rows(`SELECT id FROM email_log WHERE id = 701`)).toEqual([])
      expect(await database.rows(`SELECT delivery_id FROM invoice_reminder_deliveries WHERE scheduled_reminder_id = 88`)).toEqual([])
    })

    it('persists the intent for a deployment-attested Mailgun sender', async () => {
      database = await factory()
      await seed(database, true)
      await expect(command(database)).resolves.toMatchObject({ event_count: 1 })
      expect(await database.rows(
        `SELECT sender_identity_id, sender_evidence_version FROM invoice_email_intents`,
      )).toEqual([{ sender_identity_id: 10, sender_evidence_version: 1 }])
    })

    it('[money #1352] fences a partial audience on independently verified feedback', async () => {
      database = await factory()
      await seed(database, true)
      await command(database, 1, [{ name: 'Bad', email: 'bad@example.net' }, { name: 'Good', email: 'good@example.net' }])
      await database.run(`UPDATE email_log SET status = 'sent', provider = 'mailgun', provider_message_id = 'fixture-accepted' WHERE id = 700`)
      const before = await readThankYouRecipients(database.orm, 1), oldBinding = JSON.stringify(before)
      await database.run(`INSERT INTO email_feedback_events(event_id, signature_token, event_type, severity, recipient,
        provider_message_id, delivery_id, received_at) VALUES ('bounce-proof', 'token-proof', 'failed', 'permanent',
        'bad@example.net', 'fixture-accepted', 700, ?)`, at)
      await database.run(`UPDATE email_log SET status = 'bounced' WHERE id = 700`)
      await database.run(`UPDATE email_feedback_events SET processed_at = ?, outcome = 'bounced' WHERE event_id = 'bounce-proof'`, at)
      expect(await readThankYouRecipients(database.orm, 1)).toEqual([])
      const token = '7acbff11-1395-4011-a881-c299dad9e890'
      const nextToken = '12345678-1234-4abc-8def-123456789abc'
      expect(await database.ledger.claimInvoiceFeedbackSweep(token, at)).toBe('')
      expect(await database.ledger.claimInvoiceFeedbackSweep(nextToken, at)).toBeNull()
      expect(await database.ledger.unverifiedInvoiceFeedback('', 10)).toMatchObject([{ eventId: 'bounce-proof', recipient: 'bad@example.net' }])
      const later = new Date(Date.parse(at) + 181_000).toISOString()
      expect(await database.ledger.claimInvoiceFeedbackSweep(nextToken, later)).toBe('')
      expect(await database.ledger.finishInvoiceFeedbackSweep(token, '', false, later)).toBe(false)
      await database.ledger.recordInvoiceEvidence('bounce-proof', at)
      expect(await database.ledger.unverifiedInvoiceFeedback('', 10)).toEqual([])
      expect(await database.ledger.finishInvoiceFeedbackSweep(nextToken, '', false, later)).toBe(true)
      const eligible = [{ name: 'Client', email: 'client@example.net', role: 'to' },
        { name: 'Good', email: 'good@example.net', role: 'cc' }]
      expect(await readThankYouRecipients(database.orm, 1)).toEqual(eligible)
      const binding = JSON.stringify(eligible)
      expect(await database.rows(`SELECT CASE WHEN ${followUpAudienceGuard} THEN 1 ELSE 0 END AS allowed`,
        1, 1, oldBinding, oldBinding)).toEqual([{ allowed: 0 }])
      expect(await database.rows(`SELECT CASE WHEN ${followUpAudienceGuard} THEN 1 ELSE 0 END AS allowed`,
        1, 1, binding, binding)).toEqual([{ allowed: 1 }])
      await expect(database.run(`UPDATE invoice_feedback_provider_evidence SET verified_at = ? WHERE event_id = 'bounce-proof'`, at)).rejects.toThrow()
      await database.run(`INSERT INTO email_feedback_events(event_id, signature_token, event_type, severity, recipient,
        provider_message_id, delivery_id, received_at) VALUES ('foreign-recipient', 'foreign-token', 'failed', 'permanent',
        'other@example.net', 'fixture-accepted', 700, ?)`, at)
      await expect(database.run(`INSERT INTO invoice_feedback_provider_evidence(event_id, verified_at) VALUES ('foreign-recipient', ?)`, at)).rejects.toThrow()
      expect(await readThankYouRecipients(database.orm, 1)).toEqual(eligible)
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
