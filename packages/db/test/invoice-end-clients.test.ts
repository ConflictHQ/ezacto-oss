import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { groupInvoiceLinesByEndClient } from '@ezacto/core'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { createInvoiceGenerationService } from '../src/invoice-generation.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { createMoneyResourceRepository } from '../src/money-resources.js'
import { createReportRepository } from '../src/reports.js'

/**
 * Issue 33 (F7): one invoice for a parent client, the work of every client
 * beneath it, each line attributed to its end-client by its project and the
 * lines grouped and subtotalled per end-client.
 *
 * The tree, three levels deep with a sibling, a euro branch and an outsider:
 *
 *   1 Parent Holdings (USD)
 *   +-- 4 Alpha Unit (USD)
 *   +-- 2 Bravo Division (USD)
 *   |   +-- 3 Charlie Site (USD)
 *   +-- 6 Euro Branch (EUR)
 *   5 Unrelated Co (USD)
 *
 * Each client has one project of the same number. Run on both runtimes, since
 * the claim and the guards are SQL that D1 and SQLite each execute.
 */

const at = '2026-08-31T12:00:00.000Z'
const principal = { userId: 1, profile: 'administrator' }
const range = { from: '2026-08-01', to: '2026-08-31' }

interface TestDatabase {
  orm: ReturnType<typeof createContainerDatabase> | ReturnType<typeof createD1Database>
  run(sql: string, ...params: unknown[]): Promise<void>
  rows<T>(sql: string, ...params: unknown[]): Promise<T[]>
  close(): Promise<void>
}

const container = async (): Promise<TestDatabase> => {
  const client = new BetterSqlite3(':memory:')
  migrateContainer(client)
  return {
    orm: createContainerDatabase(client),
    run: async (sql, ...params) => {
      client.prepare(sql).run(...params)
    },
    rows: async <T>(sql: string, ...params: unknown[]) => client.prepare(sql).all(...params) as T[],
    close: async () => {
      client.close()
    },
  }
}

const d1 = async (): Promise<TestDatabase> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const client = await miniflare.getD1Database('DB')
  await migrateD1(client)
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
    close: async () => miniflare.dispose(),
  }
}

const factories = [
  ['container', container],
  ['D1', d1],
] as const

// Seconds worked at 100.00 an hour, by project number.
const worked: Record<number, number> = { 1: 3600, 2: 5400, 3: 1800, 4: 7200, 5: 3600, 6: 3600 }

const seed = async (database: TestDatabase): Promise<void> => {
  await database.run(
    `INSERT INTO organizations (id, name, modules, created_at, updated_at)
     VALUES (1, 'End Client Org', ?, ?, ?)`,
    JSON.stringify({ expenses: true, invoices: true }),
    at,
    at,
  )
  await database.run(
    `INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
     VALUES (1, 'Invoice', 'Owner', 'administrator', '[]', ?, ?),
            (2, 'Tracked', 'Person', 'member', '[]', ?, ?)`,
    at,
    at,
    at,
    at,
  )
  // Parents first: a parent has to exist before its child names it.
  const clients: Array<[number, string, number | null, string]> = [
    [1, 'Parent Holdings', null, 'USD'],
    [2, 'Bravo Division', 1, 'USD'],
    [3, 'Charlie Site', 2, 'USD'],
    [4, 'Alpha Unit', 1, 'USD'],
    [5, 'Unrelated Co', null, 'USD'],
    [6, 'Euro Branch', 1, 'EUR'],
  ]
  for (const [id, name, parent, currency] of clients) {
    await database.run(
      `INSERT INTO clients (id, name, parent_client_id, currency, payment_terms, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'net_30', ?, ?)`,
      id,
      name,
      parent,
      currency,
      at,
      at,
    )
  }
  await database.run(
    `INSERT INTO tasks (id, name, created_at, updated_at) VALUES (1, 'Consulting', ?, ?)`,
    at,
    at,
  )
  await database.run(
    `INSERT INTO expense_categories (id, name, created_at, updated_at) VALUES (1, 'Travel', ?, ?)`,
    at,
    at,
  )
  for (const id of [1, 2, 3, 4, 5, 6]) {
    await database.run(
      `INSERT INTO projects (id, client_id, name, code, hourly_rate_cents, created_at, updated_at)
       VALUES (?, ?, ?, ?, 10000, ?, ?)`,
      id,
      id,
      `Project ${id}`,
      `P${id}`,
      at,
      at,
    )
    await database.run(
      `INSERT INTO user_assignments (id, project_id, user_id, created_at, updated_at)
       VALUES (?, ?, 2, ?, ?)`,
      id,
      id,
      at,
      at,
    )
    await database.run(
      `INSERT INTO task_assignments (id, project_id, task_id, billable, created_at, updated_at)
       VALUES (?, ?, 1, 1, ?, ?)`,
      id,
      id,
      at,
      at,
    )
    await database.run(
      `INSERT INTO time_entries (
         id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
         spent_date, seconds, seconds_without_timer, rounded_seconds, billable,
         billable_rate_cents, cost_rate_cents, created_at, updated_at
       ) VALUES (?, 2, ?, 1, ?, ?, '2026-08-10', ?, ?, ?, 1, 10000, 5000, ?, ?)`,
      id,
      id,
      id,
      id,
      worked[id]!,
      worked[id]!,
      worked[id]!,
      at,
      at,
    )
  }
  await database.run(
    `INSERT INTO expenses (
       id, user_id, project_id, expense_category_id, spent_date, total_cost_cents, billable,
       created_at, updated_at
     ) VALUES (1, 2, 2, 1, '2026-08-12', 1250, 1, ?, ?),
              (2, 2, 3, 1, '2026-08-12', 333, 1, ?, ?)`,
    at,
    at,
    at,
    at,
  )
}

const tracked = (clientId: number, projectIds: number[], commandId: string) => ({
  commandId,
  principal,
  request: {
    clientId,
    ...range,
    projectIds,
    timeSummaryType: 'project' as const,
    expenseSummaryType: 'project' as const,
  },
})

const outsideTree = 'every selected project must belong to the selected client or a client beneath it'

for (const [runtime, factory] of factories) {
  describe(`one invoice, many end-clients (${runtime})`, { timeout: 120_000 }, () => {
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
    const generator = (database: TestDatabase) =>
      createInvoiceGenerationService(database.orm, { clock: () => at })

    it('[unit] groups lines by the end-client their project attributes them to, in tree order', async () => {
      const database = await setup()
      const invoice = await generator(database).generate(tracked(1, [1, 2, 3, 4], 'end-clients'))

      // Parent first, then its children by name (Alpha before Bravo), each
      // child followed by what is beneath it; within a client its time and
      // then its expenses.
      expect(invoice.line_items.map((line) => [line.project_id, line.kind])).toEqual([
        [1, 'Service'],
        [4, 'Service'],
        [2, 'Service'],
        [2, 'Expense'],
        [3, 'Service'],
        [3, 'Expense'],
      ])
      expect(invoice.line_items.map((line) => line.amount_cents)).toEqual([
        10_000, 20_000, 15_000, 1_250, 5_000, 333,
      ])
      expect(invoice.amount_cents).toBe(51_583)
      expect(invoice.client_id).toBe(1)
      // Four projects: no one project stands for the invoice.
      expect(invoice.project_id).toBeNull()
      expect(
        await database.rows(
          `SELECT
             (SELECT count(*) FROM time_entries WHERE invoice_id = ?) AS time,
             (SELECT count(*) FROM expenses WHERE invoice_id = ?) AS expenses,
             (SELECT count(*) FROM time_entries WHERE invoice_id IS NULL) AS untouched`,
          invoice.id,
          invoice.id,
        ),
      ).toEqual([{ time: 4, expenses: 2, untouched: 2 }])
    })

    it('[unit] per-end-client subtotals equal each end-client uninvoiced, to the cent', async () => {
      const database = await setup()
      const reports = createReportRepository(database.orm)
      const uninvoiced = new Map<number, number>()
      for (const projectId of [1, 2, 3, 4]) {
        const report = await reports.uninvoiced({ projectId, ...range })
        expect(report.totals).toHaveLength(1)
        uninvoiced.set(projectId, report.totals[0]!.timeCents + report.totals[0]!.expenseCents)
      }
      expect([...uninvoiced.values()]).toEqual([10_000, 16_250, 5_333, 20_000])

      const invoice = await generator(database).generate(tracked(1, [1, 2, 3, 4], 'subtotals'))
      const context = await createMoneyResourceRepository(database.orm).getInvoiceDocumentContext(
        invoice.id,
      )
      const grouped = groupInvoiceLinesByEndClient(context!.lineItems)!
      expect(grouped.sections.map((section) => [section.endClientId, section.endClientName])).toEqual([
        [1, 'Parent Holdings'],
        [4, 'Alpha Unit'],
        [2, 'Bravo Division'],
        [3, 'Charlie Site'],
      ])
      // Each end-client has one project here, so its subtotal is that project's.
      for (const section of grouped.sections) {
        expect(section.subtotalCents).toBe(uninvoiced.get(section.endClientId))
      }
      expect(grouped.sections.reduce((sum, section) => sum + section.subtotalCents, 0)).toBe(
        invoice.amount_cents,
      )
      expect(grouped.ungrouped).toEqual([])
    })

    it('[unit] refuses a project outside the tree, or above the invoice client', async () => {
      const database = await setup()
      const service = generator(database)
      await expect(service.generate(tracked(1, [1, 5], 'outsider'))).rejects.toThrow(outsideTree)
      // Bravo's invoice reaches Charlie, never its parent or its sibling.
      await expect(service.generate(tracked(2, [2, 1], 'ancestor'))).rejects.toThrow(outsideTree)
      await expect(service.generate(tracked(2, [2, 4], 'sibling'))).rejects.toThrow(outsideTree)
      expect(await database.rows(`SELECT count(*) AS n FROM invoices`)).toEqual([{ n: 0 }])
    })

    it('[unit] keeps one invoice to one currency', async () => {
      const database = await setup()
      const service = generator(database)
      await expect(service.generate(tracked(1, [1, 6], 'mixed'))).rejects.toThrow(
        'selected tracked rows must use one invoice currency',
      )
      expect(await database.rows(`SELECT count(*) AS n FROM invoices`)).toEqual([{ n: 0 }])
      // The euro branch alone is a euro invoice for the parent, claimed
      // through a project that is not the parent's own.
      const euro = await service.generate(tracked(1, [6], 'euro-only'))
      expect(euro).toMatchObject({ client_id: 1, currency: 'EUR', amount_cents: 10_000 })
      expect(euro.project_id).toBeNull()
      // And the dollar tree goes on separately, untouched by the euro claim.
      const dollars = await service.generate(tracked(1, [1, 2, 3, 4], 'dollars'))
      expect(dollars).toMatchObject({ currency: 'USD', amount_cents: 51_583 })
    })

    it('[unit] an invoice for one client is the lines it always was', async () => {
      const database = await setup()
      const invoice = await generator(database).generate(tracked(2, [2], 'single'))
      expect(invoice.line_items.map((line) => [line.kind, line.amount_cents])).toEqual([
        ['Service', 15_000],
        ['Expense', 1_250],
      ])
      const context = await createMoneyResourceRepository(database.orm).getInvoiceDocumentContext(
        invoice.id,
      )
      expect(groupInvoiceLinesByEndClient(context!.lineItems)).toBeNull()
    })

    it('[unit] the ledger still refuses a project outside the invoice client tree', async () => {
      const database = await setup()
      const invoice = await generator(database).generate(tracked(1, [1, 2], 'guard'))
      await expect(
        database.run(`UPDATE time_entries SET invoice_id = ? WHERE id = 5`, invoice.id),
      ).rejects.toThrow(/time entry project must belong to invoice client/)
      await expect(
        database.run(`UPDATE expenses SET project_id = 5, invoice_id = ? WHERE id = 1`, invoice.id),
      ).rejects.toThrow(/expense project must belong to invoice client/)
      // A client may not be re-pointed so an end-client falls outside the tree.
      await expect(
        database.run(`UPDATE invoices SET client_id = 4 WHERE id = ?`, invoice.id),
      ).rejects.toThrow(/invoice client must match every linked project|pending command/)
    })
  })
}
