import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { migrateContainer } from '../src/migrate.js'
import {
  hasThankYouIntent,
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
