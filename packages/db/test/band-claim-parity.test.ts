import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { backfillBandClaims } from '../src/band-claim-backfill.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import {
  createRecurringInvoiceDefinition,
  type RecurringInvoiceDatabase,
} from '../src/recurring-invoices.js'
import {
  createRecurringInvoiceEngine,
  type RecurringEngineDatabase,
} from '../src/recurring-invoice-engine.js'

/**
 * Issue 941. A band filled in afterwards must hold exactly what the engine
 * would have given it when it was raised. The backfill used to take every
 * billable hour up to the issue date whatever the band's terms said, so a band
 * with a ceiling claimed past it, and one that counts every tracked hour left
 * its non-billable hours behind.
 *
 * Each case runs the same data twice: once through a live generation of a band
 * that carried its terms from the start, once through a band raised before it
 * could claim and then backfilled under the same terms. The two must claim the
 * same entries and record the same value absorbed.
 */

interface TestDatabase {
  orm: RecurringEngineDatabase
  run(sql: string, ...params: unknown[]): Promise<void>
  rows<T>(sql: string, ...params: unknown[]): Promise<T[]>
  close(): Promise<void>
}

const at = '2026-08-28T12:00:00.000Z'
const issueDate = '2026-09-10'

const containerDatabase = async (): Promise<TestDatabase> => {
  const sqlite = new BetterSqlite3(':memory:')
  migrateContainer(sqlite)
  return {
    orm: createContainerDatabase(sqlite),
    run: async (sql, ...params) => {
      sqlite.prepare(sql).run(...params)
    },
    rows: async <T>(sql: string, ...params: unknown[]) => sqlite.prepare(sql).all(...params) as T[],
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
  await migrateD1(d1)
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
    close: async () => miniflare.dispose(),
  }
}

const factories = [
  ['container', containerDatabase],
  ['D1', d1Database],
] as const

interface Entry {
  spentDate: string
  seconds: number
  rateCents: number | null
  billable: boolean
}

/** The terms under test, as the definition's own columns. */
interface Terms {
  claim_mode: 'all' | 'ceiling'
  claim_ceiling_seconds: number | null
  claim_ceiling_cents: number | null
  claim_scope: 'billable' | 'tracked'
}

const seed = async (database: TestDatabase, entries: readonly Entry[]): Promise<number> => {
  await database.run(
    `INSERT INTO organizations (name, modules, created_at, updated_at)
     VALUES ('Parity Organization', '{"invoices":true}', ?, ?)`,
    at,
    at,
  )
  await database.run(
    `INSERT INTO clients (id, name, currency, created_at, updated_at)
     VALUES (1, 'Parity Client', 'USD', ?, ?)`,
    at,
    at,
  )
  await database.run(
    `INSERT INTO users (id, first_name, last_name, profile, is_active, manager_grants, created_at, updated_at)
     VALUES (1, 'Admin', 'User', 'administrator', 1, '[]', ?, ?)`,
    at,
    at,
  )
  await database.run(
    `INSERT INTO projects (id, client_id, name, code, created_at, updated_at)
     VALUES (1, 1, 'Parity Project', 'PAR', ?, ?)`,
    at,
    at,
  )
  await database.run(
    `INSERT INTO tasks (id, name, billable_by_default, is_default, is_active, created_at, updated_at)
     VALUES (1, 'Advisory', 1, 1, 1, ?, ?)`,
    at,
    at,
  )
  await database.run(
    `INSERT INTO user_assignments (id, project_id, user_id, created_at, updated_at)
     VALUES (1, 1, 1, ?, ?)`,
    at,
    at,
  )
  await database.run(
    `INSERT INTO task_assignments (id, project_id, task_id, billable, created_at, updated_at)
     VALUES (1, 1, 1, 1, ?, ?)`,
    at,
    at,
  )
  for (const [index, entry] of entries.entries()) {
    await database.run(
      `INSERT INTO time_entries (id, user_id, project_id, task_id, user_assignment_id,
                                 task_assignment_id, spent_date, seconds, seconds_without_timer,
                                 rounded_seconds, billable, billable_rate_cents,
                                 created_at, updated_at)
       VALUES (?, 1, 1, 1, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      index + 1,
      entry.spentDate,
      entry.seconds,
      entry.seconds,
      entry.seconds,
      entry.billable ? 1 : 0,
      entry.rateCents,
      at,
      at,
    )
  }
  const definition = await createRecurringInvoiceDefinition(
    database.orm as unknown as RecurringInvoiceDatabase,
    {
      clientId: 1,
      subjectTemplate: 'Banded team',
      notesTemplate: '',
      everyNMonths: 1,
      dayOfMonth: 10,
      nextIssueOn: issueDate,
      amountConfig: {
        schema_version: 1,
        type: 'fixed_lines',
        line_items: [
          {
            kind: 'Service',
            description: 'Banded team',
            quantity: 1,
            unit_price_cents: 10_000,
            taxed: false,
            taxed2: false,
            project_id: null,
          },
        ],
      },
      createdAt: at,
      updatedAt: at,
    },
  )
  return definition.id
}

const setTerms = (database: TestDatabase, definitionId: number, terms: Terms): Promise<void> =>
  database.run(
    `UPDATE recurring_invoices SET claims_project_ids = '[1]', claim_mode = ?,
       claim_ceiling_seconds = ?, claim_ceiling_cents = ?, claim_scope = ?
     WHERE id = ?`,
    terms.claim_mode,
    terms.claim_ceiling_seconds,
    terms.claim_ceiling_cents,
    terms.claim_scope,
    definitionId,
  )

const generate = (database: TestDatabase, definitionId: number) =>
  createRecurringInvoiceEngine(database.orm, {
    clock: () => `${issueDate}T10:00:00.000Z`,
  }).generate(definitionId, issueDate, { type: 'user', userId: 1, profile: 'administrator' })

const claimedBy = async (database: TestDatabase, invoiceId: number) => {
  const entries = await database.rows<{ id: number }>(
    `SELECT id FROM time_entries WHERE invoice_id = ? ORDER BY id`,
    invoiceId,
  )
  const [invoice] = await database.rows<{ foregone: number }>(
    `SELECT foregone_billable_cents AS foregone FROM invoices WHERE id = ?`,
    invoiceId,
  )
  return { entries: entries.map((row) => row.id), foregone: invoice!.foregone }
}

const hour = 3_600

const cases: readonly {
  name: string
  terms: Terms
  entries: readonly Entry[]
  claims: readonly number[]
}[] = [
  {
    // Two hours of ceiling, every tracked hour counted: the first billable hour
    // and the non-billable half hour after it fit, the next hour does not, and
    // nothing after the issue date is the band's.
    name: 'a time ceiling that counts every tracked hour',
    terms: {
      claim_mode: 'ceiling',
      claim_ceiling_seconds: 2 * hour,
      claim_ceiling_cents: null,
      claim_scope: 'tracked',
    },
    entries: [
      { spentDate: '2026-08-03', seconds: hour, rateCents: 25_000, billable: true },
      { spentDate: '2026-08-04', seconds: hour / 2, rateCents: null, billable: false },
      { spentDate: '2026-08-05', seconds: hour, rateCents: 25_000, billable: true },
      { spentDate: '2026-08-06', seconds: hour / 2, rateCents: 25_000, billable: true },
      { spentDate: '2026-09-15', seconds: hour, rateCents: 25_000, billable: true },
    ],
    claims: [1, 2],
  },
  {
    // A budget of $1,000 at list, billable hours only: the band stops at the
    // billable hour it cannot price rather than stepping over it, and leaves the
    // non-billable hour alone.
    name: 'a money ceiling on billable hours',
    terms: {
      claim_mode: 'ceiling',
      claim_ceiling_seconds: null,
      claim_ceiling_cents: 100_000,
      claim_scope: 'billable',
    },
    entries: [
      { spentDate: '2026-08-03', seconds: hour, rateCents: 25_000, billable: true },
      { spentDate: '2026-08-04', seconds: hour, rateCents: null, billable: false },
      { spentDate: '2026-08-05', seconds: hour, rateCents: 25_000, billable: true },
      { spentDate: '2026-08-06', seconds: hour, rateCents: null, billable: true },
      { spentDate: '2026-08-07', seconds: hour, rateCents: 25_000, billable: true },
    ],
    claims: [1, 3],
  },
  {
    // No ceiling, every tracked hour: the non-billable one is the band's too.
    name: 'every tracked hour with no ceiling',
    terms: {
      claim_mode: 'all',
      claim_ceiling_seconds: null,
      claim_ceiling_cents: null,
      claim_scope: 'tracked',
    },
    entries: [
      { spentDate: '2026-08-03', seconds: hour, rateCents: 25_000, billable: true },
      { spentDate: '2026-08-04', seconds: hour, rateCents: null, billable: false },
    ],
    claims: [1, 2],
  },
  {
    // The default every definition had before it carried terms.
    name: 'every billable hour with no ceiling',
    terms: {
      claim_mode: 'all',
      claim_ceiling_seconds: null,
      claim_ceiling_cents: null,
      claim_scope: 'billable',
    },
    entries: [
      { spentDate: '2026-08-03', seconds: hour, rateCents: 25_000, billable: true },
      { spentDate: '2026-08-04', seconds: hour, rateCents: null, billable: false },
    ],
    claims: [1],
  },
]

for (const [runtime, factory] of factories) {
  describe(`a backfilled band claims what a live one would (${runtime})`, () => {
    const open: TestDatabase[] = []
    afterEach(async () => {
      await Promise.all(open.splice(0).map((database) => database.close()))
    })
    const database = async (): Promise<TestDatabase> => {
      const created = await factory()
      open.push(created)
      return created
    }

    for (const scenario of cases) {
      it(`[money] ${scenario.name}`, async () => {
        const live = await database()
        const liveDefinition = await seed(live, scenario.entries)
        await setTerms(live, liveDefinition, scenario.terms)
        const raised = await generate(live, liveDefinition)
        const fromLive = await claimedBy(live, raised.invoiceId)

        // The same band, raised before it could claim, then filled in.
        const filled = await database()
        const filledDefinition = await seed(filled, scenario.entries)
        const early = await generate(filled, filledDefinition)
        expect(await claimedBy(filled, early.invoiceId)).toEqual({ entries: [], foregone: 0 })
        await setTerms(filled, filledDefinition, scenario.terms)
        const backfill = (apply: boolean) =>
          backfillBandClaims(filled.orm, {
            invoiceIds: [early.invoiceId],
            projectIds: [1],
            actorUserId: 1,
            runId: apply ? 'parity-apply' : 'parity-rehearse',
            occurredAt: at,
            recurringInvoiceId: filledDefinition,
            apply,
          })
        const rehearsal = await backfill(false)
        const applied = await backfill(true)

        expect(fromLive.entries).toEqual(scenario.claims)
        expect(await claimedBy(filled, early.invoiceId)).toEqual(fromLive)
        // The rehearsal says what the applied run then does.
        expect(rehearsal.invoices.map((line) => line.entryCount)).toEqual([scenario.claims.length])
        expect(applied.invoices.map(({ entryCount, seconds, foregoneBillableCents }) => ({
          entryCount,
          seconds,
          foregoneBillableCents,
        }))).toEqual(
          rehearsal.invoices.map(({ entryCount, seconds, foregoneBillableCents }) => ({
            entryCount,
            seconds,
            foregoneBillableCents,
          })),
        )
        expect(applied.invoices[0]!.foregoneBillableCents).toBe(fromLive.foregone)
      })
    }
  })
}
