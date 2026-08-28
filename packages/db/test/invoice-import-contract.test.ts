import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import {
  reconcileImportedInvoice,
  type ImportedInvoiceLine,
  type ImportedInvoiceMessage,
  type ImportedInvoicePayment,
  type ReconcileImportedInvoiceInput,
} from '../src/internal/invoice-import.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'

type ImportDatabase = Parameters<typeof reconcileImportedInvoice>[0]

interface TestDatabase {
  orm: ImportDatabase
  run(sql: string, ...params: unknown[]): Promise<void>
  rows<T>(sql: string, ...params: unknown[]): Promise<T[]>
  close(): Promise<void>
}

interface ReceiptManifests {
  source_manifest_json: string
  source_manifest_hash: string
  line_manifest_json: string
  line_manifest_hash: string
  message_manifest_json: string
  message_manifest_hash: string
  payment_manifest_json: string
  payment_manifest_hash: string
}

const initialTimestamp = '2026-08-27T12:00:00.000Z'
const sourceTimestamp = '2026-08-27T12:00:01.000Z'

const containerDatabase = (): TestDatabase => {
  const sqlite = new BetterSqlite3(':memory:')
  migrateContainer(sqlite)
  return {
    orm: createContainerDatabase(sqlite),
    run: async (sql, ...params) => {
      sqlite.prepare(sql).run(...params)
    },
    rows: async <T>(sql: string, ...params: unknown[]) => sqlite.prepare(sql).all(...params) as T[],
    close: async () => {
      sqlite.close()
    },
  }
}

const d1Database = async (): Promise<TestDatabase> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const d1 = await miniflare.getD1Database('DB')
  await migrateD1(d1)
  return {
    orm: createD1Database(d1),
    run: async (sql, ...params) => {
      await d1
        .prepare(sql)
        .bind(...params)
        .run()
    },
    rows: async <T>(sql: string, ...params: unknown[]) =>
      (
        await d1
          .prepare(sql)
          .bind(...params)
          .all<T>()
      ).results,
    close: async () => miniflare.dispose(),
  }
}

const factories = [
  ['container', async () => containerDatabase()],
  ['D1', d1Database],
] as const

const installFixture = async (database: TestDatabase): Promise<void> => {
  await database.run(
    `INSERT INTO organizations (name, modules, created_at, updated_at)
     VALUES ('Sanitized Organization', '{"invoices":true}', ?, ?)`,
    initialTimestamp,
    initialTimestamp,
  )
  await database.run(
    `INSERT INTO clients (id, name, currency, created_at, updated_at)
     VALUES (1, 'Sanitized Client', 'USD', ?, ?)`,
    initialTimestamp,
    initialTimestamp,
  )
  for (let id = 1; id <= 4; id += 1) {
    await database.run(
      `INSERT INTO invoices (
          id, harvest_id, client_id, number, currency, issue_date, due_date,
          state, source_updated_at, created_at, updated_at
        ) VALUES (?, ?, 1, ?, 'USD', '2026-08-01', '2026-08-31',
          'open', ?, ?, ?)`,
      id,
      7000 + id,
      `INV-IMPORT-CONTRACT-${id}`,
      initialTimestamp,
      initialTimestamp,
      initialTimestamp,
    )
  }
}

const line = (
  id: number,
  amountCents: number,
  overrides: Partial<ImportedInvoiceLine> = {},
): ImportedInvoiceLine => ({
  id,
  harvestId: 8000 + id,
  position: id,
  kind: 'Service',
  quantity: 1,
  unitPriceCents: amountCents,
  amountCents,
  createdAt: initialTimestamp,
  updatedAt: sourceTimestamp,
  ...overrides,
})

const message = (
  id: number,
  overrides: Partial<ImportedInvoiceMessage> = {},
): ImportedInvoiceMessage => ({
  id,
  harvestId: 9000 + id,
  recipients: [{ name: 'Sanitized Client', email: 'client@example.invalid' }],
  createdAt: initialTimestamp,
  updatedAt: sourceTimestamp,
  ...overrides,
})

const payment = (
  id: number,
  amountCents: number,
  overrides: Partial<ImportedInvoicePayment> = {},
): ImportedInvoicePayment => ({
  id,
  harvestId: 10_000 + id,
  amountCents,
  sourcePaidAt: sourceTimestamp,
  sourcePaidDate: null,
  createdAt: initialTimestamp,
  updatedAt: sourceTimestamp,
  ...overrides,
})

const input = (
  invoiceId: number,
  overrides: Partial<ReconcileImportedInvoiceInput> = {},
): ReconcileImportedInvoiceInput => ({
  invoiceId,
  sourceBatchComplete: true,
  expectedSourceUpdatedAt: initialTimestamp,
  sourceUpdatedAt: sourceTimestamp,
  sourceState: 'open',
  sourceSentAt: initialTimestamp,
  sourcePaidAt: null,
  sourcePaidDate: null,
  sourceClosedAt: null,
  sourceAmountCents: 1000,
  sourceDueAmountCents: 1000,
  sourceTaxAmountCents: 0,
  sourceTax2AmountCents: 0,
  sourceDiscountAmountCents: 0,
  sourcePaymentOptions: ['ach', 'credit_card'],
  sourceWrittenOffCents: 0,
  lines: [line(invoiceId * 10, 1000, { position: 0 })],
  messages: [],
  payments: [],
  ...overrides,
})

for (const [runtime, factory] of factories) {
  describe(`invoice import contract (${runtime})`, () => {
    let database: TestDatabase | undefined

    afterEach(async () => database?.close())

    it('[unit] fingerprints normalized identity sets independent of order and omitted defaults', async () => {
      database = await factory()
      await installFixture(database)
      const firstInput = input(1, {
        lines: [line(12, 600, { position: 1 }), line(11, 400, { position: 0 })],
        messages: [message(12), message(11, { subject: 'Imported invoice' })],
        payments: [payment(12, 100), payment(11, 200)],
        sourceDueAmountCents: 700,
      })
      const first = await reconcileImportedInvoice(database.orm, firstInput)

      const retry = await reconcileImportedInvoice(database.orm, {
        ...firstInput,
        lines: [
          {
            ...firstInput.lines[1]!,
            description: null,
            taxed: false,
            taxed2: false,
            projectId: null,
          },
          {
            ...firstInput.lines[0]!,
            description: null,
            taxed: false,
            taxed2: false,
            projectId: null,
          },
        ],
        messages: [
          {
            ...firstInput.messages[1]!,
            sentBy: null,
            sentByEmail: null,
            sentFrom: null,
            sentFromEmail: null,
            body: null,
            attachPdf: false,
            sendMeACopy: false,
            thankYou: false,
            reminder: false,
            sendReminderOn: null,
            eventType: null,
          },
          {
            ...firstInput.messages[0]!,
            sentBy: null,
            sentByEmail: null,
            sentFrom: null,
            sentFromEmail: null,
            subject: null,
            body: null,
            attachPdf: false,
            sendMeACopy: false,
            thankYou: false,
            reminder: false,
            sendReminderOn: null,
            eventType: null,
          },
        ],
        payments: [
          {
            ...firstInput.payments[1]!,
            sourceRecordedByName: null,
            sourceRecordedByEmail: null,
            sourceGatewayId: null,
            sourceGatewayName: null,
            notes: null,
            recordedByUserId: null,
            providerTransactionId: null,
          },
          {
            ...firstInput.payments[0]!,
            sourceRecordedByName: null,
            sourceRecordedByEmail: null,
            sourceGatewayId: null,
            sourceGatewayName: null,
            notes: null,
            recordedByUserId: null,
            providerTransactionId: null,
          },
        ],
      })

      expect(retry).toEqual(first)
      expect(
        await database.rows<Record<string, unknown>>(
          `SELECT
             (SELECT count(*) FROM invoice_import_reconciliations WHERE invoice_id = 1) AS receipts,
             (SELECT count(*) FROM invoice_line_items WHERE invoice_id = 1) AS lines,
             (SELECT count(*) FROM invoice_messages WHERE invoice_id = 1) AS messages,
             (SELECT count(*) FROM invoice_payments WHERE invoice_id = 1) AS payments,
             (SELECT count(*) FROM event_outbox WHERE aggregate_id = 1) AS outbox`,
        ),
      ).toEqual([{ receipts: 1, lines: 2, messages: 2, payments: 2, outbox: 0 }])
      const [receipt] = await database.rows<ReceiptManifests>(
        `SELECT source_manifest_json, source_manifest_hash,
           line_manifest_json, line_manifest_hash,
           message_manifest_json, message_manifest_hash,
           payment_manifest_json, payment_manifest_hash
         FROM invoice_import_reconciliations WHERE invoice_id = 1`,
      )
      expect(receipt).toBeDefined()
      expect(JSON.parse(receipt!.source_manifest_json)).toEqual({
        invoice_id: 1,
        source_updated_at: sourceTimestamp,
      })
      expect(JSON.parse(receipt!.line_manifest_json)).toEqual([
        { harvest_id: 8011, id: 11, updated_at: sourceTimestamp },
        { harvest_id: 8012, id: 12, updated_at: sourceTimestamp },
      ])
      expect(JSON.parse(receipt!.message_manifest_json)).toEqual([
        { harvest_id: 9011, id: 11, updated_at: sourceTimestamp },
        { harvest_id: 9012, id: 12, updated_at: sourceTimestamp },
      ])
      expect(JSON.parse(receipt!.payment_manifest_json)).toEqual([
        { harvest_id: 10011, id: 11, updated_at: sourceTimestamp },
        { harvest_id: 10012, id: 12, updated_at: sourceTimestamp },
      ])
      const manifestJson = [
        receipt!.source_manifest_json,
        receipt!.line_manifest_json,
        receipt!.message_manifest_json,
        receipt!.payment_manifest_json,
      ].join('\n')
      expect(manifestJson).not.toContain('client@example.invalid')
      expect(manifestJson).not.toContain('Imported invoice')
      for (const [key, value] of Object.entries(receipt!)) {
        if (key.endsWith('_hash')) expect(value).toMatch(/^sha256:[0-9a-f]{64}$/)
      }
    })

    it('[unit] preserves source-paid evidence on closed unpaid and partial invoices', async () => {
      database = await factory()
      await installFixture(database)
      const paidAt = '2026-08-26T08:30:00.000Z'
      await reconcileImportedInvoice(
        database.orm,
        input(2, {
          sourceState: 'closed',
          sourcePaidAt: paidAt,
          sourceClosedAt: sourceTimestamp,
          sourceDueAmountCents: 1000,
        }),
      )
      await reconcileImportedInvoice(
        database.orm,
        input(3, {
          sourceState: 'closed',
          sourcePaidDate: '2026-08-25',
          sourceClosedAt: sourceTimestamp,
          sourceDueAmountCents: 750,
          payments: [payment(31, 250)],
        }),
      )

      expect(
        await database.rows<Record<string, unknown>>(
          `SELECT id, state, paid_at, paid_date, due_amount_cents
           FROM invoices WHERE id IN (2,3) ORDER BY id`,
        ),
      ).toEqual([
        { id: 2, state: 'closed', paid_at: paidAt, paid_date: null, due_amount_cents: 1000 },
        {
          id: 3,
          state: 'closed',
          paid_at: null,
          paid_date: '2026-08-25',
          due_amount_cents: 750,
        },
      ])
    })

    it('[unit] returns exact snake-case state and dual-date diagnostics losslessly', async () => {
      database = await factory()
      await installFixture(database)
      const sourcePaidAt = '2026-08-27T23:45:00.000Z'
      const sourcePaidDate = '2026-08-26'
      const result = await reconcileImportedInvoice(
        database.orm,
        input(4, {
          sourceState: 'open',
          sourceDueAmountCents: 0,
          payments: [payment(41, 1000, { sourcePaidAt, sourcePaidDate })],
        }),
      )

      expect(JSON.parse(JSON.stringify(result.diagnostics))).toEqual([
        {
          invoice_id: 4,
          code: 'source_state_disagrees',
          source_state: 'open',
          derived_state: 'paid',
        },
        {
          invoice_id: 4,
          code: 'payment_paid_date_disagrees',
          payment_id: 41,
          payment_harvest_id: 10041,
          source_paid_at: sourcePaidAt,
          source_paid_date: sourcePaidDate,
        },
      ])
      expect(
        await database.rows<Record<string, unknown>>(
          `SELECT invoice.state, invoice.paid_at, invoice.paid_date,
             payment.paid_at AS payment_paid_at, payment.paid_date AS payment_paid_date,
             payment.source_paid_at, payment.source_paid_date,
             (SELECT count(*) FROM event_outbox WHERE aggregate_id = invoice.id) AS outbox
           FROM invoices invoice
           JOIN invoice_payments payment ON payment.invoice_id = invoice.id
           WHERE invoice.id = 4`,
        ),
      ).toEqual([
        {
          state: 'paid',
          paid_at: sourcePaidAt,
          paid_date: null,
          payment_paid_at: sourcePaidAt,
          payment_paid_date: null,
          source_paid_at: sourcePaidAt,
          source_paid_date: sourcePaidDate,
          outbox: 0,
        },
      ])
    })
  })
}
