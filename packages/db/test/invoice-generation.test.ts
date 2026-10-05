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
  migrateThrough(id: '0025_time_entry_note_requirements' | '0094_payment_actuals'): Promise<void>
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

const freeForm = (commandId: string, clientId = 1) => ({
  commandId,
  principal,
  request: { kind: 'free_form' as const, clientId },
})

const storedReceipt = (database: TestDatabase, commandId: string) =>
  database.rows<{ inputFingerprint: string; requestJson: string }>(
    `SELECT input_fingerprint AS inputFingerprint, request_json AS requestJson
     FROM invoice_command_ledger WHERE command_id = ?`,
    commandId,
  )

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

    it('[unit] rolls every visible project up in a fixed number of queries', async () => {
      // The projects list needs Budget | Spent | Remaining | Costs for every
      // row. One call per project would not survive the collect()-everything
      // load, which is what kept these columns off the list; this is three
      // queries whatever the project count.
      const database = await setup()
      await database.run(
        `UPDATE projects SET budget_by = 'project', budget_seconds = 3600 WHERE id = 1`,
      )
      await database.run(`UPDATE time_entries SET budgeted = 1`)

      const reports = createReportRepository(database.orm)
      const summaries = await reports.projectBudgetSummaries(
        { from: request.from, to: request.to },
        { userId: 1, profile: 'administrator' },
      )

      // 1800 + 900 tracked against an hour, both at a 50.00 cost rate.
      expect(summaries).toEqual([
        expect.objectContaining({
          projectId: 1,
          budgetBy: 'project',
          unit: 'seconds',
          budgetAmount: 3600,
          spentAmount: 2700,
          remainingAmount: 900,
          costCents: 3750,
          unpricedEntryCount: 0,
        }),
      ])

      // The list applies the same visibility predicate as the per-project
      // report, so it cannot become a way to read a budget the detail page
      // would refuse. This viewer holds no assignment on project 1.
      expect(
        await reports.projectBudgetSummaries(
          { from: request.from, to: request.to },
          { userId: 9, profile: 'member' },
        ),
      ).toEqual([])
    })

    it('[unit] equals the uninvoiced report to the cent for the identical filter', async () => {
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

    it('[unit] leaves an archived project out of both the report and generation', async () => {
      // Harvest's uninvoiced report covers active projects only, and the
      // generation candidates are the same read, so archiving a project has to
      // take its unbilled work off both sides at once.
      const database = await setup()
      const reports = createReportRepository(database.orm)
      await database.run(`UPDATE projects SET is_active = 0 WHERE id = 1`)

      await expect(
        generator(database).generate(command('archived-project')),
      ).rejects.toMatchObject({
        code: 'invalid_command_input',
        message: 'an archived project cannot be invoiced',
      })
      expect(
        (
          await reports.uninvoiced({
            clientId: 1,
            projectId: 1,
            from: request.from,
            to: request.to,
          })
        ).totals,
      ).toEqual([])
      expect(
        await database.rows(
          `SELECT
             (SELECT count(*) FROM invoices) AS invoices,
             (SELECT count(*) FROM time_entries WHERE invoice_id IS NOT NULL) AS timeEntries,
             (SELECT count(*) FROM expenses WHERE invoice_id IS NOT NULL) AS expenses`,
        ),
      ).toEqual([{ invoices: 0, timeEntries: 0, expenses: 0 }])
    })

    it('[unit] nets a correction entry into the line it corrects', async () => {
      // Harvest records an over-logged day by writing a negative entry against
      // the same task, so the line the correction belongs to must simply come
      // out smaller. Before signed seconds this threw: the group's total went
      // below zero and the sum guard refused it, so a snapshot carrying one
      // correction could not be invoiced at all.
      const database = await setup()
      await database.run(
        `INSERT INTO time_entries (
           id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
           spent_date, seconds, seconds_without_timer, rounded_seconds, notes, billable,
           billable_rate_cents, cost_rate_cents, created_at, updated_at
         ) VALUES (3, 2, 1, 1, 1, 1, '2026-08-12', -900, -900, -900, 'Logged twice', 1,
           10001, 5000, ?, ?)`,
        occurredAt,
        occurredAt,
      )

      const invoice = await generator(database).generate(command('correction-entry'))

      // 1800s at 100.01/h is 5000.5 -> 5001 cents; -900s is -2500.25 -> -2500.
      // The Design line carries both, so it is the difference, not two lines.
      // The correction does not earn a line of its own: exactly one Design line,
      // carrying the difference. The other two are Review and the expense group,
      // unchanged.
      const design = invoice.line_items.filter((line) => line.description?.includes('Design'))
      expect(design).toHaveLength(1)
      expect(design[0]!.amount_cents).toBe(2501)
      expect(invoice.line_items).toHaveLength(3)
      expect(
        await database.rows(
          `SELECT count(*) AS count FROM time_entries WHERE invoice_id IS NOT NULL`,
        ),
      ).toEqual([{ count: 3 }])
    })

    it('[unit] refuses a selection mixing an active project with an archived one', async () => {
      // The candidate read drops archived work, so without this the request
      // would succeed and return a document covering only the active project --
      // short by exactly the archived project's billable time, with nothing on
      // the invoice to say anything was left off. Refusing is the only answer
      // that cannot quietly under-bill.
      const database = await setup()
      await database.run(
        `INSERT INTO projects (
           id, client_id, name, code, hourly_rate_cents, is_active, created_at, updated_at
         ) VALUES (2, 1, 'Archived sibling', 'ARCH', 10001, 0, ?, ?)`,
        occurredAt,
        occurredAt,
      )

      await expect(
        generator(database).generate({
          ...command('mixed-selection'),
          request: { ...request, projectIds: [1, 2] },
        }),
      ).rejects.toMatchObject({
        code: 'invalid_command_input',
        message: 'an archived project cannot be invoiced',
      })
      expect(await database.rows('SELECT count(*) AS count FROM invoices')).toEqual([{ count: 0 }])
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
      expect(rejected).toBeDefined()
      // Which way the loser fails is decided by where it had got to when the
      // winner committed, and both answers are correct. Read the candidates
      // first and it commits against rows that have since been claimed, so the
      // guard that re-reads on failure sees a changed signature and raises
      // generation_conflict. Read them after and there is simply nothing left
      // to bill, refused up front as invalid_command_input. Pinning one of the
      // two asserts a scheduling order this test does not control, and on a
      // loaded two-core runner the other one wins. What this test does control
      // is asserted below: exactly one winner, and not a trace of the loser.
      // The conflict guard itself is held to a real lock by the two-handle test
      // at the bottom of this file, where the loser blocks on BEGIN IMMEDIATE
      // and so has always read before the winner commits.
      const reason = (rejected as PromiseRejectedResult).reason as InvoiceGenerationError
      expect(['generation_conflict', 'invalid_command_input']).toContain(reason.code)
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

    it('[security] writes a detailed time line without a note its entry marks internal (D20)', async () => {
      // The line is printed on the invoice, listed in its email and mirrored to
      // the books, so the rule has to hold where the description is written.
      const database = await setup()
      await database.run(`UPDATE time_entries SET client_visible = 0 WHERE id = 1`)
      const invoice = await generator(database).generate({
        commandId: 'detailed-internal-note',
        principal,
        request: { ...request, timeSummaryType: 'detailed', expenseSummaryType: 'detailed' },
      })

      expect(invoice.line_items.map(({ description }) => description)).toEqual([
        '2026-08-10 · Tracked Person · Generation Project · Design',
        '2026-08-11 · Tracked Person · Generation Project · Review\nReview notes',
        // Expense notes carry no visibility flag and are unchanged.
        '2026-08-12 · Tracked Person · Generation Project · Travel\nTrain',
      ])
      expect(
        await database.rows<{ description: string }>(
          `SELECT description FROM invoice_line_items ORDER BY position`,
        ),
      ).not.toContainEqual({ description: expect.stringContaining('Design notes') })
    })

    it('[security] withholds an unmarked note when the organization default is internal', async () => {
      const database = await setup()
      await database.run(`UPDATE organizations SET report_notes_client_visible_default = 0`)
      await database.run(`UPDATE time_entries SET client_visible = 1 WHERE id = 2`)
      const generate = () =>
        generator(database).generate({
          commandId: 'detailed-default-internal',
          principal,
          request: { ...request, timeSummaryType: 'detailed', expenseSummaryType: null },
        })
      const invoice = await generate()
      expect(invoice.line_items.map(({ description }) => description)).toEqual([
        '2026-08-10 · Tracked Person · Generation Project · Design',
        '2026-08-11 · Tracked Person · Generation Project · Review\nReview notes',
      ])

      // A replay answers with the stored invoice, not a re-derivation: turning
      // the default back to visible afterwards changes nothing already written.
      await database.run(`UPDATE organizations SET report_notes_client_visible_default = 1`)
      expect(await generate()).toEqual(invoice)
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

    it('[unit] keeps the receipt fingerprint and manifest of an explicit range byte-identical', async () => {
      // Both values were recorded by the service as it stood before open starts
      // and blank drafts. A receipt written then replays only if the same request
      // still hashes, and still records, exactly as it did.
      const database = await setup()
      const service = generator(database)
      const invoice = await service.generate(command('fingerprint-pin'))

      expect(await storedReceipt(database, 'fingerprint-pin')).toEqual([
        {
          inputFingerprint:
            'sha256:6deabc72e9fd737e732f107e68a095e406860ba89b2d152da5df702e87526310',
          requestJson:
            '{"amount_cents":7834,"client_id":1,"currency":"USD","expected_version":0,' +
            '"expense_count":1,"expense_summary_type":"category","from":"2026-08-01",' +
            '"line_count":3,"project_ids":[1],"schema_version":1,"time_entry_count":2,' +
            '"time_summary_type":"task","to":"2026-08-31"}',
        },
      ])
      // Naming the default kind is the same request as leaving it out.
      expect(
        await service.generate({
          ...command('fingerprint-pin'),
          request: { ...request, kind: 'tracked' },
        }),
      ).toEqual(invoice)
    })

    it('[unit] bills everything uninvoiced up to the end date when the start is open', async () => {
      // June time and a May expense are older than any month a person would
      // pick; September time is after `to` and has to be left for next time.
      const database = await setup()
      await database.run(
        `INSERT INTO time_entries (
           id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
           spent_date, seconds, seconds_without_timer, rounded_seconds, notes, billable,
           billable_rate_cents, cost_rate_cents, created_at, updated_at
         ) VALUES
           (3, 2, 1, 1, 1, 1, '2026-06-15', 3600, 3600, 3600, 'June design', 1,
            10001, 5000, ?, ?),
           (4, 2, 1, 1, 1, 1, '2026-09-02', 3600, 3600, 3600, 'September design', 1,
            10001, 5000, ?, ?)`,
        occurredAt,
        occurredAt,
        occurredAt,
        occurredAt,
      )
      await database.run(
        `INSERT INTO expenses (
           id, user_id, project_id, expense_category_id, spent_date, notes,
           total_cost_cents, billable, created_at, updated_at
         ) VALUES (2, 2, 1, 1, '2026-05-20', 'May train', 444, 1, ?, ?)`,
        occurredAt,
        occurredAt,
      )
      const service = generator(database)

      // Time only, so the older May expense is not billed and cannot date it.
      const time = await service.generate({
        commandId: 'all-uninvoiced-time',
        principal,
        request: { ...request, from: null, expenseSummaryType: null },
      })
      expect(time).toMatchObject({
        period_start: '2026-06-15',
        period_end: '2026-08-31',
        subject: 'Tracked work 2026-06-15 – 2026-08-31',
        // 5001 + 2500 for August, plus June's 3600s at 100.01/h.
        amount_cents: 17_502,
      })
      expect(
        await database.rows('SELECT id FROM time_entries WHERE invoice_id = ? ORDER BY id', time.id),
      ).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
      // The receipt records the period the invoice covers, which is what the
      // creation guard holds the header to.
      const [timeReceipt] = await storedReceipt(database, 'all-uninvoiced-time')
      expect(JSON.parse(timeReceipt!.requestJson)).toMatchObject({
        from: '2026-06-15',
        to: '2026-08-31',
      })

      const expenses = await service.generate({
        commandId: 'all-uninvoiced-expenses',
        principal,
        request: { ...request, from: null, timeSummaryType: null },
      })
      expect(expenses).toMatchObject({
        period_start: '2026-05-20',
        period_end: '2026-08-31',
        subject: 'Tracked work 2026-05-20 – 2026-08-31',
        amount_cents: 777,
      })
      expect(
        await database.rows('SELECT id FROM expenses WHERE invoice_id = ? ORDER BY id', expenses.id),
      ).toEqual([{ id: 1 }, { id: 2 }])
      expect(
        await database.rows('SELECT invoice_id AS invoiceId FROM time_entries WHERE id = 4'),
      ).toEqual([{ invoiceId: null }])
    })

    it('[unit] replays an open start as itself, not as the range it resolved to', async () => {
      const database = await setup()
      const service = generator(database)
      const open = {
        commandId: 'open-start-replay',
        principal,
        request: { ...request, from: null },
      }

      const invoice = await service.generate(open)
      expect(invoice.period_start).toBe('2026-08-10')
      expect(await service.generate(open)).toEqual(invoice)
      await expect(
        service.generate({ ...open, request: { ...request, from: '2026-08-10' } }),
      ).rejects.toMatchObject({ code: 'command_id_reused' })
    })

    it('[unit] creates a numbered blank free-form draft in the client currency and terms', async () => {
      // The project bills in euros on purpose: a blank draft has no tracked row
      // to take a currency from, so it takes the client's.
      const database = await setup()
      await database.run(`UPDATE projects SET billing_currency = 'EUR' WHERE id = 1`)
      await database.run(`UPDATE clients SET payment_terms = 'net_15' WHERE id = 1`)

      const draft = await generator(database).generate(freeForm('blank-draft'))

      expect(draft).toMatchObject({
        client_id: 1,
        created_by_user_id: 1,
        number: '1',
        subject: null,
        currency: 'USD',
        issue_date: '2026-08-31',
        due_date: '2026-09-15',
        payment_terms: 'net_15',
        state: 'draft',
        version: 0,
        period_start: null,
        period_end: null,
        project_id: null,
        amount_cents: 0,
        due_amount_cents: 0,
        line_items: [],
      })
      const [receipt] = await storedReceipt(database, 'blank-draft')
      expect(JSON.parse(receipt!.requestJson)).toEqual({
        schema_version: 1,
        expected_version: 0,
        kind: 'free_form',
        client_id: 1,
        currency: 'USD',
        amount_cents: 0,
        line_count: 0,
        time_entry_count: 0,
        expense_count: 0,
      })
      expect(
        await database.rows(
          `SELECT
             (SELECT count(*) FROM invoice_line_items) AS lines,
             (SELECT count(*) FROM time_entries WHERE invoice_id IS NOT NULL) AS timeEntries,
             (SELECT count(*) FROM expenses WHERE invoice_id IS NOT NULL) AS expenses,
             (SELECT count(*) FROM invoice_command_ledger
               WHERE command_kind = 'invoice.create' AND completed = 1) AS receipts,
             (SELECT count(*) FROM event_outbox
               WHERE event_type = 'invoice.created') AS createdEvents`,
        ),
      ).toEqual([{ lines: 0, timeEntries: 0, expenses: 0, receipts: 1, createdEvents: 1 }])

      // One sequence: the next tracked invoice takes the following number.
      expect((await generator(database).generate(command('after-blank-draft'))).number).toBe('2')
    })

    it('[money] starts every new draft with the organization default subject and notes', async () => {
      const database = await setup()
      // Without defaults a draft starts with no subject and no notes.
      const plain = await generator(database).generate(freeForm('before-defaults'))
      expect(plain.subject).toBeNull()
      expect(plain.notes).toBeNull()

      const notes =
        'Beneficiary:\n*CONFLICT LLC*\n\n*_For wire transfers, please use routing number 021000021._*'
      await database.run(
        `UPDATE organizations SET invoice_default_notes = ?, invoice_default_subject = ?`,
        notes,
        'Conflict <> CLIENT Invoice: MONTH YEAR',
      )
      const tracked = await generator(database).generate(command('after-defaults'))
      expect(tracked.subject).toBe('Conflict <> CLIENT Invoice: MONTH YEAR')
      expect(tracked.notes).toBe(notes)
      const blank = await generator(database).generate(freeForm('blank-with-defaults'))
      expect(blank.subject).toBe('Conflict <> CLIENT Invoice: MONTH YEAR')
      expect(blank.notes).toBe(notes)

      // The default is copied, not linked: changing it leaves drafts alone.
      await database.run(`UPDATE organizations SET invoice_default_notes = NULL`)
      expect((await generator(database).generate(freeForm('blank-with-defaults'))).notes).toBe(notes)
    })

    it('[unit] replays a free-form draft and refuses its command id for any other input', async () => {
      const database = await setup()
      await database.run(
        `INSERT INTO clients (id, name, currency, payment_terms, created_at, updated_at)
         VALUES (2, 'Second Client', 'CAD', 'upon_receipt', ?, ?)`,
        occurredAt,
        occurredAt,
      )
      const service = generator(database)

      const [first, concurrent] = await Promise.all([
        service.generate(freeForm('blank-replay')),
        service.generate(freeForm('blank-replay')),
      ])
      expect(concurrent).toEqual(first)
      expect(await service.generate(freeForm('blank-replay'))).toEqual(first)
      for (const reused of [freeForm('blank-replay', 2), command('blank-replay')]) {
        await expect(service.generate(reused)).rejects.toMatchObject({
          code: 'command_id_reused',
        })
      }
      // Nor is a tracked command's id free for a blank draft.
      await service.generate(command('tracked-first'))
      await expect(service.generate(freeForm('tracked-first'))).rejects.toMatchObject({
        code: 'command_id_reused',
      })
      expect(await database.rows('SELECT count(*) AS count FROM invoices')).toEqual([{ count: 2 }])
    })

    it('[unit] refuses a free-form request naming a selection, a missing client, or a non-money actor', async () => {
      const database = await setup()
      const service = generator(database)
      for (const [field, value] of [
        ['projectIds', [1]],
        ['from', '2026-08-01'],
        ['to', '2026-08-31'],
        ['timeSummaryType', 'task'],
        ['expenseSummaryType', null],
      ] as const) {
        const selection = { kind: 'free_form' as const, clientId: 1, [field]: value }
        await expect(
          service.generate({ commandId: `blank-with-${field}`, principal, request: selection }),
        ).rejects.toMatchObject({
          code: 'invalid_command_input',
          message: `a free-form invoice takes no ${field}`,
        })
      }
      await expect(service.generate(freeForm('blank-missing-client', 99))).rejects.toMatchObject({
        code: 'invalid_command_input',
        message: 'the selected client does not exist',
      })
      await expect(
        service.generate({
          ...freeForm('blank-by-member'),
          principal: { userId: 2, profile: 'member' },
        }),
      ).rejects.toMatchObject({ code: 'forbidden' })
      expect(
        await database.rows(
          `SELECT (SELECT count(*) FROM invoices) AS invoices,
             (SELECT count(*) FROM invoice_command_ledger) AS receipts`,
        ),
      ).toEqual([{ invoices: 0, receipts: 0 }])
    })

    it('[unit] rolls a failed free-form draft back rather than naming a conflict', async () => {
      const database = await setup()
      await database.run(
        `CREATE TRIGGER fail_generated_event BEFORE INSERT ON event_outbox
         WHEN NEW.event_type = 'invoice.created'
         BEGIN SELECT RAISE(ABORT, 'injected generation failure'); END`,
      )

      await expect(generator(database).generate(freeForm('blank-late-failure'))).rejects.toThrow(
        'injected generation failure',
      )
      expect(
        await database.rows(
          `SELECT (SELECT count(*) FROM invoices) AS invoices,
             (SELECT count(*) FROM invoice_command_ledger) AS receipts,
             (SELECT count(*) FROM event_outbox) AS events`,
        ),
      ).toEqual([{ invoices: 0, receipts: 0, events: 0 }])
    })

    it('[unit] refuses a free-form creation whose header carries a period', async () => {
      // The creation guard compares the request's range to the header's period
      // with IS, so a draft whose request has none is held to none. Forced here
      // by stamping a period behind the command's back.
      const database = await setup()
      await database.run('DROP TRIGGER invoice_period_d22_derived_update')
      await database.run(
        `CREATE TRIGGER stamp_generated_period AFTER INSERT ON invoices
         BEGIN
           UPDATE invoices SET period_start = '2026-08-01', period_end = '2026-08-31'
           WHERE id = NEW.id;
         END`,
      )

      await expect(generator(database).generate(freeForm('blank-with-period'))).rejects.toThrow(
        'invoice creation event does not match its pending command',
      )
      expect(await database.rows('SELECT count(*) AS count FROM invoices')).toEqual([{ count: 0 }])
    })

    it('[unit] holds a free-form invoice.create manifest to an empty draft', async () => {
      const database = await setup()
      const blank = {
        schema_version: 1,
        expected_version: 0,
        kind: 'free_form',
        client_id: 1,
        currency: 'USD',
        amount_cents: 0,
        line_count: 0,
        time_entry_count: 0,
        expense_count: 0,
      }
      const insert = (invoiceId: number, manifest: object, lines: readonly object[] = []) =>
        database.run(
          `INSERT INTO invoice_command_ledger (
             invoice_id, command_id, command_kind, input_fingerprint, actor_type, actor_id,
             expected_invoice_version, occurred_at, request_json, source_manifest_json,
             line_manifest_json
           ) VALUES (?, ?, 'invoice.create', ?, 'user', 1, 0, ?, ?, ?, ?)`,
          invoiceId,
          `free-form-manifest-${invoiceId}`,
          `sha256:${'0'.repeat(64)}`,
          occurredAt,
          JSON.stringify(manifest),
          JSON.stringify({ schema_version: 1, time_entries: [], expenses: [] }),
          JSON.stringify({ schema_version: 1, lines }),
        )

      await insert(500, blank)
      for (const [invoiceId, manifest, lines] of [
        [501, { ...blank, amount_cents: 100 }, []],
        [502, { ...blank, line_count: 1 }, []],
        [503, blank, [{ id: 1, position: 0 }]],
        [504, { ...blank, from: '2026-08-01', to: '2026-08-31' }, []],
        [505, { ...blank, project_ids: [1] }, []],
        [506, { ...blank, time_entry_count: 1 }, []],
      ] as const) {
        await expect(insert(invoiceId, manifest, lines)).rejects.toThrow(/CHECK constraint failed/)
      }
      expect(
        await database.rows('SELECT invoice_id AS invoiceId FROM invoice_command_ledger'),
      ).toEqual([{ invoiceId: 500 }])
    })

    it('[unit] carries every receipt across the 0095 ledger rebuild', async () => {
      active = await factory(false)
      await active.migrateThrough('0094_payment_actuals')
      await seed(active)
      const before = await generator(active).generate(command('before-ledger-rebuild'))
      // Red before green: the old creation CHECK has no shape for a blank draft.
      await expect(
        generator(active).generate(freeForm('blank-before-rebuild')),
      ).rejects.toThrow(/CHECK constraint failed/)

      await active.migrate()

      expect(await generator(active).generate(command('before-ledger-rebuild'))).toEqual(before)
      expect(await generator(active).generate(freeForm('blank-after-rebuild'))).toMatchObject({
        number: '2',
        amount_cents: 0,
        line_items: [],
      })
      expect(
        await active.rows(
          `SELECT command_id AS commandId FROM invoice_command_ledger
           WHERE command_kind = 'invoice.create' AND completed = 1 ORDER BY command_id`,
        ),
      ).toEqual([{ commandId: 'before-ledger-rebuild' }, { commandId: 'blank-after-rebuild' }])
    })
  })
}

describe('transactional invoice generation (two SQLite handles)', () => {
  // The conflict guard re-reads the loser's candidates, and an open start is a
  // read of its own, so it is raced the same way.
  for (const [competing, from] of [
    ['competing commands', request.from],
    ['competing open-start commands', null],
  ] as const) {
    it(`[unit] serializes ${competing} with an immediate transaction`, async () => {
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
          generator(first).generate({ ...command('two-handle-a'), request: { ...request, from } }),
          generator(second).generate({ ...command('two-handle-b'), request: { ...request, from } }),
        ])

        expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
        expect(results.find(({ status }) => status === 'rejected')).toMatchObject({
          status: 'rejected',
          reason: expect.objectContaining({ code: 'generation_conflict' }),
        })
        expect(await first.rows('SELECT count(*) AS count FROM invoices')).toEqual([{ count: 1 }])
        expect(await first.rows('SELECT count(*) AS count FROM event_outbox')).toEqual([
          { count: 1 },
        ])
      } finally {
        await second.close()
        await first.close()
        await rm(directory, { recursive: true, force: true })
      }
    })
  }
})
