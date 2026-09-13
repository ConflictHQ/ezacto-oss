import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import {
  executeInvoiceLifecycleCommand,
  type InvoiceStateDatabase,
} from '../src/invoice-state.js'
import { migrateContainer } from '../src/migrate.js'
import {
  hasThankYouIntent,
  readThankYouRecipients,
  recordThankYouDelivery,
  resolveThankYouPolicy,
  setInvoiceThankYouPolicy,
  setOrganizationThankYouPolicy,
} from '../src/automatic-thank-you.js'

/**
 * Issue 545, and specifically the half that decides whether to send at all.
 *
 * Run against a real migrated database rather than a stub, because everything
 * load-bearing here is a constraint: the primary key that makes a second
 * thank-you impossible, and the trigger that refuses an imported payment. A
 * fake would agree with whatever it was told.
 */

const at = '2026-09-12T12:00:00.000Z'
let sqlite: BetterSqlite3.Database | null = null

const fixture = async () => {
  const database = new BetterSqlite3(':memory:')
  await migrateContainer(database)
  database.pragma('foreign_keys = ON')
  database.exec(`
    INSERT INTO organizations (name, modules, created_at, updated_at)
      VALUES ('Fixture', '{}', '${at}', '${at}');
    INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
      VALUES (1, 'Operator', 'One', 'administrator', '[]', '${at}', '${at}');
    INSERT INTO clients (id, name, currency, created_at, updated_at)
      VALUES (1, 'Kestrel Environmental', 'USD', '${at}', '${at}');
    INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date, state, created_at, updated_at)
      VALUES (1, 1, '1315', 'USD', '2026-09-12', '2026-10-12', 'draft', '${at}', '${at}');
    INSERT INTO invoice_line_items (invoice_id, position, kind, description, quantity, unit_price_cents, amount_cents, created_at, updated_at)
      VALUES (1, 0, 'Service', 'Advisory', 1, 100000, 100000, '${at}', '${at}');
    INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date, state, created_at, updated_at)
      VALUES (2, 1, '1316', 'USD', '2026-09-12', '2026-10-12', 'open', '${at}', '${at}');
  `)
  sqlite = database
  return createContainerDatabase(database)
}

afterEach(() => {
  sqlite?.close()
  sqlite = null
})

const bare = async () => {
  const database = new BetterSqlite3(':memory:')
  await migrateContainer(database)
  for (const name of database
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='trigger'
         AND tbl_name IN ('invoice_payments','email_log')`,
    )
    .all() as { name: string }[]) {
    database.exec(`DROP TRIGGER ${name.name}`)
  }
  database.pragma('foreign_keys = ON')
  database.exec(`
    INSERT INTO organizations (name, modules, created_at, updated_at)
      VALUES ('Fixture', '{}', '${at}', '${at}');
    INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
      VALUES (1, 'Operator', 'One', 'administrator', '[]', '${at}', '${at}');
    INSERT INTO clients (id, name, currency, created_at, updated_at)
      VALUES (1, 'Kestrel Environmental', 'USD', '${at}', '${at}');
    INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date, state, created_at, updated_at)
      VALUES (1, 1, '1315', 'USD', '2026-09-12', '2026-10-12', 'open', '${at}', '${at}');
    INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date, state,
                          sent_at, paid_date, created_at, updated_at)
      VALUES (3, 1, '1317', 'USD', '2026-09-12', '2026-10-12', 'paid',
              '${at}', '2026-09-12', '${at}', '${at}');
    INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date, state,
                          amount_cents, due_amount_cents, created_at, updated_at)
      VALUES (4, 1, '1318', 'USD', '2026-09-12', '2026-10-12', 'draft',
              100000, 100000, '${at}', '${at}');
    INSERT INTO payment_provider_accounts
      (id, provider, provider_shape, external_account_id, display_name, created_at, updated_at)
      VALUES (1, 'stripe', 'checkout', 'stripe', 'Stripe', '${at}', '${at}');
    INSERT INTO sender_identities
      (id, email, display_name, provider, provider_identity, is_default, version,
       created_by_user_id, created_at, updated_at)
      VALUES (1, 'billing@example.test', 'Fixture', 'mailgun', 'billing@example.test',
              0, 0, 1, '${at}', '${at}');
    INSERT INTO sender_identity_evidence
      (sender_identity_id, evidence_version, source, identity_kind, verification_status,
       dkim_status, mail_from_status, observed_at)
      VALUES (1, 1, 'deployment_config', 'email_address', 'operator_configured',
              'not_applicable', 'not_configured', '${at}');
    INSERT INTO email_log (id, template, subject, status, from_json, to_json, created_at, updated_at)
      VALUES (9000, 'thank_you', 'Paid', 'queued', '{"email":"b@example.test"}',
              '[{"email":"c@example.test"}]', '${at}', '${at}');
    INSERT INTO email_log (id, template, subject, status, from_json, to_json, created_at, updated_at)
      VALUES (9001, 'thank_you', 'Paid', 'queued', '{"email":"b@example.test"}',
              '[{"email":"c@example.test"}]', '${at}', '${at}');
  `)
  sqlite = database
  return createContainerDatabase(database)
}

// An imported payment is manual by definition -- the schema requires it,
// because Harvest recorded receipts rather than taking them.
const seedPayment = (harvestId: number | null) => {
  sqlite!.exec(
    harvestId === null
      ? `INSERT INTO invoice_payments
           (id, invoice_id, currency, amount_cents, paid_date, provider, provider_shape,
            provider_account_id, provider_transaction_id, created_at, updated_at)
           VALUES (500, 1, 'USD', 100000, '2026-09-12', 'stripe', 'checkout',
                   1, 'pi_fixture', '${at}', '${at}')`
      : // An imported receipt mirrors its source dates -- the schema requires
        // `paid_date` to be exactly `source_paid_date`, so the loaded row
        // cannot drift from what Harvest recorded.
        `INSERT INTO invoice_payments
           (id, harvest_id, invoice_id, currency, amount_cents, paid_date,
            source_paid_date, provider, provider_shape, created_at, updated_at)
           VALUES (500, ${String(harvestId)}, 1, 'USD', 100000, '2026-09-12',
                   '2026-09-12', 'manual', 'manual', '${at}', '${at}')`,
  )
}

describe('deciding whether a settled invoice says thank you', () => {
  it('[unit] sends nothing until somebody turns it on', async () => {
    // A deployment that upgrades into this feature must not begin emailing
    // clients because it was deployed.
    const database = await fixture()
    expect(await resolveThankYouPolicy(database, 1)).toEqual({
      send: false,
      because: 'organization',
    })
  })

  it('[unit] follows the organization default when the invoice has no preference', async () => {
    const database = await fixture()
    await setOrganizationThankYouPolicy(database, true)
    expect(await resolveThankYouPolicy(database, 1)).toEqual({
      send: true,
      because: 'organization',
    })
  })

  it('[money] lets one invoice refuse while the default says send', async () => {
    // The load-bearing half. Some invoices settle a dispute, and a cheerful
    // automated thank-you is the wrong thing to send about those.
    const database = await fixture()
    await setOrganizationThankYouPolicy(database, true)
    await setInvoiceThankYouPolicy(database, { invoiceId: 1, enabled: false })
    expect(await resolveThankYouPolicy(database, 1)).toEqual({
      send: false,
      because: 'invoice',
    })
    expect(await resolveThankYouPolicy(database, 2)).toEqual({
      send: true,
      because: 'organization',
    })
  })

  it('[money] lets one invoice send while the default is off', async () => {
    const database = await fixture()
    await setInvoiceThankYouPolicy(database, { invoiceId: 1, enabled: true })
    expect(await resolveThankYouPolicy(database, 1)).toEqual({
      send: true,
      because: 'invoice',
    })
  })

  it('[money] reads the default at send time, not at the time the invoice was raised', async () => {
    // An operator who turns this off today expects that to govern an invoice
    // raised yesterday. A preference frozen at creation would keep sending from
    // invoices already in flight.
    const database = await fixture()
    await setOrganizationThankYouPolicy(database, true)
    expect((await resolveThankYouPolicy(database, 1)).send).toBe(true)
    await setOrganizationThankYouPolicy(database, false)
    expect((await resolveThankYouPolicy(database, 1)).send).toBe(false)
  })

  it('[unit] hands an invoice back to the default when its preference is cleared', async () => {
    const database = await fixture()
    await setOrganizationThankYouPolicy(database, true)
    await setInvoiceThankYouPolicy(database, { invoiceId: 1, enabled: false })
    expect((await resolveThankYouPolicy(database, 1)).send).toBe(false)
    await setInvoiceThankYouPolicy(database, { invoiceId: 1, enabled: null })
    expect(await resolveThankYouPolicy(database, 1)).toEqual({
      send: true,
      because: 'organization',
    })
  })

  it('[unit] refuses an invoice that does not exist rather than falling back', async () => {
    const database = await fixture()
    await setOrganizationThankYouPolicy(database, true)
    expect(await resolveThankYouPolicy(database, 404)).toEqual({
      send: false,
      because: 'unknown_invoice',
    })
  })
})

describe('what the schema itself refuses', () => {
  /**
   * These exercise this migration's own constraints, so the surrounding payment
   * and delivery guards are stood down first. They are not what is under test
   * here and they are exercised where they belong -- the payment command ledger
   * in `checkout-payments.test.ts`, the delivery guards in the email suite --
   * and leaving them up would mean building the entire import machinery to
   * reach a single trigger.
   */

  const insertIntent = (deliveryId: number, kind = 'thank_you') =>
    sqlite!.exec(`
      INSERT INTO invoice_auto_email_intents
        (invoice_payment_id, invoice_id, delivery_id, template_kind, template_version,
         sender_identity_id, sender_identity_version, sender_evidence_version,
         from_name, from_email, subject, text_body, triggered_by, created_at)
        VALUES (500, 1, ${deliveryId}, '${kind}',
                (SELECT current_version FROM email_template_heads WHERE template_kind='${kind}'),
                1, 0, 1, 'Fixture', 'billing@example.test', 'Paid', 'Thank you.',
                'payment_settled', '${at}');
    `)

  it('[money] allows exactly one thank-you per payment', async () => {
    // Idempotence as a schema fact rather than something the sender has to
    // remember: a payment recorded, removed and recorded again cannot produce
    // a second thank-you.
    const database = await bare()
    seedPayment(null)
    insertIntent(9000)
    expect(await hasThankYouIntent(database, 500)).toBe(true)
    expect(() => insertIntent(9001)).toThrow(/UNIQUE|PRIMARY KEY/iu)
  })

  it('[money] refuses to thank a client for a payment that was imported', async () => {
    // The cutover carried 432 settled invoices. The failure this refuses is
    // emailing every client of the last thirteen years at once.
    const database = await bare()
    seedPayment(99001)
    expect(() => insertIntent(9000)).toThrow(/imported payment cannot send a thank-you/u)
    expect(await hasThankYouIntent(database, 500)).toBe(false)
  })

  it('[security] keeps the record of what was sent immutable', async () => {
    await bare()
    seedPayment(null)
    insertIntent(9000)
    expect(() => sqlite!.exec(`UPDATE invoice_auto_email_intents SET subject = 'Edited'`)).toThrow(
      /immutable/u,
    )
    expect(() => sqlite!.exec(`DELETE FROM invoice_auto_email_intents`)).toThrow(/immutable/u)
  })

  it('[security] refuses a kind other than thank_you in the automatic table', async () => {
    // An invoice send is a person's decision and belongs in the confirmed
    // table. Widening this check is how the two provenances blur back together.
    await bare()
    seedPayment(null)
    expect(() => insertIntent(9000, 'invoice')).toThrow(/CHECK|constraint/iu)
  })
})

describe('recording the thank-you that was sent', () => {
  // Invoice 3 is already settled, and invoice 1 is still open. An invoice
  // cannot be moved between the two here: the lifecycle trigger from migration
  // 0022 refuses a bare state change, which is the money authority working, so
  // the two states are two fixtures rather than one fixture and an UPDATE.
  const SETTLED_INVOICE = 3
  const SETTLED_PAYMENT = 501

  const seedSettledPayment = (harvestId: number | null) =>
    sqlite!.exec(
      harvestId === null
        ? `INSERT INTO invoice_payments
             (id, invoice_id, currency, amount_cents, paid_date, provider, provider_shape,
              provider_account_id, provider_transaction_id, created_at, updated_at)
             VALUES (${SETTLED_PAYMENT}, ${SETTLED_INVOICE}, 'USD', 100000, '2026-09-12',
                     'stripe', 'checkout', 1, 'pi_settled', '${at}', '${at}')`
        : `INSERT INTO invoice_payments
             (id, harvest_id, invoice_id, currency, amount_cents, paid_date,
              source_paid_date, provider, provider_shape, created_at, updated_at)
             VALUES (${SETTLED_PAYMENT}, ${String(harvestId)}, ${SETTLED_INVOICE}, 'USD', 100000,
                     '2026-09-12', '2026-09-12', 'manual', 'manual', '${at}', '${at}')`,
    )

  const delivery = (overrides: Record<string, unknown> = {}) => ({
    invoicePaymentId: SETTLED_PAYMENT,
    invoiceId: SETTLED_INVOICE,
    deliveryId: 9100,
    templateVersion: 1,
    senderIdentityId: 1,
    senderIdentityVersion: 0,
    senderEvidenceVersion: 1,
    fromName: 'Fixture',
    fromEmail: 'billing@example.test',
    replyToEmail: null,
    recipients: [{ name: 'Accounts Payable', email: 'ap@example.test' }],
    subject: 'Thank you for your payment',
    textBody: 'We received your payment. Thank you.',
    htmlBody: null,
    now: at,
    ...overrides,
  })

  const deliveries = (id = 9100) =>
    sqlite!.prepare(`SELECT id FROM email_log WHERE id = ${String(id)}`).all()
  const intents = () =>
    sqlite!
      .prepare(`SELECT invoice_payment_id AS payment, delivery_id AS delivery,
                       template_kind AS kind, triggered_by AS why, subject
                FROM invoice_auto_email_intents`)
      .all() as Record<string, unknown>[]

  it('[money] writes the delivery and the intent that explains it', async () => {
    const database = await bare()
    seedSettledPayment(null)
    expect(await recordThankYouDelivery(database, delivery())).toBe('recorded')
    expect(intents()).toEqual([
      {
        payment: SETTLED_PAYMENT,
        delivery: 9100,
        kind: 'thank_you',
        why: 'payment_settled',
        subject: 'Thank you for your payment',
      },
    ])
    expect(deliveries()).toHaveLength(1)
  })

  it('[money] sends one thank-you per payment, however often it is asked', async () => {
    // A queue redelivers. The second call must be an answer rather than a
    // constraint failure the caller has to interpret, and must leave no second
    // delivery behind for the outbox to find.
    const database = await bare()
    seedSettledPayment(null)
    expect(await recordThankYouDelivery(database, delivery())).toBe('recorded')
    expect(await recordThankYouDelivery(database, delivery({ deliveryId: 9101 }))).toBe(
      'already_sent',
    )
    expect(intents()).toHaveLength(1)
    expect(deliveries(9101)).toHaveLength(0)
  })

  it('[money] says nothing while the invoice is only part paid', async () => {
    // A $10 payment against a $10,000 invoice is not "paid". Invoice 1 is still
    // open, and its client must not be thanked for settling it.
    const database = await bare()
    seedPayment(null)
    expect(
      await recordThankYouDelivery(database, delivery({ invoicePaymentId: 500, invoiceId: 1 })),
    ).toBe('not_settled')
    expect(intents()).toHaveLength(0)
  })

  it('[money] refuses an imported payment before writing anything', async () => {
    // The cutover carried 432 settled invoices. The failure this refuses is
    // emailing every client of the last thirteen years at once.
    const database = await bare()
    seedSettledPayment(99001)
    expect(await recordThankYouDelivery(database, delivery())).toBe('imported_payment')
    expect(intents()).toHaveLength(0)
  })

  it('[security] refuses a sender identity that has been archived', async () => {
    const database = await bare()
    seedSettledPayment(null)
    // Archiving advances the version, so the new version is passed here too:
    // the only condition left failing is that the identity is archived, which
    // is what this test is about.
    sqlite!.exec(`UPDATE sender_identities
      SET archived_at = '2026-09-12T13:00:00.000Z', version = version + 1,
          updated_at = '2026-09-12T13:00:00.000Z'
      WHERE id = 1`)
    expect(await recordThankYouDelivery(database, delivery({ senderIdentityVersion: 1 }))).toBe(
      'sender_unusable',
    )
  })

  it('[security] refuses a sender version the identity has moved past', async () => {
    // The version ties the record to the identity as it was. Recording a send
    // against a version that is not current claims evidence that was not in
    // force when it went out.
    const database = await bare()
    seedSettledPayment(null)
    expect(await recordThankYouDelivery(database, delivery({ senderIdentityVersion: 7 }))).toBe(
      'sender_unusable',
    )
  })

  it('[money] refuses a template version that does not exist', async () => {
    const database = await bare()
    seedSettledPayment(null)
    expect(await recordThankYouDelivery(database, delivery({ templateVersion: 999 }))).toBe(
      'template_missing',
    )
  })

  it('[money] refuses a payment that belongs to a different invoice', async () => {
    const database = await bare()
    seedSettledPayment(null)
    expect(await recordThankYouDelivery(database, delivery({ invoiceId: 1 }))).toBe(
      'unknown_payment',
    )
  })

  it('[money] leaves no delivery behind when it refuses', async () => {
    // The hazard is an `email_log` row with no intent recording why it exists:
    // a message the book cannot explain. Every refusal path, not only whichever
    // one happens to be checked last.
    const database = await bare()
    seedSettledPayment(null)
    for (const [reason, input] of [
      ['template_missing', delivery({ templateVersion: 999 })],
      ['sender_unusable', delivery({ senderIdentityVersion: 7 })],
      ['unknown_payment', delivery({ invoiceId: 1 })],
    ] as const) {
      expect(await recordThankYouDelivery(database, input)).toBe(reason)
      expect(deliveries()).toHaveLength(0)
    }
  })
})

describe('choosing who to thank', () => {
  // Sends are driven through the real lifecycle command rather than seeded by
  // hand. Every layer of the money authority refused a hand-built imitation --
  // the message needs a pending command, the event needs a payload that matches
  // it, the intent needs that event -- and a fixture that fought its way past
  // all three would be proving a shape the product never produces.
  const send = (
    database: InvoiceStateDatabase,
    messageId: number,
    expectedVersion: number,
    people: readonly { name: string; email: string }[],
  ) =>
    executeInvoiceLifecycleCommand(database, {
      invoiceId: 4,
      commandId: `send-${String(messageId)}`,
      command: 'send',
      actor: { type: 'user', id: 1 },
      authorize: async () => true,
      expectedVersion,
      occurredAt: at,
      messageId,
      eventId: `evt-${String(messageId)}`,
      message: {
        sentBy: 'Operator One',
        sentByEmail: null,
        sentFrom: 'Fixture',
        sentFromEmail: 'billing@example.test',
        recipients: people,
        subject: 'Invoice 1318',
        body: 'Attached.',
        attachPdf: false,
        sendMeACopy: false,
        thankYou: false,
        reminder: false,
        sendReminderOn: null,
      },
      delivery: {
        templateVersion: 1,
        senderIdentityId: 1,
        senderIdentityVersion: 0,
        senderEvidenceVersion: 1,
        fromName: 'Fixture',
        fromEmail: 'billing@example.test',
        replyToEmail: null,
        subject: 'Invoice 1318',
        textBody: 'Attached.',
        htmlBody: null,
        recipients: people.map((person, index) => ({
          deliveryId: messageId * 100 + index,
          ...person,
        })),
      },
    })

  it('[unit] thanks everyone the invoice was sent to, in the order it was sent', async () => {
    const database = await bare()
    await send(database, 70, 0, [
      { name: 'Accounts Payable', email: 'ap@example.test' },
      { name: 'R. Adeyemi', email: 'adeyemi@example.test' },
    ])
    expect(await readThankYouRecipients(database, 4)).toEqual([
      { name: 'Accounts Payable', email: 'ap@example.test' },
      { name: 'R. Adeyemi', email: 'adeyemi@example.test' },
    ])
  })

  it('[money] follows the most recent send, not the first', async () => {
    // An invoice re-sent to a corrected address must not thank the address that
    // was wrong.
    const database = await bare()
    await send(database, 70, 0, [{ name: 'Wrong Address', email: 'typo@example.test' }])
    await send(database, 71, 1, [{ name: 'Accounts Payable', email: 'ap@example.test' }])
    expect(await readThankYouRecipients(database, 4)).toEqual([
      { name: 'Accounts Payable', email: 'ap@example.test' },
    ])
  })

  it('[money] finds nobody for an invoice that was never sent', async () => {
    // Not an error. An invoice settled by a cheque that arrived before anybody
    // emailed it has nobody to thank, and the sender must say so rather than
    // guess at the client record.
    const database = await bare()
    expect(await readThankYouRecipients(database, 3)).toEqual([])
  })

  it('[security] never reaches across to another invoice', async () => {
    const database = await bare()
    await send(database, 70, 0, [{ name: 'Other Invoice', email: 'other@example.test' }])
    expect(await readThankYouRecipients(database, 3)).toEqual([])
  })
})

describe('one thank-you, however many addresses received the invoice', () => {
  it('[money] addresses everyone on a single delivery', async () => {
    // The intent is keyed on the payment and its delivery is unique, so there
    // is one thank-you per payment by construction. A client who received the
    // invoice at three addresses is thanked once, not three times.
    const database = await bare()
    sqlite!.exec(`INSERT INTO invoice_payments
      (id, invoice_id, currency, amount_cents, paid_date, provider, provider_shape,
       provider_account_id, provider_transaction_id, created_at, updated_at)
      VALUES (501, 3, 'USD', 100000, '2026-09-12', 'stripe', 'checkout',
              1, 'pi_settled', '${at}', '${at}')`)
    expect(
      await recordThankYouDelivery(database, {
        invoicePaymentId: 501,
        invoiceId: 3,
        deliveryId: 9100,
        templateVersion: 1,
        senderIdentityId: 1,
        senderIdentityVersion: 0,
        senderEvidenceVersion: 1,
        fromName: 'Fixture',
        fromEmail: 'billing@example.test',
        replyToEmail: null,
        recipients: [
          { name: 'Accounts Payable', email: 'ap@example.test' },
          { name: '', email: 'adeyemi@example.test' },
        ],
        subject: 'Thank you for your payment',
        textBody: 'We received your payment. Thank you.',
        htmlBody: null,
        now: at,
      }),
    ).toBe('recorded')
    const [row] = sqlite!
      .prepare(`SELECT to_json AS addressed FROM email_log WHERE id = 9100`)
      .all() as { addressed: string }[]
    // A recipient with no name is addressed by address alone rather than by an
    // empty display name, which providers render as a stray comma.
    expect(JSON.parse(row!.addressed)).toEqual([
      { email: 'ap@example.test', name: 'Accounts Payable' },
      { email: 'adeyemi@example.test' },
    ])
    expect(
      sqlite!.prepare(`SELECT count(*) AS n FROM invoice_auto_email_intents`).all(),
    ).toEqual([{ n: 1 }])
  })

  it('[money] refuses to record a message addressed to nobody', async () => {
    // An invoice settled before anyone emailed it has nobody to thank. That is
    // an answer, not a row claiming a send that had no destination.
    const database = await bare()
    sqlite!.exec(`INSERT INTO invoice_payments
      (id, invoice_id, currency, amount_cents, paid_date, provider, provider_shape,
       provider_account_id, provider_transaction_id, created_at, updated_at)
      VALUES (501, 3, 'USD', 100000, '2026-09-12', 'stripe', 'checkout',
              1, 'pi_settled', '${at}', '${at}')`)
    expect(
      await recordThankYouDelivery(database, {
        invoicePaymentId: 501,
        invoiceId: 3,
        deliveryId: 9100,
        templateVersion: 1,
        senderIdentityId: 1,
        senderIdentityVersion: 0,
        senderEvidenceVersion: 1,
        fromName: 'Fixture',
        fromEmail: 'billing@example.test',
        replyToEmail: null,
        recipients: [],
        subject: 'Thank you for your payment',
        textBody: 'Thank you.',
        htmlBody: null,
        now: at,
      }),
    ).toBe('no_recipients')
    expect(sqlite!.prepare(`SELECT id FROM email_log WHERE id = 9100`).all()).toEqual([])
  })
})
