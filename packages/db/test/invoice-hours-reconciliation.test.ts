import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { readInvoiceHoursReconciliation, readInvoiceJournal } from '../src/index.js'
import { migrateContainer } from '../src/migrate.js'

/**
 * Issue 924. Against a real migrated database, because the figure must be the
 * same one the hours report totals: linked by `time_entries.invoice_id`, at
 * `rounded_seconds`.
 */

const at = '2026-09-12T12:00:00.000Z'
let sqlite: BetterSqlite3.Database | null = null

const fixture = async () => {
  const database = new BetterSqlite3(':memory:')
  await migrateContainer(database)
  database.pragma('foreign_keys = ON')
  database.exec(`
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
  `)
  sqlite = database
  return createContainerDatabase(database)
}

afterEach(() => {
  sqlite?.close()
  sqlite = null
})

const entry = (
  id: number,
  projectId: number,
  seconds: number,
  rounded: number,
  invoiceId: number | null,
) =>
  sqlite!.exec(`
    INSERT INTO time_entries (id, user_id, project_id, task_id, user_assignment_id,
                              task_assignment_id, spent_date, seconds, seconds_without_timer,
                              rounded_seconds, billable, invoice_id, created_at, updated_at)
      VALUES (${String(id)}, 1, ${String(projectId)}, 1, ${String(projectId)}, ${String(projectId)},
              '2026-09-0${String(id)}', ${String(seconds)}, ${String(seconds)},
              ${String(rounded)}, 1,
              ${invoiceId === null ? 'NULL' : String(invoiceId)}, '${at}', '${at}');
  `)

const line = (
  id: number,
  invoiceId: number,
  projectId: number | null,
  quantity: number,
) =>
  sqlite!.exec(`
    INSERT INTO invoice_line_items (id, invoice_id, position, kind, description, quantity,
                                    unit_price_cents, amount_cents, project_id, created_at, updated_at)
      VALUES (${String(id)}, ${String(invoiceId)}, ${String(id)}, 'Service', 'Line ${String(id)}',
              ${String(quantity)}, 15000, 0, ${projectId === null ? 'NULL' : String(projectId)},
              '${at}', '${at}');
  `)

describe('reading an invoice against the time it claims', () => {
  it('[money] totals the rounded seconds the journal totals, per project', async () => {
    const database = await fixture()
    entry(1, 1, 3500, 3600, 1)
    entry(2, 1, 1700, 1800, 1)
    entry(3, 2, 7100, 7200, 1)
    // Another invoice's time and unbilled time are not this invoice's.
    entry(4, 1, 3600, 3600, 2)
    entry(5, 1, 3600, 3600, null)
    line(1, 1, 1, 1)
    line(2, 1, 2, 2)
    line(3, 1, null, 3)
    const result = await readInvoiceHoursReconciliation(database, 1)
    expect(result).toMatchObject({
      linkedSeconds: 12_600,
      billedSeconds: 10_800,
      differenceSeconds: -1800,
      status: 'billed_below_linked',
      projects: [
        { projectId: 1, projectName: 'Phase 1', linkedSeconds: 5400, billedSeconds: 3600 },
        { projectId: 2, projectName: 'Phase 2', linkedSeconds: 7200, billedSeconds: 7200, status: 'matched' },
      ],
      notCompared: [expect.objectContaining({ id: 3, projectId: null, quantity: 3 })],
    })
    // The same number the hours report totals.
    const journal = await readInvoiceJournal(database, 1)
    expect(journal.reduce((sum, row) => sum + row.seconds, 0)).toBe(result!.linkedSeconds)
  })

  it('[unit] is an empty, matched result for an invoice with no time and no lines', async () => {
    const database = await fixture()
    expect(await readInvoiceHoursReconciliation(database, 1)).toMatchObject({
      linkedSeconds: 0,
      billedSeconds: 0,
      status: 'matched',
      projects: [],
      notCompared: [],
    })
  })

  it('[unit] is null for an invoice that does not exist', async () => {
    const database = await fixture()
    expect(await readInvoiceHoursReconciliation(database, 404)).toBeNull()
  })
})
