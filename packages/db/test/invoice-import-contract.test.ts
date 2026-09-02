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
import { migrateContainer, migrateContainerThrough, migrateD1 } from '../src/migrate.js'
import {
  ensureImportedInvoiceHeader,
  reconcileHarvestInvoice,
  type ImportedInvoiceHeader,
} from '../src/importer.js'

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
const nextSourceTimestamp = '2026-08-27T12:00:02.000Z'

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
          `SELECT id, state, paid_at, paid_date, closed_at, due_amount_cents
           FROM invoices WHERE id IN (2,3) ORDER BY id`,
        ),
      ).toEqual([
        {
          id: 2,
          state: 'closed',
          paid_at: paidAt,
          paid_date: null,
          closed_at: null,
          due_amount_cents: 1000,
        },
        {
          id: 3,
          state: 'closed',
          paid_at: null,
          paid_date: '2026-08-25',
          closed_at: sourceTimestamp,
          due_amount_cents: 750,
        },
      ])
    })

    it('[unit] ignores equal or older observations and rejects child provenance drift', async () => {
      database = await factory()
      await installFixture(database)
      const firstInput = input(1, {
        messages: [
          message(11, {
            sentBy: 'Original Sender',
            sentByEmail: 'original@example.invalid',
            sentFrom: 'Original Company',
            sentFromEmail: 'billing@example.invalid',
            body: 'Original body',
          }),
        ],
      })
      const first = await reconcileImportedInvoice(database.orm, firstInput)

      const equal = await reconcileImportedInvoice(database.orm, {
        ...firstInput,
        sourceAmountCents: 999,
        lines: [line(19, 999, { position: 0 })],
        messages: [],
      })
      const older = await reconcileImportedInvoice(database.orm, {
        ...firstInput,
        sourceUpdatedAt: initialTimestamp,
        expectedSourceUpdatedAt: sourceTimestamp,
        sourceAmountCents: 1,
        lines: [line(18, 1, { position: 0 })],
        messages: [],
      })
      expect(equal).toEqual(first)
      expect(older).toEqual(first)

      await expect(
        reconcileImportedInvoice(database.orm, {
          ...firstInput,
          expectedSourceUpdatedAt: sourceTimestamp,
          sourceUpdatedAt: nextSourceTimestamp,
          lines: firstInput.lines.map((item) => ({
            ...item,
            createdAt: nextSourceTimestamp,
            updatedAt: nextSourceTimestamp,
          })),
        }),
      ).rejects.toThrow(/line identity or provenance drifted/)

      await expect(
        reconcileImportedInvoice(database.orm, {
          ...firstInput,
          expectedSourceUpdatedAt: sourceTimestamp,
          sourceUpdatedAt: nextSourceTimestamp,
          lines: firstInput.lines.map((item) => ({
            ...item,
            updatedAt: nextSourceTimestamp,
          })),
          messages: firstInput.messages.map((item) => ({
            ...item,
            sentBy: 'Changed Sender',
            body: 'Changed body',
            updatedAt: nextSourceTimestamp,
          })),
        }),
      ).rejects.toThrow(/sender provenance drifted/)
      expect(
        await database.rows<Record<string, unknown>>(
          `SELECT invoice.source_updated_at, invoice.amount_cents,
             message.sent_by, message.body,
             (SELECT count(*) FROM invoice_import_reconciliations
               WHERE invoice_id = invoice.id) AS receipts,
             (SELECT count(*) FROM event_outbox
               WHERE aggregate_id = invoice.id) AS outbox
           FROM invoices invoice
           JOIN invoice_messages message ON message.invoice_id = invoice.id
           WHERE invoice.id = 1`,
        ),
      ).toEqual([
        {
          source_updated_at: sourceTimestamp,
          amount_cents: 1000,
          sent_by: 'Original Sender',
          body: 'Original body',
          receipts: 1,
          outbox: 0,
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

    it('[unit] requires pending receipt authority for source observation updates', async () => {
      database = await factory()
      await installFixture(database)
      await expect(
        database.run(
          `UPDATE invoices SET source_amount_cents = 999, source_updated_at = ?
           WHERE id = 1`,
          nextSourceTimestamp,
        ),
      ).rejects.toThrow(/exact pending import authority/)
      expect(
        await database.rows<Record<string, unknown>>(
          `SELECT source_amount_cents, source_updated_at, updated_at FROM invoices WHERE id = 1`,
        ),
      ).toEqual([
        {
          source_amount_cents: null,
          source_updated_at: initialTimestamp,
          updated_at: initialTimestamp,
        },
      ])
    })

    it('[unit] does not widen native invoice or message authority while an import is pending', async () => {
      database = await factory()
      await installFixture(database)
      const sourceLine = {
        harvestId: 8010,
        position: 0,
        kind: 'Service',
        quantity: 1,
        unitPriceCents: 1000,
        amountCents: 1000,
        createdAt: initialTimestamp,
        updatedAt: sourceTimestamp,
      }
      const sourceMessage = {
        harvestId: 9010,
        recipients: [{ name: 'Sanitized Client', email: 'client@example.invalid' }],
        body: 'Original body',
        createdAt: initialTimestamp,
        updatedAt: sourceTimestamp,
      }
      const firstInput = {
        ...input(1),
        lines: [sourceLine],
        messages: [sourceMessage],
        payments: [],
      }
      await reconcileHarvestInvoice(database.orm, firstInput)
      const [before] = await database.rows<{
        client_key: string
        reference_token: string | null
        reminder_policy: string | null
        payment_options: string
        message_id: number
        message_harvest_id: number
      }>(
        `SELECT invoice.client_key, invoice.reference_token, invoice.reminder_policy,
           invoice.payment_options, message.id AS message_id,
           message.harvest_id AS message_harvest_id
         FROM invoices invoice JOIN invoice_messages message ON message.invoice_id = invoice.id
         WHERE invoice.id = 1 AND message.harvest_id = 9010`,
      )
      expect(before).toBeDefined()

      const pendingInput = {
        ...firstInput,
        expectedSourceUpdatedAt: sourceTimestamp,
        sourceUpdatedAt: nextSourceTimestamp,
        sourceAmountCents: 1300,
        sourceDueAmountCents: 1200,
        maximumStatements: 4,
        lines: [
          sourceLine,
          { ...sourceLine, harvestId: 8020, position: 1, amountCents: 100, unitPriceCents: 100 },
          { ...sourceLine, harvestId: 8030, position: 2, amountCents: 100, unitPriceCents: 100 },
          { ...sourceLine, harvestId: 8040, position: 3, amountCents: 100, unitPriceCents: 100 },
        ],
        messages: [
          { ...sourceMessage, body: 'Newer body', updatedAt: nextSourceTimestamp },
          {
            ...sourceMessage,
            harvestId: 9020,
            body: 'New source message',
            updatedAt: nextSourceTimestamp,
          },
        ],
        payments: [
          {
            harvestId: 10010,
            amountCents: 100,
            sourcePaidAt: nextSourceTimestamp,
            sourcePaidDate: null,
            createdAt: initialTimestamp,
            updatedAt: nextSourceTimestamp,
          },
        ],
      }
      let pending = await reconcileHarvestInvoice(database.orm, pendingInput)
      expect(pending.complete).toBe(false)
      expect(
        await database.rows<Record<string, unknown>>(
          `SELECT count(*) AS count FROM invoice_import_operations WHERE completed = 0`,
        ),
      ).toEqual([{ count: 0 }])
      expect(
        await database.rows<Record<string, unknown>>(
          `SELECT completed, message_manifest_json
           FROM invoice_import_reconciliations
           WHERE invoice_id = 1 AND source_updated_at = ?`,
          nextSourceTimestamp,
        ),
      ).toEqual([
        {
          completed: 0,
          message_manifest_json: JSON.stringify([
            { harvest_id: 9010, id: before!.message_id, updated_at: nextSourceTimestamp },
            { harvest_id: 9020, id: 0, updated_at: nextSourceTimestamp },
          ]),
        },
      ])

      const invoiceMutations = [
        `UPDATE invoices SET client_key = 'tampered-client-key' WHERE id = 1`,
        `UPDATE invoices SET reminder_policy =
           '{"first_after_days":1,"every_days":2}' WHERE id = 1`,
        `UPDATE invoices SET payment_options = '["stripe_checkout"]' WHERE id = 1`,
        `UPDATE invoices SET payment_options = '["wise_transfer"]',
           reference_token = 'EZ-123456789ABC' WHERE id = 1`,
      ]
      for (const sql of invoiceMutations) {
        await expect(database.run(sql)).rejects.toThrow(/invoice header mutation/)
      }
      await expect(
        database.run(
          `UPDATE invoice_messages SET id = id + 100000, updated_at = ?
           WHERE invoice_id = 1 AND harvest_id = 9010`,
          nextSourceTimestamp,
        ),
      ).rejects.toThrow(/invoice message source mutation/)
      await expect(
        database.run(
          `UPDATE invoice_messages SET sent_by = 'Doctored Sender', updated_at = ?
           WHERE invoice_id = 1 AND harvest_id = 9010`,
          nextSourceTimestamp,
        ),
      ).rejects.toThrow(/invoice message source mutation/)
      await expect(
        database.run(
          `INSERT INTO invoice_line_items (
             harvest_id, invoice_id, position, kind, quantity,
             unit_price_cents, amount_cents, created_at, updated_at
           ) VALUES (8040, 1, 3, 'Doctored', 1, 999, 999, ?, ?)`,
          initialTimestamp,
          sourceTimestamp,
        ),
      ).rejects.toThrow(/invoice line insert requires/)
      await expect(
        database.run(
          `UPDATE invoice_messages SET harvest_id = 9020, updated_at = ?
           WHERE invoice_id = 1 AND harvest_id = 9010`,
          nextSourceTimestamp,
        ),
      ).rejects.toThrow(/invoice message source mutation/)
      await expect(
        database.run(
          `INSERT INTO invoice_line_items (
             id, harvest_id, invoice_id, position, kind, quantity,
             unit_price_cents, amount_cents, created_at, updated_at
           ) VALUES (777777, 8040, 1, 3, 'Service', 1, 100, 100, ?, ?)`,
          initialTimestamp,
          nextSourceTimestamp,
        ),
      ).rejects.toThrow(/invoice line insert requires/)
      await expect(
        database.run(
          `INSERT INTO invoice_payments (
             harvest_id, invoice_id, currency, amount_cents, paid_at, source_paid_at,
             provider, provider_shape, created_at, updated_at
           ) VALUES (10010, 1, 'USD', 999, ?, ?, 'manual', 'manual', ?, ?)`,
          nextSourceTimestamp,
          nextSourceTimestamp,
          initialTimestamp,
          nextSourceTimestamp,
        ),
      ).rejects.toThrow(/invoice payment insert requires/)

      let allocatedLineId: number | undefined
      let admissionAttempts = 0
      while (allocatedLineId === undefined && pending.complete === false) {
        pending = await reconcileHarvestInvoice(database.orm, pendingInput)
        expect(
          await database.rows<Record<string, unknown>>(
            `SELECT count(*) AS count FROM invoice_import_operations WHERE completed = 0`,
          ),
        ).toEqual([{ count: 0 }])
        const [allocatedLine] = await database.rows<{ id: number }>(
          `SELECT id FROM invoice_line_items WHERE invoice_id = 1 AND harvest_id = 8020`,
        )
        allocatedLineId = allocatedLine?.id
        admissionAttempts += 1
        if (admissionAttempts > 10) throw new Error('allocated line was not admitted')
      }
      expect(allocatedLineId).toBeGreaterThan(0)
      expect(pending.complete).toBe(false)
      await expect(
        database.run(`DELETE FROM invoice_line_items WHERE id = ?`, allocatedLineId!),
      ).rejects.toThrow(/invoice line delete requires/)

      while (pending.complete === false) {
        pending = await reconcileHarvestInvoice(database.orm, pendingInput)
        expect(
          await database.rows<Record<string, unknown>>(
            `SELECT count(*) AS count FROM invoice_import_operations WHERE completed = 0`,
          ),
        ).toEqual([{ count: 0 }])
      }
      expect(
        await database.rows<Record<string, unknown>>(
          `SELECT invoice.client_key, invoice.reference_token, invoice.reminder_policy,
             invoice.payment_options, message.id AS message_id,
             message.harvest_id AS message_harvest_id
           FROM invoices invoice JOIN invoice_messages message ON message.invoice_id = invoice.id
           WHERE invoice.id = 1 AND message.harvest_id = 9010`,
        ),
      ).toEqual([before])
      const operationReceipts = JSON.stringify(
        await database.rows<Record<string, unknown>>(
          `SELECT * FROM invoice_import_operations WHERE invoice_id = 1`,
        ),
      )
      expect(operationReceipts).not.toContain('client@example.invalid')
      expect(operationReceipts).not.toContain('Newer body')
    })

    it('[unit] rejects newer payment rows that rewrite immutable source provenance', async () => {
      database = await factory()
      await installFixture(database)
      const sourceLine = {
        harvestId: 8040,
        position: 0,
        kind: 'Service',
        quantity: 1,
        unitPriceCents: 1000,
        amountCents: 1000,
        createdAt: initialTimestamp,
        updatedAt: sourceTimestamp,
      }
      const sourcePayment = {
        harvestId: 10041,
        amountCents: 100,
        sourcePaidAt: sourceTimestamp,
        sourcePaidDate: null,
        sourceRecordedByName: 'Sanitized Recorder',
        sourceRecordedByEmail: 'recorder@example.invalid',
        sourceGatewayId: 42,
        sourceGatewayName: 'Sanitized Gateway',
        notes: 'Original note',
        recordedByUserId: null,
        providerTransactionId: 'sanitized-transaction-41',
        createdAt: initialTimestamp,
        updatedAt: sourceTimestamp,
      }
      const firstInput = {
        ...input(4),
        sourceDueAmountCents: 900,
        lines: [sourceLine],
        messages: [],
        payments: [sourcePayment],
      }
      await reconcileHarvestInvoice(database.orm, firstInput)
      const [before] = await database.rows<{ id: number }>(
        'SELECT id FROM invoice_payments WHERE harvest_id = 10041',
      )
      expect(before).toBeDefined()

      const immutableDrifts = [
        { sourcePaidAt: nextSourceTimestamp },
        { sourcePaidDate: '2026-08-26' },
        { sourceRecordedByName: 'Doctored Recorder' },
        { sourceRecordedByEmail: 'doctored@example.invalid' },
        { sourceGatewayId: 84 },
        { sourceGatewayName: 'Doctored Gateway' },
        { providerTransactionId: 'doctored-transaction-41' },
        { createdAt: '2026-08-27T11:59:59.000Z' },
      ]
      for (const drift of immutableDrifts) {
        await expect(
          reconcileHarvestInvoice(database.orm, {
            ...firstInput,
            expectedSourceUpdatedAt: sourceTimestamp,
            sourceUpdatedAt: nextSourceTimestamp,
            payments: [{ ...sourcePayment, ...drift, updatedAt: nextSourceTimestamp }],
          }),
        ).rejects.toThrow(/payment identity or provenance drifted/)
      }

      await reconcileHarvestInvoice(database.orm, {
        ...firstInput,
        expectedSourceUpdatedAt: sourceTimestamp,
        sourceUpdatedAt: nextSourceTimestamp,
        sourceDueAmountCents: 800,
        payments: [
          {
            ...sourcePayment,
            amountCents: 200,
            notes: 'Corrected source note',
            updatedAt: nextSourceTimestamp,
          },
        ],
      })
      expect(
        await database.rows<Record<string, unknown>>(
          `SELECT id, amount_cents, notes, source_paid_at, source_recorded_by_name,
             source_gateway_id, provider_transaction_id
           FROM invoice_payments WHERE harvest_id = 10041`,
        ),
      ).toEqual([
        {
          id: before!.id,
          amount_cents: 200,
          notes: 'Corrected source note',
          source_paid_at: sourceTimestamp,
          source_recorded_by_name: 'Sanitized Recorder',
          source_gateway_id: 42,
          provider_transaction_id: 'sanitized-transaction-41',
        },
      ])
    })

    it('[unit] keeps replacement deletes and inserts atomic across bounded retries', async () => {
      database = await factory()
      await installFixture(database)
      const sourceLine = {
        harvestId: 8051,
        position: 0,
        kind: 'Service',
        quantity: 1,
        unitPriceCents: 1000,
        amountCents: 1000,
        createdAt: initialTimestamp,
        updatedAt: sourceTimestamp,
      }
      const sourcePayment = {
        harvestId: 10051,
        amountCents: 100,
        sourcePaidAt: sourceTimestamp,
        sourcePaidDate: null,
        notes: 'Original note',
        createdAt: initialTimestamp,
        updatedAt: sourceTimestamp,
      }
      const firstInput = {
        ...input(4),
        sourceDueAmountCents: 900,
        lines: [sourceLine],
        messages: [],
        payments: [sourcePayment],
      }
      await reconcileHarvestInvoice(database.orm, firstInput)
      const [before] = await database.rows<{ line_id: number; payment_id: number }>(
        `SELECT line.id AS line_id, payment.id AS payment_id
         FROM invoice_line_items line JOIN invoice_payments payment
           ON payment.invoice_id = line.invoice_id
         WHERE line.harvest_id = 8051 AND payment.harvest_id = 10051`,
      )
      expect(before).toBeDefined()

      const nextInput = {
        ...firstInput,
        expectedSourceUpdatedAt: sourceTimestamp,
        sourceUpdatedAt: nextSourceTimestamp,
        sourceAmountCents: 1200,
        sourceDueAmountCents: 1000,
        maximumStatements: 3,
        lines: [
          {
            ...sourceLine,
            unitPriceCents: 1200,
            amountCents: 1200,
            updatedAt: nextSourceTimestamp,
          },
        ],
        payments: [
          {
            ...sourcePayment,
            amountCents: 200,
            notes: 'Corrected note',
            updatedAt: nextSourceTimestamp,
          },
        ],
      }
      let result = await reconcileHarvestInvoice(database.orm, nextInput)
      expect(result.complete).toBe(false)
      expect(
        await database.rows<Record<string, unknown>>(
          `SELECT count(*) AS count FROM invoice_import_operations WHERE completed = 0`,
        ),
      ).toEqual([{ count: 0 }])
      let retries = 0
      while (result.complete === false) {
        result = await reconcileHarvestInvoice(database.orm, nextInput)
        expect(
          await database.rows<Record<string, unknown>>(
            `SELECT count(*) AS count FROM invoice_import_operations WHERE completed = 0`,
          ),
        ).toEqual([{ count: 0 }])
        retries += 1
        if (retries > 10) throw new Error('bounded reconciliation did not converge')
      }

      expect(
        await database.rows<Record<string, unknown>>(
          `SELECT line.id AS line_id, line.amount_cents,
             payment.id AS payment_id, payment.amount_cents AS payment_cents, payment.notes
           FROM invoice_line_items line JOIN invoice_payments payment
             ON payment.invoice_id = line.invoice_id
           WHERE line.harvest_id = 8051 AND payment.harvest_id = 10051`,
        ),
      ).toEqual([
        {
          line_id: before!.line_id,
          amount_cents: 1200,
          payment_id: before!.payment_id,
          payment_cents: 200,
          notes: 'Corrected note',
        },
      ])
    })

    it('[unit] preserves native line ids while atomically reconciling a position cycle', async () => {
      database = await factory()
      await installFixture(database)
      const original = input(1, {
        sourceAmountCents: 1000,
        sourceDueAmountCents: 1000,
        lines: [line(71, 400, { position: 0 }), line(72, 600, { position: 1 })],
      })
      await reconcileImportedInvoice(database.orm, original)
      const before = await database.rows<{ id: number; harvest_id: number }>(
        `SELECT id, harvest_id FROM invoice_line_items WHERE invoice_id = 1 ORDER BY harvest_id`,
      )

      const reordered = {
        ...original,
        expectedSourceUpdatedAt: sourceTimestamp,
        sourceUpdatedAt: nextSourceTimestamp,
        maximumStatements: 12,
        lines: [
          { ...original.lines[0]!, position: 1, updatedAt: nextSourceTimestamp },
          { ...original.lines[1]!, position: 0, updatedAt: nextSourceTimestamp },
        ],
      }
      let result = await reconcileImportedInvoice(database.orm, reordered)
      let retries = 0
      while (result.complete === false) {
        result = await reconcileImportedInvoice(database.orm, reordered)
        retries += 1
        if (retries > 5) throw new Error('line position cycle did not converge')
      }
      expect(
        await database.rows<Record<string, unknown>>(
          `SELECT id, harvest_id, position FROM invoice_line_items
           WHERE invoice_id = 1 ORDER BY harvest_id`,
        ),
      ).toEqual([
        { ...before[0], position: 1 },
        { ...before[1], position: 0 },
      ])
    })

    it('[unit] advances minimum-size retries after atomically applying a source header', async () => {
      database = await factory()
      await installFixture(database)
      const sourceHeader: ImportedInvoiceHeader = {
        harvestId: 7001,
        clientId: 1,
        createdByUserId: null,
        sourceCreatorId: null,
        sourceCreatorName: null,
        number: 'INV-IMPORT-CONTRACT-1',
        subject: 'Bounded source header',
        purchaseOrder: null,
        notes: null,
        currency: 'USD',
        issueDate: '2026-08-01',
        dueDate: '2026-08-31',
        paymentTerms: 'custom',
        periodStart: null,
        periodEnd: null,
        projectId: null,
        estimateId: null,
        taxRatePpm: null,
        tax2RatePpm: null,
        discountRatePpm: null,
        createdAt: initialTimestamp,
        updatedAt: sourceTimestamp,
      }
      const boundedInput = {
        ...input(1),
        sourceHeader,
        maximumStatements: 3,
        lines: [
          {
            harvestId: 8061,
            position: 0,
            kind: 'Service',
            quantity: 1,
            unitPriceCents: 1000,
            amountCents: 1000,
            createdAt: initialTimestamp,
            updatedAt: sourceTimestamp,
          },
        ],
      }
      let result = await reconcileHarvestInvoice(database.orm, boundedInput)
      let retries = 0
      while (result.complete === false) {
        result = await reconcileHarvestInvoice(database.orm, boundedInput)
        retries += 1
        if (retries > 5) throw new Error('minimum-size reconciliation did not converge')
      }
      expect(retries).toBeGreaterThan(0)
      expect(
        await database.rows<Record<string, unknown>>(
          `SELECT invoice.subject,
             (SELECT count(*) FROM invoice_line_items line
              WHERE line.invoice_id = invoice.id AND line.harvest_id = 8061) AS lines
           FROM invoices invoice WHERE invoice.id = 1`,
        ),
      ).toEqual([{ subject: 'Bounded source header', lines: 1 }])
    })

    it('[unit] atomically refreshes imported headers and retains DB-owned child ids', async () => {
      database = await factory()
      await installFixture(database)
      const header: ImportedInvoiceHeader = {
        harvestId: 7001,
        clientId: 1,
        createdByUserId: null,
        sourceCreatorId: null,
        sourceCreatorName: null,
        number: 'INV-IMPORT-CONTRACT-1',
        subject: 'Newer source subject',
        purchaseOrder: null,
        notes: null,
        currency: 'USD',
        issueDate: '2026-08-01',
        dueDate: '2026-08-31',
        paymentTerms: 'custom',
        periodStart: null,
        periodEnd: null,
        projectId: null,
        taxRatePpm: null,
        tax2RatePpm: null,
        discountRatePpm: null,
        createdAt: initialTimestamp,
        updatedAt: sourceTimestamp,
      }
      const ensured = await ensureImportedInvoiceHeader(database.orm, header)
      const sourceLine = {
        harvestId: 8010,
        position: 0,
        kind: 'Service',
        quantity: 1,
        unitPriceCents: 1000,
        amountCents: 1000,
        createdAt: initialTimestamp,
        updatedAt: sourceTimestamp,
      }
      const sourceMessage = {
        harvestId: 9010,
        sentBy: 'Original Sender',
        sentByEmail: 'original@example.invalid',
        sentFrom: 'Original Company',
        sentFromEmail: 'billing@example.invalid',
        recipients: [{ name: 'Sanitized Client', email: 'client@example.invalid' }],
        body: 'Original body',
        createdAt: initialTimestamp,
        updatedAt: sourceTimestamp,
      }
      await reconcileHarvestInvoice(database.orm, {
        ...input(1),
        invoiceId: ensured.id,
        sourceHeader: header,
        lines: [sourceLine],
        messages: [sourceMessage],
        payments: [],
      })
      const first = await database.rows<{
        lineId: number
        messageId: number
        subject: string
      }>(
        `SELECT line.id AS lineId, message.id AS messageId, invoice.subject
         FROM invoice_line_items line
         JOIN invoices invoice ON invoice.id = line.invoice_id
         JOIN invoice_messages message ON message.invoice_id = invoice.id
         WHERE line.harvest_id = 8010 AND message.harvest_id = 9010`,
      )
      const newerHeader = {
        ...header,
        subject: 'Newest source subject',
        updatedAt: nextSourceTimestamp,
      }
      await reconcileHarvestInvoice(database.orm, {
        ...input(1),
        invoiceId: ensured.id,
        expectedSourceUpdatedAt: sourceTimestamp,
        sourceUpdatedAt: nextSourceTimestamp,
        sourceHeader: newerHeader,
        lines: [
          {
            ...sourceLine,
            amountCents: 1200,
            unitPriceCents: 1200,
            updatedAt: nextSourceTimestamp,
          },
        ],
        sourceAmountCents: 1200,
        sourceDueAmountCents: 1200,
        messages: [{ ...sourceMessage, body: 'Newest body', updatedAt: nextSourceTimestamp }],
        payments: [],
      })
      expect(
        await database.rows<Record<string, unknown>>(
          `SELECT line.id AS lineId, message.id AS messageId, message.body, invoice.subject
         FROM invoice_line_items line
         JOIN invoices invoice ON invoice.id = line.invoice_id
         JOIN invoice_messages message ON message.invoice_id = invoice.id
         WHERE line.harvest_id = 8010 AND message.harvest_id = 9010`,
        ),
      ).toEqual([
        {
          lineId: first[0]!.lineId,
          messageId: first[0]!.messageId,
          body: 'Newest body',
          subject: 'Newest source subject',
        },
      ])
      expect(first[0]!.lineId).not.toBe(8010)
      expect(first[0]!.messageId).not.toBe(9010)
    })

    it('[unit] converges concurrent header creation and rejects immutable collision drift', async () => {
      database = await factory()
      await installFixture(database)
      const header: ImportedInvoiceHeader = {
        harvestId: 7999,
        clientId: 1,
        createdByUserId: null,
        sourceCreatorId: 42,
        sourceCreatorName: 'Original Creator',
        number: 'INV-CONCURRENT-7999',
        subject: 'Concurrent import',
        purchaseOrder: null,
        notes: null,
        currency: 'USD',
        issueDate: '2026-08-01',
        dueDate: '2026-08-31',
        paymentTerms: 'custom',
        periodStart: null,
        periodEnd: null,
        projectId: null,
        taxRatePpm: null,
        tax2RatePpm: null,
        discountRatePpm: null,
        createdAt: initialTimestamp,
        updatedAt: sourceTimestamp,
      }
      const [left, right] = await Promise.all([
        ensureImportedInvoiceHeader(database.orm, header),
        ensureImportedInvoiceHeader(database.orm, header),
      ])
      expect(right).toEqual(left)
      expect(
        await database.rows<Record<string, unknown>>(
          `SELECT count(*) AS count, min(client_key) AS clientKey
         FROM invoices WHERE harvest_id = 7999`,
        ),
      ).toEqual([{ count: 1, clientKey: left.clientKey }])

      await expect(
        ensureImportedInvoiceHeader(database.orm, {
          ...header,
          sourceCreatorName: 'Changed Creator',
        }),
      ).rejects.toThrow(/immutable creator provenance drifted/)
      expect(
        await database.rows<Record<string, unknown>>(
          `SELECT source_creator_id, source_creator_name
         FROM invoices WHERE harvest_id = 7999`,
        ),
      ).toEqual([{ source_creator_id: 42, source_creator_name: 'Original Creator' }])
    })
  })
}

it('[integration] resumes a D1 reconciliation that exceeds one deterministic statement budget', async () => {
  const database = await d1Database()
  try {
    await installFixture(database)
    // 670 lines require 2,010 operation statements, so receipt/finalization
    // force more than two full 994-statement D1 reconciliation budgets.
    const oversizedLines = Array.from({ length: 670 }, (_, index) =>
      line(1000 + index, 1, { position: index }),
    )
    let result = await reconcileImportedInvoice(
      database.orm,
      input(1, {
        sourceAmountCents: oversizedLines.length,
        sourceDueAmountCents: oversizedLines.length,
        lines: oversizedLines,
      }),
    )
    expect(result.complete).toBe(false)
    const [partial] = await database.rows<{
      source_updated_at: string
      lines: number
      receipts: number
    }>(
      `SELECT invoice.source_updated_at,
           (SELECT count(*) FROM invoice_line_items WHERE invoice_id = invoice.id) AS lines,
           (SELECT count(*) FROM invoice_import_reconciliations
             WHERE invoice_id = invoice.id) AS receipts
         FROM invoices invoice WHERE invoice.id = 1`,
    )
    expect(partial).toMatchObject({ source_updated_at: initialTimestamp, receipts: 1 })
    expect(partial!.lines).toBeGreaterThan(0)
    expect(partial!.lines).toBeLessThan(oversizedLines.length)
    let attempts = 1
    while (result.complete === false) {
      expect(
        await database.rows<Record<string, unknown>>(
          `SELECT count(*) AS count FROM invoice_import_operations WHERE completed = 0`,
        ),
      ).toEqual([{ count: 0 }])
      result = await reconcileImportedInvoice(
        database.orm,
        input(1, {
          sourceAmountCents: oversizedLines.length,
          sourceDueAmountCents: oversizedLines.length,
          lines: oversizedLines,
        }),
      )
      attempts += 1
      if (attempts > 10) throw new Error('oversized reconciliation did not converge')
    }
    expect(attempts).toBeGreaterThan(2)
    expect(
      await database.rows<Record<string, unknown>>(
        `SELECT invoice.source_updated_at,
           (SELECT count(*) FROM invoice_line_items WHERE invoice_id = invoice.id) AS lines,
           (SELECT count(*) FROM invoice_import_reconciliations
             WHERE invoice_id = invoice.id AND completed = 1) AS receipts
         FROM invoices invoice WHERE invoice.id = 1`,
      ),
    ).toEqual([{ source_updated_at: sourceTimestamp, lines: oversizedLines.length, receipts: 1 }])
  } finally {
    await database.close()
  }
})

it('[integration] upgrades a populated 0022 ledger and authorizes every imported invoice mutation', async () => {
  const sqlite = new BetterSqlite3(':memory:')
  migrateContainerThrough(sqlite, '0022_resource_create_commands')
  const database: TestDatabase = {
    orm: createContainerDatabase(sqlite),
    run: async (sql, ...params) => {
      sqlite.prepare(sql).run(...params)
    },
    rows: async <T>(sql: string, ...params: unknown[]) => sqlite.prepare(sql).all(...params) as T[],
    close: async () => {
      sqlite.close()
    },
  }
  try {
    await installFixture(database)
    expect(
      await database.rows<{ id: string }>(
        'SELECT id FROM _ezacto_migrations ORDER BY id DESC LIMIT 1',
      ),
    ).toEqual([{ id: '0022_resource_create_commands' }])

    migrateContainer(sqlite)
    const sourceHeader: ImportedInvoiceHeader = {
      harvestId: 7001,
      clientId: 1,
      createdByUserId: null,
      sourceCreatorId: null,
      sourceCreatorName: null,
      number: 'INV-IMPORT-CONTRACT-1',
      subject: 'Imported after upgrade',
      purchaseOrder: null,
      notes: null,
      currency: 'USD',
      issueDate: '2026-08-01',
      dueDate: '2026-08-31',
      paymentTerms: 'custom',
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      projectId: null,
      estimateId: null,
      taxRatePpm: 50_000,
      tax2RatePpm: null,
      discountRatePpm: null,
      createdAt: initialTimestamp,
      updatedAt: sourceTimestamp,
    }
    await reconcileHarvestInvoice(database.orm, {
      ...input(1),
      sourceHeader,
      lines: [{ ...line(11, 1000, { position: 0 }), harvestId: 8011 }],
      messages: [{ ...message(11), harvestId: 9011 }],
      payments: [{ ...payment(11, 100), harvestId: 10011 }],
      sourceDueAmountCents: 900,
    })
    const [native] = await database.rows<{ lineId: number }>(
      `SELECT line.id AS lineId FROM invoice_line_items line WHERE line.harvest_id = 8011`,
    )
    expect(native?.lineId).not.toBe(8011)

    await reconcileHarvestInvoice(database.orm, {
      ...input(1),
      expectedSourceUpdatedAt: sourceTimestamp,
      sourceUpdatedAt: nextSourceTimestamp,
      sourceHeader: {
        ...sourceHeader,
        subject: 'Updated after upgrade',
        periodStart: null,
        periodEnd: null,
        taxRatePpm: null,
        updatedAt: nextSourceTimestamp,
      },
      lines: [
        { ...line(11, 1200, { position: 0, updatedAt: nextSourceTimestamp }), harvestId: 8011 },
      ],
      messages: [],
      payments: [],
      sourceAmountCents: 1200,
      sourceDueAmountCents: 1200,
    })
    expect(
      await database.rows<Record<string, unknown>>(
        `SELECT invoice.subject, invoice.tax_rate_ppm, invoice.source_updated_at,
         line.id AS line_id, line.amount_cents,
         (SELECT count(*) FROM invoice_messages WHERE invoice_id = invoice.id) AS messages,
         (SELECT count(*) FROM invoice_payments WHERE invoice_id = invoice.id) AS payments
       FROM invoices invoice JOIN invoice_line_items line ON line.invoice_id = invoice.id
       WHERE invoice.id = 1`,
      ),
    ).toEqual([
      {
        subject: 'Updated after upgrade',
        tax_rate_ppm: null,
        source_updated_at: nextSourceTimestamp,
        line_id: native!.lineId,
        amount_cents: 1200,
        messages: 0,
        payments: 0,
      },
    ])
    expect(
      await database.rows<{ id: string }>(
        'SELECT id FROM _ezacto_migrations ORDER BY id DESC LIMIT 1',
      ),
    ).toEqual([{ id: '0030_email_templates' }])
  } finally {
    await database.close()
  }
})
