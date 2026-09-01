import BetterSqlite3 from 'better-sqlite3'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { calculateInvoiceLineAmountCents } from '@ezacto/core'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import {
  createInvoiceGenerationService,
  maximumGenerationManifestBytes,
  maximumGenerationSourceRows,
  type InvoiceGenerationDatabase,
  type InvoiceGenerationError,
} from '../src/invoice-generation.js'
import {
  migrateContainer,
  migrateContainerThrough,
  migrateD1,
  migrateD1Through,
} from '../src/migrate.js'
import { createReportRepository } from '../src/reports.js'

interface TestDatabase {
  orm: InvoiceGenerationDatabase
  run(sql: string, ...params: unknown[]): Promise<void>
  rows<T>(sql: string, ...params: unknown[]): Promise<T[]>
  migrate(): Promise<void>
  migrateThrough(id: '0025_time_entry_note_requirements'): Promise<void>
  close(): Promise<void>
}

const occurredAt = '2026-08-31T12:00:00.000Z'
const request = {
  clientId: 1,
  from: '2026-08-01',
  to: '2026-08-31',
  projectIds: [1],
  timeSummaryType: 'task',
  expenseSummaryType: 'category',
} as const
const principal = { userId: 1, profile: 'administrator' }

const containerDatabaseFrom = (client: BetterSqlite3.Database): TestDatabase => {
  return {
    orm: createContainerDatabase(client),
    run: async (sql, ...params) => {
      client.prepare(sql).run(...params)
    },
    rows: async <T>(sql: string, ...params: unknown[]) => client.prepare(sql).all(...params) as T[],
    migrate: async () => migrateContainer(client),
    migrateThrough: async (id) => migrateContainerThrough(client, id),
    close: async () => {
      client.close()
    },
  }
}

const containerDatabase = (migrate = true): TestDatabase => {
  const client = new BetterSqlite3(':memory:')
  if (migrate) migrateContainer(client)
  return containerDatabaseFrom(client)
}

const d1Database = async (migrate = true): Promise<TestDatabase> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const client = await miniflare.getD1Database('DB')
  if (migrate) await migrateD1(client)
  return {
    orm: createD1Database(client),
    run: async (sql, ...params) => {
      await client
        .prepare(sql)
        .bind(...params)
        .run()
    },
    rows: async <T>(sql: string, ...params: unknown[]) =>
      (
        await client
          .prepare(sql)
          .bind(...params)
          .all<T>()
      ).results,
    migrate: async () => migrateD1(client),
    migrateThrough: async (id) => migrateD1Through(client, id),
    close: async () => miniflare.dispose(),
  }
}

const factories = [
  ['container', async (migrate = true) => containerDatabase(migrate)],
  ['D1', d1Database],
] as const

const seed = async (database: TestDatabase): Promise<void> => {
  await database.run(
    `INSERT INTO organizations (id, name, modules, created_at, updated_at)
     VALUES (1, 'Generation Org', ?, ?, ?)`,
    JSON.stringify({ expenses: true, invoices: true }),
    occurredAt,
    occurredAt,
  )
  await database.run(
    `INSERT INTO users (
       id, first_name, last_name, profile, manager_grants, created_at, updated_at
     ) VALUES
       (1, 'Invoice', 'Owner', 'administrator', '[]', ?, ?),
       (2, 'Tracked', 'Person', 'member', '[]', ?, ?)`,
    occurredAt,
    occurredAt,
    occurredAt,
    occurredAt,
  )
  await database.run(
    `INSERT INTO clients (id, name, currency, payment_terms, created_at, updated_at)
     VALUES (1, 'Generation Client', 'USD', 'net_30', ?, ?)`,
    occurredAt,
    occurredAt,
  )
  await database.run(
    `INSERT INTO projects (
       id, client_id, name, code, hourly_rate_cents, created_at, updated_at
     ) VALUES (1, 1, 'Generation Project', 'GEN', 10001, ?, ?)`,
    occurredAt,
    occurredAt,
  )
  await database.run(
    `INSERT INTO tasks (id, name, created_at, updated_at)
     VALUES (1, 'Design', ?, ?), (2, 'Review', ?, ?)`,
    occurredAt,
    occurredAt,
    occurredAt,
    occurredAt,
  )
  await database.run(
    `INSERT INTO user_assignments (id, project_id, user_id, created_at, updated_at)
     VALUES (1, 1, 2, ?, ?)`,
    occurredAt,
    occurredAt,
  )
  await database.run(
    `INSERT INTO task_assignments (
       id, project_id, task_id, billable, created_at, updated_at
     ) VALUES (1, 1, 1, 1, ?, ?), (2, 1, 2, 1, ?, ?)`,
    occurredAt,
    occurredAt,
    occurredAt,
    occurredAt,
  )
  await database.run(
    `INSERT INTO time_entries (
       id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
       spent_date, seconds, seconds_without_timer, rounded_seconds, notes, billable,
       billable_rate_cents, cost_rate_cents, created_at, updated_at
     ) VALUES
       (1, 2, 1, 1, 1, 1, '2026-08-10', 1800, 1800, 1800, 'Design notes', 1,
        10001, 5000, ?, ?),
       (2, 2, 1, 2, 1, 2, '2026-08-11', 900, 900, 900, 'Review notes', 1,
        10000, 5000, ?, ?)`,
    occurredAt,
    occurredAt,
    occurredAt,
    occurredAt,
  )
  await database.run(
    `INSERT INTO expense_categories (id, name, created_at, updated_at)
     VALUES (1, 'Travel', ?, ?)`,
    occurredAt,
    occurredAt,
  )
  await database.run(
    `INSERT INTO expenses (
       id, user_id, project_id, expense_category_id, spent_date, notes,
       total_cost_cents, billable, created_at, updated_at
     ) VALUES (1, 2, 1, 1, '2026-08-12', 'Train', 333, 1, ?, ?)`,
    occurredAt,
    occurredAt,
  )
}

const generator = (database: TestDatabase) =>
  createInvoiceGenerationService(database.orm, { clock: () => occurredAt })

const command = (commandId: string) => ({ commandId, principal, request })

for (const [runtime, factory] of factories) {
  describe(`transactional invoice generation (${runtime})`, () => {
    let active: TestDatabase | undefined
    afterEach(async () => {
      await active?.close()
      active = undefined
    })

    const setup = async (): Promise<TestDatabase> => {
      active = await factory()
      await seed(active)
      return active
    }

    it('[unit] concurrently generates one complete invoice and never double bills source rows', async () => {
      const database = await setup()
      const service = generator(database)
      const [first, replay] = await Promise.all([
        service.generate(command('same-generation-command')),
        service.generate(command('same-generation-command')),
      ])

      expect(replay).toEqual(first)
      expect(first).toMatchObject({
        client_id: 1,
        currency: 'USD',
        state: 'draft',
        version: 0,
        amount_cents: 7_834,
        due_amount_cents: 7_834,
      })
      expect(first.line_items).toHaveLength(3)
      expect(first.line_items.map(({ description }) => description)).toEqual([
        'Generation Project — Design',
        'Generation Project — Review',
        'Generation Project — Travel',
      ])
      expect(
        await database.rows(
          `SELECT
             (SELECT count(*) FROM invoices) AS invoices,
             (SELECT count(*) FROM invoice_line_items) AS lines,
             (SELECT count(*) FROM time_entries WHERE invoice_id IS NOT NULL) AS timeEntries,
             (SELECT count(*) FROM expenses WHERE invoice_id IS NOT NULL) AS expenses,
             (SELECT count(*) FROM invoice_command_ledger
               WHERE command_kind = 'invoice.create' AND completed = 1) AS receipts,
             (SELECT count(*) FROM event_outbox
               WHERE event_type = 'invoice.created') AS createdEvents,
             (SELECT count(*) FROM event_outbox
               WHERE event_type = 'invoice.updated') AS updatedEvents`,
        ),
      ).toEqual([
        {
          invoices: 1,
          lines: 3,
          timeEntries: 2,
          expenses: 1,
          receipts: 1,
          createdEvents: 1,
          updatedEvents: 0,
        },
      ])
    })

    it('[unit] [inv-11] equals the uninvoiced report to the cent for the identical filter', async () => {
      const database = await setup()
      const preview = await createReportRepository(database.orm).uninvoiced({
        clientId: 1,
        projectId: 1,
        from: request.from,
        to: request.to,
      })
      const invoice = await generator(database).generate(command('report-parity'))

      expect(preview.totals).toEqual([
        expect.objectContaining({
          currency: 'USD',
          timeCents: 7_501,
          expenseCents: 333,
          totalCents: 7_834,
        }),
      ])
      expect(invoice.amount_cents).toBe(preview.totals[0]!.totalCents)
      expect(invoice.line_items.reduce((sum, line) => sum + line.amount_cents, 0)).toBe(
        preview.totals[0]!.totalCents,
      )
    })

    it('[unit] [inv-11] reconciles every client report currency to generated invoices', async () => {
      const database = await setup()
      await database.run(
        `INSERT INTO projects (
           id, client_id, name, code, hourly_rate_cents, billing_currency,
           created_at, updated_at
         ) VALUES (2, 1, 'Euro Project', 'EUR', 9001, 'EUR', ?, ?)`,
        occurredAt,
        occurredAt,
      )
      await database.run(
        `INSERT INTO user_assignments (id, project_id, user_id, created_at, updated_at)
         VALUES (2, 2, 2, ?, ?)`,
        occurredAt,
        occurredAt,
      )
      await database.run(
        `INSERT INTO task_assignments (
           id, project_id, task_id, billable, created_at, updated_at
         ) VALUES (3, 2, 1, 1, ?, ?)`,
        occurredAt,
        occurredAt,
      )
      await database.run(
        `INSERT INTO time_entries (
           id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
           spent_date, seconds, seconds_without_timer, rounded_seconds, billable,
           billable_rate_cents, cost_rate_cents, created_at, updated_at
         ) VALUES (3, 2, 2, 1, 2, 3, '2026-08-13', 1200, 1200, 1200, 1,
           9001, 5000, ?, ?)`,
        occurredAt,
        occurredAt,
      )
      await database.run(
        `INSERT INTO expenses (
           id, user_id, project_id, expense_category_id, spent_date, notes,
           total_cost_cents, billable, created_at, updated_at
         ) VALUES (2, 2, 2, 1, '2026-08-14', 'Euro train', 222, 1, ?, ?)`,
        occurredAt,
        occurredAt,
      )

      const report = await createReportRepository(database.orm).uninvoiced({
        clientId: 1,
        from: request.from,
        to: request.to,
      })
      const usdInvoice = await generator(database).generate(command('report-parity-usd'))
      const eurInvoice = await generator(database).generate({
        commandId: 'report-parity-eur',
        principal,
        request: { ...request, projectIds: [2] },
      })

      expect(report.totals).toEqual([
        expect.objectContaining({
          currency: 'EUR',
          timeCents: 3_000,
          expenseCents: 222,
          totalCents: 3_222,
        }),
        expect.objectContaining({
          currency: 'USD',
          timeCents: 7_501,
          expenseCents: 333,
          totalCents: 7_834,
        }),
      ])
      expect(
        new Map([
          [eurInvoice.currency, eurInvoice.amount_cents],
          [usdInvoice.currency, usdInvoice.amount_cents],
        ]),
      ).toEqual(new Map(report.totals.map((total) => [total.currency, total.totalCents])))
    })

    it('[unit] lets one different command win the same filter and rolls the loser back', async () => {
      const database = await setup()
      const service = generator(database)
      const results = await Promise.allSettled([
        service.generate(command('generation-race-a')),
        service.generate(command('generation-race-b')),
      ])

      expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
      const rejected = results.find(({ status }) => status === 'rejected')
      expect(rejected).toMatchObject({
        status: 'rejected',
        reason: expect.objectContaining<Partial<InvoiceGenerationError>>({
          code: 'generation_conflict',
        }),
      })
      expect(await database.rows('SELECT count(*) AS count FROM invoices')).toEqual([{ count: 1 }])
      expect(
        await database.rows('SELECT count(*) AS count FROM event_outbox'),
      ).toEqual([{ count: 1 }])
      expect(
        await database.rows(
          `SELECT count(*) AS count FROM time_entries WHERE invoice_id IS NOT NULL`,
        ),
      ).toEqual([{ count: 2 }])
    })

    it('[unit] rolls invoice, lines, claims, receipt, and event back on a late failure', async () => {
      const database = await setup()
      await database.run(
        `CREATE TRIGGER fail_generated_event BEFORE INSERT ON event_outbox
         WHEN NEW.event_type = 'invoice.created'
         BEGIN SELECT RAISE(ABORT, 'injected generation failure'); END`,
      )

      await expect(generator(database).generate(command('late-failure'))).rejects.toThrow(
        'injected generation failure',
      )
      expect(
        await database.rows(
          `SELECT
             (SELECT count(*) FROM invoices) AS invoices,
             (SELECT count(*) FROM invoice_line_items) AS lines,
             (SELECT count(*) FROM invoice_command_ledger) AS receipts,
             (SELECT count(*) FROM event_outbox) AS events,
             (SELECT count(*) FROM time_entries WHERE invoice_id IS NOT NULL) AS timeEntries,
             (SELECT count(*) FROM expenses WHERE invoice_id IS NOT NULL) AS expenses`,
        ),
      ).toEqual([
        { invoices: 0, lines: 0, receipts: 0, events: 0, timeEntries: 0, expenses: 0 },
      ])
    })

    it('[unit] rolls everything back when one source claim is ignored', async () => {
      const database = await setup()
      await database.run(
        `CREATE TRIGGER ignore_one_generation_claim
         BEFORE UPDATE OF invoice_id ON time_entries
         WHEN OLD.id = 2 AND NEW.invoice_id IS NOT NULL
         BEGIN SELECT RAISE(IGNORE); END`,
      )

      await expect(generator(database).generate(command('partial-claim'))).rejects.toThrow(
        'invoice creation time entries do not match their manifest',
      )
      expect(
        await database.rows(
          `SELECT
             (SELECT count(*) FROM invoices) AS invoices,
             (SELECT count(*) FROM invoice_line_items) AS lines,
             (SELECT count(*) FROM invoice_command_ledger) AS receipts,
             (SELECT count(*) FROM event_outbox) AS events,
             (SELECT count(*) FROM time_entries WHERE invoice_id IS NOT NULL) AS timeEntries,
             (SELECT count(*) FROM expenses WHERE invoice_id IS NOT NULL) AS expenses`,
        ),
      ).toEqual([
        { invoices: 0, lines: 0, receipts: 0, events: 0, timeEntries: 0, expenses: 0 },
      ])
    })

    it('[unit] allocates ordered numeric invoice numbers and preserves them on retry', async () => {
      const database = await setup()
      await database.run(
        `INSERT INTO invoices (
           id, client_id, number, currency, issue_date, due_date, payment_terms,
           created_at, updated_at
         ) VALUES (99, 1, '41', 'USD', '2026-08-01', '2026-08-01', 'upon_receipt', ?, ?)`,
        occurredAt,
        occurredAt,
      )

      const service = generator(database)
      const first = await service.generate(command('number-sequence-first'))
      await database.run(
        `INSERT INTO time_entries (
           id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
           spent_date, seconds, seconds_without_timer, rounded_seconds, billable,
           billable_rate_cents, cost_rate_cents, created_at, updated_at
         ) VALUES (3, 2, 1, 1, 1, 1, '2026-08-20', 3600, 3600, 3600, 1,
           10001, 5000, ?, ?)`,
        occurredAt,
        occurredAt,
      )
      const second = await service.generate({
        commandId: 'number-sequence-second',
        principal,
        request: { ...request, expenseSummaryType: null },
      })
      const replay = await service.generate(command('number-sequence-first'))

      expect([first.number, second.number]).toEqual(['42', '43'])
      expect(replay.number).toBe('42')
      expect(
        await database.rows('SELECT next_number AS nextNumber FROM invoice_number_sequence'),
      ).toEqual([{ nextNumber: 44 }])
    })

    it('[unit] uses the sole project billing currency instead of the client default', async () => {
      const database = await setup()
      await database.run(`UPDATE projects SET billing_currency = 'EUR' WHERE id = 1`)

      const invoice = await generator(database).generate(command('project-currency'))
      expect(invoice.currency).toBe('EUR')
      expect(invoice.amount_cents).toBe(7_834)
    })

    it('[unit] groups both time and expenses by project', async () => {
      const database = await setup()
      await database.run(`UPDATE expenses SET total_cost_cents = 100 WHERE id = 1`)
      await database.run(
        `INSERT INTO expenses (
           id, user_id, project_id, expense_category_id, spent_date, notes,
           total_cost_cents, billable, created_at, updated_at
         ) VALUES (2, 2, 1, 1, '2026-08-13', 'Bus', 101, 1, ?, ?)`,
        occurredAt,
        occurredAt,
      )
      const invoice = await generator(database).generate({
        commandId: 'project-summaries',
        principal,
        request: {
          ...request,
          timeSummaryType: 'project',
          expenseSummaryType: 'project',
        },
      })

      expect(invoice.line_items.map(({ kind, description }) => ({ kind, description }))).toEqual([
        { kind: 'Service', description: 'Generation Project' },
        { kind: 'Expense', description: 'Generation Project' },
      ])
      expect(invoice.line_items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'Expense',
            quantity: 1,
            unit_price_cents: 201,
            amount_cents: 201,
          }),
        ]),
      )
      for (const line of invoice.line_items) {
        expect(calculateInvoiceLineAmountCents(line.quantity, line.unit_price_cents)).toBe(
          line.amount_cents,
        )
      }
    })

    it('[unit] rejects a positive-net group containing a report-invalid negative expense', async () => {
      const database = await setup()
      await database.run(
        `INSERT INTO expenses (
           id, user_id, project_id, expense_category_id, spent_date, notes,
           total_cost_cents, billable, created_at, updated_at
         ) VALUES (2, 2, 1, 1, '2026-08-13', 'Historical credit', -100, 1, ?, ?)`,
        occurredAt,
        occurredAt,
      )

      await expect(
        generator(database).generate({
          commandId: 'negative-expense-group',
          principal,
          request: {
            ...request,
            timeSummaryType: null,
            expenseSummaryType: 'project',
          },
        }),
      ).rejects.toMatchObject({
        code: 'invalid_command_input',
        message: 'expense cents must be a non-negative safe integer',
      })
      expect(await database.rows('SELECT count(*) AS count FROM invoices')).toEqual([{ count: 0 }])
    })

    it('[unit] groups both time and expenses by person', async () => {
      const database = await setup()
      const invoice = await generator(database).generate({
        commandId: 'people-summaries',
        principal,
        request: {
          ...request,
          timeSummaryType: 'people',
          expenseSummaryType: 'people',
        },
      })

      expect(invoice.line_items.map(({ kind, description }) => ({ kind, description }))).toEqual([
        { kind: 'Service', description: 'Generation Project — Tracked Person' },
        { kind: 'Expense', description: 'Generation Project — Tracked Person' },
      ])
    })

    it('[unit] creates detailed time and expense lines with their immutable notes', async () => {
      const database = await setup()
      const invoice = await generator(database).generate({
        commandId: 'detailed-summaries',
        principal,
        request: {
          ...request,
          timeSummaryType: 'detailed',
          expenseSummaryType: 'detailed',
        },
      })

      expect(invoice.line_items.map(({ description }) => description)).toEqual([
        '2026-08-10 · Tracked Person · Generation Project · Design\nDesign notes',
        '2026-08-11 · Tracked Person · Generation Project · Review\nReview notes',
        '2026-08-12 · Tracked Person · Generation Project · Travel\nTrain',
      ])
    })

    it('[unit] rejects a grouped duration whose sum exceeds a safe integer', async () => {
      const database = await setup()
      await database.run(
        `UPDATE time_entries
         SET rounded_seconds = 9007199254740991, billable_rate_cents = 0`,
      )

      await expect(
        generator(database).generate({
          commandId: 'duration-overflow',
          principal,
          request: {
            ...request,
            timeSummaryType: 'project',
            expenseSummaryType: null,
          },
        }),
      ).rejects.toMatchObject({
        code: 'invalid_command_input',
        message: 'rounded seconds exceeds the supported aggregate range',
      })
      expect(await database.rows('SELECT count(*) AS count FROM invoices')).toEqual([{ count: 0 }])
    })

    it('[unit] upgrades 0025 data and installs real invoice.create event authority', async () => {
      active = await factory(false)
      await active.migrateThrough('0025_time_entry_note_requirements')
      await seed(active)
      await active.migrate()

      const invoice = await generator(active).generate(command('upgrade-generation'))
      expect(invoice.amount_cents).toBe(7_834)
      expect(
        await active.rows<{ sql: string }>(
          `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'invoice_command_ledger'`,
        ),
      ).toEqual([expect.objectContaining({ sql: expect.stringContaining("'invoice.create'") })])
      expect(
        await active.rows<{ sql: string }>(
          `SELECT sql FROM sqlite_master
           WHERE type = 'trigger' AND name = 'invoices_d22_transition_guard'`,
        ),
      ).toEqual([
        expect.objectContaining({
          sql: expect.stringContaining('invoice_command_ledger command'),
        }),
      ])
      expect(
        await active.rows<{ count: number }>(
          `SELECT count(*) AS count FROM sqlite_master
           WHERE type = 'trigger' AND sql LIKE '%invoice_command_ledger_0025%'`,
        ),
      ).toEqual([{ count: 0 }])
      expect(
        await active.rows('SELECT event_type AS eventType FROM event_outbox'),
      ).toEqual([{ eventType: 'invoice.created' }])
    })

    it('[unit] rejects invoice.create manifests with missing required keys', async () => {
      const database = await setup()
      await expect(
        database.run(
          `INSERT INTO invoice_command_ledger (
             invoice_id, command_id, command_kind, input_fingerprint, actor_type, actor_id,
             expected_invoice_version, occurred_at, request_json, source_manifest_json,
             line_manifest_json
           ) VALUES (500, 'malformed-manifest', 'invoice.create', ?, 'user', 1, 0, ?, ?, ?, ?)`,
          `sha256:${'0'.repeat(64)}`,
          occurredAt,
          JSON.stringify({ schema_version: 1, expected_version: 0 }),
          JSON.stringify({ schema_version: 1, time_entries: [], expenses: [] }),
          JSON.stringify({ schema_version: 1, lines: [] }),
        ),
      ).rejects.toThrow()
      expect(await database.rows('SELECT count(*) AS count FROM invoice_command_ledger')).toEqual([
        { count: 0 },
      ])
    })

    it('[unit] uses a fixed small batch beyond D1 parameter and free-query thresholds', async () => {
      const database = await setup()
      await database.run('DELETE FROM time_entries')
      await database.run('DELETE FROM expenses')
      await database.run(
        `WITH RECURSIVE ids(id) AS (
           SELECT 1 UNION ALL SELECT id + 1 FROM ids WHERE id < 101
         ) INSERT INTO time_entries (
           id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
           spent_date, seconds, seconds_without_timer, rounded_seconds, billable,
           billable_rate_cents, cost_rate_cents, created_at, updated_at
         ) SELECT id, 2, 1, 1, 1, 1, '2026-08-15', 60, 60, 60, 1, 6000, 3000, ?, ?
         FROM ids`,
        occurredAt,
        occurredAt,
      )

      const invoice = await generator(database).generate({
        commandId: 'set-based-generation',
        principal,
        request: { ...request, timeSummaryType: 'detailed', expenseSummaryType: null },
      })
      expect(invoice.line_items).toHaveLength(101)
      expect(invoice.amount_cents).toBe(10_100)
      expect(
        await database.rows('SELECT count(*) AS count FROM time_entries WHERE invoice_id = ?', invoice.id),
      ).toEqual([{ count: 101 }])
      expect(maximumGenerationSourceRows).toBeGreaterThanOrEqual(101)
    })

    it('[unit] preserves numeric source order for 2-versus-10 grouping keys', async () => {
      const database = await setup()
      await database.run('DELETE FROM time_entries')
      await database.run('DELETE FROM expenses')
      await database.run(
        `INSERT INTO projects (
           id, client_id, name, code, hourly_rate_cents, created_at, updated_at
         ) VALUES
           (2, 1, 'Project Two', 'TWO', 6000, ?, ?),
           (10, 1, 'Project Ten', 'TEN', 6000, ?, ?)`,
        occurredAt,
        occurredAt,
        occurredAt,
        occurredAt,
      )
      await database.run(
        `INSERT INTO user_assignments (id, project_id, user_id, created_at, updated_at)
         VALUES (20, 2, 2, ?, ?), (100, 10, 2, ?, ?)`,
        occurredAt,
        occurredAt,
        occurredAt,
        occurredAt,
      )
      await database.run(
        `INSERT INTO task_assignments (
           id, project_id, task_id, billable, created_at, updated_at
         ) VALUES (20, 2, 1, 1, ?, ?), (100, 10, 1, 1, ?, ?)`,
        occurredAt,
        occurredAt,
        occurredAt,
        occurredAt,
      )
      await database.run(
        `INSERT INTO time_entries (
           id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
           spent_date, seconds, seconds_without_timer, rounded_seconds, billable,
           billable_rate_cents, cost_rate_cents, created_at, updated_at
         ) VALUES
           (2, 2, 2, 1, 20, 20, '2026-08-15', 60, 60, 60, 1, 6000, 3000, ?, ?),
           (10, 2, 10, 1, 100, 100, '2026-08-15', 60, 60, 60, 1, 6000, 3000, ?, ?)`,
        occurredAt,
        occurredAt,
        occurredAt,
        occurredAt,
      )

      const invoice = await generator(database).generate({
        commandId: 'numeric-source-order',
        principal,
        request: {
          ...request,
          projectIds: [10, 2],
          timeSummaryType: 'project',
          expenseSummaryType: null,
        },
      })
      expect(invoice.line_items.map(({ project_id: projectId }) => projectId)).toEqual([2, 10])
    })

    it('[unit] rejects manifests before they can exceed the D1 ledger row budget', async () => {
      const database = await setup()
      await database.run('DELETE FROM time_entries')
      await database.run('DELETE FROM expenses')
      await database.run(
        `WITH RECURSIVE ids(id) AS (
           SELECT 1 UNION ALL SELECT id + 1 FROM ids WHERE id < 80
         ) INSERT INTO time_entries (
           id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
           spent_date, seconds, seconds_without_timer, rounded_seconds, notes, billable,
           billable_rate_cents, cost_rate_cents, created_at, updated_at
         ) SELECT id, 2, 1, 1, 1, 1, '2026-08-15', 60, 60, 60,
           replace(hex(zeroblob(10000)), '00', 'x'), 1, 6000, 3000, ?, ?
         FROM ids`,
        occurredAt,
        occurredAt,
      )

      await expect(
        generator(database).generate({
          commandId: 'oversized-generation',
          principal,
          request: { ...request, timeSummaryType: 'detailed', expenseSummaryType: null },
        }),
      ).rejects.toMatchObject({
        code: 'invalid_command_input',
        message: 'the generated invoice manifest is too large for one atomic command',
      })
      expect(maximumGenerationManifestBytes).toBeLessThan(1_000_000)
      expect(await database.rows('SELECT count(*) AS count FROM invoices')).toEqual([{ count: 0 }])
      expect(await database.rows('SELECT count(*) AS count FROM invoice_command_ledger')).toEqual([
        { count: 0 },
      ])
    })
  })
}

describe('transactional invoice generation (two SQLite handles)', () => {
  it('[unit] serializes competing commands with an immediate transaction', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezacto-invoice-generation-'))
    const path = join(directory, 'race.sqlite')
    const firstClient = new BetterSqlite3(path)
    firstClient.pragma('busy_timeout = 5000')
    migrateContainer(firstClient)
    const first = containerDatabaseFrom(firstClient)
    const secondClient = new BetterSqlite3(path)
    secondClient.pragma('busy_timeout = 5000')
    const second = containerDatabaseFrom(secondClient)
    try {
      await seed(first)
      const results = await Promise.allSettled([
        generator(first).generate(command('two-handle-a')),
        generator(second).generate(command('two-handle-b')),
      ])

      expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
      expect(results.find(({ status }) => status === 'rejected')).toMatchObject({
        status: 'rejected',
        reason: expect.objectContaining({ code: 'generation_conflict' }),
      })
      expect(await first.rows('SELECT count(*) AS count FROM invoices')).toEqual([{ count: 1 }])
      expect(await first.rows('SELECT count(*) AS count FROM event_outbox')).toEqual([{ count: 1 }])
    } finally {
      await second.close()
      await first.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
