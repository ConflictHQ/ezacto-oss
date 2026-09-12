import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { migrateContainer } from '../src/migrate.js'
import {
  readTimeEntryClaim,
  releaseInvoicedTimeEntries,
} from '../src/release-invoiced-time.js'

/**
 * Issue 496. A test invoice raised during acceptance had to be removed by
 * rebuilding the production database, because 352 time entries were locked to
 * it and nothing could release them.
 *
 * Against a real migrated database, because the rule that matters is a trigger:
 * a repository check alone would be a rule a fix-up script at 2am walks past.
 */

const at = '2026-09-12T12:00:00.000Z'
let sqlite: BetterSqlite3.Database | null = null

const fixture = async (state: string) => {
  const database = new BetterSqlite3(':memory:')
  await migrateContainer(database)
  database.pragma('foreign_keys = ON')
  database.exec(`
    INSERT INTO organizations (name, modules, created_at, updated_at)
      VALUES ('Fixture', '{}', '${at}', '${at}');
    INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
      VALUES (1, 'Operator', 'One', 'administrator', '[]', '${at}', '${at}');
    INSERT INTO clients (id, name, currency, created_at, updated_at)
      VALUES (1, 'Kestrel Environmental', 'USD', '${at}', '${at}');
    INSERT INTO projects (id, client_id, name, code, is_active, billing_method, created_at, updated_at)
      VALUES (1, 1, 'Phase 1', 'P1', 1, 'time_materials', '${at}', '${at}');
    INSERT INTO tasks (id, name, billable_by_default, is_default, is_active, created_at, updated_at)
      VALUES (1, 'Advisory', 1, 1, 1, '${at}', '${at}');
    INSERT INTO user_assignments (id, project_id, user_id, created_at, updated_at)
      VALUES (1, 1, 1, '${at}', '${at}');
    INSERT INTO task_assignments (id, project_id, task_id, billable, created_at, updated_at)
      VALUES (1, 1, 1, 1, '${at}', '${at}');
    -- A paid invoice must carry exactly one of paid_at or paid_date, and a
    -- closed one must name why it closed. The shape trigger enforces both.
    INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date, state,
                          close_reason, paid_date, created_at, updated_at)
      VALUES (1, 1, '1315', 'USD', '2026-09-12', '2026-10-12', '${state}',
              ${state === 'closed' ? "'cancelled'" : 'NULL'},
              ${state === 'paid' ? "'2026-09-12'" : 'NULL'}, '${at}', '${at}');
    INSERT INTO time_entries (id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
                              spent_date, seconds, seconds_without_timer, rounded_seconds, billable,
                              invoice_id, created_at, updated_at)
      VALUES (1, 1, 1, 1, 1, 1, '2026-09-01', 3600, 3600, 3600, 1, 1, '${at}', '${at}');
    INSERT INTO time_entries (id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
                              spent_date, seconds, seconds_without_timer, rounded_seconds, billable,
                              invoice_id, created_at, updated_at)
      VALUES (2, 1, 1, 1, 1, 1, '2026-09-02', 7200, 7200, 7200, 1, 1, '${at}', '${at}');
  `)
  sqlite = database
  return createContainerDatabase(database)
}

afterEach(() => {
  sqlite?.close()
  sqlite = null
})

describe('releasing time from an invoice', () => {
  it('[money] refuses while the invoice is open', async () => {
    // An invoice a client has been sent must not quietly lose the hours behind
    // it: release them and it claims money nothing accounts for any more.
    const database = await fixture('open')
    expect(await releaseInvoicedTimeEntries(database, 1)).toEqual({
      refused: 'invoice_still_stands',
    })
    expect(
      sqlite!.prepare(`SELECT count(*) AS n FROM time_entries WHERE invoice_id = 1`).get(),
    ).toEqual({ n: 2 })
  })

  it('[money] refuses while the invoice is paid', async () => {
    const database = await fixture('paid')
    expect(await releaseInvoicedTimeEntries(database, 1)).toEqual({
      refused: 'invoice_still_stands',
    })
  })

  it('[money] releases every entry once the invoice has been closed', async () => {
    // Cancelled or written off: the hours are no longer supporting a live claim.
    const database = await fixture('closed')
    expect(await releaseInvoicedTimeEntries(database, 1)).toEqual({ released: 2 })
    expect(
      sqlite!.prepare(`SELECT count(*) AS n FROM time_entries WHERE invoice_id IS NULL`).get(),
    ).toEqual({ n: 2 })
  })

  it('[money] releases from a draft, which was never sent', async () => {
    const database = await fixture('draft')
    expect(await releaseInvoicedTimeEntries(database, 1)).toEqual({ released: 2 })
  })

  it('[unit] says so when the invoice does not exist', async () => {
    const database = await fixture('closed')
    expect(await releaseInvoicedTimeEntries(database, 404)).toEqual({
      refused: 'invoice_not_found',
    })
  })

  it('[unit] reports nothing released rather than failing when there is nothing to release', async () => {
    const database = await fixture('closed')
    await releaseInvoicedTimeEntries(database, 1)
    expect(await releaseInvoicedTimeEntries(database, 1)).toEqual({ released: 0 })
  })
})

describe('what the schema refuses directly', () => {
  it('[money] refuses to clear the claim while the invoice stands', async () => {
    // The rule has to hold against a statement nobody reviewed, which is the
    // shape the original incident took.
    await fixture('open')
    expect(() =>
      sqlite!.exec(`UPDATE time_entries SET invoice_id = NULL WHERE id = 1`),
    ).toThrow(/cannot be released while its invoice stands/u)
  })

  it('[money] refuses to delete the entry out from under a standing invoice', async () => {
    // The identical hole reached by a different statement: deleting the row
    // takes the hours with it.
    await fixture('open')
    expect(() => sqlite!.exec(`DELETE FROM time_entries WHERE id = 1`)).toThrow(
      /cannot be deleted while its invoice stands/u,
    )
  })

  it('[unit] leaves an unclaimed entry alone', async () => {
    // The guard is about billed hours, not about time entries in general.
    await fixture('open')
    sqlite!.exec(`
      INSERT INTO time_entries (id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
         spent_date, seconds, seconds_without_timer, rounded_seconds, billable, created_at, updated_at)
        VALUES (3, 1, 1, 1, 1, 1, '2026-09-03', 1800, 1800, 1800, 1, '${at}', '${at}');
    `)
    sqlite!.exec(`DELETE FROM time_entries WHERE id = 3`)
    expect(sqlite!.prepare(`SELECT count(*) AS n FROM time_entries`).get()).toEqual({ n: 2 })
  })

  it('[unit] allows the delete once the entry has been released', async () => {
    const database = await fixture('closed')
    await releaseInvoicedTimeEntries(database, 1)
    sqlite!.exec(`DELETE FROM time_entries WHERE id = 1`)
    expect(sqlite!.prepare(`SELECT count(*) AS n FROM time_entries`).get()).toEqual({ n: 1 })
  })
})

describe('what a screen can ask before offering delete', () => {
  it('[unit] reports a claimed entry as not deletable, with the invoice that holds it', async () => {
    const database = await fixture('open')
    expect(await readTimeEntryClaim(database, 1)).toEqual({
      invoiceId: 1,
      invoiceState: 'open',
      deletable: false,
    })
  })

  it('[unit] reports an unclaimed entry as deletable', async () => {
    const database = await fixture('open')
    sqlite!.exec(`
      INSERT INTO time_entries (id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
         spent_date, seconds, seconds_without_timer, rounded_seconds, billable, created_at, updated_at)
        VALUES (3, 1, 1, 1, 1, 1, '2026-09-03', 1800, 1800, 1800, 1, '${at}', '${at}');
    `)
    expect(await readTimeEntryClaim(database, 3)).toEqual({
      invoiceId: null,
      invoiceState: null,
      deletable: true,
    })
  })

  it('[unit] answers for an entry that does not exist', async () => {
    const database = await fixture('open')
    expect(await readTimeEntryClaim(database, 404)).toBeNull()
  })
})
