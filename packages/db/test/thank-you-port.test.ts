import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { migrateContainer } from '../src/migrate.js'
import { createContainerEmailConfigurationStore } from '../src/email-configuration.js'
import { recordCheckoutPayment } from '../src/checkout-payments.js'
import { executeInvoiceLifecycleCommand } from '../src/invoice-state.js'
import { createThankYouPort } from '../src/thank-you-port.js'

/**
 * Issue 545, end to end against a real migrated database.
 *
 * The unit tests either side of this prove the store and the renderer. This is
 * the one that proves they are joined: an invoice is sent to somebody, a
 * payment settles it, and a message comes out addressed to the person who was
 * sent it. Every previous defect on this issue's neighbours was a layer that
 * worked alone and was never called, so this is the test that matters.
 */

const at = '2026-09-12T12:00:00.000Z'
let sqlite: BetterSqlite3.Database | null = null

const fixture = async (thankYou: boolean) => {
  const database = new BetterSqlite3(':memory:')
  await migrateContainer(database)
  database.pragma('foreign_keys = ON')
  database.exec(`
    INSERT INTO organizations (name, modules, invoice_extras, created_at, updated_at)
      VALUES ('CONFLICT', '{}', '{"thank_you":${thankYou ? 'true' : 'false'}}', '${at}', '${at}');
    INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
      VALUES (1, 'Operator', 'One', 'administrator', '[]', '${at}', '${at}');
    INSERT INTO clients (id, name, currency, created_at, updated_at)
      VALUES (1, 'Kestrel Environmental', 'USD', '${at}', '${at}');
    INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date, state,
                          amount_cents, due_amount_cents, created_at, updated_at)
      VALUES (1, 1, '1315', 'USD', '2026-08-31', '2026-09-30', 'draft',
              100000, 100000, '${at}', '${at}');
    INSERT INTO invoice_line_items (invoice_id, position, kind, description, quantity,
                                    unit_price_cents, amount_cents, created_at, updated_at)
      VALUES (1, 0, 'Service', 'Advisory', 1, 100000, 100000, '${at}', '${at}');
    INSERT INTO payment_provider_accounts
      (id, provider, provider_shape, external_account_id, display_name, created_at, updated_at)
      VALUES (1, 'stripe', 'checkout', 'stripe', 'Stripe', '${at}', '${at}');
    INSERT INTO sender_identities
      (id, email, display_name, provider, provider_identity, is_default, version,
       created_by_user_id, created_at, updated_at)
      VALUES (1, 'billing@example.test', 'CONFLICT Billing', 'mailgun',
              'billing@example.test', 0, 0, 1, '${at}', '${at}');
    INSERT INTO sender_identity_evidence
      (sender_identity_id, evidence_version, source, identity_kind, verification_status,
       dkim_status, mail_from_status, observed_at)
      VALUES (1, 1, 'deployment_config', 'email_address', 'operator_configured',
              'not_applicable', 'not_configured', '${at}');
  `)
  // Promoted rather than inserted as the default: the schema refuses an
  // identity that is default before it has evidence, which is the right way
  // round and means a fixture cannot skip the evidence.
  database.exec(`UPDATE sender_identities
    SET is_default = 1, version = version + 1, updated_at = '${at}' WHERE id = 1`)
  sqlite = database
  const orm = createContainerDatabase(database)
  const port = createThankYouPort({
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
            {
              kind: 'Service',
              description: 'Advisory',
              quantity: 1,
              unitPriceCents: 100000,
              amountCents: 100000,
            },
          ],
        }
      },
    },
    now: () => at,
  })
  return { orm, port }
}

const sendTo = (
  orm: Awaited<ReturnType<typeof fixture>>['orm'],
  people: readonly { name: string; email: string }[],
) =>
  executeInvoiceLifecycleCommand(orm, {
    invoiceId: 1,
    commandId: 'send-1',
    command: 'send',
    actor: { type: 'user', id: 1 },
    authorize: async () => true,
    expectedVersion: 0,
    occurredAt: at,
    messageId: 70,
    eventId: 'evt-70',
    message: {
      sentBy: 'Operator One', sentByEmail: null,
      sentFrom: 'CONFLICT Billing', sentFromEmail: 'billing@example.test',
      recipients: people, subject: 'Invoice 1315', body: 'Attached.',
      attachPdf: false, sendMeACopy: false, thankYou: false,
      reminder: false, sendReminderOn: null,
    },
    delivery: {
      // Version 1, not 0: promoting the identity to default advanced it.
      templateVersion: 1, senderIdentityId: 1, senderIdentityVersion: 1,
      senderEvidenceVersion: 1, fromName: 'CONFLICT Billing',
      fromEmail: 'billing@example.test', replyToEmail: null,
      subject: 'Invoice 1315', textBody: 'Attached.', htmlBody: null,
      recipients: people.map((person, index) => ({ deliveryId: 700 + index, ...person })),
    },
  })

const settle = (orm: Awaited<ReturnType<typeof fixture>>['orm'], amountCents = 100000) =>
  recordCheckoutPayment(orm, {
    invoiceId: 1,
    provider: 'stripe',
    externalAccountId: 'stripe',
    accountDisplayName: 'Stripe',
    providerTransactionId: 'pi_fixture',
    amountCents,
    paidOn: '2026-09-12',
    now: at,
  })

afterEach(() => {
  sqlite?.close()
  sqlite = null
})

describe('an invoice settling produces a message', () => {
  it('[money] addresses the person the invoice was sent to, and records it', async () => {
    const { orm, port } = await fixture(true)
    await sendTo(orm, [{ name: 'Accounts Payable', email: 'ap@example.test' }])
    expect(await settle(orm)).toBe('recorded')

    const message = await port.prepare(1)
    expect(message).not.toBeNull()
    expect(message!.to).toEqual([{ name: 'Accounts Payable', email: 'ap@example.test' }])
    expect(message!.fromEmail).toBe('billing@example.test')
    expect(message!.subject.length).toBeGreaterThan(0)
    // The record exists before anything is queued, which is what stops a
    // redelivery sending a second one.
    expect(
      sqlite!.prepare(`SELECT count(*) AS n FROM invoice_auto_email_intents`).get(),
    ).toEqual({ n: 1 })
  })

  it('[money] prepares nothing the second time, so a redelivered event sends once', async () => {
    const { orm, port } = await fixture(true)
    await sendTo(orm, [{ name: 'Accounts Payable', email: 'ap@example.test' }])
    await settle(orm)
    expect(await port.prepare(1)).not.toBeNull()
    expect(await port.prepare(1)).toBeNull()
    expect(
      sqlite!.prepare(`SELECT count(*) AS n FROM invoice_auto_email_intents`).get(),
    ).toEqual({ n: 1 })
  })

  it('[money] sends nothing while the feature is off', async () => {
    const { orm, port } = await fixture(false)
    await sendTo(orm, [{ name: 'Accounts Payable', email: 'ap@example.test' }])
    await settle(orm)
    expect(await port.prepare(1)).toBeNull()
  })

  it('[money] sends nothing for an invoice nobody was ever emailed', async () => {
    // Settled by a cheque that arrived before anyone sent the invoice. There is
    // no address to thank, and guessing at the client record would mail
    // somebody who never received the invoice in the first place.
    const { orm, port } = await fixture(true)
    await settle(orm)
    expect(await port.prepare(1)).toBeNull()
  })

  it('[money] sends nothing while the invoice is only part paid', async () => {
    const { orm, port } = await fixture(true)
    await sendTo(orm, [{ name: 'Accounts Payable', email: 'ap@example.test' }])
    expect(await settle(orm, 1000)).toBe('recorded')
    expect(
      sqlite!.prepare(`SELECT state FROM invoices WHERE id = 1`).get(),
    ).toEqual({ state: 'open' })
    expect(await port.prepare(1)).toBeNull()
  })

  it('[security] refuses when the only sender identity is archived', async () => {
    const { orm, port } = await fixture(true)
    await sendTo(orm, [{ name: 'Accounts Payable', email: 'ap@example.test' }])
    await settle(orm)
    sqlite!.exec(`UPDATE sender_identities
      SET is_default = 0, archived_at = '2026-09-12T13:00:00.000Z', version = version + 1,
          updated_at = '2026-09-12T13:00:00.000Z' WHERE id = 1`)
    expect(await port.prepare(1)).toBeNull()
  })

  it('[money] lets one invoice opt out of a default that is on', async () => {
    const { orm, port } = await fixture(true)
    await sendTo(orm, [{ name: 'Accounts Payable', email: 'ap@example.test' }])
    await settle(orm)
    // Some invoices settle a dispute, and a cheerful automated note is the
    // wrong thing to send about those.
    sqlite!.exec(`UPDATE invoices SET invoice_extras = '{"thank_you":false}' WHERE id = 1`)
    expect(await port.prepare(1)).toBeNull()
  })
})
