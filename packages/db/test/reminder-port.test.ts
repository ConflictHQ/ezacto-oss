import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { migrateContainer } from '../src/migrate.js'
import { createContainerEmailConfigurationStore } from '../src/email-configuration.js'
import { executeInvoiceLifecycleCommand, recordInvoicePayment } from '../src/invoice-state.js'
import { createContainerOutboxService } from '../src/outbox.js'
import { createContainerReminderScheduler } from '../src/reminders.js'
import { createReminderPort, listReminderDeliveries } from '../src/reminder-port.js'
import {
  readOrganizationReminderPolicy,
  setOrganizationReminderPolicy,
} from '../src/reminder-settings.js'

/**
 * Issue 801, end to end against a real migrated database.
 *
 * An invoice is sent to somebody with no policy of its own while the
 * organisation has a default; the scheduler books the reminder off the
 * default; the day comes; the processor asks the port; a message comes out
 * addressed to the person who was sent the invoice, saying what is owed and
 * how late it is; and the record of it is kept. Then the invoice is paid and
 * nothing more goes.
 */

const sentAt = '2026-09-02T10:00:00.000Z'
let sqlite: BetterSqlite3.Database | null = null

const fixture = async () => {
  const database = new BetterSqlite3(':memory:')
  await migrateContainer(database)
  database.pragma('foreign_keys = ON')
  database.exec(`
    INSERT INTO organizations (name, modules, created_at, updated_at)
      VALUES ('CONFLICT', '{"invoices":true}', '${sentAt}', '${sentAt}');
    INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
      VALUES (1, 'Operator', 'One', 'administrator', '[]', '${sentAt}', '${sentAt}');
    INSERT INTO clients (id, name, currency, created_at, updated_at)
      VALUES (1, 'Kestrel Environmental', 'USD', '${sentAt}', '${sentAt}');
    INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date, state,
                          amount_cents, due_amount_cents, created_at, updated_at)
      VALUES (1, 1, '1293', 'USD', '2026-07-01', '2026-07-31', 'draft',
              1511250, 1511250, '${sentAt}', '${sentAt}');
    INSERT INTO invoice_line_items (invoice_id, position, kind, description, quantity,
                                    unit_price_cents, amount_cents, created_at, updated_at)
      VALUES (1, 0, 'Service', 'Advisory', 63.5, 23800, 1511250, '${sentAt}', '${sentAt}');
    INSERT INTO sender_identities
      (id, email, display_name, provider, provider_identity, is_default, version,
       created_by_user_id, created_at, updated_at)
      VALUES (1, 'billing@example.test', 'Finance team - CONFLICT', 'mailgun',
              'billing@example.test', 0, 0, 1, '${sentAt}', '${sentAt}');
    INSERT INTO sender_identity_evidence
      (sender_identity_id, evidence_version, source, identity_kind, verification_status,
       dkim_status, mail_from_status, observed_at)
      VALUES (1, 1, 'deployment_config', 'email_address', 'operator_configured',
              'not_applicable', 'not_configured', '${sentAt}');
  `)
  database.exec(`UPDATE sender_identities
    SET is_default = 1, version = version + 1, updated_at = '${sentAt}' WHERE id = 1`)
  sqlite = database
  const orm = createContainerDatabase(database)
  const scheduler = createContainerReminderScheduler(database)
  const outbox = createContainerOutboxService(database, {
    additionalSubscribers: [scheduler.subscriber],
  })
  const port = createReminderPort({
    database: orm,
    configuration: createContainerEmailConfigurationStore(database),
    invoices: {
      read: async (invoiceId) => {
        const row = database
          .prepare(
            `SELECT id, number, subject, currency, amount_cents AS amountCents,
                    issue_date AS issueDate, due_date AS dueDate
             FROM invoices WHERE id = ?`,
          )
          .get(invoiceId) as Record<string, never> | undefined
        if (row === undefined) return null
        return {
          invoiceId: Number(row.id),
          number: String(row.number),
          subject: row.subject === null ? null : String(row.subject),
          currency: String(row.currency),
          amountCents: Number(row.amountCents),
          discountAmountCents: 0,
          taxAmountCents: 0,
          tax2AmountCents: 0,
          issueDate: String(row.issueDate),
          dueDate: String(row.dueDate),
          organizationName: 'CONFLICT',
          clientName: 'Kestrel Environmental',
          lineItems: [
            { kind: 'Service', description: 'Advisory', quantity: 63.5, unitPriceCents: 23800, amountCents: 1511250 },
          ],
        }
      },
      paymentUrl: async () => 'https://pay.example.test/1293',
    },
    // The wall clock, as the outbox's own is: a fixed instant here would sit
    // before the booking's `created_at` and trip the row's timestamp check.
    now: () => new Date().toISOString(),
  })
  return { database, orm, scheduler, outbox, port }
}

const sendTo = (
  orm: Awaited<ReturnType<typeof fixture>>['orm'],
  people: readonly { name: string; email: string }[],
  sendReminderOn: string | null = null,
) =>
  executeInvoiceLifecycleCommand(orm, {
    invoiceId: 1,
    commandId: 'send-1',
    command: 'send',
    actor: { type: 'user', id: 1 },
    authorize: async () => true,
    expectedVersion: 0,
    occurredAt: sentAt,
    messageId: 70,
    eventId: 'evt-70',
    message: {
      sentBy: 'Operator One', sentByEmail: null,
      sentFrom: 'Finance team - CONFLICT', sentFromEmail: 'billing@example.test',
      recipients: people, subject: 'Invoice 1293', body: 'Attached.',
      attachPdf: false, sendMeACopy: false, thankYou: false,
      reminder: sendReminderOn !== null, sendReminderOn,
    },
    delivery: {
      templateVersion: 1, senderIdentityId: 1, senderIdentityVersion: 1,
      senderEvidenceVersion: 1, fromName: 'Finance team - CONFLICT',
      fromEmail: 'billing@example.test', replyToEmail: null,
      subject: 'Invoice 1293', textBody: 'Attached.', htmlBody: null,
      recipients: people.map((person, index) => ({ deliveryId: 700 + index, ...person })),
    },
  })

afterEach(() => {
  sqlite?.close()
  sqlite = null
})

describe('the organisation default policy', () => {
  it('[unit] is read back as it was set, and null switches it off', async () => {
    const { orm } = await fixture()
    expect(await readOrganizationReminderPolicy(orm)).toBeNull()
    await setOrganizationReminderPolicy(orm, { first_after_days: 3, every_days: 7 }, sentAt)
    expect(await readOrganizationReminderPolicy(orm)).toEqual({ first_after_days: 3, every_days: 7 })
    await setOrganizationReminderPolicy(orm, null, sentAt)
    expect(await readOrganizationReminderPolicy(orm)).toBeNull()
  })
})

describe('an overdue invoice is reminded', () => {
  it('[money] books the reminder off the organisation default, sends once, records it, and stops when paid', async () => {
    const { database, orm, scheduler, outbox, port } = await fixture()
    await setOrganizationReminderPolicy(orm, { first_after_days: 14, every_days: 7 }, sentAt)
    await sendTo(orm, [{ name: 'Accounts Payable', email: 'ap@kestrel.test' }])
    await outbox.drain()

    // Scheduled 14 days after the due date, from the default, with nothing on
    // the invoice itself.
    const pending = await scheduler.listPending(1)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.scheduledAt).toBe('2026-08-14T00:00:00.000Z')

    const sent: string[] = []
    // Processed on the day the cron runs, well after the scheduled date (and
    // after the outbox recorded the booking, whose clock is the wall's): a row
    // that came due while nothing was processing is still sent, and says how
    // late the invoice is today rather than on the day it was booked.
    const processedAt = new Date().toISOString()
    const summary = await scheduler.processReminders({
      now: processedAt,
      send: async (reminder) => {
        const message = await port.prepare(reminder)
        if (message === null) throw new Error('nothing to send')
        sent.push(message.textBody)
        expect(message.to).toEqual([{ name: 'Accounts Payable', email: 'ap@kestrel.test' }])
        expect(message.subject).toBe('Reminder: invoice #1293 from CONFLICT')
      },
    })
    expect(summary).toEqual({ examined: 1, sent: 1, scheduled: 1 })
    expect(sent).toHaveLength(1)
    // The seeded template names the amount and the due date; the line items
    // follow because the template never asks for them.
    expect(sent[0]).toContain('$15,112.50')
    expect(sent[0]).toContain('Advisory')

    const deliveries = await listReminderDeliveries(orm, 1)
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toMatchObject({
      daysPastDue: Math.floor((Date.parse(processedAt) - Date.parse('2026-07-31T00:00:00.000Z')) / 86_400_000),
    })
    const log = database
      .prepare(`SELECT template, related_type, related_id FROM email_log WHERE id = ?`)
      .get(deliveries[0]!.deliveryId)
    expect(log).toEqual({ template: 'reminder:3', related_type: 'invoice', related_id: 1 })

    // The next one is booked a week on from the scheduled date, which keeps
    // the cadence anchored to the due date rather than to when the cron ran.
    const next = await scheduler.listPending(1)
    expect(next[0]!.scheduledAt).toBe('2026-08-21T00:00:00.000Z')
    // The row already sent is refused a second time: the delivery record is
    // keyed on it, so a redelivered tick cannot mail the client twice.
    expect(await port.prepare(pending[0]!)).toBeNull()

    // Paid in full: the pending row is cancelled and the port refuses.
    await recordInvoicePayment(orm, {
      invoiceId: 1,
      commandId: 'pay-1',
      actor: { type: 'user', id: 1 },
      authorize: async () => true,
      expectedVersion: 1,
      occurredAt: new Date().toISOString(),
      eventIds: ['evt-pay-a', 'evt-pay-b'],
      payment: {
        type: 'manual', id: 1, currency: 'USD', amountCents: 1511250,
        paidAt: null, paidDate: new Date().toISOString().slice(0, 10), notes: null, recordedByUserId: 1,
      },
    })
    await outbox.drain()
    expect(await scheduler.listPending(1)).toHaveLength(0)
    expect(await port.prepare(next[0]!)).toBeNull()
  })

  it('[unit] the date named on the send wins over the policy offset', async () => {
    const { orm, scheduler, outbox } = await fixture()
    await setOrganizationReminderPolicy(orm, { first_after_days: 14, every_days: 7 }, sentAt)
    await sendTo(orm, [{ name: 'AP', email: 'ap@kestrel.test' }], '2026-08-05')
    await outbox.drain()
    expect((await scheduler.listPending(1))[0]!.scheduledAt).toBe('2026-08-05T00:00:00.000Z')
  })

  it('[unit] a date named on the send with no policy anywhere books it, weekly after', async () => {
    const { orm, scheduler, outbox } = await fixture()
    await sendTo(orm, [{ name: 'AP', email: 'ap@kestrel.test' }], '2026-08-05')
    await outbox.drain()
    const [booked] = await scheduler.listPending(1)
    expect(booked).toMatchObject({ scheduledAt: '2026-08-05T00:00:00.000Z', intervalDays: 7 })
  })

  it('[unit] with no policy anywhere, nothing is booked', async () => {
    const { orm, scheduler, outbox } = await fixture()
    await sendTo(orm, [{ name: 'AP', email: 'ap@kestrel.test' }])
    await outbox.drain()
    expect(await scheduler.listPending(1)).toHaveLength(0)
  })

  it('[security] the record refuses a reminder for an invoice that is not open', async () => {
    const { database, orm, scheduler, outbox, port } = await fixture()
    await setOrganizationReminderPolicy(orm, { first_after_days: 0, every_days: 7 }, sentAt)
    await sendTo(orm, [{ name: 'AP', email: 'ap@kestrel.test' }])
    await outbox.drain()
    const [reminder] = await scheduler.listPending(1)
    // Settled underneath the scheduled row, before the outbox has run the
    // cancellation: the port refuses on the invoice's own state.
    await recordInvoicePayment(orm, {
      invoiceId: 1,
      commandId: 'pay-early',
      actor: { type: 'user', id: 1 },
      authorize: async () => true,
      expectedVersion: 1,
      occurredAt: '2026-08-01T09:00:00.000Z',
      eventIds: ['evt-early-a', 'evt-early-b'],
      payment: {
        type: 'manual', id: 1, currency: 'USD', amountCents: 1511250,
        paidAt: null, paidDate: '2026-08-01', notes: null, recordedByUserId: 1,
      },
    })
    expect(database.prepare(`SELECT state FROM invoices WHERE id = 1`).get()).toEqual({ state: 'paid' })
    expect(await port.prepare(reminder!)).toBeNull()
    expect(await listReminderDeliveries(orm, 1)).toHaveLength(0)
  })
})
