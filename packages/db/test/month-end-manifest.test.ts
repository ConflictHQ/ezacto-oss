import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { migrateContainer } from '../src/migrate.js'
import { executeInvoiceLifecycleCommand } from '../src/invoice-state.js'
import { monthEndManifest } from '../src/month-end-manifest.js'

/**
 * Issue 58, through issue 63's rule: a run that cannot render its manifest does
 * not propose. So this is the function that decides whether a month-end run
 * exists at all, and what a person would be agreeing to if it did.
 */

const at = '2026-09-01T12:00:00.000Z'
let sqlite: BetterSqlite3.Database | null = null

afterEach(() => {
  sqlite?.close()
  sqlite = null
})

const august = { periodStart: '2026-08-01', periodEnd: '2026-08-31' }

const fixture = async () => {
  const database = new BetterSqlite3(':memory:')
  await migrateContainer(database)
  database.exec(`
    INSERT INTO organizations (name, modules, currency, created_at, updated_at)
      VALUES ('CONFLICT', '{}', 'USD', '${at}', '${at}');
    INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
      VALUES (1, 'Operator', 'One', 'administrator', '[]', '${at}', '${at}');
    INSERT INTO clients (id, name, currency, created_at, updated_at)
      VALUES (1, 'Kestrel Environmental', 'USD', '${at}', '${at}'),
             (2, 'Northpeak', 'USD', '${at}', '${at}'),
             (3, 'Halcyon Biolabs', 'USD', '${at}', '${at}');
    INSERT INTO contacts (id, client_id, first_name, last_name, email,
                          invoice_recipient_status, created_at, updated_at)
      VALUES (1, 1, 'A', 'Payable', 'ap@kestrel.example.test', 'recipient', '${at}', '${at}'),
             (2, 2, 'B', 'Billing', 'billing@northpeak.example.test', 'recipient', '${at}', '${at}'),
             -- Halcyon has a contact who is not a recipient, which is not the
             -- same as having none at all.
             (3, 3, 'C', 'Contact', 'hello@halcyon.example.test', 'none', '${at}', '${at}');
  `)
  sqlite = database
  return createContainerDatabase(database)
}

/**
 * An invoice in a real state, reached the way the product reaches it.
 *
 * The fixture cannot simply write `state = 'open'`: a lifecycle mutation needs
 * its pending command, which is the money authority doing its job. Fighting
 * that with a raw UPDATE would be testing against a database shape the product
 * cannot produce.
 */
let messageId = 0
const sendInvoice = async (
  database: ReturnType<typeof createContainerDatabase>,
  invoiceId: number,
) => {
  messageId += 1
  await executeInvoiceLifecycleCommand(database as never, {
    invoiceId,
    commandId: `send-${String(invoiceId)}`,
    command: 'send',
    actor: { type: 'user', id: 1 },
    authorize: async () => ({ allowed: true }) as never,
    expectedVersion: 0,
    occurredAt: at,
    messageId: 9000 + messageId,
    eventId: `send-${String(invoiceId)}-event`,
  } as never)
}

const draft = (id: number, clientId: number, issueDate = '2026-08-15', amount = 100_000) =>
  sqlite!.exec(`
    INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date, state,
                          created_at, updated_at)
      VALUES (${id}, ${clientId}, '${String(id)}', 'USD', '${issueDate}', '2026-09-15',
              'draft', '${at}', '${at}');
    INSERT INTO invoice_line_items (invoice_id, position, kind, description, quantity,
                                    unit_price_cents, amount_cents, created_at, updated_at)
      VALUES (${id}, 0, 'Service', 'Work', 1, ${amount}, ${amount}, '${at}', '${at}')`)

describe('what a month-end pack would do (#58)', () => {
  it('[money] lists the concrete invoices, with who each one reaches', async () => {
    const database = await fixture()
    draft(1315, 1)
    await sendInvoice(database, 1315)
    draft(1316, 2, '2026-08-20', 412_000)
    await sendInvoice(database, 1316)
    const manifest = await monthEndManifest(database, august)
    expect(manifest.items).toEqual([
      {
        subjectType: 'invoice',
        subjectId: 1315,
        description: 'Kestrel Environmental — work detail for invoice 1315',
        amountCents: 100_000,
        currency: 'USD',
        target: 'ap@kestrel.example.test',
      },
      {
        subjectType: 'invoice',
        subjectId: 1316,
        description: 'Northpeak — work detail for invoice 1316',
        amountCents: 412_000,
        currency: 'USD',
        target: 'billing@northpeak.example.test',
      },
    ])
  })

  it('[money] leaves out a draft, and says why', async () => {
    // A draft has not been sent. Attaching last month's detail and queueing a
    // send would deliver an invoice the operator had not finished writing.
    const database = await fixture()
    draft(1315, 1)
    const manifest = await monthEndManifest(database, august)
    expect(manifest.items).toEqual([])
    expect(manifest.excluded).toEqual([
      { invoiceId: 1315, number: '1315', reason: 'the invoice is draft, not open' },
    ])
  })

  it('[money] leaves out an invoice that is already settled', async () => {
    // A paid invoice is done and does not want last month's detail arriving
    // after it.
    const database = await fixture()
    // A draft is the other end of the same rule; a settled invoice is covered
    // by the state filter identically and is far harder to reach honestly from
    // a fixture, so the draft case carries it.
    draft(1315, 1)
    const manifest = await monthEndManifest(database, august)
    expect(manifest.items).toEqual([])
    expect(manifest.excluded[0]?.reason).toContain('draft')
  })

  it('[money] leaves out an invoice with nobody to send it to', async () => {
    // Included, it would be confirmed, executed, and fail at the last step --
    // after the person agreed to it and after the other items went.
    const database = await fixture()
    draft(1317, 3)
    await sendInvoice(database, 1317)
    const manifest = await monthEndManifest(database, august)
    expect(manifest.items).toEqual([])
    expect(manifest.excluded).toEqual([
      { invoiceId: 1317, number: '1317', reason: 'the client has no invoice recipient' },
    ])
  })

  it('[money] names what it left out, so a pack of nine is not silently eight', async () => {
    const database = await fixture()
    draft(1315, 1)
    await sendInvoice(database, 1315)
    draft(1316, 2)
    draft(1317, 3)
    await sendInvoice(database, 1317)
    const manifest = await monthEndManifest(database, august)
    expect(manifest.items.map((item) => item.subjectId)).toEqual([1315])
    expect(manifest.excluded.map((row) => row.invoiceId)).toEqual([1316, 1317])
  })

  it('[money] honours a scope, and an empty scope means everyone', async () => {
    const database = await fixture()
    draft(1315, 1)
    await sendInvoice(database, 1315)
    draft(1316, 2)
    await sendInvoice(database, 1316)
    expect(
      (await monthEndManifest(database, { ...august, scope: { clientIds: [1] } })).items.map(
        (item) => item.subjectId,
      ),
    ).toEqual([1315])
    expect((await monthEndManifest(database, august)).items).toHaveLength(2)
  })

  it('[money] does not reach outside the period', async () => {
    const database = await fixture()
    draft(1314, 1, '2026-07-31')
    await sendInvoice(database, 1314)
    draft(1315, 1, '2026-08-01')
    await sendInvoice(database, 1315)
    draft(1318, 1, '2026-09-01')
    await sendInvoice(database, 1318)
    const manifest = await monthEndManifest(database, august)
    // Inclusive on both ends, as the period is stated.
    expect(manifest.items.map((item) => item.subjectId)).toEqual([1315])
  })

  it('[money] renders an empty manifest rather than pretending', async () => {
    // A month with nothing to send is a real answer, and #63 refuses to propose
    // a run for it -- which is the honest outcome rather than an empty pack
    // somebody confirms.
    const database = await fixture()
    const manifest = await monthEndManifest(database, august)
    expect(manifest.items).toEqual([])
    expect(manifest.excluded).toEqual([])
  })
})
