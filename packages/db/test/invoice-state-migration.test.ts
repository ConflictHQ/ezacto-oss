import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
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
  migrate(): Promise<void>
  close(): Promise<void>
}

const timestamp = '2026-08-27T00:00:00.000Z'
const migrationsThrough0005 = [
  ['0000_org_people', orgPeopleMigration],
  ['0001_clients', clientsMigration],
  ['0002_projects_time', projectsTimeMigration],
  ['0003_rate_resolver', rateResolverMigration],
  ['0004_invoice_foundation', invoiceFoundationMigration],
  ['0005_invoice_payments_totals', invoicePaymentsTotalsMigration],
] as const

const containerDatabase = (): TestDatabase => {
  const sqlite = new BetterSqlite3(':memory:')
  return {
    run: async (sql, ...params) => {
      sqlite.prepare(sql).run(...params)
    },
    rows: async <T>(sql: string, ...params: unknown[]) => sqlite.prepare(sql).all(...params) as T[],
    migrate: async () => migrateContainer(sqlite),
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
    migrate: async () => migrateD1(d1),
    close: async () => miniflare.dispose(),
  }
}

const factories = [
  ['container', async () => containerDatabase()],
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

const installBase = async (database: TestDatabase): Promise<void> => {
  await database.run(
    `INSERT INTO organizations (name, modules, created_at, updated_at)
     VALUES ('Sanitized Organization', '{"invoices":true}', ?, ?)`,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO clients (id, name, currency, created_at, updated_at)
     VALUES (1, 'Sanitized Client', 'USD', ?, ?)`,
    timestamp,
    timestamp,
  )
}

const insertInvoice = async (
  database: TestDatabase,
  id: number,
  state: 'draft' | 'open' | 'paid' | 'closed',
  paidAt: string | null = null,
  paidDate: string | null = null,
): Promise<void> => {
  await database.run(
    `INSERT INTO invoices (
      id, client_id, number, currency, issue_date, due_date, state, paid_at, paid_date,
      created_at, updated_at
    ) VALUES (?, 1, ?, 'USD', '2026-08-27', '2026-09-27', ?, ?, ?, ?, ?)`,
    id,
    `INV-${id}`,
    state,
    paidAt,
    paidDate,
    timestamp,
    timestamp,
  )
}

const insertPayment = async (
  database: TestDatabase,
  id: number,
  invoiceId: number,
): Promise<void> => {
  await database.run(
    `INSERT INTO invoice_payments (
      id, invoice_id, currency, amount_cents, paid_at, provider, provider_shape,
      created_at, updated_at
    ) VALUES (?, ?, 'USD', 100, ?, 'manual', 'manual', ?, ?)`,
    id,
    invoiceId,
    timestamp,
    timestamp,
    timestamp,
  )
}

for (const [runtime, factory] of factories) {
  describe(`invoice state migration (${runtime})`, () => {
    let database: TestDatabase | undefined

    afterEach(async () => database?.close())

    it('[unit] installs the 0006 schema on a fresh database', async () => {
      database = await factory()
      await database.migrate()

      expect(
        (await database.rows<{ name: string }>(`PRAGMA table_info(invoices)`)).map(
          ({ name }) => name,
        ),
      ).toEqual(expect.arrayContaining(['version', 'close_reason', 'close_write_off_cents']))
      expect(
        (await database.rows<{ name: string }>(`PRAGMA table_info(event_outbox)`)).map(
          ({ name }) => name,
        ),
      ).toEqual(expect.arrayContaining(['command_id', 'event_index']))
      expect(
        await database.rows<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'invoice_command_ledger'`,
        ),
      ).toEqual([{ name: 'invoice_command_ledger' }])
      expect(
        await database.rows<{ id: string }>(
          `SELECT id FROM _ezacto_migrations WHERE id = '0006_invoice_state_events'`,
        ),
      ).toEqual([{ id: '0006_invoice_state_events' }])
    })

    it('[unit] reports each stable preflight code before any 0006 schema write', async () => {
      database = await factory()
      await installThrough0005(database)
      await installBase(database)
      await insertInvoice(database, 1, 'draft')
      await insertInvoice(database, 2, 'paid', timestamp)
      await insertInvoice(database, 3, 'paid')
      await insertInvoice(database, 4, 'closed', timestamp, '2026-08-27')
      await insertInvoice(database, 5, 'open', timestamp)
      await insertInvoice(database, 6, 'open')
      await insertPayment(database, 1, 1)
      await insertPayment(database, 3, 3)
      await database.run(`UPDATE invoices SET reminder_policy = '{}' WHERE id = 6`)

      const assertFailure = async (code: string): Promise<void> => {
        await expect(database!.migrate()).rejects.toThrow(`code=${code}`)
        expect(
          (await database!.rows<{ name: string }>(`PRAGMA table_info(invoices)`)).map(
            ({ name }) => name,
          ),
        ).not.toContain('version')
        expect(
          await database!.rows<{ id: string }>(
            `SELECT id FROM _ezacto_migrations WHERE id = '0006_invoice_state_events'`,
          ),
        ).toEqual([])
      }

      await assertFailure('draft_has_payment')
      await database.run(`DELETE FROM invoice_payments WHERE invoice_id = 1`)
      await assertFailure('active_paid_state_mismatch')
      await database.run(`UPDATE invoices SET state = 'open', paid_at = NULL WHERE id = 2`)
      await assertFailure('paid_timestamp_missing')
      await database.run(`UPDATE invoices SET paid_at = ? WHERE id = 3`, timestamp)
      await assertFailure('paid_timestamp_conflict')
      await database.run(`UPDATE invoices SET paid_date = NULL WHERE id = 4`)
      await assertFailure('active_nonpaid_timestamp_present')
      await database.run(`UPDATE invoices SET paid_at = NULL WHERE id = 5`)
      await assertFailure('invalid_reminder_policy')
      await database.run(
        `UPDATE invoices
         SET reminder_policy = '{"first_after_days":3,"every_days":7}'
         WHERE id = 6`,
      )

      await database.migrate()
      expect(
        await database.rows<{ id: number; close_reason: string | null }>(
          `SELECT id, close_reason FROM invoices WHERE id = 4`,
        ),
      ).toEqual([{ id: 4, close_reason: 'source_closed' }])
    })

    it('[unit] preserves history, rolls back a late failure, and retries cleanly', async () => {
      database = await factory()
      await installThrough0005(database)
      await installBase(database)
      await insertInvoice(database, 1, 'open')
      await database.run(
        `INSERT INTO invoice_messages (
          id, invoice_id, recipients, event_type, created_at, updated_at
        ) VALUES (1, 1, '[]', 'close', ?, ?)`,
        timestamp,
        timestamp,
      )
      await database.run(
        `INSERT INTO event_outbox (
          id, aggregate_type, aggregate_id, aggregate_sequence, event_type,
          payload_json, occurred_at, available_at
        ) VALUES ('historical-1', 'invoice', 1, 1, 'invoice.sent', '{}', ?, ?)`,
        timestamp,
        timestamp,
      )
      await database.run(
        `CREATE TRIGGER invoices_d22_closed_financials_update
         AFTER UPDATE ON invoices BEGIN SELECT 1; END`,
      )

      await expect(database.migrate()).rejects.toThrow()
      expect(
        (await database.rows<{ name: string }>(`PRAGMA table_info(invoices)`)).map(
          ({ name }) => name,
        ),
      ).not.toContain('version')
      expect(
        await database.rows<{ id: string }>(
          `SELECT id FROM _ezacto_migrations WHERE id = '0006_invoice_state_events'`,
        ),
      ).toEqual([])

      await database.run(`DROP TRIGGER invoices_d22_closed_financials_update`)
      await database.migrate()
      expect(
        await database.rows<{ id: string; command_id: string | null; event_index: number | null }>(
          `SELECT id, command_id, event_index FROM event_outbox`,
        ),
      ).toEqual([{ id: 'historical-1', command_id: null, event_index: null }])
      expect(
        await database.rows<{ count: number }>(`SELECT count(*) AS count FROM event_outbox`),
      ).toEqual([{ count: 1 }])
      expect(await database.rows(`PRAGMA foreign_key_check`)).toEqual([])
    })

    it('[unit] preserves the narrow imported-payment recorder enrichment lane', async () => {
      database = await factory()
      await installThrough0005(database)
      await installBase(database)
      await database.run(
        `INSERT INTO users
          (id, first_name, last_name, manager_grants, created_at, updated_at)
         VALUES
          (1, 'Owner', 'User', '[]', ?, ?),
          (2, 'Recorder', 'User', '[]', ?, ?)`,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
      )
      await database.run(
        `INSERT INTO invoices (
          id, harvest_id, client_id, number, currency, issue_date, due_date, state,
          source_updated_at, created_at, updated_at
        ) VALUES (
          1, 7001, 1, 'INV-RECORDER', 'USD', '2026-08-01', '2026-08-31', 'open',
          ?, ?, ?
        )`,
        timestamp,
        timestamp,
        timestamp,
      )
      await database.run(
        `INSERT INTO invoice_line_items (
          id, harvest_id, invoice_id, position, kind, quantity, unit_price_cents,
          amount_cents, created_at, updated_at
        ) VALUES (1, 8001, 1, 0, 'Service', 1, 100, 100, ?, ?)`,
        timestamp,
        timestamp,
      )
      await database.run(
        `INSERT INTO invoice_payments (
          id, harvest_id, invoice_id, currency, amount_cents, paid_at, source_paid_at,
          provider, provider_shape, created_at, updated_at
        ) VALUES (1, 9001, 1, 'USD', 50, ?, ?, 'manual', 'manual', ?, ?)`,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
      )
      await database.migrate()

      await database.run(`UPDATE invoice_payments SET recorded_by_user_id = 2 WHERE id = 1`)
      expect(
        await database.rows<{ recorded_by_user_id: number | null }>(
          `SELECT recorded_by_user_id FROM invoice_payments WHERE id = 1`,
        ),
      ).toEqual([{ recorded_by_user_id: 2 }])

      await database.run(`DELETE FROM users WHERE id = 2`)
      expect(
        await database.rows<{ recorded_by_user_id: number | null }>(
          `SELECT recorded_by_user_id FROM invoice_payments WHERE id = 1`,
        ),
      ).toEqual([{ recorded_by_user_id: null }])
      await expect(
        database.run(`UPDATE invoice_payments SET notes = 'raw mutation' WHERE id = 1`),
      ).rejects.toThrow(/pending command|immutable|exact import authority/)
    })

    it('[unit] guards source-owned imported messages but permits provider delivery fields', async () => {
      database = await factory()
      await installThrough0005(database)
      await installBase(database)
      await database.run(
        `INSERT INTO invoices (
          id, harvest_id, client_id, number, currency, issue_date, due_date, state,
          source_updated_at, created_at, updated_at
        ) VALUES (
          1, 7001, 1, 'INV-MESSAGE', 'USD', '2026-08-01', '2026-08-31', 'open',
          ?, ?, ?
        )`,
        timestamp,
        timestamp,
        timestamp,
      )
      await database.run(
        `INSERT INTO invoice_messages (
          id, harvest_id, invoice_id, recipients, subject, body, created_at, updated_at
        ) VALUES (1, 8001, 1, '[]', 'Source subject', 'Source body', ?, ?)`,
        timestamp,
        timestamp,
      )
      await database.migrate()

      await database.run(
        `UPDATE invoice_messages
         SET delivery_status = 'sent', provider_message_id = 'provider-1'
         WHERE id = 1`,
      )
      expect(
        await database.rows<{ delivery_status: string; provider_message_id: string }>(
          `SELECT delivery_status, provider_message_id FROM invoice_messages WHERE id = 1`,
        ),
      ).toEqual([{ delivery_status: 'sent', provider_message_id: 'provider-1' }])
      await expect(
        database.run(`UPDATE invoice_messages SET subject = 'Raw subject' WHERE id = 1`),
      ).rejects.toThrow(/exact import authority/)
      await expect(
        database.run(
          `UPDATE invoice_messages SET updated_at = '2026-08-27T00:00:00.001Z' WHERE id = 1`,
        ),
      ).rejects.toThrow(/exact import authority/)
      await expect(database.run(`DELETE FROM invoice_messages WHERE id = 1`)).rejects.toThrow(
        /exact import authority/,
      )
      await expect(
        database.run(
          `INSERT INTO invoice_messages (
            id, harvest_id, invoice_id, recipients, created_at, updated_at
          ) VALUES (2, 8002, 1, '[]', ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/exact pending authority/)
    })

    it('[unit] rejects a forged import receipt that omits the exact payment manifest', async () => {
      database = await factory()
      await database.migrate()
      await installBase(database)
      await database.run(
        `INSERT INTO invoices (
          id, harvest_id, client_id, number, currency, issue_date, due_date, state,
          close_reason, closed_at, source_updated_at, created_at, updated_at
        ) VALUES (
          1, 7001, 1, 'INV-IMPORT', 'USD', '2026-08-01', '2026-08-31', 'closed',
          'source_closed', ?, ?, ?, ?
        )`,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
      )

      await expect(
        database.run(
          `UPDATE invoices SET paid_at = ?, source_updated_at = ?, updated_at = ? WHERE id = 1`,
          timestamp,
          '2026-08-27T00:00:00.001Z',
          '2026-08-27T00:00:00.001Z',
        ),
      ).rejects.toThrow(/pending command/)
      await expect(
        database.run(
          `INSERT INTO invoice_payments (
            id, invoice_id, currency, amount_cents, paid_at, provider, provider_shape,
            created_at, updated_at
          ) VALUES (1, 1, 'USD', 100, ?, 'manual', 'manual', ?, ?)`,
          timestamp,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/pending command/)

      const sourceUpdatedAt = '2026-08-27T00:00:00.001Z'
      await database.run(
        `INSERT INTO invoice_import_reconciliations (
          invoice_id, source_updated_at, expected_source_updated_at, input_fingerprint,
          source_manifest_json, source_manifest_hash,
          line_manifest_json, line_manifest_hash,
          message_manifest_json, message_manifest_hash,
          payment_manifest_json, payment_manifest_hash,
          source_state, target_state, target_version, target_updated_at,
          target_close_reason, target_close_write_off_cents, target_written_off_cents,
          target_sent_at, target_paid_at, target_paid_date, target_closed_at,
          outbox_count_before
        ) VALUES (
          1, ?, ?, ?, ?, ?, '[]', ?, '[]', ?, '[]', ?,
          'closed', 'closed', 1, ?, 'source_closed', 0, 0,
          NULL, NULL, NULL, ?, 0
        )`,
        sourceUpdatedAt,
        timestamp,
        `sha256:${'0'.repeat(64)}`,
        JSON.stringify({ invoice_id: 1, source_updated_at: sourceUpdatedAt }),
        `sha256:${'1'.repeat(64)}`,
        `sha256:${'2'.repeat(64)}`,
        `sha256:${'3'.repeat(64)}`,
        `sha256:${'4'.repeat(64)}`,
        sourceUpdatedAt,
        timestamp,
      )
      await expect(
        database.run(
          `INSERT INTO invoice_payments (
            id, harvest_id, invoice_id, currency, amount_cents, paid_at, source_paid_at,
            provider, provider_shape, created_at, updated_at
          ) VALUES (1, 9001, 1, 'USD', 100, ?, ?, 'manual', 'manual', ?, ?)`,
          timestamp,
          timestamp,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/pending command|exact pending authority/)
      await expect(
        database.run(
          `INSERT INTO invoice_line_items (
            id, harvest_id, invoice_id, position, kind, quantity, unit_price_cents,
            amount_cents, created_at, updated_at
          ) VALUES (1, 8001, 1, 0, 'Service', 1, 100, 100, ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/pending command/)
      await expect(
        database.run(
          `INSERT INTO invoice_messages (
            id, harvest_id, invoice_id, recipients, created_at, updated_at
          ) VALUES (1, 8101, 1, '[]', ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/exact pending authority/)
      await expect(
        database.run(
          `UPDATE invoices
           SET close_reason = 'cancelled', source_updated_at = ?, updated_at = ?
           WHERE id = 1`,
          sourceUpdatedAt,
          sourceUpdatedAt,
        ),
      ).rejects.toThrow(/pending command/)
      expect(
        await database.rows<{ payments: number; lines: number; messages: number; outbox: number }>(
          `SELECT (SELECT count(*) FROM invoice_payments) AS payments,
             (SELECT count(*) FROM invoice_line_items) AS lines,
             (SELECT count(*) FROM invoice_messages) AS messages,
             (SELECT count(*) FROM event_outbox) AS outbox`,
        ),
      ).toEqual([{ payments: 0, lines: 0, messages: 0, outbox: 0 }])
    })
  })
}
