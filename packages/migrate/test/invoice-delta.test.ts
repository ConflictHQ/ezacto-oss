import BetterSqlite3 from 'better-sqlite3'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runLoad } from '../src/load.js'
import { runInvoiceDelta } from '../src/invoice-delta.js'
import { buildSanitizedLoadSnapshot } from './load-fixture.js'

const rows = <T>(path: string, sql: string): T[] => {
  const database = new BetterSqlite3(path, { readonly: true, fileMustExist: true })
  try {
    return database.prepare(sql).all() as T[]
  } finally {
    database.close()
  }
}
const one = <T>(path: string, sql: string): T => rows<T>(path, sql)[0]!

describe('carry-invoices', () => {
  let dir: string
  let sourceDir: string
  let targetDir: string
  let sourcePath: string
  let targetPath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ezacto-invoice-delta-'))
    sourceDir = join(dir, 'source-snapshot')
    targetDir = join(dir, 'target-snapshot')
    sourcePath = join(dir, 'source.db')
    targetPath = join(dir, 'target.db')
    await buildSanitizedLoadSnapshot(sourceDir)
    await buildSanitizedLoadSnapshot(targetDir, { firstInvoiceOnly: true })
    await runLoad({ snapshotDir: sourceDir, databasePath: sourcePath, organizationCurrency: 'USD' })
    await runLoad({ snapshotDir: targetDir, databasePath: targetPath, organizationCurrency: 'USD' })
  }, 120_000)

  afterEach(async () => rm(dir, { recursive: true, force: true }))

  it('[integration] carries the invoice the target never saw, with its children', async () => {
    const before = one<{ n: number }>(targetPath, 'SELECT count(*) n FROM invoices').n
    const expected = one<{ n: number }>(sourcePath, 'SELECT count(*) n FROM invoices').n
    expect(before).toBeLessThan(expected)

    const result = await runInvoiceDelta({ sourcePath, targetPath })

    expect(result.missing).toHaveLength(expected - before)
    expect(result.carried).toHaveLength(expected - before)
    expect(one<{ n: number }>(targetPath, 'SELECT count(*) n FROM invoices').n).toBe(expected)
    // The carried invoice arrives with the money and the children it had, not
    // just a header. Matching the source's own counts is the assertion rather
    // than "more than none": an invoice whose charge is all expenses carries no
    // lines at all, and demanding one would only be testing the fixture.
    for (const carried of result.carried) {
      const target = one<{ amount_cents: number; state: string; lines: number }>(
        targetPath,
        `SELECT invoice.amount_cents, invoice.state,
           (SELECT count(*) FROM invoice_line_items line WHERE line.invoice_id = invoice.id) lines
         FROM invoices invoice WHERE invoice.harvest_id = ${carried.harvestId}`,
      )
      const source = one<{ amount_cents: number; state: string; lines: number }>(
        sourcePath,
        `SELECT invoice.amount_cents, invoice.state,
           (SELECT count(*) FROM invoice_line_items line WHERE line.invoice_id = invoice.id) lines
         FROM invoices invoice WHERE invoice.harvest_id = ${carried.harvestId}`,
      )
      expect(target).toEqual(source)
    }
    // Children as a whole moved, not just the headers.
    for (const table of ['invoice_line_items', 'invoice_messages', 'invoice_payments']) {
      expect(one<{ n: number }>(targetPath, `SELECT count(*) n FROM ${table}`).n).toBe(
        one<{ n: number }>(sourcePath, `SELECT count(*) n FROM ${table}`).n,
      )
    }
  }, 120_000)

  it('[integration] leaves the numbering sequence past everything it carried', async () => {
    // A sequence that did not advance hands the next generated invoice a number
    // the books already used, which is the failure nobody notices until a client
    // has two invoices with one number.
    await runInvoiceDelta({ sourcePath, targetPath })
    // Only numeric numbers advance the sequence; the fixture also carries an
    // invoice numbered INV-EXPENSE, which the trigger correctly ignores.
    const highest = one<{ n: number }>(
      targetPath,
      `SELECT coalesce(max(CAST(number AS INTEGER)), 0) n FROM invoices
       WHERE number = CAST(CAST(number AS INTEGER) AS TEXT)`,
    ).n
    const next = one<{ next_number: number }>(
      targetPath,
      'SELECT next_number FROM invoice_number_sequence',
    ).next_number
    expect(next).toBeGreaterThan(highest)
  }, 120_000)

  it('[integration] is idempotent: a second pass has nothing left to carry', async () => {
    await runInvoiceDelta({ sourcePath, targetPath })
    const after = await runInvoiceDelta({ sourcePath, targetPath })
    expect(after.missing).toEqual([])
    expect(after.carried).toEqual([])
  }, 120_000)

  it('[security] a dry run reports the delta and writes nothing', async () => {
    const before = one<{ n: number }>(targetPath, 'SELECT count(*) n FROM invoices').n

    const result = await runInvoiceDelta({ sourcePath, targetPath, dryRun: true })

    expect(result.missing.length).toBeGreaterThan(0)
    expect(result.carried).toEqual([])
    expect(one<{ n: number }>(targetPath, 'SELECT count(*) n FROM invoices').n).toBe(before)
  }, 120_000)
})
