import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import { executeInvoiceEdit } from '../src/invoice-state.js'
import { sql } from 'drizzle-orm'
import { createInvoiceGenerationService } from '../src/invoice-generation.js'
import { createD1Database, createContainerDatabase } from '../src/adapters.js'
import { readInvoiceHoursReconciliation, readInvoiceJournal } from '../src/index.js'
import { migrateD1, migrateContainer } from '../src/migrate.js'

/**
 * Issue 924. Against a real migrated database, because the figure must be the
 * same one the hours report totals: linked by `time_entries.invoice_id`, at
 * `rounded_seconds`.
 */

const at = '2026-09-12T12:00:00.000Z'
let active:
  | ReturnType<typeof createContainerDatabase>
  | ReturnType<typeof createD1Database>
  | undefined
let dispose: (() => Promise<void>) | undefined
const execute = async (query: string) => {
  await active!.run(sql.raw(query))
}

const fixture = async (runtime: 'sqlite' | 'd1') => {
  if (runtime === 'sqlite') {
    const sqlite = new BetterSqlite3(':memory:')
    migrateContainer(sqlite)
    active = createContainerDatabase(sqlite)
    dispose = async () => {
      sqlite.close()
    }
  } else {
    const mf = new Miniflare({
      modules: true,
      script: 'export default {fetch(){return new Response("ok")}}',
      d1Databases: ['DB'],
    })
    const binding = await mf.getD1Database('DB')
    await migrateD1(binding)
    active = createD1Database(binding)
    dispose = () => mf.dispose()
  }
  const seed = `
    INSERT INTO organizations (name, modules, created_at, updated_at)
      VALUES ('Fixture', '{}', '${at}', '${at}');
    INSERT INTO clients (id, name, currency, created_at, updated_at)
      VALUES (1, 'Kestrel Environmental', 'USD', '${at}', '${at}');
    INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date, state, created_at, updated_at)
      VALUES (1, 1, '1315', 'USD', '2026-09-12', '2026-10-12', 'draft', '${at}', '${at}');
    INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date, state, created_at, updated_at)
      VALUES (2, 1, '1316', 'USD', '2026-09-12', '2026-10-12', 'draft', '${at}', '${at}');
    INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
      VALUES (1, 'R.', 'Adeyemi', 'administrator', '[]', '${at}', '${at}');
    INSERT INTO projects (id, client_id, name, code, is_active, billing_method, created_at, updated_at)
      VALUES (1, 1, 'Phase 1', 'P1', 1, 'time_materials', '${at}', '${at}');
    INSERT INTO projects (id, client_id, name, code, is_active, billing_method, created_at, updated_at)
      VALUES (2, 1, 'Phase 2', 'P2', 1, 'time_materials', '${at}', '${at}');
    INSERT INTO tasks (id, name, billable_by_default, is_default, is_active, created_at, updated_at)
      VALUES (1, 'Advisory', 1, 1, 1, '${at}', '${at}');
    INSERT INTO user_assignments (id, project_id, user_id, created_at, updated_at)
      VALUES (1, 1, 1, '${at}', '${at}'), (2, 2, 1, '${at}', '${at}');
    INSERT INTO task_assignments (id, project_id, task_id, billable, created_at, updated_at)
      VALUES (1, 1, 1, 1, '${at}', '${at}'), (2, 2, 1, 1, '${at}', '${at}');
  `
  for (const statement of seed
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean))
    await execute(statement)
  return active!
}

afterEach(async () => {
  await dispose?.()
  dispose = undefined
  active = undefined
})

const entry = (
  id: number,
  projectId: number,
  seconds: number,
  rounded: number,
  invoiceId: number | null,
) =>
  execute(`
    INSERT INTO time_entries (id, user_id, project_id, task_id, user_assignment_id,
                              task_assignment_id, spent_date, seconds, seconds_without_timer,
                              rounded_seconds, billable, invoice_id, created_at, updated_at)
      VALUES (${String(id)}, 1, ${String(projectId)}, 1, ${String(projectId)}, ${String(projectId)},
              '2026-09-0${String(id)}', ${String(seconds)}, ${String(seconds)},
              ${String(rounded)}, 1,
              ${invoiceId === null ? 'NULL' : String(invoiceId)}, '${at}', '${at}');
  `)

const line = (id: number, invoiceId: number, projectId: number | null, quantity: number) =>
  execute(`
    INSERT INTO invoice_line_items (id, invoice_id, position, kind, description, quantity,
                                    unit_price_cents, amount_cents, project_id, created_at, updated_at)
      VALUES (${String(id)}, ${String(invoiceId)}, ${String(id)}, 'Service', 'Line ${String(id)}',
              ${String(quantity)}, 15000, 0, ${projectId === null ? 'NULL' : String(projectId)},
              '${at}', '${at}');
  `)

for (const runtime of ['sqlite', 'd1'] as const)
  describe(`reading linked invoice hours (${runtime})`, () => {
    it('[money] totals the journal without inventing hour units for unknown legacy lines', async () => {
      const database = await fixture(runtime)
      await entry(1, 1, 3500, 3600, 1)
      await entry(2, 1, 1700, 1800, 1)
      await entry(3, 2, 7100, 7200, 1)
      // Another invoice's time and unbilled time are not this invoice's.
      await entry(4, 1, 3600, 3600, 2)
      await entry(5, 1, 3600, 3600, null)
      await line(1, 1, 1, 1)
      await line(2, 1, 2, 2)
      await line(3, 1, null, 3)
      const result = await readInvoiceHoursReconciliation(database, 1)
      expect(result).toMatchObject({
        linkedSeconds: 12600,
        billedSeconds: 0,
        status: 'not_comparable',
        comparisonComplete: false,
        hasMismatch: false,
      })
      expect(result!.notCompared.map((line) => line.id)).toEqual([1, 2, 3])
      // The same number the hours report totals.
      const journal = await readInvoiceJournal(database, 1)
      expect(journal.reduce((sum, row) => sum + row.seconds, 0)).toBe(result!.linkedSeconds)
    })

    it('[unit] is an empty, matched result for an invoice with no time and no lines', async () => {
      const database = await fixture(runtime)
      expect(await readInvoiceHoursReconciliation(database, 1)).toMatchObject({
        linkedSeconds: 0,
        billedSeconds: 0,
        status: 'matched',
        projects: [],
        notCompared: [],
      })
    })

    it('[unit] is null for an invoice that does not exist', async () => {
      const database = await fixture(runtime)
      expect(await readInvoiceHoursReconciliation(database, 404)).toBeNull()
    })
    it('[money] retains exact per-person origins through a quantity cap without counting fees as hours', async () => {
      const database = await fixture(runtime)
      await execute(`UPDATE organizations SET modules='{"invoices":true}'`)
      await execute(
        `INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(2,'Second','Person','member','[]','${at}','${at}')`,
      )
      await execute(
        `INSERT INTO user_assignments(id,project_id,user_id,created_at,updated_at) VALUES(3,1,2,'${at}','${at}')`,
      )
      await entry(1, 1, 7200, 7200, null)
      await entry(2, 1, 3600, 3600, null)
      await execute('UPDATE time_entries SET user_id=2,user_assignment_id=3 WHERE id=2')
      await execute('UPDATE time_entries SET billable_rate_cents=15000')
      const invoice = await createInvoiceGenerationService(database, { clock: () => at }).generate({
        commandId: 'hours-origin',
        principal: { userId: 1, profile: 'administrator' },
        request: {
          clientId: 1,
          from: '2026-09-01',
          to: '2026-09-30',
          projectIds: [1],
          timeSummaryType: 'people',
          expenseSummaryType: null,
        },
      })
      const original = await readInvoiceHoursReconciliation(database, invoice.id)
      expect(original).toMatchObject({
        status: 'matched',
        hasMismatch: false,
        comparisonComplete: true,
        linkedSeconds: 10800,
        billedSeconds: 10800,
      })
      expect(original!.lines.map((line) => line.entryIds)).toEqual([[1], [2]])
      const capped = original!.lines.find((line) => line.entryIds.includes(1))!
      const originalLine = invoice.line_items.find((line) => line.id === capped.lineId)!
      const edited = await executeInvoiceEdit(database, {
        invoiceId: invoice.id,
        commandId: 'cap-924',
        actor: { type: 'user', id: 1 },
        authorize: async () => true,
        expectedVersion: invoice.version,
        occurredAt: at,
        eventIds: ['cap-924-event'],
        edit: {
          type: 'line_update',
          lineId: capped.lineId,
          expectedLineUpdatedAt: originalLine.updated_at,
          position: originalLine.position,
          kind: originalLine.kind,
          description: originalLine.description,
          projectId: originalLine.project_id,
          quantity: 1.5,
          unitPriceCents: 15000,
          amountCents: 22500,
          taxed: false,
          taxed2: false,
        },
      })
      await executeInvoiceEdit(database, {
        invoiceId: invoice.id,
        commandId: 'fee-924',
        actor: { type: 'user', id: 1 },
        authorize: async () => true,
        expectedVersion: edited.invoice.version,
        occurredAt: at,
        eventIds: ['fee-924-event'],
        edit: {
          type: 'line_insert',
          lineId: 99,
          position: 99,
          kind: 'Service',
          description: 'Fixed fee',
          projectId: 1,
          quantity: 12,
          unitPriceCents: 15000,
          amountCents: 180000,
          taxed: false,
          taxed2: false,
        },
      })
      const after = await readInvoiceHoursReconciliation(database, invoice.id)
      expect(after).toMatchObject({
        status: 'billed_below_linked',
        hasMismatch: true,
        comparisonComplete: true,
        linkedSeconds: 10800,
        billedSeconds: 9000,
      })
      expect(after!.lines.find((line) => line.lineId === capped.lineId)).toMatchObject({
        linkedSeconds: 7200,
        billedSeconds: 5400,
        differenceSeconds: -1800,
      })
      expect(after!.notCompared.map((line) => line.id)).toEqual([99])
      expect(
        (await readInvoiceJournal(database, invoice.id)).reduce((sum, row) => sum + row.seconds, 0),
      ).toBe(after!.linkedSeconds)
      // Releasing one linked entry changes the comparison immediately, while the
      // immutable origin continues to identify that generated line.
      await execute('UPDATE time_entries SET invoice_id=NULL WHERE id=2')
      expect(
        (await readInvoiceHoursReconciliation(database, invoice.id))!.lines.find((line) =>
          line.entryIds.includes(1),
        ),
      ).toMatchObject({ linkedSeconds: 7200 })
    }, 60000)
  })
