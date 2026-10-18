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
import { invoiceTotalsPerInvoiceMigration } from '../src/migrations/0110_invoice_totals_per_invoice.js'

/**
 * Invoice totals recompute one invoice per row, not the organization (issue 950).
 *
 * 0005's triggers read `invoice_financial_calculation` with a correlated key
 * that SQLite does not push into the view's organization-wide GROUP BY, so
 * every inserted line aggregated every invoice twice. A 100-line invoice on a
 * long history spent over a second inside SQLite. 0110 keys each recompute on
 * the row's own invoice. These cases pin three things:
 *
 * - The stored totals still equal the canonical view after every kind of
 *   mutation. The view is 0005's definition and is deliberately left
 *   unchanged.
 * - The work is per invoice and index-only, read off the triggers themselves.
 * - A 100-line invoice costs the same whether the organization has no history
 *   or years of it. This case fails against 0005's triggers.
 */

interface RawDatabase {
  run(sql: string, ...params: unknown[]): Promise<void>
  rows<T>(sql: string, ...params: unknown[]): Promise<T[]>
  close(): Promise<void>
}

const at = '2026-09-01T09:00:00.000Z'

const containerDatabase = async (migrate: boolean): Promise<RawDatabase> => {
  const sqlite = new BetterSqlite3(':memory:')
  sqlite.pragma('foreign_keys = ON')
  if (migrate) migrateContainer(sqlite)
  return {
    run: async (sql, ...params) => {
      sqlite.prepare(sql).run(...params)
    },
    rows: async <T>(sql: string, ...params: unknown[]) => sqlite.prepare(sql).all(...params) as T[],
    close: async () => {
      sqlite.close()
    },
  }
}

const d1Database = async (migrate: boolean): Promise<RawDatabase> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const d1 = await miniflare.getD1Database('DB')
  await d1.exec('PRAGMA foreign_keys = ON')
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
    close: async () => miniflare.dispose(),
  }
}

const factories = [
  ['container', containerDatabase],
  ['D1', d1Database],
] as const

// The totals foundation and its replacement, without the lifecycle guards
// later migrations add. Raw SQL can then move lines and payments in every way
// the triggers have to answer for.
const installTotalsFoundation = async (database: RawDatabase): Promise<void> => {
  for (const statements of [
    orgPeopleMigration,
    clientsMigration,
    projectsTimeMigration,
    rateResolverMigration,
    invoiceFoundationMigration,
    invoicePaymentsTotalsMigration,
    invoiceTotalsPerInvoiceMigration,
  ])
    for (const statement of statements) await database.run(statement)
  await database.run(
    `INSERT INTO clients (id, name, currency, created_at, updated_at)
     VALUES (1, 'Example Harbor Works', 'USD', ?, ?)`,
    at,
    at,
  )
}

const totalsTriggers = [
  'invoice_line_items_totals_insert',
  'invoice_line_items_totals_update',
  'invoice_line_items_totals_delete',
  'invoice_payments_totals_insert',
  'invoice_payments_totals_update',
  'invoice_payments_totals_delete',
  'invoices_financial_inputs_update',
  'invoices_financial_totals_insert',
  'invoices_derived_totals_canonical',
] as const

const divergentTotals = `SELECT invoice.id
  FROM invoices invoice
  JOIN invoice_financial_calculation calculation ON calculation.invoice_id = invoice.id
  WHERE calculation.amount_cents IS NOT invoice.amount_cents
    OR calculation.due_amount_cents IS NOT invoice.due_amount_cents
    OR calculation.tax_amount_cents IS NOT invoice.tax_amount_cents
    OR calculation.tax2_amount_cents IS NOT invoice.tax2_amount_cents
    OR calculation.discount_amount_cents IS NOT invoice.discount_amount_cents
  ORDER BY invoice.id`

const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

let open: RawDatabase | undefined

afterEach(async () => {
  await open?.close()
  open = undefined
})

for (const [runtime, factory] of factories) {
  describe(`invoice totals per invoice (${runtime})`, () => {
    it('[unit] keeps every stored total canonical through random line, payment and rate mutations', async () => {
      open = await factory(false)
      const db = open
      await installTotalsFoundation(db)
      const next = random(950)
      const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)]!
      // Midpoints and signs are where rounding goes wrong: half-cent discounts
      // and taxes on odd and negative amounts, rates at both bounds, and NULL.
      const rate = () => pick([null, 0, 1, 333_333, 500_000, 999_999, 1_000_000, 75_000, 125_000])
      const amount = () =>
        pick([-1, 1, 5, 15, 25, -25, 99, Math.floor(next() * 100_000) - 50_000])
      const invoices: number[] = []
      const lines: Array<{ id: number; invoice: number }> = []
      const payments: number[] = []
      const positions = new Map<number, number>()
      let nextId = 1
      const addInvoice = async () => {
        const id = nextId++
        await db.run(
          `INSERT INTO invoices
            (id, client_id, number, currency, issue_date, due_date, discount_rate_ppm,
             tax_rate_ppm, tax2_rate_ppm, created_at, updated_at)
           VALUES (?, 1, ?, 'USD', '2026-08-01', '2026-08-31', ?, ?, ?, ?, ?)`,
          id,
          `TOT-${id}`,
          rate(),
          rate(),
          rate(),
          at,
          at,
        )
        invoices.push(id)
        positions.set(id, 0)
      }
      const nextPosition = (invoice: number) => {
        const position = positions.get(invoice)!
        positions.set(invoice, position + 1)
        return position
      }
      const steps: Record<string, () => Promise<void>> = {
        addInvoice,
        addLine: async () => {
          const invoice = pick(invoices)
          const id = nextId++
          await db.run(
            `INSERT INTO invoice_line_items
              (id, invoice_id, position, kind, quantity, unit_price_cents, amount_cents,
               taxed, taxed2, created_at, updated_at)
             VALUES (?, ?, ?, 'Service', 1, 0, ?, ?, ?, ?, ?)`,
            id,
            invoice,
            nextPosition(invoice),
            amount(),
            next() < 0.5 ? 1 : 0,
            next() < 0.5 ? 1 : 0,
            at,
            at,
          )
          lines.push({ id, invoice })
        },
        changeLineAmount: async () => {
          if (lines.length === 0) return
          await db.run(
            `UPDATE invoice_line_items SET amount_cents = ? WHERE id = ?`,
            amount(),
            pick(lines).id,
          )
        },
        toggleLineTaxes: async () => {
          if (lines.length === 0) return
          await db.run(
            `UPDATE invoice_line_items SET taxed = 1 - taxed, taxed2 = ? WHERE id = ?`,
            next() < 0.5 ? 1 : 0,
            pick(lines).id,
          )
        },
        describeLine: async () => {
          if (lines.length === 0) return
          await db.run(
            `UPDATE invoice_line_items SET description = 'Reworded' WHERE id = ?`,
            pick(lines).id,
          )
        },
        moveLine: async () => {
          if (lines.length === 0 || invoices.length < 2) return
          const line = pick(lines)
          const target = pick(invoices.filter((invoice) => invoice !== line.invoice))
          await db.run(
            `UPDATE invoice_line_items SET invoice_id = ?, position = ? WHERE id = ?`,
            target,
            nextPosition(target),
            line.id,
          )
          line.invoice = target
        },
        deleteLine: async () => {
          if (lines.length === 0) return
          const line = pick(lines)
          await db.run(`DELETE FROM invoice_line_items WHERE id = ?`, line.id)
          lines.splice(lines.indexOf(line), 1)
        },
        addPayment: async () => {
          const id = nextId++
          await db.run(
            `INSERT INTO invoice_payments
              (id, invoice_id, currency, amount_cents, paid_date, provider, provider_shape,
               created_at, updated_at)
             VALUES (?, ?, 'USD', ?, '2026-08-15', 'manual', 'manual', ?, ?)`,
            id,
            pick(invoices),
            Math.floor(next() * 60_000) - 1_000,
            at,
            at,
          )
          payments.push(id)
        },
        changePayment: async () => {
          if (payments.length === 0) return
          await db.run(
            `UPDATE invoice_payments SET amount_cents = ? WHERE id = ?`,
            Math.floor(next() * 60_000),
            pick(payments),
          )
        },
        deletePayment: async () => {
          if (payments.length === 0) return
          const payment = pick(payments)
          await db.run(`DELETE FROM invoice_payments WHERE id = ?`, payment)
          payments.splice(payments.indexOf(payment), 1)
        },
        changeRates: async () => {
          await db.run(
            `UPDATE invoices SET discount_rate_ppm = ?, tax_rate_ppm = ?, tax2_rate_ppm = ?
             WHERE id = ?`,
            rate(),
            rate(),
            rate(),
            pick(invoices),
          )
        },
        writeOff: async () => {
          await db.run(
            `UPDATE invoices SET written_off_cents = ? WHERE id = ?`,
            Math.floor(next() * 5_000),
            pick(invoices),
          )
        },
        forgeTotals: async () => {
          const forged = () => Math.floor(next() * 2_000_000) - 1_000_000
          await db.run(
            `UPDATE invoices SET amount_cents = ?, due_amount_cents = ?, tax_amount_cents = ?,
               tax2_amount_cents = ?, discount_amount_cents = ? WHERE id = ?`,
            forged(),
            forged(),
            forged(),
            forged(),
            forged(),
            pick(invoices),
          )
        },
        deleteInvoice: async () => {
          if (invoices.length < 3) return
          const invoice = pick(invoices)
          await db.run(`DELETE FROM invoices WHERE id = ?`, invoice)
          invoices.splice(invoices.indexOf(invoice), 1)
          for (const line of lines.filter((candidate) => candidate.invoice === invoice))
            lines.splice(lines.indexOf(line), 1)
          const kept = await db.rows<{ id: number }>(`SELECT id FROM invoice_payments`)
          payments.splice(0, payments.length, ...kept.map(({ id }) => id))
        },
      }
      const weighted = [
        ...Array<string>(8).fill('addLine'),
        ...Object.keys(steps).filter((name) => name !== 'addLine'),
      ]
      for (let invoice = 0; invoice < 4; invoice++) await addInvoice()
      // Not vacuous: somewhere in the walk there were real discounts, taxes and
      // balances. Seen at any step, not at the last, which may be a deletion.
      const seen = { discounted: 0, taxed: 0, taxed2: 0, part_paid: 0 }
      for (let step = 0; step < 240; step++) {
        const name = pick(weighted)
        await steps[name]!()
        expect(await db.rows(divergentTotals), `after ${name} (step ${step})`).toEqual([])
        const [shape] = await db.rows<typeof seen>(
          `SELECT coalesce(sum(discount_amount_cents <> 0), 0) AS discounted,
             coalesce(sum(tax_amount_cents <> 0), 0) AS taxed,
             coalesce(sum(tax2_amount_cents <> 0), 0) AS taxed2,
             coalesce(sum(due_amount_cents <> amount_cents), 0) AS part_paid
           FROM invoices`,
        )
        for (const key of Object.keys(seen) as Array<keyof typeof seen>)
          seen[key] = Math.max(seen[key], shape![key])
      }
      expect(seen.discounted).toBeGreaterThan(0)
      expect(seen.taxed).toBeGreaterThan(0)
      expect(seen.taxed2).toBeGreaterThan(0)
      expect(seen.part_paid).toBeGreaterThan(0)
    })

    it('[unit] reads one invoice through the covering index and never the organization-wide view', async () => {
      open = await factory(true)
      const db = open
      const triggers = await db.rows<{ name: string; sql: string }>(
        `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (${totalsTriggers
          .map(() => '?')
          .join(', ')}) ORDER BY name`,
        ...totalsTriggers,
      )
      expect(triggers.map(({ name }) => name)).toEqual([...totalsTriggers].sort())
      for (const { name, sql } of triggers)
        expect(sql, name).not.toContain('invoice_financial_calculation')
      const insert = triggers.find(({ name }) => name === 'invoice_line_items_totals_insert')!.sql
      // The trigger's own line aggregate, with its row key bound as a parameter.
      const lineBases = insert
        .match(/\(SELECT COALESCE\(SUM\(line\.amount_cents\), 0\)[\s\S]*?\) AS line_bases/u)?.[0]
        .replace(/^\(/u, '')
        .replace(/\) AS line_bases$/u, '')
        .replace('NEW.invoice_id', '?')
      expect(lineBases).toBeDefined()
      const plan = await db.rows<{ detail: string }>(`EXPLAIN QUERY PLAN ${lineBases!}`, 1)
      expect(plan.map(({ detail }) => detail)).toEqual([
        'SEARCH line USING COVERING INDEX invoice_line_items_invoice_totals (invoice_id=?)',
      ])
      const bound = await db.rows<{ detail: string }>(
        `EXPLAIN QUERY PLAN SELECT COALESCE(SUM(CASE WHEN amount_cents < 0 THEN -amount_cents
           ELSE amount_cents END), 0) FROM invoice_line_items WHERE invoice_id = ?`,
        1,
      )
      expect(bound.map(({ detail }) => detail)).toEqual([
        'SEARCH invoice_line_items USING COVERING INDEX invoice_line_items_invoice_totals (invoice_id=?)',
      ])
      expect(
        await db.rows(`SELECT name FROM sqlite_master WHERE name = 'invoice_line_items_invoice_id'`),
      ).toEqual([])
    })
  })
}

describe('invoice totals per invoice (container timing)', () => {
  // Builds a migrated organization with `invoices` historical drafts of
  // `linesEach` lines, the shape of a long-running book.
  const organization = (invoices: number, linesEach: number): BetterSqlite3.Database => {
    const sqlite = new BetterSqlite3(':memory:')
    migrateContainer(sqlite)
    sqlite
      .prepare(
        `INSERT INTO clients (id, name, currency, created_at, updated_at)
         VALUES (1, 'Example Harbor Works', 'USD', ?, ?)`,
      )
      .run(at, at)
    const invoice = sqlite.prepare(
      `INSERT INTO invoices (client_id, number, currency, issue_date, due_date, state,
         discount_rate_ppm, tax_rate_ppm, created_at, updated_at)
       VALUES (1, ?, 'USD', '2026-08-01', '2026-08-31', 'draft', 50000, 125000, ?, ?)`,
    )
    const line = sqlite.prepare(
      `INSERT INTO invoice_line_items (invoice_id, position, kind, description, quantity,
         unit_price_cents, amount_cents, taxed, created_at, updated_at)
       VALUES (?, ?, 'Service', 'Survey work', 1, ?, ?, ?, ?, ?)`,
    )
    sqlite.transaction(() => {
      for (let number = 0; number < invoices; number++) {
        const id = Number(invoice.run(`HIST-${number}`, at, at).lastInsertRowid)
        for (let position = 0; position < linesEach; position++) {
          const cents = 9_000 + ((number * 31 + position * 17) % 12_000)
          line.run(id, position, cents, cents, position % 2, at, at)
        }
      }
    })()
    return sqlite
  }

  // The bake-off's heavy write: one draft and `lines` single-row inserts in one
  // transaction. Rolled back, so every run sees the same organization; the
  // fastest of several runs is the least disturbed by a loaded machine.
  const invoiceMilliseconds = (sqlite: BetterSqlite3.Database, lines: number): number => {
    const invoice = sqlite.prepare(
      `INSERT INTO invoices (client_id, number, currency, issue_date, due_date, state,
         discount_rate_ppm, tax_rate_ppm, created_at, updated_at)
       VALUES (1, 'TIMED', 'USD', '2026-09-01', '2026-09-30', 'draft', 50000, 125000, ?, ?)`,
    )
    const line = sqlite.prepare(
      `INSERT INTO invoice_line_items (invoice_id, position, kind, description, quantity,
         unit_price_cents, amount_cents, taxed, created_at, updated_at)
       VALUES ((SELECT id FROM invoices WHERE number = 'TIMED'), ?, 'Service', ?, 2, ?, ?, ?, ?, ?)`,
    )
    let fastest = Number.POSITIVE_INFINITY
    for (let run = 0; run < 5; run++) {
      sqlite.exec('BEGIN')
      try {
        const started = performance.now()
        invoice.run(at, at)
        for (let position = 0; position < lines; position++) {
          const unit = 9_000 + position * 37
          line.run(position, `Line ${position}`, unit, unit * 2, position % 2, at, at)
        }
        fastest = Math.min(fastest, performance.now() - started)
        const [totals] = sqlite
          .prepare(
            `SELECT invoice.amount_cents, calculation.amount_cents AS canonical,
               (SELECT count(*) FROM invoice_line_items WHERE invoice_id = invoice.id) AS lines
             FROM invoices invoice
             JOIN invoice_financial_calculation calculation ON calculation.invoice_id = invoice.id
             WHERE invoice.number = 'TIMED'`,
          )
          .all() as Array<{ amount_cents: number; canonical: number; lines: number }>
        expect(totals).toEqual({ amount_cents: totals!.canonical, canonical: totals!.canonical, lines })
        expect(totals!.amount_cents).toBeGreaterThan(0)
      } finally {
        sqlite.exec('ROLLBACK')
      }
    }
    return fastest
  }

  it('[unit] keeps a 100-line invoice independent of the organization history', () => {
    const empty = organization(0, 0)
    const book = organization(1_000, 8)
    try {
      const fresh = invoiceMilliseconds(empty, 100)
      const long = invoiceMilliseconds(book, 100)
      // 0005's triggers made the long book roughly fifty to a hundred times
      // slower than the empty one (about 1.4 ms a line here, 5 ms on the
      // bake-off's 14-year file). Per invoice, the two now cost the same, and
      // the margin covers timer noise rather than a slope.
      expect(long, `fresh book ${fresh.toFixed(2)} ms`).toBeLessThan(4 * fresh + 10)
      expect(long).toBeLessThan(150)
    } finally {
      empty.close()
      book.close()
    }
  })
})
