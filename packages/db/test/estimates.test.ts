import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import {
  createEstimateMessage,
  mapHarvestEstimateItemCategoryPayload,
  mapHarvestEstimateMessagePayload,
  mapHarvestEstimatePayload,
  recordEstimateMessageDelivery,
  recordSystemEstimateEvent,
  type CreateEstimateMessageInput,
  type EstimateDatabase,
  type HarvestEstimateItemCategoryPayload,
  type HarvestEstimateMessagePayload,
  type HarvestEstimatePayload,
} from '../src/estimates.js'
import * as publicDatabase from '../src/index.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { orgPeopleMigration } from '../src/migrations/0000_org_people.js'
import { clientsMigration } from '../src/migrations/0001_clients.js'
import { projectsTimeMigration } from '../src/migrations/0002_projects_time.js'
import { rateResolverMigration } from '../src/migrations/0003_rate_resolver.js'
import { invoiceFoundationMigration } from '../src/migrations/0004_invoice_foundation.js'
import { invoicePaymentsTotalsMigration } from '../src/migrations/0005_invoice_payments_totals.js'
import {
  estimateItemCategories,
  estimateLineItems,
  estimateMessages,
  estimates,
} from '../src/schema.js'

type PrivilegedMessageKey = Extract<
  keyof CreateEstimateMessageInput,
  | 'id'
  | 'harvestId'
  | 'deliveryStatus'
  | 'providerMessageId'
  | 'attachPdf'
  | 'thankYou'
  | 'reminder'
>
type AssertNever<T extends never> = T

const nativeMessageHasNoPrivilegedKeys: AssertNever<PrivilegedMessageKey> | null = null

interface TestDatabase {
  orm: EstimateDatabase
  run(sql: string, ...params: unknown[]): Promise<void>
  rows<T>(sql: string, ...params: unknown[]): Promise<T[]>
  migrateAgain(): Promise<void>
  close(): Promise<void>
}

const timestamp = '2026-08-28T12:00:00.000Z'
const laterTimestamp = '2026-08-28T12:01:00.000Z'
const migrationsThrough0005 = [
  ['0000_org_people', orgPeopleMigration],
  ['0001_clients', clientsMigration],
  ['0002_projects_time', projectsTimeMigration],
  ['0003_rate_resolver', rateResolverMigration],
  ['0004_invoice_foundation', invoiceFoundationMigration],
  ['0005_invoice_payments_totals', invoicePaymentsTotalsMigration],
] as const

const containerDatabase = (migrate = true): TestDatabase => {
  const sqlite = new BetterSqlite3(':memory:')
  if (migrate) migrateContainer(sqlite)
  return {
    orm: createContainerDatabase(sqlite),
    run: async (sql, ...params) => {
      sqlite.prepare(sql).run(...params)
    },
    rows: async <T>(sql: string, ...params: unknown[]) => sqlite.prepare(sql).all(...params) as T[],
    migrateAgain: async () => migrateContainer(sqlite),
    close: async () => {
      sqlite.close()
    },
  }
}

const d1Database = async (migrate = true): Promise<TestDatabase> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const d1 = await miniflare.getD1Database('DB')
  if (migrate) await migrateD1(d1)
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
    migrateAgain: async () => migrateD1(d1),
    close: async () => miniflare.dispose(),
  }
}

const factories = [
  ['container', async (migrate = true) => containerDatabase(migrate)],
  ['D1', d1Database],
] as const

const installThrough0005 = async (database: TestDatabase): Promise<void> => {
  await database.run(
    `CREATE TABLE _ezacto_migrations (
      id TEXT PRIMARY KEY, applied_at TEXT NOT NULL
    ) STRICT`,
  )
  for (const [id, statements] of migrationsThrough0005) {
    for (const statement of statements) await database.run(statement)
    await database.run(
      `INSERT INTO _ezacto_migrations (id, applied_at) VALUES (?, ?)`,
      id,
      timestamp,
    )
  }
}

const seedOrganizationAndClients = async (database: TestDatabase): Promise<void> => {
  await database.run(
    `INSERT INTO organizations (name, modules, created_at, updated_at)
     VALUES ('Sanitized Organization', '{"invoices":true,"estimates":true}', ?, ?)`,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO clients (id, harvest_id, name, currency, created_at, updated_at)
     VALUES (1, 41001, 'Sanitized Client', 'USD', ?, ?),
            (2, 41002, 'Other Sanitized Client', 'USD', ?, ?)`,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
  )
}

const insertInvoice = async (
  database: TestDatabase,
  id: number,
  clientId = 1,
  number = `INV-SAN-${id}`,
): Promise<void> => {
  await database.run(
    `INSERT INTO invoices (
      id, client_id, number, currency, issue_date, due_date, created_at, updated_at
    ) VALUES (?, ?, ?, 'USD', '2026-08-28', '2026-09-28', ?, ?)`,
    id,
    clientId,
    number,
    timestamp,
    timestamp,
  )
}

const insertEstimate = async (
  database: TestDatabase,
  id: number,
  clientId = 1,
  number = `EST-SAN-${id}`,
  creatorId: number | null = null,
): Promise<void> => {
  await database.run(
    `INSERT INTO estimates (
      id, client_id, created_by_user_id, source_creator_id, source_creator_name,
      number, currency, issue_date, created_at, updated_at
    ) VALUES (?, ?, ?, 770099, 'Archived Estimate Creator', ?, 'USD',
      '2026-08-28', ?, ?)`,
    id,
    clientId,
    creatorId,
    number,
    timestamp,
    timestamp,
  )
}

for (const [runtime, factory] of factories) {
  describe(`estimate schema (${runtime})`, () => {
    let database: TestDatabase | undefined

    afterEach(async () => database?.close())

    it('[unit] creates the complete fresh schema and stays idempotent', async () => {
      database = await factory()
      await database.migrateAgain()
      expect(
        await database.rows<{ id: string }>(
          `SELECT id FROM _ezacto_migrations ORDER BY id DESC LIMIT 1`,
        ),
      ).toEqual([{ id: '0024_migration_worksheet_completions' }])
      expect(
        await database.rows<{ name: string }>(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name LIKE 'estimate%'
           ORDER BY name`,
        ),
      ).toEqual([
        { name: 'estimate_attachments' },
        { name: 'estimate_command_ledger' },
        { name: 'estimate_item_categories' },
        { name: 'estimate_line_items' },
        { name: 'estimate_messages' },
        { name: 'estimates' },
      ])
      expect(
        await database.rows<{ from: string; table: string; on_delete: string }>(
          `SELECT "from", "table", on_delete FROM pragma_foreign_key_list('invoices')
           WHERE "from" = 'estimate_id'`,
        ),
      ).toEqual([{ from: 'estimate_id', table: 'estimates', on_delete: 'RESTRICT' }])
      expect(await database.rows(`PRAGMA foreign_key_check`)).toEqual([])
    })

    it('[unit] upgrades a populated invoice foundation without changing invoice rows', async () => {
      database = await factory(false)
      await installThrough0005(database)
      await seedOrganizationAndClients(database)
      await insertInvoice(database, 1)
      await database.run(
        `INSERT INTO invoice_line_items (
          id, invoice_id, position, kind, quantity, unit_price_cents, amount_cents,
          created_at, updated_at
        ) VALUES (1, 1, 0, 'Service', 2.75, 10000, 27500, ?, ?)`,
        timestamp,
        timestamp,
      )
      await database.run(
        `INSERT INTO invoice_messages (
          id, invoice_id, recipients, event_type, created_at, updated_at
        ) VALUES (1, 1, '[]', NULL, ?, ?)`,
        timestamp,
        timestamp,
      )

      await database.migrateAgain()

      expect(await database.rows(`SELECT id, number, estimate_id FROM invoices`)).toEqual([
        { id: 1, number: 'INV-SAN-1', estimate_id: null },
      ])
      expect(
        await database.rows(`SELECT id, quantity, amount_cents FROM invoice_line_items`),
      ).toEqual([{ id: 1, quantity: 2.75, amount_cents: 27500 }])
      expect(await database.rows(`SELECT id, event_type FROM invoice_messages`)).toEqual([
        { id: 1, event_type: null },
      ])
      expect(await database.rows(`PRAGMA foreign_key_check`)).toEqual([])
    })

    it('[unit] enforces the nullable invoice FK, creator provenance, and client boundary', async () => {
      database = await factory()
      await seedOrganizationAndClients(database)
      await database.run(
        `INSERT INTO users (
          id, first_name, last_name, manager_grants, created_at, updated_at
        ) VALUES (6, 'Organization', 'Owner', '[]', ?, ?),
                 (7, 'Resolved', 'Creator', '[]', ?, ?)`,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
      )
      await insertEstimate(database, 10, 1, 'EST-LINKED', 7)
      await insertEstimate(database, 20, 2, 'EST-OTHER')
      await insertInvoice(database, 100, 1)

      await database.run(`UPDATE invoices SET estimate_id = 10 WHERE id = 100`)
      expect(await database.rows(`SELECT estimate_id FROM invoices WHERE id = 100`)).toEqual([
        { estimate_id: 10 },
      ])
      await expect(
        database.run(`UPDATE invoices SET estimate_id = 999 WHERE id = 100`),
      ).rejects.toThrow(/must belong|FOREIGN KEY/)
      await expect(
        database.run(`UPDATE invoices SET estimate_id = 20 WHERE id = 100`),
      ).rejects.toThrow(/must belong to invoice client/)
      await expect(database.run(`DELETE FROM estimates WHERE id = 10`)).rejects.toThrow(
        /FOREIGN KEY/,
      )
      await expect(
        database.run(`UPDATE estimates SET client_id = 2 WHERE id = 10`),
      ).rejects.toThrow(/immutable/)

      await database.run(`DELETE FROM users WHERE id = 7`)
      expect(
        await database.rows(
          `SELECT created_by_user_id, source_creator_id, source_creator_name
           FROM estimates WHERE id = 10`,
        ),
      ).toEqual([
        {
          created_by_user_id: null,
          source_creator_id: 770099,
          source_creator_name: 'Archived Estimate Creator',
        },
      ])
      await expect(
        database.run(`UPDATE estimates SET source_creator_name = 'Forged' WHERE id = 10`),
      ).rejects.toThrow(/provenance is immutable/)
      expect(await database.rows(`PRAGMA foreign_key_check`)).toEqual([])
    })

    it('[unit] stores real estimate quantities without altering invoice quantity semantics', async () => {
      database = await factory()
      await seedOrganizationAndClients(database)
      await insertEstimate(database, 10)
      await insertInvoice(database, 100)
      await database.run(
        `INSERT INTO estimate_line_items (
          estimate_id, position, kind, quantity, unit_price_cents, amount_cents,
          created_at, updated_at
        ) VALUES (10, 0, 'Service', 1.25, 120000, 150000, ?, ?)`,
        timestamp,
        timestamp,
      )
      await database.run(
        `INSERT INTO invoice_line_items (
          invoice_id, position, kind, quantity, unit_price_cents, amount_cents,
          created_at, updated_at
        ) VALUES (100, 0, 'Service', 2.75, 120000, 330000, ?, ?)`,
        timestamp,
        timestamp,
      )
      expect(
        await database.rows(
          `SELECT quantity, typeof(quantity) AS storage FROM estimate_line_items`,
        ),
      ).toEqual([{ quantity: 1.25, storage: 'real' }])
      expect(
        await database.rows(`SELECT quantity, typeof(quantity) AS storage FROM invoice_line_items`),
      ).toEqual([{ quantity: 2.75, storage: 'real' }])
    })

    it('[unit] accepts exactly the four native events and keeps system events trusted', async () => {
      database = await factory()
      await seedOrganizationAndClients(database)
      await insertEstimate(database, 10)
      for (const eventType of ['send', 'accept', 'decline', 're-open'] as const) {
        await createEstimateMessage(database.orm, {
          estimateId: 10,
          recipients:
            eventType === 'send'
              ? [{ name: 'Sanitized Recipient', email: 'recipient@example.invalid' }]
              : [],
          eventType,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
      }
      for (const eventType of ['view', 'invoice'] as const) {
        await expect(
          createEstimateMessage(database.orm, {
            estimateId: 10,
            eventType: eventType as never,
            createdAt: timestamp,
            updatedAt: timestamp,
          }),
        ).rejects.toThrow(/native estimate event/)
        await recordSystemEstimateEvent(database.orm, {
          estimateId: 10,
          eventType,
          createdAt: timestamp,
        })
      }
      expect(
        await database.rows<{ event_type: string }>(
          `SELECT event_type FROM estimate_messages ORDER BY id`,
        ),
      ).toEqual(
        ['send', 'accept', 'decline', 're-open', 'view', 'invoice'].map((event_type) => ({
          event_type,
        })),
      )
      await expect(
        database.run(
          `INSERT INTO estimate_messages (
            estimate_id, recipients, event_type, created_at, updated_at
          ) VALUES (10, '[]', 'invalid', ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow()
    })

    it('[unit] requires send recipients and round-trips immutable sender delivery evidence', async () => {
      database = await factory()
      await seedOrganizationAndClients(database)
      await insertEstimate(database, 10)
      await expect(
        createEstimateMessage(database.orm, {
          estimateId: 10,
          recipients: [],
          eventType: 'send',
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      ).rejects.toThrow(/requires at least one recipient/)
      await expect(
        database.run(
          `INSERT INTO estimate_messages (
            estimate_id, recipients, event_type, created_at, updated_at
          ) VALUES (10, '[]', 'send', ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow()

      const message = await createEstimateMessage(database.orm, {
        estimateId: 10,
        sentBy: 'Archived Estimate Creator',
        sentByEmail: 'archived.creator@example.invalid',
        sentFrom: 'Sanitized Finance Team',
        sentFromEmail: 'finance@example.invalid',
        recipients: [{ name: 'Sanitized Recipient', email: 'recipient@example.invalid' }],
        subject: 'Sanitized estimate',
        body: 'Please review.',
        sendMeACopy: true,
        eventType: 'send',
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      await recordEstimateMessageDelivery(database.orm, {
        messageId: message.id,
        deliveryStatus: 'bounced',
        providerMessageId: 'provider-sanitized-1',
        updatedAt: laterTimestamp,
      })
      expect(
        await database.rows(
          `SELECT sent_by, sent_by_email, sent_from, sent_from_email,
            recipients, send_me_a_copy, delivery_status, provider_message_id
           FROM estimate_messages WHERE id = ?`,
          message.id,
        ),
      ).toEqual([
        {
          sent_by: 'Archived Estimate Creator',
          sent_by_email: 'archived.creator@example.invalid',
          sent_from: 'Sanitized Finance Team',
          sent_from_email: 'finance@example.invalid',
          recipients: '[{"name":"Sanitized Recipient","email":"recipient@example.invalid"}]',
          send_me_a_copy: 1,
          delivery_status: 'bounced',
          provider_message_id: 'provider-sanitized-1',
        },
      ])
      await expect(
        database.run(
          `UPDATE estimate_messages SET sent_from_email = 'forged@example.invalid'
           WHERE id = ?`,
          message.id,
        ),
      ).rejects.toThrow(/sender snapshots are immutable/)
      await expect(
        database.run(
          `UPDATE estimate_messages SET delivery_status = 'unknown' WHERE id = ?`,
          message.id,
        ),
      ).rejects.toThrow()

      const columns = await database.rows<{ name: string }>(`PRAGMA table_info(estimate_messages)`)
      const names = columns.map(({ name }) => name)
      for (const invoiceOnly of ['attach_pdf', 'thank_you', 'reminder', 'send_reminder_on']) {
        expect(names).not.toContain(invoiceOnly)
      }
    })

    it('[unit] maps sanitized Harvest estimate and message evidence losslessly', async () => {
      database = await factory()
      await seedOrganizationAndClients(database)
      const sourceEstimate = JSON.parse(
        await readFile(new URL('fixtures/harvest-estimate.json', import.meta.url), 'utf8'),
      ) as HarvestEstimatePayload
      const sourceMessage = JSON.parse(
        await readFile(new URL('fixtures/harvest-estimate-message.json', import.meta.url), 'utf8'),
      ) as HarvestEstimateMessagePayload
      const sourceCategory = JSON.parse(
        await readFile(
          new URL('fixtures/harvest-estimate-item-category.json', import.meta.url),
          'utf8',
        ),
      ) as HarvestEstimateItemCategoryPayload

      const mapped = mapHarvestEstimatePayload(sourceEstimate, {
        clientId: 1,
        createdByUserId: null,
      })
      const [storedEstimate] = await database.orm
        .insert(estimates)
        .values(mapped.estimate)
        .returning()
      if (!storedEstimate) throw new Error('estimate fixture did not insert')
      await database.orm
        .insert(estimateLineItems)
        .values(mapped.lineItems.map((line) => ({ ...line, estimateId: storedEstimate.id })))
      await database.orm
        .insert(estimateItemCategories)
        .values(mapHarvestEstimateItemCategoryPayload(sourceCategory))
      await database.orm
        .insert(estimateMessages)
        .values(mapHarvestEstimateMessagePayload(sourceMessage, storedEstimate.id))

      expect(
        await database.rows(
          `SELECT harvest_id, client_id, created_by_user_id, source_creator_id,
            source_creator_name, number, currency, state, tax_rate_ppm,
            amount_cents, client_key
           FROM estimates WHERE id = ?`,
          storedEstimate.id,
        ),
      ).toEqual([
        {
          harvest_id: 920001,
          client_id: 1,
          created_by_user_id: null,
          source_creator_id: 770099,
          source_creator_name: 'Archived Estimate Creator',
          number: 'EST-SAN-001',
          currency: 'USD',
          state: 'sent',
          tax_rate_ppm: 72500,
          amount_cents: 168925,
          client_key: storedEstimate.clientKey,
        },
      ])
      expect(storedEstimate.clientKey).not.toBe(sourceEstimate.client_key)
      expect(
        await database.rows(
          `SELECT harvest_id, position, kind, quantity, unit_price_cents, amount_cents,
            taxed, taxed2 FROM estimate_line_items ORDER BY position`,
        ),
      ).toEqual([
        {
          harvest_id: 920101,
          position: 0,
          kind: 'Professional Services',
          quantity: 1.25,
          unit_price_cents: 120000,
          amount_cents: 150000,
          taxed: 1,
          taxed2: 0,
        },
        {
          harvest_id: 920102,
          position: 1,
          kind: 'Expenses',
          quantity: 1,
          unit_price_cents: 8050,
          amount_cents: 8050,
          taxed: 0,
          taxed2: 0,
        },
      ])
      expect(
        await database.rows(
          `SELECT harvest_id, sent_by, sent_by_email, sent_from, sent_from_email,
            recipients, event_type, delivery_status, provider_message_id
           FROM estimate_messages`,
        ),
      ).toEqual([
        {
          harvest_id: 921001,
          sent_by: 'Archived Estimate Creator',
          sent_by_email: 'archived.creator@example.invalid',
          sent_from: 'Sanitized Finance Team',
          sent_from_email: 'finance@example.invalid',
          recipients: '[{"name":"Sanitized Recipient","email":"recipient@example.invalid"}]',
          event_type: 'send',
          delivery_status: null,
          provider_message_id: null,
        },
      ])
      expect(await database.rows(`SELECT harvest_id, name FROM estimate_item_categories`)).toEqual([
        { harvest_id: 922001, name: 'Professional Services' },
      ])
      expect(await database.rows(`PRAGMA foreign_key_check`)).toEqual([])
    })

    it('[unit] rejects replacement collisions and preserves bearer/provenance identity', async () => {
      database = await factory()
      await seedOrganizationAndClients(database)
      await insertEstimate(database, 10)
      const [original] = await database.rows<{
        client_key: string
        source_creator_id: number
        source_creator_name: string
      }>(`SELECT client_key, source_creator_id, source_creator_name FROM estimates WHERE id = 10`)
      await expect(
        database.run(
          `INSERT OR REPLACE INTO estimates (
            id, client_id, source_creator_id, source_creator_name, number,
            currency, issue_date, created_at, updated_at
          ) VALUES (10, 1, 1, 'Forged', 'EST-FORGED', 'USD', '2026-08-28', ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/identity already exists/)
      expect(
        await database.rows(
          `SELECT client_key, source_creator_id, source_creator_name FROM estimates WHERE id = 10`,
        ),
      ).toEqual([original])
    })
  })
}

describe('estimate package surface', () => {
  it('[unit] exports schema and guarded operations from the package root', () => {
    expect(publicDatabase.estimates).toBe(estimates)
    expect(publicDatabase.estimateLineItems).toBe(estimateLineItems)
    expect(publicDatabase.estimateMessages).toBe(estimateMessages)
    expect(publicDatabase.createEstimateMessage).toBe(createEstimateMessage)
    expect(publicDatabase.recordSystemEstimateEvent).toBe(recordSystemEstimateEvent)
    expect(nativeMessageHasNoPrivilegedKeys).toBeNull()
  })
})
