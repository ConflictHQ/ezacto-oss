import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { orgPeopleMigration } from '../src/migrations/0000_org_people.js'
import { clientsMigration } from '../src/migrations/0001_clients.js'
import { projectsTimeMigration } from '../src/migrations/0002_projects_time.js'
import { rateResolverMigration } from '../src/migrations/0003_rate_resolver.js'
import { invoiceFoundationMigration } from '../src/migrations/0004_invoice_foundation.js'
import { invoicePaymentsTotalsMigration } from '../src/migrations/0005_invoice_payments_totals.js'

interface TestDatabase {
  run(sql: string, ...params: unknown[]): Promise<void>
  rows<T>(sql: string, ...params: unknown[]): Promise<T[]>
  migrateAgain(): Promise<void>
  close(): Promise<void>
}

interface HarvestInvoice {
  id: number
  client: { id: number; name: string }
  line_items: Array<{
    id: number
    project: { id: number; name: string; code: string } | null
    kind: string
    description: string | null
    quantity: number
    unit_price: number
    amount: number
    taxed: boolean
    taxed2: boolean
  }>
  creator: { id: number; name: string } | null
  client_key: string
  number: string
  purchase_order: string | null
  tax: number | null
  tax2: number | null
  discount: number | null
  subject: string | null
  notes: string | null
  currency: string
  state: 'draft' | 'open' | 'paid' | 'closed'
  period_start: string | null
  period_end: string | null
  issue_date: string
  due_date: string
  payment_term: string
  sent_at: string | null
  paid_at: string | null
  paid_date: string | null
  closed_at: string | null
  created_at: string
  updated_at: string
}

interface HarvestInvoiceMessage {
  id: number
  sent_by: string | null
  sent_by_email: string | null
  sent_from: string | null
  sent_from_email: string | null
  recipients: Array<{ name: string; email: string }>
  subject: string | null
  body: string | null
  attach_pdf: boolean
  send_me_a_copy: boolean
  thank_you: boolean
  event_type: 'send' | 'close' | 're-open' | 'draft' | null
  reminder: boolean
  send_reminder_on: string | null
  created_at: string
  updated_at: string
}

const timestamp = '2026-08-27T00:00:00.000Z'
const modules = JSON.stringify({ expenses: true, invoices: true })
const migrationsThrough0003 = [
  ['0000_org_people', orgPeopleMigration],
  ['0001_clients', clientsMigration],
  ['0002_projects_time', projectsTimeMigration],
  ['0003_rate_resolver', rateResolverMigration],
] as const

const invoiceMigrationsThrough0005 = [
  ['0004_invoice_foundation', invoiceFoundationMigration],
  ['0005_invoice_payments_totals', invoicePaymentsTotalsMigration],
] as const

const loadFixture = async <T>(name: string): Promise<T> =>
  JSON.parse(await readFile(new URL(`fixtures/${name}`, import.meta.url), 'utf8')) as T

const containerDatabase = (migrate = true): TestDatabase => {
  const sqlite = new BetterSqlite3(':memory:')
  if (migrate) migrateContainer(sqlite)
  return {
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

const installThrough0003 = async (database: TestDatabase): Promise<void> => {
  await database.run(
    `CREATE TABLE _ezacto_migrations (
      id TEXT PRIMARY KEY, applied_at TEXT NOT NULL
    ) STRICT`,
  )
  for (const [id, statements] of migrationsThrough0003) {
    for (const statement of statements) await database.run(statement)
    await database.run(
      `INSERT INTO _ezacto_migrations (id, applied_at) VALUES (?, ?)`,
      id,
      timestamp,
    )
  }
}

const installInvoiceMigrationsThrough0005 = async (database: TestDatabase): Promise<void> => {
  for (const [id, statements] of invoiceMigrationsThrough0005) {
    for (const statement of statements) await database.run(statement)
    await database.run(
      `INSERT INTO _ezacto_migrations (id, applied_at) VALUES (?, ?)`,
      id,
      timestamp,
    )
  }
}

const installProjectsTimeFixture = async (database: TestDatabase): Promise<void> => {
  await database.run(
    `INSERT INTO organizations (name, modules, created_at, updated_at)
     VALUES ('Sanitized Organization', ?, ?, ?)`,
    modules,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO users
      (id, harvest_id, first_name, last_name, manager_grants, created_at, updated_at)
     VALUES (1, 1782959, 'Sanitized', 'Creator', '[]', ?, ?)`,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO clients (id, harvest_id, name, currency, created_at, updated_at)
     VALUES
      (1, 5735776, 'Sanitized Client', 'USD', ?, ?),
      (2, 5735777, 'Other Client', 'USD', ?, ?)`,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO projects
      (id, harvest_id, client_id, name, code, created_at, updated_at)
     VALUES
      (1, 14308069, 1, 'Migration', 'MIG', ?, ?),
      (2, 14308070, 1, 'Unlinked', 'FREE', ?, ?)`,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO project_milestones
      (id, project_id, name, amount_cents, created_at, updated_at)
     VALUES (1, 1, 'Existing milestone', 10000, ?, ?)`,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO tasks
      (id, name, created_at, updated_at)
     VALUES (1, 'Existing task', ?, ?)`,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO task_assignments
      (id, project_id, task_id, billable, created_at, updated_at)
     VALUES (1, 1, 1, 1, ?, ?)`,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO user_assignments
      (id, project_id, user_id, created_at, updated_at)
     VALUES (1, 1, 1, ?, ?)`,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO time_entries
      (id, harvest_id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
       spent_date, seconds, seconds_without_timer, rounded_seconds, billable, budgeted,
       billable_rate_cents, cost_rate_cents, created_at, updated_at)
     VALUES (1, 'legacy-entry', 1, 1, 1, 1, 1, '2026-08-01', 3600, 3600, 3600,
       1, 0, 17500, 7500, ?, ?)`,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO time_entry_rate_reprices
      (id, time_entry_id, previous_billable_rate_cents, billable_rate_cents,
       previous_cost_rate_cents, cost_rate_cents, reason, repriced_at)
     VALUES (1, 1, 17500, 18000, 7500, 8000, 'Sanitized existing audit', ?)`,
    timestamp,
  )
}

const paymentTerm = (value: string): string => value.replaceAll(' ', '_')
const cents = (value: number): number => {
  const scaled = value * 100
  if (!Number.isSafeInteger(scaled)) {
    throw new Error('Harvest money must have at most two decimal places')
  }
  return scaled
}

for (const [runtime, factory] of factories) {
  describe(`invoice foundation migration (${runtime})`, () => {
    let database: TestDatabase | undefined

    afterEach(async () => database?.close())

    it('[unit] creates the exact foundation, links, and extensible outbox on a fresh database', async () => {
      database = await factory()
      const db = database
      const tables = await db.rows<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
      )
      expect(tables.map(({ name }) => name)).toEqual(
        expect.arrayContaining([
          'invoices',
          'invoice_item_categories',
          'invoice_line_items',
          'invoice_messages',
          'event_outbox',
        ]),
      )
      const forbiddenTables = [
        'receipts',
        'estimates',
        'estimate_line_items',
        'estimate_item_categories',
        'estimate_messages',
        'recurring_invoices',
        'file_objects',
        'attachments',
      ]
      expect(
        tables.map(({ name }) => name).filter((name) => forbiddenTables.includes(name)),
      ).toEqual([])

      const invoiceColumns = await db.rows<{ name: string }>(`PRAGMA table_info(invoices)`)
      expect(invoiceColumns.map(({ name }) => name)).toEqual([
        'id',
        'harvest_id',
        'client_id',
        'created_by_user_id',
        'source_creator_id',
        'source_creator_name',
        'number',
        'subject',
        'purchase_order',
        'notes',
        'currency',
        'issue_date',
        'due_date',
        'payment_terms',
        'state',
        'sent_at',
        'paid_at',
        'paid_date',
        'closed_at',
        'period_start',
        'period_end',
        'client_key',
        'project_id',
        'reminder_policy',
        'created_at',
        'updated_at',
        'tax_rate_ppm',
        'tax2_rate_ppm',
        'discount_rate_ppm',
        'amount_cents',
        'due_amount_cents',
        'tax_amount_cents',
        'tax2_amount_cents',
        'discount_amount_cents',
        'written_off_cents',
        'payment_options',
        'reference_token',
        'source_amount_cents',
        'source_due_amount_cents',
        'source_tax_amount_cents',
        'source_tax2_amount_cents',
        'source_discount_amount_cents',
        'source_payment_options',
        'source_updated_at',
        'version',
        'close_reason',
        'close_write_off_cents',
        'retainer_id',
      ])
      expect(
        (await db.rows<{ name: string }>(`PRAGMA table_info(invoice_item_categories)`)).map(
          ({ name }) => name,
        ),
      ).toEqual([
        'id',
        'harvest_id',
        'name',
        'use_as_service',
        'use_as_expense',
        'created_at',
        'updated_at',
      ])
      expect(
        (await db.rows<{ name: string }>(`PRAGMA table_info(invoice_line_items)`)).map(
          ({ name }) => name,
        ),
      ).toEqual([
        'id',
        'harvest_id',
        'invoice_id',
        'position',
        'kind',
        'description',
        'quantity',
        'unit_price_cents',
        'amount_cents',
        'taxed',
        'taxed2',
        'project_id',
        'created_at',
        'updated_at',
      ])
      const messageColumns = await db.rows<{
        name: string
        notnull: number
        dflt_value: string | null
      }>(`PRAGMA table_info(invoice_messages)`)
      expect(messageColumns.map(({ name }) => name)).toEqual([
        'id',
        'harvest_id',
        'invoice_id',
        'sent_by',
        'sent_by_email',
        'sent_from',
        'sent_from_email',
        'recipients',
        'subject',
        'body',
        'attach_pdf',
        'send_me_a_copy',
        'thank_you',
        'reminder',
        'send_reminder_on',
        'event_type',
        'delivery_status',
        'provider_message_id',
        'created_at',
        'updated_at',
      ])
      expect(messageColumns.find(({ name }) => name === 'recipients')?.dflt_value).toBe("'[]'")
      expect(messageColumns.find(({ name }) => name === 'delivery_status')).toMatchObject({
        notnull: 0,
        dflt_value: null,
      })
      expect(
        (
          await db.rows<{ name: string }>(
            `PRAGMA index_info('invoice_messages_invoice_created_id')`,
          )
        ).map(({ name }) => name),
      ).toEqual(['invoice_id', 'created_at', 'id'])
      expect(
        (
          await db.rows<{ from: string; table: string; to: string; on_delete: string }>(
            `PRAGMA foreign_key_list(time_entries)`,
          )
        ).map(({ from, table, to, on_delete }) => ({ from, table, to, on_delete })),
      ).toEqual(
        expect.arrayContaining([
          { from: 'invoice_id', table: 'invoices', to: 'id', on_delete: 'RESTRICT' },
        ]),
      )
      expect(
        (
          await db.rows<{ from: string; table: string; to: string; on_delete: string }>(
            `PRAGMA foreign_key_list(project_milestones)`,
          )
        ).map(({ from, table, to, on_delete }) => ({ from, table, to, on_delete })),
      ).toEqual(
        expect.arrayContaining([
          {
            from: 'invoiced_invoice_id',
            table: 'invoices',
            to: 'id',
            on_delete: 'RESTRICT',
          },
        ]),
      )
      const foreignKeys = async (tableName: string) =>
        (
          await db.rows<{ from: string; table: string; to: string; on_delete: string }>(
            `PRAGMA foreign_key_list(${tableName})`,
          )
        ).map(({ from, table, to, on_delete }) => ({ from, table, to, on_delete }))
      expect(await foreignKeys('invoices')).toEqual(
        expect.arrayContaining([
          { from: 'client_id', table: 'clients', to: 'id', on_delete: 'RESTRICT' },
          {
            from: 'created_by_user_id',
            table: 'users',
            to: 'id',
            on_delete: 'SET NULL',
          },
          { from: 'project_id', table: 'projects', to: 'id', on_delete: 'RESTRICT' },
        ]),
      )
      expect(await foreignKeys('invoice_line_items')).toEqual(
        expect.arrayContaining([
          { from: 'invoice_id', table: 'invoices', to: 'id', on_delete: 'CASCADE' },
          { from: 'project_id', table: 'projects', to: 'id', on_delete: 'RESTRICT' },
        ]),
      )
      expect(await foreignKeys('invoice_messages')).toEqual([
        { from: 'invoice_id', table: 'invoices', to: 'id', on_delete: 'CASCADE' },
      ])
      for (const forbidden of [
        'estimate_id',
        'recurring_invoice_id',
        'tax_pct',
        'tax2_pct',
        'discount_pct',
        'sender_identity_id',
      ]) {
        expect(invoiceColumns.map(({ name }) => name)).not.toContain(forbidden)
      }

      expect(
        (await db.rows<{ name: string }>(`PRAGMA table_info(time_entries)`)).map(
          ({ name }) => name,
        ),
      ).toContain('invoice_id')
      expect(
        (await db.rows<{ name: string }>(`PRAGMA table_info(project_milestones)`)).map(
          ({ name }) => name,
        ),
      ).toContain('invoiced_invoice_id')

      const outboxColumns = await db.rows<{
        name: string
        type: string
        dflt_value: string | null
      }>(`PRAGMA table_info(event_outbox)`)
      expect(outboxColumns.map(({ name }) => name)).toEqual([
        'id',
        'aggregate_type',
        'aggregate_id',
        'aggregate_sequence',
        'event_type',
        'payload_json',
        'occurred_at',
        'available_at',
        'published_at',
        'attempt_count',
        'last_error',
        'command_id',
        'event_index',
      ])
      expect(outboxColumns.find(({ name }) => name === 'event_type')?.type).toBe('TEXT')
      expect(outboxColumns.find(({ name }) => name === 'id')?.dflt_value).toBeNull()
      expect(outboxColumns.find(({ name }) => name === 'attempt_count')?.dflt_value).toBe('0')
      expect(
        (await db.rows<{ name: string }>(`PRAGMA index_info('event_outbox_dequeue')`)).map(
          ({ name }) => name,
        ),
      ).toEqual(['published_at', 'available_at', 'occurred_at', 'id'])
      await db.run(
        `INSERT INTO event_outbox
          (id, aggregate_type, aggregate_id, aggregate_sequence, event_type, payload_json,
           occurred_at, available_at)
         VALUES ('event-1', 'future', 1, 1, 'invoice.future_event', '{}', ?, ?)`,
        timestamp,
        timestamp,
      )
      await expect(
        db.run(
          `INSERT INTO event_outbox
            (id, aggregate_type, aggregate_id, aggregate_sequence, event_type, payload_json,
             occurred_at, available_at)
           VALUES ('event-2', 'future', 1, 1, 'another.future.event', '{}', ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/outbox event identity already exists/)
      await expect(
        db.run(
          `INSERT INTO event_outbox
            (id, aggregate_type, aggregate_id, aggregate_sequence, event_type, payload_json,
             occurred_at, available_at)
           VALUES ('event-zero', 'future', 2, 0, 'invoice.created', '{}', ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/CHECK constraint/i)
      await expect(
        db.run(
          `INSERT INTO event_outbox
            (id, aggregate_type, aggregate_id, aggregate_sequence, event_type, payload_json,
             occurred_at, available_at, attempt_count)
           VALUES ('event-negative', 'future', 2, 1, 'invoice.created', '{}', ?, ?, -1)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/CHECK constraint/i)
      await expect(
        db.run(
          `INSERT INTO event_outbox
            (id, aggregate_type, aggregate_id, aggregate_sequence, event_type, payload_json,
             occurred_at, available_at)
           VALUES ('event-json', 'future', 2, 1, 'invoice.created', '{', ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/CHECK constraint/i)
      await expect(
        db.run(
          `INSERT INTO event_outbox
            (aggregate_type, aggregate_id, aggregate_sequence, event_type, payload_json,
             occurred_at, available_at)
           VALUES ('future', 3, 1, 'invoice.created', '{}', ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow()
      await expect(
        db.run(
          `INSERT INTO event_outbox
            (id, aggregate_type, aggregate_id, aggregate_sequence, event_type, payload_json,
             occurred_at, available_at)
           VALUES ('event-offset', 'future', 4, 1, 'invoice.created', '{}',
             '2026-08-27T00:00:00+00:00', ?)`,
          timestamp,
        ),
      ).rejects.toThrow(/CHECK constraint/i)
      await expect(
        db.run(
          `INSERT INTO event_outbox
            (id, aggregate_type, aggregate_id, aggregate_sequence, event_type, payload_json,
             occurred_at, available_at, published_at)
           VALUES ('event-hour', 'future', 4, 1, 'invoice.created', '{}', ?, ?,
             '2026-08-27T24:00:00Z')`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/CHECK constraint/i)
    })

    it('[unit] upgrades populated 0003 data without loss and reruns idempotently', async () => {
      database = await factory(false)
      const db = database
      await installThrough0003(db)
      await installProjectsTimeFixture(db)

      await db.migrateAgain()
      const firstLedger = await db.rows<{ id: string; applied_at: string }>(
        `SELECT id, applied_at FROM _ezacto_migrations ORDER BY id`,
      )
      expect(firstLedger.map(({ id }) => id)).toEqual([
        '0000_org_people',
        '0001_clients',
        '0002_projects_time',
        '0003_rate_resolver',
        '0004_invoice_foundation',
        '0005_invoice_payments_totals',
        '0006_invoice_state_events',
        '0007_expenses',
        '0008_retainer_ledger',
        '0011_api_tokens',
      ])
      expect(
        firstLedger.slice(0, 4).every(({ applied_at: appliedAt }) => appliedAt === timestamp),
      ).toBe(true)
      expect(
        await db.rows<{ id: number; harvest_id: string; invoice_id: number | null }>(
          `SELECT id, harvest_id, invoice_id FROM time_entries`,
        ),
      ).toEqual([{ id: 1, harvest_id: 'legacy-entry', invoice_id: null }])
      expect(
        await db.rows<{ id: number; name: string; client_id: number }>(
          `SELECT id, name, client_id FROM projects ORDER BY id`,
        ),
      ).toEqual([
        { id: 1, name: 'Migration', client_id: 1 },
        { id: 2, name: 'Unlinked', client_id: 1 },
      ])
      expect(
        await db.rows<{ id: number; time_entry_id: number; reason: string }>(
          `SELECT id, time_entry_id, reason FROM time_entry_rate_reprices`,
        ),
      ).toEqual([{ id: 1, time_entry_id: 1, reason: 'Sanitized existing audit' }])
      expect(
        await db.rows<{ id: number; name: string; invoiced_invoice_id: number | null }>(
          `SELECT id, name, invoiced_invoice_id FROM project_milestones`,
        ),
      ).toEqual([{ id: 1, name: 'Existing milestone', invoiced_invoice_id: null }])
      expect(await db.rows<{ id: number; name: string }>(`SELECT id, name FROM tasks`)).toEqual([
        { id: 1, name: 'Existing task' },
      ])
      expect(
        await db.rows<{ id: number; project_id: number; task_id: number }>(
          `SELECT id, project_id, task_id FROM task_assignments`,
        ),
      ).toEqual([{ id: 1, project_id: 1, task_id: 1 }])
      expect(
        await db.rows<{ id: number; project_id: number; user_id: number }>(
          `SELECT id, project_id, user_id FROM user_assignments`,
        ),
      ).toEqual([{ id: 1, project_id: 1, user_id: 1 }])
      expect(
        await db.rows<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'trigger'
           AND name IN ('time_entries_stop_previous_insert',
             'time_entry_rate_reprices_apply') ORDER BY name`,
        ),
      ).toEqual([
        { name: 'time_entries_stop_previous_insert' },
        { name: 'time_entry_rate_reprices_apply' },
      ])
      expect(await db.rows(`PRAGMA foreign_key_check`)).toEqual([])

      await db.migrateAgain()
      expect(
        await db.rows<{ id: string; applied_at: string }>(
          `SELECT id, applied_at FROM _ezacto_migrations ORDER BY id`,
        ),
      ).toEqual(firstLedger)
    })

    it('[unit] rolls back a failed 0004 migration and retries without partial links', async () => {
      database = await factory(false)
      const db = database
      await installThrough0003(db)
      await db.run(
        `CREATE TRIGGER projects_client_immutable_while_invoiced
         BEFORE UPDATE OF client_id ON projects BEGIN SELECT 1; END`,
      )
      const schemaBeforeFailure = await db.rows<Record<string, unknown>>(
        `SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name`,
      )

      await expect(db.migrateAgain()).rejects.toThrow()
      expect(
        await db.rows<Record<string, unknown>>(
          `SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name`,
        ),
      ).toEqual(schemaBeforeFailure)
      expect(
        await db.rows<{ id: string }>(`SELECT id FROM _ezacto_migrations ORDER BY id`),
      ).toEqual([
        { id: '0000_org_people' },
        { id: '0001_clients' },
        { id: '0002_projects_time' },
        { id: '0003_rate_resolver' },
      ])
      expect(
        await db.rows<{ name: string }>(
          `SELECT name FROM sqlite_master
           WHERE name IN ('invoices', 'invoice_messages', 'event_outbox') ORDER BY name`,
        ),
      ).toEqual([])
      expect(
        (await db.rows<{ name: string }>(`PRAGMA table_info(time_entries)`)).map(
          ({ name }) => name,
        ),
      ).not.toContain('invoice_id')
      expect(
        (await db.rows<{ name: string }>(`PRAGMA table_info(project_milestones)`)).map(
          ({ name }) => name,
        ),
      ).not.toContain('invoiced_invoice_id')

      await db.run(`DROP TRIGGER projects_client_immutable_while_invoiced`)
      await db.migrateAgain()
      expect(
        await db.rows<{ id: string }>(`SELECT id FROM _ezacto_migrations ORDER BY id`),
      ).toContainEqual({ id: '0004_invoice_foundation' })
      expect(await db.rows(`PRAGMA foreign_key_check`)).toEqual([])
    })

    it('[unit] enforces real invoice links and linked-project client immutability', async () => {
      database = await factory(false)
      const db = database
      await installThrough0003(db)
      await installProjectsTimeFixture(db)
      await db.migrateAgain()
      await db.run(
        `INSERT INTO invoices
          (id, client_id, number, currency, issue_date, due_date, project_id, created_at, updated_at)
         VALUES (1, 1, 'INV-LINKED', 'USD', '2026-08-01', '2026-08-31', 1, ?, ?)`,
        timestamp,
        timestamp,
      )
      await db.run(`UPDATE time_entries SET invoice_id = 1 WHERE id = 1`)
      await db.run(`UPDATE project_milestones SET invoiced_invoice_id = 1 WHERE id = 1`)
      await db.run(
        `INSERT INTO invoices
          (id, client_id, number, currency, issue_date, due_date, created_at, updated_at)
         VALUES
          (2, 2, 'INV-OTHER-CLIENT', 'USD', '2026-08-01', '2026-08-31', ?, ?),
          (3, 1, 'INV-LINE-CHILD', 'USD', '2026-08-01', '2026-08-31', ?, ?)`,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
      )
      await db.run(
        `INSERT INTO invoice_line_items
          (id, invoice_id, position, kind, quantity, unit_price_cents, amount_cents,
           project_id, created_at, updated_at)
         VALUES (1, 3, 0, 'Service', 1, 10000, 10000, 1, ?, ?)`,
        timestamp,
        timestamp,
      )
      await expect(
        db.run(`UPDATE time_entries SET invoice_id = 999 WHERE id = 1`),
      ).rejects.toThrow()
      await expect(
        db.run(`UPDATE project_milestones SET invoiced_invoice_id = 999 WHERE id = 1`),
      ).rejects.toThrow()
      await expect(
        db.run(
          `INSERT INTO invoices
            (id, client_id, number, currency, issue_date, due_date, project_id, created_at, updated_at)
           VALUES (4, 2, 'INV-MISMATCH', 'USD', '2026-08-01', '2026-08-31', 1, ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/must belong/)
      await expect(
        db.run(
          `INSERT INTO invoice_line_items
            (id, invoice_id, position, kind, quantity, unit_price_cents, amount_cents,
             project_id, created_at, updated_at)
           VALUES (2, 2, 0, 'Service', 1, 10000, 10000, 1, ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/must belong/)
      await expect(db.run(`UPDATE time_entries SET invoice_id = 2 WHERE id = 1`)).rejects.toThrow(
        /must belong/,
      )
      await expect(
        db.run(`UPDATE project_milestones SET invoiced_invoice_id = 2 WHERE id = 1`),
      ).rejects.toThrow(/must belong/)
      await expect(db.run(`UPDATE invoices SET client_id = 2 WHERE id = 3`)).rejects.toThrow(
        /match every linked project/,
      )
      await db.run(`UPDATE projects SET client_id = 1 WHERE id = 1`)
      await db.run(`UPDATE invoices SET client_id = 1 WHERE id = 1`)
      await expect(db.run(`UPDATE projects SET client_id = 2 WHERE id IN (1, 2)`)).rejects.toThrow(
        /immutable/,
      )
      expect(
        await db.rows<{ id: number; client_id: number }>(
          `SELECT id, client_id FROM projects ORDER BY id`,
        ),
      ).toEqual([
        { id: 1, client_id: 1 },
        { id: 2, client_id: 1 },
      ])

      await db.run(`UPDATE time_entries SET invoice_id = NULL WHERE id = 1`)
      await db.run(`UPDATE project_milestones SET invoiced_invoice_id = NULL WHERE id = 1`)
      await db.run(`DELETE FROM invoice_line_items WHERE id = 1`)
      await db.run(`UPDATE invoices SET project_id = NULL WHERE id = 1`)
      await db.run(`UPDATE projects SET client_id = 2 WHERE id IN (1, 2)`)
      expect(
        await db.rows<{ id: number; client_id: number }>(
          `SELECT id, client_id FROM projects ORDER BY id`,
        ),
      ).toEqual([
        { id: 1, client_id: 2 },
        { id: 2, client_id: 2 },
      ])
      expect(await db.rows(`PRAGMA foreign_key_check`)).toEqual([])
    })

    it('[unit] rejects malformed foundation rows while preserving evidenced negative lines', async () => {
      database = await factory(false)
      const db = database
      await installThrough0003(db)
      await installProjectsTimeFixture(db)
      await installInvoiceMigrationsThrough0005(db)
      await db.run(
        `INSERT INTO invoices
          (id, harvest_id, client_id, created_by_user_id, source_creator_id,
           source_creator_name, number, currency, issue_date, due_date, project_id,
           reminder_policy, created_at, updated_at)
         VALUES (1, 101, 1, 1, 1782959, 'Sanitized Creator', 'INV-VALID', 'USD',
           '2026-08-01', '2026-08-31', 1,
           '{"first_after_days":3,"every_days":7}', ?, ?)`,
        timestamp,
        timestamp,
      )
      expect(
        await db.rows<{ count: number }>(`SELECT count(*) AS count FROM event_outbox`),
      ).toEqual([{ count: 0 }])
      const invalidInvoices = [
        `INSERT INTO invoices
          (id, client_id, number, currency, issue_date, due_date, created_at, updated_at)
         VALUES (2, 999, 'BAD-CLIENT', 'USD', '2026-08-01', '2026-08-31', '${timestamp}', '${timestamp}')`,
        `INSERT INTO invoices
          (id, client_id, created_by_user_id, number, currency, issue_date, due_date,
           created_at, updated_at)
         VALUES (2, 1, 999, 'BAD-USER', 'USD', '2026-08-01', '2026-08-31',
           '${timestamp}', '${timestamp}')`,
        `INSERT INTO invoices
          (id, client_id, number, currency, issue_date, due_date, project_id,
           created_at, updated_at)
         VALUES (2, 1, 'BAD-PROJECT', 'USD', '2026-08-01', '2026-08-31', 999,
           '${timestamp}', '${timestamp}')`,
        `INSERT INTO invoices
          (id, client_id, number, currency, issue_date, due_date, state,
           created_at, updated_at)
         VALUES (2, 1, 'BAD-STATE', 'USD', '2026-08-01', '2026-08-31', 'cancelled',
           '${timestamp}', '${timestamp}')`,
        `INSERT INTO invoices
          (id, client_id, number, currency, issue_date, due_date, created_at, updated_at)
         VALUES (2, 1, 'BAD-DATE', 'USD', 'not-a-date', '2026-08-31',
           '${timestamp}', '${timestamp}')`,
        `INSERT INTO invoices
          (id, client_id, number, currency, issue_date, due_date, created_at, updated_at)
         VALUES (2, 1, 'BAD-CALENDAR-DATE', 'USD', '2026-02-30', '2026-08-31',
           '${timestamp}', '${timestamp}')`,
        `INSERT INTO invoices
          (id, client_id, number, currency, issue_date, due_date, reminder_policy,
           created_at, updated_at)
         VALUES (2, 1, 'BAD-REMINDER', 'USD', '2026-08-01', '2026-08-31', '[]',
           '${timestamp}', '${timestamp}')`,
        `INSERT INTO invoices
          (id, client_id, number, currency, issue_date, due_date, sent_at,
           created_at, updated_at)
         VALUES (2, 1, 'BAD-SENT-AT', 'USD', '2026-08-01', '2026-08-31',
           '2026-08-01T00:00:00+00:00', '${timestamp}', '${timestamp}')`,
        `INSERT INTO invoices
          (id, client_id, number, currency, issue_date, due_date, created_at, updated_at)
         VALUES (2, 1, 'BAD-CREATED-AT', 'USD', '2026-08-01', '2026-08-31',
           '2026-08-01T24:00:00Z', '${timestamp}')`,
      ]
      for (const sql of invalidInvoices) await expect(db.run(sql)).rejects.toThrow()
      await expect(
        db.run(
          `INSERT INTO invoices
            (id, harvest_id, client_id, number, currency, issue_date, due_date,
             created_at, updated_at)
           VALUES (2, 101, 1, 'DUP-HARVEST', 'USD', '2026-08-01', '2026-08-31', ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow()
      await expect(
        db.run(
          `INSERT INTO invoices
            (id, harvest_id, client_id, number, currency, issue_date, due_date,
             created_at, updated_at)
           VALUES (2, 102, 1, 'INV-VALID', 'USD', '2026-08-01', '2026-08-31', ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow()

      await db.run(
        `INSERT INTO invoice_item_categories
          (id, harvest_id, name, use_as_service, use_as_expense, created_at, updated_at)
         VALUES (1, 201, 'Service', 1, 0, ?, ?)`,
        timestamp,
        timestamp,
      )
      await expect(
        db.run(
          `INSERT INTO invoice_item_categories
            (id, harvest_id, name, use_as_service, use_as_expense, created_at, updated_at)
           VALUES (2, 201, 'Other', 0, 0, ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow()
      await expect(
        db.run(
          `INSERT INTO invoice_item_categories
            (id, harvest_id, name, use_as_service, use_as_expense, created_at, updated_at)
           VALUES (2, 202, 'Other', 2, 0, ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/CHECK constraint/i)
      await expect(
        db.run(
          `INSERT INTO invoice_item_categories
            (id, harvest_id, name, use_as_service, use_as_expense, created_at, updated_at)
           VALUES (2, 202, 'Bad timestamp', 0, 0,
             '2026-08-27T00:00:00+00:00', ?)`,
          timestamp,
        ),
      ).rejects.toThrow(/CHECK constraint/i)

      await db.run(
        `INSERT INTO invoice_line_items
          (id, harvest_id, invoice_id, position, kind, quantity, unit_price_cents,
           amount_cents, taxed, taxed2, project_id, created_at, updated_at)
         VALUES (1, 301, 1, 0, 'Credit', -1, -10000, -10000, 0, 0, 1, ?, ?)`,
        timestamp,
        timestamp,
      )
      await expect(
        db.run(
          `INSERT INTO invoice_line_items
            (id, harvest_id, invoice_id, position, kind, quantity, unit_price_cents,
             amount_cents, created_at, updated_at)
           VALUES (2, 302, 1, 0, 'Duplicate position', 1, 1, 1, ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/line identity already exists|UNIQUE constraint/i)
      await expect(
        db.run(
          `INSERT INTO invoice_line_items
            (id, harvest_id, invoice_id, position, kind, quantity, unit_price_cents,
             amount_cents, created_at, updated_at)
           VALUES (2, 301, 1, 1, 'Duplicate Harvest', 1, 1, 1, ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/line identity already exists|UNIQUE constraint/i)
      await expect(
        db.run(
          `INSERT INTO invoice_line_items
            (id, invoice_id, position, kind, quantity, unit_price_cents, amount_cents,
             created_at, updated_at)
           VALUES (2, 999, 1, 'Bad invoice', 1, 1, 1, ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow()
      await expect(
        db.run(
          `INSERT INTO invoice_line_items
            (id, invoice_id, position, kind, quantity, unit_price_cents, amount_cents,
             created_at, updated_at)
           VALUES (2, 1, 1, 'Bad timestamp', 1, 1, 1, ?, '2026-08-27T24:00:00Z')`,
          timestamp,
        ),
      ).rejects.toThrow(/CHECK constraint/i)
      await expect(
        db.run(
          `INSERT INTO invoice_line_items
            (id, invoice_id, position, kind, quantity, unit_price_cents, amount_cents,
             taxed, project_id, created_at, updated_at)
           VALUES (2, 1, 1, 'Bad project', 1, 1, 1, 2, 999, ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow()

      await db.run(
        `INSERT INTO invoice_messages
          (id, harvest_id, invoice_id, recipients, delivery_status, created_at, updated_at)
         VALUES (1, 401, 1, '[]', NULL, ?, ?)`,
        timestamp,
        timestamp,
      )
      const invalidMessages = [
        `INSERT INTO invoice_messages
          (id, invoice_id, recipients, created_at, updated_at)
         VALUES (2, 999, '[]', '${timestamp}', '${timestamp}')`,
        `INSERT INTO invoice_messages
          (id, invoice_id, recipients, created_at, updated_at)
         VALUES (2, 1, '{}', '${timestamp}', '${timestamp}')`,
        `INSERT INTO invoice_messages
          (id, invoice_id, recipients, created_at, updated_at)
         VALUES (2, 1, '{', '${timestamp}', '${timestamp}')`,
        `INSERT INTO invoice_messages
          (id, invoice_id, recipients, delivery_status, created_at, updated_at)
         VALUES (2, 1, '[]', 'delivered', '${timestamp}', '${timestamp}')`,
        `INSERT INTO invoice_messages
          (id, invoice_id, recipients, attach_pdf, created_at, updated_at)
         VALUES (2, 1, '[]', 2, '${timestamp}', '${timestamp}')`,
        `INSERT INTO invoice_messages
          (id, invoice_id, recipients, send_reminder_on, created_at, updated_at)
         VALUES (2, 1, '[]', 'tomorrow', '${timestamp}', '${timestamp}')`,
        `INSERT INTO invoice_messages
          (id, invoice_id, recipients, created_at, updated_at)
         VALUES (2, 1, '[]', '2026-08-01T00:00:00+00:00', '${timestamp}')`,
      ]
      for (const sql of invalidMessages) await expect(db.run(sql)).rejects.toThrow()
      await expect(
        db.run(
          `INSERT INTO invoice_messages
            (id, harvest_id, invoice_id, recipients, created_at, updated_at)
           VALUES (2, 401, 1, '[]', ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow()
      await db.migrateAgain()
      expect(
        await db.rows<{
          quantity: number
          unit_price_cents: number
          amount_cents: number
        }>(
          `SELECT quantity, unit_price_cents, amount_cents
           FROM invoice_line_items WHERE id = 1`,
        ),
      ).toEqual([{ quantity: -1, unit_price_cents: -10000, amount_cents: -10000 }])
      expect(await db.rows(`PRAGMA foreign_key_check`)).toEqual([])
    })

    it('[unit] blocks INSERT OR REPLACE from bypassing provenance immutability', async () => {
      database = await factory(false)
      const db = database
      await installThrough0003(db)
      await installProjectsTimeFixture(db)
      await installInvoiceMigrationsThrough0005(db)
      await db.run(
        `INSERT INTO invoices
          (id, harvest_id, client_id, source_creator_id, source_creator_name, number,
           currency, issue_date, due_date, created_at, updated_at)
         VALUES (1, 501, 1, 1782959, 'Original Creator', 'INV-REPLACE', 'USD',
           '2026-08-01', '2026-08-31', ?, ?)`,
        timestamp,
        timestamp,
      )
      await db.run(
        `INSERT INTO invoices
          (id, harvest_id, client_id, source_creator_id, source_creator_name, number,
           currency, issue_date, due_date, created_at, updated_at)
         VALUES (2, 502, 1, 1782960, 'Other Creator', 'INV-OTHER', 'USD',
           '2026-08-01', '2026-08-31', ?, ?)`,
        timestamp,
        timestamp,
      )
      await db.run(
        `INSERT INTO invoice_line_items
          (id, invoice_id, position, kind, quantity, unit_price_cents, amount_cents,
           created_at, updated_at)
         VALUES (1, 1, 0, 'Service', 1, 100, 100, ?, ?)`,
        timestamp,
        timestamp,
      )
      await db.run(
        `INSERT INTO invoice_messages
          (id, harvest_id, invoice_id, sent_by, sent_by_email, sent_from, sent_from_email,
           recipients, created_at, updated_at)
         VALUES (1, 601, 1, 'Original By', 'by@example.invalid', 'Original From',
           'from@example.invalid', '[]', ?, ?)`,
        timestamp,
        timestamp,
      )
      await db.run(
        `INSERT INTO invoice_messages
          (id, harvest_id, invoice_id, recipients, created_at, updated_at)
         VALUES (2, 602, 2, '[]', ?, ?)`,
        timestamp,
        timestamp,
      )
      await db.run(
        `INSERT INTO event_outbox
          (id, aggregate_type, aggregate_id, aggregate_sequence, event_type, payload_json,
           occurred_at, available_at)
         VALUES
          ('event-1', 'fixture', 1, 1, 'invoice.created', '{"invoice":1}', ?, ?),
          ('event-2', 'fixture', 2, 1, 'invoice.created', '{"invoice":2}', ?, ?)`,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
      )
      await db.migrateAgain()
      const originalInvoices = await db.rows<Record<string, unknown>>(
        `SELECT id, harvest_id, number, source_creator_id, source_creator_name, client_key
         FROM invoices ORDER BY id`,
      )
      const originalMessages = await db.rows<Record<string, unknown>>(
        `SELECT id, harvest_id, sent_by, sent_by_email, sent_from, sent_from_email
         FROM invoice_messages ORDER BY id`,
      )
      const originalEvents = await db.rows<Record<string, unknown>>(
        `SELECT id, aggregate_type, aggregate_id, aggregate_sequence, event_type, payload_json
         FROM event_outbox ORDER BY id`,
      )
      await expect(
        db.run(
          `INSERT OR REPLACE INTO invoices
            (id, harvest_id, client_id, source_creator_id, source_creator_name, number,
             currency, issue_date, due_date, created_at, updated_at)
           VALUES (1, 501, 1, 999, 'Forged', 'INV-REPLACE', 'USD',
             '2026-08-01', '2026-08-31', ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/identity already exists/)
      await expect(
        db.run(
          `INSERT INTO invoices
            (id, harvest_id, client_id, source_creator_id, source_creator_name, number,
             currency, issue_date, due_date, created_at, updated_at)
           VALUES (3, 501, 1, 999, 'Forged upsert', 'INV-UPSERT', 'USD',
             '2026-08-01', '2026-08-31', ?, ?)
           ON CONFLICT(harvest_id) DO UPDATE SET source_creator_id = excluded.source_creator_id,
             source_creator_name = excluded.source_creator_name`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/identity already exists/)
      const existingClientKey = originalInvoices[0]?.client_key
      await expect(
        db.run(
          `INSERT OR REPLACE INTO invoices
            (id, harvest_id, client_id, source_creator_id, source_creator_name, number,
             client_key, currency, issue_date, due_date, created_at, updated_at)
           VALUES (3, 503, 1, 999, 'Forged', 'INV-COPIED-KEY', ?, 'USD',
             '2026-08-01', '2026-08-31', ?, ?)`,
          existingClientKey,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/identity already exists/)
      await expect(
        db.run(
          `INSERT INTO invoice_messages
            (id, harvest_id, invoice_id, sent_by, recipients, created_at, updated_at)
           VALUES (3, 601, 1, 'Forged upsert', '[]', ?, ?)
           ON CONFLICT(harvest_id) DO UPDATE SET sent_by = excluded.sent_by`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/exact pending authority/)
      await expect(
        db.run(`UPDATE OR REPLACE invoices SET harvest_id = 501 WHERE id = 2`),
      ).rejects.toThrow(/belongs to another row|immutable/)
      await expect(db.run(`UPDATE OR REPLACE invoices SET id = 1 WHERE id = 2`)).rejects.toThrow(
        /belongs to another row|immutable/,
      )
      await expect(
        db.run(`UPDATE OR REPLACE invoices SET number = 'INV-REPLACE' WHERE id = 2`),
      ).rejects.toThrow(/belongs to another row|pending command/)
      await expect(
        db.run(`UPDATE OR REPLACE invoices SET client_key = ? WHERE id = 2`, existingClientKey),
      ).rejects.toThrow(/belongs to another row|pending command/)
      await expect(
        db.run(
          `INSERT OR REPLACE INTO invoices
            (id, harvest_id, client_id, source_creator_id, source_creator_name, number,
             currency, issue_date, due_date, created_at, updated_at)
           VALUES (2, 501, 1, 999, 'Forged', 'INV-OTHER', 'USD',
             '2026-08-01', '2026-08-31', ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/identity already exists/)
      await expect(
        db.run(
          `INSERT OR REPLACE INTO invoice_messages
            (id, harvest_id, invoice_id, sent_by, sent_by_email, sent_from, sent_from_email,
             recipients, created_at, updated_at)
           VALUES (1, 601, 1, 'Forged', 'forged@example.invalid', 'Forged',
             'forged@example.invalid', '[]', ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/exact pending authority/)
      await expect(
        db.run(
          `INSERT OR REPLACE INTO invoice_messages
            (id, harvest_id, invoice_id, recipients, created_at, updated_at)
           VALUES (2, 601, 1, '[]', ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/exact pending authority/)
      await expect(
        db.run(`UPDATE OR REPLACE invoice_messages SET harvest_id = 601 WHERE id = 2`),
      ).rejects.toThrow(/belongs to another row|exact import authority/)
      await expect(
        db.run(`UPDATE OR REPLACE invoice_messages SET id = 1 WHERE id = 2`),
      ).rejects.toThrow(/belongs to another row|exact import authority/)
      await expect(
        db.run(
          `INSERT OR REPLACE INTO event_outbox
            (id, aggregate_type, aggregate_id, aggregate_sequence, event_type, payload_json,
             occurred_at, available_at)
           VALUES ('event-1', 'fixture', 1, 1, 'forged', '{}', ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/identity already exists/)
      await expect(
        db.run(
          `INSERT OR REPLACE INTO event_outbox
            (id, aggregate_type, aggregate_id, aggregate_sequence, event_type, payload_json,
             occurred_at, available_at)
           VALUES ('event-3', 'fixture', 1, 1, 'forged', '{}', ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/identity already exists/)
      await expect(
        db.run(`UPDATE OR REPLACE event_outbox SET id = 'event-1' WHERE id = 'event-2'`),
      ).rejects.toThrow(/belongs to another row|outbox event identity.*payload are immutable/)
      await expect(
        db.run(
          `UPDATE OR REPLACE event_outbox
           SET aggregate_id = 1, aggregate_sequence = 1 WHERE id = 'event-2'`,
        ),
      ).rejects.toThrow(/belongs to another row|outbox event identity.*payload are immutable/)
      for (const update of [
        `id = 'event-fresh'`,
        `aggregate_type = 'forged'`,
        `aggregate_id = 999`,
        `aggregate_sequence = 2`,
        `event_type = 'forged'`,
        `payload_json = '{}'`,
        `occurred_at = '2026-08-27T00:01:00Z'`,
      ]) {
        await expect(
          db.run(`UPDATE event_outbox SET ${update} WHERE id = 'event-1'`),
        ).rejects.toThrow(/outbox event identity.*payload are immutable/)
      }
      expect(
        await db.rows<Record<string, unknown>>(
          `SELECT id, harvest_id, number, source_creator_id, source_creator_name, client_key
           FROM invoices ORDER BY id`,
        ),
      ).toEqual(originalInvoices)
      expect(
        await db.rows<Record<string, unknown>>(
          `SELECT id, harvest_id, sent_by, sent_by_email, sent_from, sent_from_email
           FROM invoice_messages ORDER BY id`,
        ),
      ).toEqual(originalMessages)
      expect(
        await db.rows<Record<string, unknown>>(
          `SELECT id, aggregate_type, aggregate_id, aggregate_sequence, event_type, payload_json
           FROM event_outbox ORDER BY id`,
        ),
      ).toEqual(originalEvents)
      expect(
        await db.rows<{ count: number }>(`SELECT count(*) AS count FROM invoice_line_items`),
      ).toEqual([{ count: 1 }])
      const rotatedKey = 'a'.repeat(64)
      await expect(
        db.run(
          `UPDATE invoices SET number = 'INV-OTHER-ROTATED', client_key = ? WHERE id = 2`,
          rotatedKey,
        ),
      ).rejects.toThrow(/pending command/)
      await db.run(
        `UPDATE event_outbox SET available_at = '2026-08-27T00:01:00Z', published_at = ?,
           attempt_count = 1, last_error = 'retry'
         WHERE id = 'event-1'`,
        timestamp,
      )
      expect(
        await db.rows<{ number: string; client_key: string }>(
          `SELECT number, client_key FROM invoices WHERE id = 2`,
        ),
      ).toEqual([
        {
          number: originalInvoices[1]?.number,
          client_key: originalInvoices[1]?.client_key,
        },
      ])
      expect(
        await db.rows<{
          available_at: string
          published_at: string
          attempt_count: number
          last_error: string
        }>(
          `SELECT available_at, published_at, attempt_count, last_error
           FROM event_outbox WHERE id = 'event-1'`,
        ),
      ).toEqual([
        {
          available_at: '2026-08-27T00:01:00Z',
          published_at: timestamp,
          attempt_count: 1,
          last_error: 'retry',
        },
      ])
      expect(await db.rows(`PRAGMA foreign_key_check`)).toEqual([])
    })

    it('[unit] preserves golden Harvest creator and sender provenance without source secrets', async () => {
      database = await factory(false)
      const db = database
      await installThrough0003(db)
      await installProjectsTimeFixture(db)
      await installInvoiceMigrationsThrough0005(db)
      const invoice = await loadFixture<HarvestInvoice>('harvest-invoice.json')
      const message = await loadFixture<HarvestInvoiceMessage>('harvest-invoice-message.json')
      const creator = invoice.creator
      const creatorRows = creator
        ? await db.rows<{ id: number }>(`SELECT id FROM users WHERE harvest_id = ?`, creator.id)
        : []
      const clientRows = await db.rows<{ id: number }>(
        `SELECT id FROM clients WHERE harvest_id = ?`,
        invoice.client.id,
      )
      const projectIds = new Map<number, number>()
      for (const line of invoice.line_items) {
        if (!line.project || projectIds.has(line.project.id)) continue
        const rows = await db.rows<{ id: number }>(
          `SELECT id FROM projects WHERE harvest_id = ?`,
          line.project.id,
        )
        const nativeId = rows[0]?.id
        if (nativeId === undefined) throw new Error(`missing project ${line.project.id}`)
        projectIds.set(line.project.id, nativeId)
      }
      await db.run(
        `INSERT INTO invoices
          (id, harvest_id, client_id, created_by_user_id, source_creator_id,
           source_creator_name, number, subject, purchase_order, notes, currency,
           issue_date, due_date, payment_terms, state,
           sent_at, paid_at, paid_date, closed_at, period_start, period_end,
           created_at, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        invoice.id,
        clientRows[0]?.id,
        creatorRows[0]?.id ?? null,
        creator?.id ?? null,
        creator?.name ?? null,
        invoice.number,
        invoice.subject,
        invoice.purchase_order,
        invoice.notes,
        invoice.currency,
        invoice.issue_date,
        invoice.due_date,
        paymentTerm(invoice.payment_term),
        invoice.state,
        invoice.sent_at,
        invoice.paid_at,
        invoice.paid_date,
        invoice.closed_at,
        invoice.period_start,
        invoice.period_end,
        invoice.created_at,
        invoice.updated_at,
      )
      for (const [position, line] of invoice.line_items.entries()) {
        await db.run(
          `INSERT INTO invoice_line_items
            (id, harvest_id, invoice_id, position, kind, description, quantity,
             unit_price_cents, amount_cents, taxed, taxed2, project_id, created_at, updated_at)
           VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          position + 1,
          line.id,
          position,
          line.kind,
          line.description,
          line.quantity,
          cents(line.unit_price),
          cents(line.amount),
          line.taxed ? 1 : 0,
          line.taxed2 ? 1 : 0,
          line.project ? projectIds.get(line.project.id) : null,
          invoice.created_at,
          invoice.updated_at,
        )
      }
      await db.run(
        `INSERT INTO invoice_messages
          (id, harvest_id, invoice_id, sent_by, sent_by_email, sent_from, sent_from_email,
           recipients, subject, body, attach_pdf, send_me_a_copy, thank_you, reminder,
           send_reminder_on, event_type, delivery_status, created_at, updated_at)
         VALUES (1, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        message.id,
        message.sent_by,
        message.sent_by_email,
        message.sent_from,
        message.sent_from_email,
        JSON.stringify(message.recipients),
        message.subject,
        message.body,
        message.attach_pdf ? 1 : 0,
        message.send_me_a_copy ? 1 : 0,
        message.thank_you ? 1 : 0,
        message.reminder ? 1 : 0,
        message.send_reminder_on,
        message.event_type,
        message.created_at,
        message.updated_at,
      )
      await db.migrateAgain()

      const storedInvoice = (
        await db.rows<Record<string, unknown>>(
          `SELECT harvest_id, client_id, created_by_user_id, source_creator_id,
            source_creator_name, number, subject, purchase_order, notes, currency,
            issue_date, due_date, payment_terms, state,
            sent_at, paid_at, paid_date, closed_at, period_start, period_end, project_id,
            client_key, created_at, updated_at
           FROM invoices WHERE id = 1`,
        )
      )[0]
      expect(storedInvoice).toMatchObject({
        harvest_id: invoice.id,
        client_id: clientRows[0]?.id,
        created_by_user_id: creatorRows[0]?.id,
        source_creator_id: creator?.id ?? null,
        source_creator_name: creator?.name,
        number: invoice.number,
        subject: invoice.subject,
        purchase_order: invoice.purchase_order,
        notes: invoice.notes,
        currency: invoice.currency,
        issue_date: invoice.issue_date,
        due_date: invoice.due_date,
        payment_terms: paymentTerm(invoice.payment_term),
        state: invoice.state,
        sent_at: invoice.sent_at,
        paid_at: invoice.paid_at,
        paid_date: invoice.paid_date,
        closed_at: invoice.closed_at,
        period_start: invoice.period_start,
        period_end: invoice.period_end,
        project_id: null,
        created_at: invoice.created_at,
        updated_at: invoice.updated_at,
      })
      expect(storedInvoice?.client_key).not.toBe(invoice.client_key)
      expect(storedInvoice?.client_key).toMatch(/^[0-9a-f]{64}$/)
      expect(
        await db.rows<Record<string, unknown>>(
          `SELECT harvest_id, position, kind, description, quantity, unit_price_cents,
            amount_cents, taxed, taxed2, project_id FROM invoice_line_items ORDER BY position`,
        ),
      ).toEqual(
        invoice.line_items.map((line, position) => ({
          harvest_id: line.id,
          position,
          kind: line.kind,
          description: line.description,
          quantity: line.quantity,
          unit_price_cents: cents(line.unit_price),
          amount_cents: cents(line.amount),
          taxed: line.taxed ? 1 : 0,
          taxed2: line.taxed2 ? 1 : 0,
          project_id: line.project ? projectIds.get(line.project.id) : null,
        })),
      )
      expect(
        await db.rows<Record<string, unknown>>(
          `SELECT harvest_id, sent_by, sent_by_email, sent_from, sent_from_email,
            recipients, subject, body, attach_pdf, send_me_a_copy, thank_you, reminder,
            send_reminder_on, event_type, delivery_status
           FROM invoice_messages WHERE id = 1`,
        ),
      ).toEqual([
        {
          harvest_id: message.id,
          sent_by: message.sent_by,
          sent_by_email: message.sent_by_email,
          sent_from: message.sent_from,
          sent_from_email: message.sent_from_email,
          recipients: JSON.stringify(message.recipients),
          subject: message.subject,
          body: message.body,
          attach_pdf: message.attach_pdf ? 1 : 0,
          send_me_a_copy: message.send_me_a_copy ? 1 : 0,
          thank_you: message.thank_you ? 1 : 0,
          reminder: message.reminder ? 1 : 0,
          send_reminder_on: message.send_reminder_on,
          event_type: message.event_type,
          delivery_status: null,
        },
      ])
      await expect(
        db.run(`UPDATE invoices SET source_creator_name = 'Changed' WHERE id = 1`),
      ).rejects.toThrow(/immutable/)
      await db.run(
        `UPDATE invoices SET source_creator_id = source_creator_id,
          source_creator_name = source_creator_name WHERE id = 1`,
      )
      await expect(
        db.run(
          `UPDATE invoice_messages SET sent_from_email = 'changed@example.invalid' WHERE id = 1`,
        ),
      ).rejects.toThrow(/exact import authority/)
      await db.run(
        `UPDATE invoice_messages SET sent_by = sent_by, sent_by_email = sent_by_email,
          sent_from = sent_from, sent_from_email = sent_from_email WHERE id = 1`,
      )
      await db.run(
        `UPDATE invoice_messages
         SET delivery_status = 'bounced', provider_message_id = 'provider-1' WHERE id = 1`,
      )
      expect(
        await db.rows<{ delivery_status: string; provider_message_id: string }>(
          `SELECT delivery_status, provider_message_id FROM invoice_messages WHERE id = 1`,
        ),
      ).toEqual([{ delivery_status: 'bounced', provider_message_id: 'provider-1' }])
    })

    it('[unit] keeps unresolved creator provenance and enforces the exact delivery status set', async () => {
      database = await factory(false)
      const db = database
      await installThrough0003(db)
      await installProjectsTimeFixture(db)
      await installInvoiceMigrationsThrough0005(db)
      await db.run(
        `INSERT INTO invoices
          (id, client_id, created_by_user_id, source_creator_id, source_creator_name,
           number, currency, issue_date, due_date, created_at, updated_at)
         VALUES (1, 1, NULL, 999999999, 'Deleted Harvest User',
           'INV-UNRESOLVED', 'USD', '2026-08-01', '2026-08-31', ?, ?)`,
        timestamp,
        timestamp,
      )
      expect(
        await db.rows<Record<string, unknown>>(
          `SELECT created_by_user_id, source_creator_id, source_creator_name FROM invoices`,
        ),
      ).toEqual([
        {
          created_by_user_id: null,
          source_creator_id: 999999999,
          source_creator_name: 'Deleted Harvest User',
        },
      ])
      await db.run(
        `INSERT INTO users
          (id, harvest_id, first_name, last_name, manager_grants, created_at, updated_at)
         VALUES (2, 1782960, 'Deleted', 'Creator', '[]', ?, ?)`,
        timestamp,
        timestamp,
      )
      await db.run(
        `INSERT INTO invoices
          (id, client_id, created_by_user_id, source_creator_id, source_creator_name,
           number, currency, issue_date, due_date, created_at, updated_at)
         VALUES (2, 1, 2, 1782960, 'Deleted Creator', 'INV-CREATOR-LIFECYCLE', 'USD',
           '2026-08-01', '2026-08-31', ?, ?)`,
        timestamp,
        timestamp,
      )
      await db.run(`DELETE FROM users WHERE id = 2`)
      expect(
        await db.rows<Record<string, unknown>>(
          `SELECT created_by_user_id, source_creator_id, source_creator_name
           FROM invoices WHERE id = 2`,
        ),
      ).toEqual([
        {
          created_by_user_id: null,
          source_creator_id: 1782960,
          source_creator_name: 'Deleted Creator',
        },
      ])
      const statuses = ['queued', 'sent', 'bounced', 'complained', 'failed'] as const
      for (const [index, status] of statuses.entries()) {
        await db.run(
          `INSERT INTO invoice_messages
            (id, invoice_id, recipients, delivery_status, created_at, updated_at)
           VALUES (?, 1, '[]', ?, ?, ?)`,
          index + 1,
          status,
          timestamp,
          timestamp,
        )
      }
      await expect(
        db.run(
          `INSERT INTO invoice_messages
            (id, invoice_id, recipients, delivery_status, created_at, updated_at)
           VALUES (99, 1, '[]', 'delivered', ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/CHECK constraint/i)
      await db.migrateAgain()
      expect(
        await db.rows<{ delivery_status: string }>(
          `SELECT delivery_status FROM invoice_messages ORDER BY id`,
        ),
      ).toEqual(statuses.map((delivery_status) => ({ delivery_status })))
      expect(
        (await db.rows<{ name: string }>(`PRAGMA table_info(event_outbox)`)).map(
          ({ name }) => name,
        ),
      ).not.toContain('delivery_status')
      expect(await db.rows(`PRAGMA foreign_key_check`)).toEqual([])
    })
  })
}

describe('invoice foundation package contract', () => {
  it('[unit] refuses to round Harvest money silently', () => {
    expect(cents(10.25)).toBe(1025)
    expect(() => cents(10.001)).toThrow(/at most two decimal places/)
  })

  it('[unit] keeps later money and attachment slices out of 0004 SQL', () => {
    const sql = invoiceFoundationMigration.join('\n').toLowerCase()
    for (const forbidden of [
      'create table expenses',
      'create table invoice_payments',
      'create table bank_deposits',
      'create table estimates',
      'create table retainers',
      'create table recurring_invoices',
      'create table file_objects',
      'create table attachments',
      'sender_identity_id',
      'retainer_id',
      'recurring_invoice_id',
      'estimate_id',
    ]) {
      expect(sql).not.toContain(forbidden)
    }
  })
})
