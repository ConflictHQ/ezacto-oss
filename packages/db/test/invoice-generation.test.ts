import { repriceTimeEntry } from '../src/rate-resolver.js'
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
  type GenerateBandedInvoiceRequest,
  type GeneratedInvoice,
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
  migrateThrough(
    id:
      | '0025_time_entry_note_requirements'
      | '0094_payment_actuals'
      | '0097_organization_invoice_defaults'
      | '0098_banded_invoice_create',
  ): Promise<void>
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

    it('[money] names the project and exact missing-rate cause before any invoice is created', async () => {
      const database = await setup()
      await database.run("UPDATE projects SET billing_method = 'time_materials', bill_by = 'project', hourly_rate_cents = NULL WHERE id = 1")
      await repriceTimeEntry(database.orm, { timeEntryId: 1, reason: 'Missing-rate test', repricedAt: occurredAt })
      await expect(generator(database).generate(command('unpriced-project'))).rejects.toMatchObject({ code: 'missing_billable_rate', projectId: 1, message: expect.stringContaining('project "Generation Project" bills by project but has no hourly rate') })
      expect(await database.rows('SELECT id FROM invoices')).toHaveLength(0)
      await database.run('UPDATE projects SET hourly_rate_cents = 1000 WHERE id = 1')
      await expect(generator(database).generate(command('unpriced-history'))).rejects.toMatchObject({ code: 'missing_billable_rate', message: expect.stringContaining('Preview and confirm Repair missing rates') })
    })

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
        '[GEN] Generation Project: Design (2026-08-01 - 2026-08-31)',
        '[GEN] Generation Project: Review (2026-08-01 - 2026-08-31)',
        '[GEN] Generation Project: Travel (2026-08-01 - 2026-08-31)',
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

      // 1800s and -900s net to 900s, a quarter of an hour, and the line bills
      // those hours at the rate: 0.25 x 100.01 = 25.0025 -> 2500 cents (issue
      // 923; priced entry by entry it would be 5001 - 2500 = 2501).
      // The correction does not earn a line of its own: exactly one Design line,
      // carrying the difference. The other two are Review and the expense group,
      // unchanged.
      const design = invoice.line_items.filter((line) => line.description?.includes('Design'))
      expect(design).toHaveLength(1)
      expect(design[0]).toMatchObject({ quantity: 0.25, unit_price_cents: 10_001, amount_cents: 2500 })
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
      // Hours, entries and expenses reconcile exactly. Time cents reconcile to
      // the lines: a generated line bills its hours to the hundredth times the
      // rate, which can differ by a few cents from the report pricing each
      // entry on its own (issue 923).
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
      const billed = await database.rows<{
        currency: string
        seconds: number
        entries: number
        expenseCents: number
      }>(
        `SELECT invoice.currency AS currency,
           (SELECT coalesce(sum(rounded_seconds), 0) FROM time_entries
             WHERE invoice_id = invoice.id) AS seconds,
           (SELECT count(*) FROM time_entries WHERE invoice_id = invoice.id) AS entries,
           (SELECT coalesce(sum(amount_cents), 0) FROM invoice_line_items
             WHERE invoice_id = invoice.id AND kind = 'Expense') AS expenseCents
         FROM invoices invoice ORDER BY invoice.currency`,
      )
      expect(billed).toEqual(
        report.totals.map((total) => ({
          currency: total.currency,
          seconds: total.roundedSeconds,
          entries: total.timeEntryCount,
          expenseCents: total.expenseCents,
        })),
      )
      // EUR: 1200 s is 0.33 h, and 0.33 x 90.01 = 29.70, where the entry
      // priced alone is 30.00. USD: 0.50 x 100.01 + 0.25 x 100.00 = 75.01.
      expect(
        new Map([
          [eurInvoice.currency, eurInvoice.amount_cents],
          [usdInvoice.currency, usdInvoice.amount_cents],
        ]),
      ).toEqual(
        new Map([
          ['EUR', 2_970 + 222],
          ['USD', 7_501 + 333],
        ]),
      )
      for (const line of [...eurInvoice.line_items, ...usdInvoice.line_items]) {
        expect(calculateInvoiceLineAmountCents(line.quantity, line.unit_price_cents)).toBe(
          line.amount_cents,
        )
      }
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
        { kind: 'Service', description: '[GEN] Generation Project (2026-08-01 - 2026-08-31)' },
        { kind: 'Expense', description: '[GEN] Generation Project (2026-08-01 - 2026-08-31)' },
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

    // Issue 923. 37.2067 hours in two entries at a whole-dollar rate: priced one
    // entry at a time they come to 3,534.64, which no 37.2067 × 95.00 line
    // reproduces, so the line fell back to 1 × 3,534.64. Harvest bills it as
    // 37.21 × 95.00, and so does every grouping now.
    for (const timeSummaryType of ['people', 'task', 'project'] as const) {
      it(`[money] bills ${timeSummaryType} lines as hours to the hundredth times the rate`, async () => {
        const database = await setup()
        await database.run(
          `UPDATE time_entries SET task_id = 1, task_assignment_id = 1, seconds = 66972,
             seconds_without_timer = 66972, rounded_seconds = 66972, billable_rate_cents = 9500`,
        )
        const invoice = await generator(database).generate({
          commandId: `rounded-${timeSummaryType}`,
          principal,
          request: { ...request, timeSummaryType, expenseSummaryType: null },
        })

        expect(
          invoice.line_items.map(({ quantity, unit_price_cents, amount_cents }) => ({
            quantity,
            unit_price_cents,
            amount_cents,
          })),
        ).toEqual([{ quantity: 37.21, unit_price_cents: 9_500, amount_cents: 353_495 }])
        expect(invoice.amount_cents).toBe(353_495)
        expect(
          await database.rows(`SELECT quantity, unit_price_cents AS unitPriceCents FROM invoice_line_items`),
        ).toEqual([{ quantity: 37.21, unitPriceCents: 9_500 }])
      })
    }

    it('[money] rounds hours a single entry leaves at a long fraction', async () => {
      // 4471 seconds is 1.241944... hours, which the line used to print as is.
      const database = await setup()
      await database.run(
        `UPDATE time_entries SET seconds = 4471, seconds_without_timer = 4471,
           rounded_seconds = 4471 WHERE id = 1`,
      )
      await database.run(
        `UPDATE time_entries SET seconds = 1000, seconds_without_timer = 1000,
           rounded_seconds = 1000, billable_rate_cents = 12000 WHERE id = 2`,
      )
      const invoice = await generator(database).generate({
        commandId: 'rounded-detailed',
        principal,
        request: { ...request, timeSummaryType: 'detailed', expenseSummaryType: null },
      })

      expect(
        invoice.line_items.map(({ quantity, unit_price_cents, amount_cents }) => ({
          quantity,
          unit_price_cents,
          amount_cents,
        })),
      ).toEqual([
        { quantity: 1.24, unit_price_cents: 10_001, amount_cents: 12_401 },
        { quantity: 0.28, unit_price_cents: 12_000, amount_cents: 3_360 },
      ])
      expect(invoice.amount_cents).toBe(15_761)
    })

    it('[money] bills a group that mixes rates at its rounded hours, never 1 × total', async () => {
      // One person at two rates (the rate changed mid-month): 4471 s at 100.01
      // and 900 s at 100.00, 5371 s in all, so 1.49 hours. The entries price
      // to 149.21; the line keeps as close to that as one quantity and one
      // price can, 1.49 × 100.14.
      const database = await setup()
      await database.run(
        `UPDATE time_entries SET seconds = 4471, seconds_without_timer = 4471,
           rounded_seconds = 4471 WHERE id = 1`,
      )
      const invoice = await generator(database).generate({
        commandId: 'rounded-mixed-rates',
        principal,
        request: { ...request, timeSummaryType: 'people', expenseSummaryType: null },
      })

      expect(invoice.line_items).toEqual([
        expect.objectContaining({ quantity: 1.49, unit_price_cents: 10_014, amount_cents: 14_921 }),
      ])
      for (const line of invoice.line_items) {
        expect(calculateInvoiceLineAmountCents(line.quantity, line.unit_price_cents)).toBe(
          line.amount_cents,
        )
      }
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
        {
          kind: 'Service',
          description: '[GEN] Generation Project: Tracked Person (2026-08-01 - 2026-08-31)',
        },
        {
          kind: 'Expense',
          description: '[GEN] Generation Project: Tracked Person (2026-08-01 - 2026-08-31)',
        },
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
        '[GEN] Generation Project - 2026-08-10 - Design / Tracked Person: Design notes',
        '[GEN] Generation Project - 2026-08-11 - Review / Tracked Person: Review notes',
        '[GEN] Generation Project - 2026-08-12 - Travel / Tracked Person: Train',
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
        '[GEN] Generation Project - 2026-08-10 - Design / Tracked Person',
        '[GEN] Generation Project - 2026-08-11 - Review / Tracked Person: Review notes',
        // Expense notes carry no visibility flag and are unchanged.
        '[GEN] Generation Project - 2026-08-12 - Travel / Tracked Person: Train',
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
        '[GEN] Generation Project - 2026-08-10 - Design / Tracked Person',
        '[GEN] Generation Project - 2026-08-11 - Review / Tracked Person: Review notes',
      ])

      // A replay answers with the stored invoice, not a re-derivation: turning
      // the default back to visible afterwards changes nothing already written.
      await database.run(`UPDATE organizations SET report_notes_client_visible_default = 1`)
      expect(await generate()).toEqual(invoice)
    })

    it("[money] leaves the [code] prefix off a project that has no code, as Harvest did", async () => {
      const database = await setup()
      await database.run(`UPDATE projects SET code = '' WHERE id = 1`)
      const invoice = await generator(database).generate({
        commandId: 'codeless-project',
        principal,
        request: { ...request, timeSummaryType: 'task', expenseSummaryType: 'detailed' },
      })

      expect(invoice.line_items.map(({ description }) => description)).toEqual([
        'Generation Project: Design (2026-08-01 - 2026-08-31)',
        'Generation Project: Review (2026-08-01 - 2026-08-31)',
        'Generation Project - 2026-08-12 - Travel / Tracked Person: Train',
      ])
    })

    it("[money] writes every date in a line in the organization's own date format", async () => {
      // Harvest wrote the account's format into its lines: the same archive
      // has 09/17/2019 from years on %m/%d/%Y and 2025-10-08 from years on
      // %Y-%m-%d. An import carries the account's format over.
      const database = await setup()
      await database.run(`UPDATE organizations SET date_format = '%m/%d/%Y'`)
      const service = generator(database)
      const grouped = await service.generate({
        commandId: 'us-dates-grouped',
        principal,
        request: { ...request, timeSummaryType: 'project', expenseSummaryType: null },
      })
      expect(grouped.line_items.map(({ description }) => description)).toEqual([
        '[GEN] Generation Project (08/01/2026 - 08/31/2026)',
      ])
      // The invoice's own period stays a calendar date; only the words change.
      expect(grouped).toMatchObject({ period_start: '2026-08-01', period_end: '2026-08-31' })

      await database.run('UPDATE time_entries SET invoice_id = NULL')
      await database.run(`UPDATE organizations SET date_format = '%d.%m.%Y'`)
      const detailed = await service.generate({
        commandId: 'dotted-dates-detailed',
        principal,
        request: { ...request, timeSummaryType: 'detailed', expenseSummaryType: 'detailed' },
      })
      expect(detailed.line_items.map(({ description }) => description)).toEqual([
        '[GEN] Generation Project - 10.08.2026 - Design / Tracked Person: Design notes',
        '[GEN] Generation Project - 11.08.2026 - Review / Tracked Person: Review notes',
        '[GEN] Generation Project - 12.08.2026 - Travel / Tracked Person: Train',
      ])
    })

    it('[money] names the period a grouped line covers from the first entry billed', async () => {
      // An open start bills everything uninvoiced, and the line says so with
      // the same dates the invoice carries: its earliest row, then `to`.
      const database = await setup()
      const invoice = await generator(database).generate({
        commandId: 'open-start-line-period',
        principal,
        request: { ...request, from: null, timeSummaryType: 'people', expenseSummaryType: null },
      })

      expect(invoice.period_start).toBe('2026-08-10')
      expect(invoice.line_items.map(({ description }) => description)).toEqual([
        '[GEN] Generation Project: Tracked Person (2026-08-10 - 2026-08-31)',
      ])
    })

    it("[money] fills the default subject's placeholders for the draft it starts", async () => {
      // One default for every client: the client, the month the work was in
      // rather than the month the draft is raised in, and the project when
      // there is exactly one. The text around them is kept as written.
      const database = await setup()
      await database.run(
        `INSERT INTO projects (id, client_id, name, code, hourly_rate_cents, created_at, updated_at)
         VALUES (2, 1, 'Second Project', 'TWO', 10001, ?, ?)`,
        occurredAt,
        occurredAt,
      )
      await database.run(
        `UPDATE organizations SET invoice_default_subject = ?`,
        'Acme Studio <> %client%: %period_month_name% %period_year% %project%',
      )
      // Raised in September, for August.
      const service = createInvoiceGenerationService(database.orm, {
        clock: () => '2026-09-03T12:00:00.000Z',
      })

      const august = await service.generate(command('subject-one-project'))
      expect(august).toMatchObject({ issue_date: '2026-09-03', period_start: '2026-08-01' })
      expect(august.subject).toBe(
        'Acme Studio <> Generation Client: August 2026 Generation Project',
      )

      await database.run('UPDATE time_entries SET invoice_id = NULL')
      await database.run('UPDATE expenses SET invoice_id = NULL')
      const both = await service.generate({
        ...command('subject-two-projects'),
        request: { ...request, projectIds: [1, 2] },
      })
      expect(both.subject).toBe('Acme Studio <> Generation Client: August 2026 ')

      // A blank draft has no period, so it takes the month it is issued in.
      expect((await service.generate(freeForm('subject-free-form'))).subject).toBe(
        'Acme Studio <> Generation Client: September 2026 ',
      )

      // A subject that fills to nothing is no subject.
      await database.run(`UPDATE organizations SET invoice_default_subject = '%project%'`)
      expect((await service.generate(freeForm('subject-fills-to-nothing'))).subject).toBeNull()
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
      // A minute is 0.0166... hours, billed as 0.02 x 60.00 = 1.20 a line, as
      // Harvest prints it (issue 923), where the entry priced alone is 1.00.
      expect(invoice.line_items.every((line) => line.quantity === 0.02)).toBe(true)
      expect(invoice.amount_cents).toBe(12_120)
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
      // Recorded by the service as it stood before bands, so a blank draft's
      // receipt still replays: its kind hashes exactly as it did.
      expect(receipt!.inputFingerprint).toBe(
        'sha256:74d38502804df212d1435f3113936899c722cd9e9cfa9a871c60462e29a33336',
      )
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

/**
 * A band's month: two people at their own rates, seeded out of date order so
 * that "oldest first" can only mean the spent date. By date: 10h of Tracked
 * Person at 150.00/h (id 14), 5h of Second Person at 100.00/h (13), 2.5h of
 * Tracked Person (12), 2.75h of Second Person (11) -- 20.25h, worth 2,650.00 at
 * list. The base seed's expense stays: a band claims time and nothing else.
 */
const seedBand = async (database: TestDatabase): Promise<void> => {
  await database.run('DELETE FROM time_entries')
  await database.run(
    `INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
     VALUES (3, 'Second', 'Person', 'member', '[]', ?, ?)`,
    occurredAt,
    occurredAt,
  )
  await database.run(
    `INSERT INTO user_assignments (id, project_id, user_id, created_at, updated_at)
     VALUES (2, 1, 3, ?, ?)`,
    occurredAt,
    occurredAt,
  )
  await database.run(
    `INSERT INTO time_entries (
       id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
       spent_date, seconds, seconds_without_timer, rounded_seconds, notes, billable,
       billable_rate_cents, cost_rate_cents, created_at, updated_at
     ) VALUES
       (14, 2, 1, 1, 1, 1, '2026-08-03', 36000, 36000, 36000, 'Discovery', 1,
        15000, 5000, ?, ?),
       (13, 3, 1, 2, 2, 2, '2026-08-05', 18000, 18000, 18000, 'Review pass', 1,
        10000, 5000, ?, ?),
       (12, 2, 1, 1, 1, 1, '2026-08-07', 9000, 9000, 9000, 'Build', 1,
        15000, 5000, ?, ?),
       (11, 3, 1, 2, 2, 2, '2026-08-09', 9900, 9900, 9900, 'Second review', 1,
        10000, 5000, ?, ?)`,
    ...Array.from({ length: 8 }, () => occurredAt),
  )
}

const feeLine = {
  kind: 'Service',
  description: 'Monthly retainer',
  quantity: 1,
  unitPriceCents: 150_000,
  projectId: null,
}

const bandRequest = (
  overrides: Partial<GenerateBandedInvoiceRequest> = {},
): GenerateBandedInvoiceRequest => ({
  kind: 'banded',
  clientId: 1,
  from: '2026-08-01',
  to: '2026-08-31',
  projectIds: [1],
  lineItems: [feeLine],
  claimMode: 'all',
  claimCeilingSeconds: null,
  claimCeilingCents: null,
  overageSummaryType: null,
  ...overrides,
})

const banded = (commandId: string, overrides: Partial<GenerateBandedInvoiceRequest> = {}) => ({
  commandId,
  principal,
  request: bandRequest(overrides),
})

/** Sixteen hours, the rest billed per person. */
const hoursCeiling = {
  claimMode: 'ceiling',
  claimCeilingSeconds: 57_600,
  overageSummaryType: 'people',
} as const

const lineShapes = (invoice: Pick<GeneratedInvoice, 'line_items'>) =>
  invoice.line_items.map(
    ({ position, kind, description, quantity, unit_price_cents, amount_cents, project_id }) => ({
      position,
      kind,
      description,
      quantity,
      unit_price_cents,
      amount_cents,
      project_id,
    }),
  )

const feeShape = {
  position: 0,
  kind: 'Service',
  description: 'Monthly retainer',
  quantity: 1,
  unit_price_cents: 150_000,
  amount_cents: 150_000,
  project_id: null,
}

const schemaObjects = (database: TestDatabase) =>
  database.rows<{ type: string; name: string; tbl_name: string; sql: string | null }>(
    `SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name`,
  )

for (const [runtime, factory] of factories) {
  describe(`banded invoice generation (${runtime})`, () => {
    let active: TestDatabase | undefined
    afterEach(async () => {
      await active?.close()
      active = undefined
    })

    const setup = async (): Promise<TestDatabase> => {
      active = await factory()
      await seed(active)
      await seedBand(active)
      return active
    }

    const invoicedEntries = async (database: TestDatabase, invoiceId: number) =>
      (
        await database.rows<{ id: number }>(
          'SELECT id FROM time_entries WHERE invoice_id = ? ORDER BY id',
          invoiceId,
        )
      ).map(({ id }) => id)

    const absorbed = (database: TestDatabase, invoiceId: number) =>
      database.rows<{ foregone: number; writtenOff: number }>(
        `SELECT foregone_billable_cents AS foregone, written_off_cents AS writtenOff
         FROM invoices WHERE id = ?`,
        invoiceId,
      )

    it('[money] covers every uninvoiced hour with the fee and bills none of them', async () => {
      const database = await setup()
      const invoice = await generator(database).generate(banded('band-all'))

      expect(invoice).toMatchObject({
        client_id: 1,
        currency: 'USD',
        state: 'draft',
        version: 0,
        subject: 'Tracked work 2026-08-01 – 2026-08-31',
        period_start: '2026-08-01',
        period_end: '2026-08-31',
        project_id: 1,
        amount_cents: 150_000,
        due_amount_cents: 150_000,
      })
      // The fee is the invoice: the hours it covers contribute no line.
      expect(lineShapes(invoice)).toEqual([feeShape])
      expect(invoice.band).toEqual({
        claimed_entry_count: 4,
        claimed_seconds: 72_900,
        billed_entry_count: 0,
        billed_seconds: 0,
      })
      expect(await invoicedEntries(database, invoice.id)).toEqual([11, 12, 13, 14])
      // Expenses are not a band's to claim.
      expect(await database.rows('SELECT invoice_id AS invoiceId FROM expenses')).toEqual([
        { invoiceId: null },
      ])
      // 2,650.00 of work for a 1,500.00 fee: what the band absorbed is recorded
      // the way the recurring engine records it, and not as a write-off.
      expect(await absorbed(database, invoice.id)).toEqual([{ foregone: 115_000, writtenOff: 0 }])

      const [receipt] = await storedReceipt(database, 'band-all')
      expect(JSON.parse(receipt!.requestJson)).toEqual({
        schema_version: 1,
        expected_version: 0,
        kind: 'banded',
        client_id: 1,
        from: '2026-08-01',
        to: '2026-08-31',
        project_ids: [1],
        claim_mode: 'all',
        claim_ceiling_seconds: null,
        claim_ceiling_cents: null,
        overage_summary_type: null,
        currency: 'USD',
        amount_cents: 150_000,
        line_count: 1,
        fee_line_count: 1,
        time_entry_count: 4,
        expense_count: 0,
        claimed_entry_count: 4,
        claimed_seconds: 72_900,
        billed_entry_count: 0,
        billed_seconds: 0,
      })

      // The covered time no longer reads as uninvoiced; the expense still does.
      const report = await createReportRepository(database.orm).uninvoiced({
        clientId: 1,
        projectId: 1,
        from: '2026-08-01',
        to: '2026-08-31',
      })
      expect(report.totals).toEqual([
        expect.objectContaining({
          currency: 'USD',
          roundedSeconds: 0,
          timeEntryCount: 0,
          expenseCount: 1,
          totalCents: 333,
        }),
      ])
    })

    it("[money] a ceiling in hours covers the oldest whole entries and bills the rest at each person's rate", async () => {
      const database = await setup()
      const invoice = await generator(database).generate(banded('band-hours', hoursCeiling))

      // By spent date, not id: 10h and 5h fit inside 16. The 2.5h entry would
      // take the band to 17.5h, so it is left out whole -- and so is everything
      // after it -- and billed after the fee, per person at that person's rate.
      expect(invoice.band).toEqual({
        claimed_entry_count: 2,
        claimed_seconds: 54_000,
        billed_entry_count: 2,
        billed_seconds: 18_900,
      })
      expect(lineShapes(invoice)).toEqual([
        feeShape,
        {
          position: 1,
          kind: 'Service',
          description: '[GEN] Generation Project: Second Person (2026-08-01 - 2026-08-31)',
          quantity: 2.75,
          unit_price_cents: 10_000,
          amount_cents: 27_500,
          project_id: 1,
        },
        {
          position: 2,
          kind: 'Service',
          description: '[GEN] Generation Project: Tracked Person (2026-08-01 - 2026-08-31)',
          quantity: 2.5,
          unit_price_cents: 15_000,
          amount_cents: 37_500,
          project_id: 1,
        },
      ])
      expect(invoice.amount_cents).toBe(215_000)
      // Covered and billed alike, every entry is this invoice's now.
      expect(await invoicedEntries(database, invoice.id)).toEqual([11, 12, 13, 14])
      // 2,000.00 of covered work against a 1,500.00 fee; the billed hours are
      // charged at the value they add, so they absorb nothing.
      expect(await absorbed(database, invoice.id)).toEqual([{ foregone: 50_000, writtenOff: 0 }])
      const [receipt] = await storedReceipt(database, 'band-hours')
      expect(JSON.parse(receipt!.requestJson)).toMatchObject({
        claim_mode: 'ceiling',
        claim_ceiling_seconds: 57_600,
        claim_ceiling_cents: null,
        overage_summary_type: 'people',
        amount_cents: 215_000,
        line_count: 3,
        fee_line_count: 1,
        time_entry_count: 4,
        claimed_entry_count: 2,
        claimed_seconds: 54_000,
        billed_entry_count: 2,
        billed_seconds: 18_900,
      })
    })

    it('[money] a ceiling in value covers by worth at list and bills a straddling entry whole', async () => {
      const database = await setup()
      const invoice = await generator(database).generate(
        banded('band-value', {
          claimMode: 'ceiling',
          claimCeilingCents: 190_000,
          overageSummaryType: 'detailed',
        }),
      )

      // The oldest entry is worth 1,500.00 and fits; the next is worth 500.00
      // and would take the band past 1,900.00, so it is billed whole, and the
      // two after it with it.
      expect(invoice.band).toEqual({
        claimed_entry_count: 1,
        claimed_seconds: 36_000,
        billed_entry_count: 3,
        billed_seconds: 36_900,
      })
      expect(lineShapes(invoice)).toEqual([
        feeShape,
        {
          position: 1,
          kind: 'Service',
          description:
            '[GEN] Generation Project - 2026-08-09 - Review / Second Person: Second review',
          quantity: 2.75,
          unit_price_cents: 10_000,
          amount_cents: 27_500,
          project_id: 1,
        },
        {
          position: 2,
          kind: 'Service',
          description: '[GEN] Generation Project - 2026-08-07 - Design / Tracked Person: Build',
          quantity: 2.5,
          unit_price_cents: 15_000,
          amount_cents: 37_500,
          project_id: 1,
        },
        {
          position: 3,
          kind: 'Service',
          description:
            '[GEN] Generation Project - 2026-08-05 - Review / Second Person: Review pass',
          quantity: 5,
          unit_price_cents: 10_000,
          amount_cents: 50_000,
          project_id: 1,
        },
      ])
      expect(invoice.amount_cents).toBe(265_000)
      expect(await invoicedEntries(database, invoice.id)).toEqual([11, 12, 13, 14])
      expect(await absorbed(database, invoice.id)).toEqual([{ foregone: 0, writtenOff: 0 }])
    })

    it('[money] raises the fee over no uninvoiced time, and says it covered none', async () => {
      // A flat fee is owed whether or not anything was tracked yet.
      const database = await setup()
      await database.run('DELETE FROM time_entries')
      const service = generator(database)

      const open = await service.generate(
        banded('band-nothing-open', {
          from: null,
          lineItems: [{ ...feeLine, description: null }],
        }),
      )
      // Nothing to date an open start from, so the period has an end and no
      // invented start, and there is no period subject to write.
      expect(open).toMatchObject({
        period_start: null,
        period_end: '2026-08-31',
        subject: null,
        amount_cents: 150_000,
      })
      expect(lineShapes(open)).toEqual([{ ...feeShape, description: null }])
      expect(open.band).toEqual({
        claimed_entry_count: 0,
        claimed_seconds: 0,
        billed_entry_count: 0,
        billed_seconds: 0,
      })
      const [receipt] = await storedReceipt(database, 'band-nothing-open')
      expect(JSON.parse(receipt!.requestJson)).toMatchObject({
        from: null,
        to: '2026-08-31',
        time_entry_count: 0,
        claimed_entry_count: 0,
      })

      const ranged = await service.generate(banded('band-nothing-ranged', hoursCeiling))
      expect(ranged).toMatchObject({
        period_start: '2026-08-01',
        period_end: '2026-08-31',
        subject: 'Tracked work 2026-08-01 – 2026-08-31',
      })
      expect(lineShapes(ranged)).toEqual([feeShape])
      expect(ranged.band).toMatchObject({ claimed_entry_count: 0, billed_entry_count: 0 })
      expect(await absorbed(database, ranged.id)).toEqual([{ foregone: 0, writtenOff: 0 }])
    })

    it('[unit] replays a banded draft and refuses its command id for any other input', async () => {
      const database = await setup()
      const service = generator(database)
      const [first, concurrent] = await Promise.all([
        service.generate(banded('band-replay', hoursCeiling)),
        service.generate(banded('band-replay', hoursCeiling)),
      ])
      expect(concurrent).toEqual(first)
      // A replay answers from the receipt, the band included.
      expect(await service.generate(banded('band-replay', hoursCeiling))).toEqual(first)
      expect(first.band).toMatchObject({ claimed_entry_count: 2, billed_entry_count: 2 })

      for (const reused of [
        banded('band-replay', { ...hoursCeiling, claimCeilingSeconds: 7_200 }),
        banded('band-replay', { ...hoursCeiling, overageSummaryType: 'task' }),
        banded('band-replay', {
          ...hoursCeiling,
          lineItems: [{ ...feeLine, unitPriceCents: 150_001 }],
        }),
        banded('band-replay'),
        command('band-replay'),
        freeForm('band-replay'),
      ]) {
        await expect(service.generate(reused)).rejects.toMatchObject({
          code: 'command_id_reused',
        })
      }

      // Another band over the same selection is another fee; the hours are the
      // first one's, so it covers none of them.
      const second = await service.generate(banded('band-second', hoursCeiling))
      expect(second.band).toEqual({
        claimed_entry_count: 0,
        claimed_seconds: 0,
        billed_entry_count: 0,
        billed_seconds: 0,
      })
      expect(await invoicedEntries(database, first.id)).toEqual([11, 12, 13, 14])
      expect(
        await database.rows(
          `SELECT
             (SELECT count(*) FROM invoices) AS invoices,
             (SELECT count(*) FROM invoice_command_ledger WHERE completed = 1) AS receipts,
             (SELECT count(*) FROM event_outbox
               WHERE event_type = 'invoice.created') AS createdEvents`,
        ),
      ).toEqual([{ invoices: 2, receipts: 2, createdEvents: 2 }])
    })

    it('[money] starts a banded draft with the organization defaults, placeholders filled', async () => {
      const database = await setup()
      await database.run(
        `UPDATE organizations SET invoice_default_subject = ?, invoice_default_notes = ?`,
        '%client% retainer, %period_month_name% %period_year% (%project%)',
        'Pay by transfer.',
      )
      const invoice = await generator(database).generate(banded('band-defaults', hoursCeiling))
      expect(invoice.subject).toBe('Generation Client retainer, August 2026 (Generation Project)')
      expect(invoice.notes).toBe('Pay by transfer.')
    })

    it('[unit] refuses a band whose terms do not hold together, and writes nothing', async () => {
      const database = await setup()
      await database.run(
        `INSERT INTO clients (id, name, currency, payment_terms, created_at, updated_at)
         VALUES (2, 'Other Client', 'USD', 'net_30', ?, ?)`,
        occurredAt,
        occurredAt,
      )
      await database.run(
        `INSERT INTO projects (id, client_id, name, code, hourly_rate_cents, created_at, updated_at)
         VALUES (2, 2, 'Other Project', 'OTH', 10000, ?, ?),
                (3, 1, 'Euro Project', 'EUR', 10000, ?, ?)`,
        ...Array.from({ length: 4 }, () => occurredAt),
      )
      await database.run(`UPDATE projects SET billing_currency = 'EUR' WHERE id = 3`)
      const service = generator(database)
      const cases: Array<[Partial<GenerateBandedInvoiceRequest>, string]> = [
        [
          { claimMode: 'ceiling', overageSummaryType: 'people' },
          'a ceiling needs exactly one positive limit, in seconds or in cents',
        ],
        [
          { ...hoursCeiling, claimCeilingCents: 100_000 },
          'a ceiling needs exactly one positive limit, in seconds or in cents',
        ],
        [
          { ...hoursCeiling, claimCeilingSeconds: 0 },
          'a ceiling needs exactly one positive limit, in seconds or in cents',
        ],
        [
          { ...hoursCeiling, overageSummaryType: null },
          'a ceiling needs overageSummaryType: project, task, people, or detailed',
        ],
        [{ claimCeilingSeconds: 3_600 }, 'a band covering all of the time takes no ceiling'],
        [{ overageSummaryType: 'people' }, 'a band covering all of the time bills no overage'],
        [{ lineItems: [] }, 'lineItems must hold the fee in 1-100 lines'],
        [
          { lineItems: [{ ...feeLine, kind: ' ' }] },
          'lineItems[0].kind must be a non-blank string of at most 255 characters',
        ],
        [
          { lineItems: [{ ...feeLine, projectId: 2 }] },
          'a fee line project must belong to the selected client',
        ],
        [{ projectIds: [1, 3] }, 'selected projects must bill in one invoice currency'],
        [{ projectIds: [2] }, 'every selected project must belong to the selected client'],
      ]
      for (const [index, [overrides, message]] of cases.entries()) {
        await expect(
          service.generate(banded(`band-refused-${index}`, overrides)),
        ).rejects.toMatchObject({ code: 'invalid_command_input', message })
      }
      await expect(
        service.generate({
          ...banded('band-with-summary'),
          request: { ...bandRequest(), timeSummaryType: 'task' } as GenerateBandedInvoiceRequest,
        }),
      ).rejects.toMatchObject({
        code: 'invalid_command_input',
        message: 'a banded invoice takes no timeSummaryType',
      })
      await expect(
        service.generate({ ...banded('band-by-member'), principal: { userId: 2, profile: 'member' } }),
      ).rejects.toMatchObject({ code: 'forbidden' })
      // Hours past the ceiling are billed at their rate, so one without a rate
      // cannot be billed -- the same refusal a tracked draft gives.
      await database.run('UPDATE time_entries SET billable_rate_cents = NULL WHERE id = 12')
      await expect(service.generate(banded('band-unpriced-overage', hoursCeiling))).rejects.toMatchObject({
        code: 'missing_billable_rate',
        projectId: 1,
        message: expect.stringContaining('Changing rates affects new entries only'),
      })
      expect(
        await database.rows(
          `SELECT (SELECT count(*) FROM invoices) AS invoices,
             (SELECT count(*) FROM invoice_command_ledger) AS receipts,
             (SELECT count(*) FROM time_entries WHERE invoice_id IS NOT NULL) AS claimed`,
        ),
      ).toEqual([{ invoices: 0, receipts: 0, claimed: 0 }])

      // Covering all of it needs no price: an unpriced hour is an hour.
      const all = await service.generate(banded('band-covers-unpriced'))
      expect(all.band).toMatchObject({ claimed_entry_count: 4, billed_entry_count: 0 })
    })

    it('[unit] holds a banded invoice.create manifest to its own shape', async () => {
      const database = await setup()
      const manifest = {
        schema_version: 1,
        expected_version: 0,
        kind: 'banded',
        client_id: 1,
        from: '2026-08-01',
        to: '2026-08-31',
        project_ids: [1],
        claim_mode: 'ceiling',
        claim_ceiling_seconds: 57_600,
        claim_ceiling_cents: null,
        overage_summary_type: 'people',
        currency: 'USD',
        amount_cents: 215_000,
        line_count: 3,
        fee_line_count: 1,
        time_entry_count: 4,
        expense_count: 0,
        claimed_entry_count: 2,
        claimed_seconds: 54_000,
        billed_entry_count: 2,
        billed_seconds: 18_900,
      }
      const insert = (invoiceId: number, body: object) =>
        database.run(
          `INSERT INTO invoice_command_ledger (
             invoice_id, command_id, command_kind, input_fingerprint, actor_type, actor_id,
             expected_invoice_version, occurred_at, request_json, source_manifest_json,
             line_manifest_json
           ) VALUES (?, ?, 'invoice.create', ?, 'user', 1, 0, ?, ?, ?, ?)`,
          invoiceId,
          `banded-manifest-${invoiceId}`,
          `sha256:${'0'.repeat(64)}`,
          occurredAt,
          JSON.stringify(body),
          JSON.stringify({ schema_version: 1, time_entries: [], expenses: [] }),
          JSON.stringify({ schema_version: 1, lines: [] }),
        )

      await insert(500, manifest)
      await insert(501, {
        ...manifest,
        from: null,
        claim_mode: 'all',
        claim_ceiling_seconds: null,
        overage_summary_type: null,
        claimed_entry_count: 4,
        claimed_seconds: 72_900,
        billed_entry_count: 0,
        billed_seconds: 0,
      })
      for (const [invoiceId, body] of [
        // Everything, with a ceiling or an overage grouping beside it.
        [510, { ...manifest, claim_mode: 'all' }],
        [511, { ...manifest, claim_mode: 'all', claim_ceiling_seconds: null }],
        // A ceiling in both units, in neither, or with no grouping for the rest.
        [512, { ...manifest, claim_ceiling_cents: 100_000 }],
        [513, { ...manifest, claim_ceiling_seconds: null }],
        [514, { ...manifest, overage_summary_type: null }],
        [515, { ...manifest, overage_summary_type: 'category' }],
        // Entries that are neither covered nor billed, or billed twice over.
        [516, { ...manifest, billed_entry_count: 1 }],
        // No fee, or more fee lines than lines.
        [517, { ...manifest, fee_line_count: 0 }],
        [518, { ...manifest, fee_line_count: 4 }],
        // Expenses, a summary of the selection, an inverted or missing period.
        [519, { ...manifest, expense_count: 1 }],
        [520, { ...manifest, time_summary_type: 'people' }],
        [521, { ...manifest, from: '2026-09-01' }],
        [522, { ...manifest, to: null }],
        [523, { ...manifest, project_ids: [] }],
      ] as const) {
        await expect(insert(invoiceId, body)).rejects.toThrow(/CHECK constraint failed/)
      }
      expect(
        await database.rows(
          'SELECT invoice_id AS invoiceId FROM invoice_command_ledger ORDER BY invoice_id',
        ),
      ).toEqual([{ invoiceId: 500 }, { invoiceId: 501 }])
    })

    it('[unit] carries every receipt across the 0098 ledger rebuild and changes nothing else', async () => {
      active = await factory(false)
      await active.migrateThrough('0097_organization_invoice_defaults')
      await seed(active)
      const service = generator(active)
      const tracked = await service.generate(command('tracked-before-0098'))
      const blank = await service.generate(freeForm('blank-before-0098'))
      // Red before green: the old creation CHECK has no shape for a band.
      await expect(service.generate(banded('band-before-0098'))).rejects.toThrow(
        /CHECK constraint failed/,
      )
      const receipts = `SELECT * FROM invoice_command_ledger ORDER BY invoice_id, command_id`
      const before = { schema: await schemaObjects(active), receipts: await active.rows(receipts) }

      // Through 0098 alone: what is compared is that migration's change, not
      // whatever later migrations add.
      await active.migrateThrough('0098_banded_invoice_create')

      const after = { schema: await schemaObjects(active), receipts: await active.rows(receipts) }
      // Byte for byte, every receipt the rebuild copied.
      expect(after.receipts).toEqual(before.receipts)
      // The whole schema, object by object: the ledger's CHECK and the line
      // manifest guard changed, and nothing else did -- the ledger's index and
      // guards are back exactly as they were.
      const named = (rows: typeof before.schema) =>
        new Map(rows.map((row) => [`${row.type}:${row.name}`, row]))
      const old = named(before.schema)
      const rebuilt = named(after.schema)
      expect([...rebuilt.keys()].sort()).toEqual([...old.keys()].sort())
      expect(
        [...rebuilt.entries()]
          .filter(([key, row]) => old.get(key)?.sql !== row.sql)
          .map(([key]) => key)
          .sort(),
      ).toEqual(['table:invoice_command_ledger', 'trigger:invoice_generation_line_manifest_guard'])
      expect(rebuilt.get('table:invoice_command_ledger')!.sql).toContain(
        "json_extract(request_json, '$.kind') = 'banded'",
      )
      expect(rebuilt.get('trigger:invoice_generation_line_manifest_guard')!.sql).toContain(
        "line.project_id IS json_extract(member.value, '$.project_id')",
      )

      // The receipts written before still replay as themselves, on the
      // database as it stands today.
      await active.migrate()
      expect(await service.generate(command('tracked-before-0098'))).toEqual(tracked)
      expect(await service.generate(freeForm('blank-before-0098'))).toEqual(blank)
      // The tracked draft took the hours, so this band covers none of them.
      const band = await service.generate(banded('band-after-0098', hoursCeiling))
      expect(band).toMatchObject({ number: '3', amount_cents: 150_000 })
      expect(band.band).toMatchObject({ claimed_entry_count: 0, billed_entry_count: 0 })
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
