import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { createBillEffectFenceStore } from '../src/bill.js'
import { migrateContainer } from '../src/migrate.js'

const t = (minute: number): string => `2026-09-11T12:${String(minute).padStart(2, '0')}:00.000Z`
const clock = () => new Date(t(5))
const digest = (character: string) => character.repeat(64)

let sqlite: BetterSqlite3.Database | null = null

const fixture = async (connected = true) => {
  const database = new BetterSqlite3(':memory:')
  await migrateContainer(database)
  database.pragma('foreign_keys = ON')
  database.exec(`
    INSERT INTO organizations (name, modules, created_at, updated_at) VALUES ('Fixture', '{}', '${t(0)}', '${t(0)}');
    INSERT INTO clients (id, name, currency, created_at, updated_at) VALUES (1, 'Kestrel Environmental', 'USD', '${t(0)}', '${t(0)}');
    INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date, state, created_at, updated_at)
      VALUES (10, 1, '1315', 'USD', '2026-09-11', '2026-10-11', 'draft', '${t(0)}', '${t(0)}');`)
  if (connected) {
    database.exec(`UPDATE bill_managed_connection SET generation=1, status='configured', company_id='008OWNED',
      binding_company_id='008OWNED', sealed_credential='sealed', updated_at='${t(1)}' WHERE singleton=1`)
  }
  sqlite = database
  return { sqlite: database, orm: createContainerDatabase(database) }
}

afterEach(() => { sqlite?.close(); sqlite = null })

/** Drizzle wraps the SQLite abort; the schema's reason is on the cause. */
const refusedBy = async (work: Promise<unknown>, reason: string) => {
  const error = await work.then(() => null, (caught: unknown) => caught as { cause?: unknown })
  expect(error).not.toBeNull()
  expect(`${error}${error?.cause ?? ''}`).toContain(reason)
}

describe('the BILL effect fence store (issue 1252)', () => {
  it('[db] holds under the stored generation and locks the request source until released', async () => {
    const { sqlite: db, orm } = await fixture()
    const fence = createBillEffectFenceStore(orm, 1, clock)
    const { effectId } = await fence.hold({ kind: 'invoice-create', invoiceId: 10, clientId: 1, requestDigest: digest('a') })
    expect(() => db.exec("UPDATE invoices SET number='9999' WHERE id=10")).toThrow(/bill_effect_source_held/)
    expect(() => db.exec("UPDATE clients SET name='Renamed' WHERE id=1")).toThrow(/bill_effect_source_held/)
    await fence.release(effectId)
    db.exec("UPDATE invoices SET number='9999' WHERE id=10")
    expect(db.prepare("SELECT state FROM bill_effect_fences WHERE effect_id=?").get(effectId)).toEqual({ state: 'released' })
  })

  it('[db] a repeated hold for the same request returns the same effect, and a changed request is refused', async () => {
    const { sqlite: db, orm } = await fixture()
    const fence = createBillEffectFenceStore(orm, 1, clock)
    const first = await fence.hold({ kind: 'invoice-send', invoiceId: 10, clientId: 1, requestDigest: digest('a') })
    const again = await fence.hold({ kind: 'invoice-send', invoiceId: 10, clientId: 1, requestDigest: digest('a') })
    expect(again).toEqual(first)
    await expect(fence.hold({ kind: 'invoice-send', invoiceId: 10, clientId: 1, requestDigest: digest('b') }))
      .rejects.toThrow('bill_effect_fence_request_changed')
    expect(db.prepare("SELECT count(*) AS n FROM bill_effect_fences").get()).toEqual({ n: 1 })
  })

  it('[db] refuses a hold under another generation or with no live connection', async () => {
    const stale = createBillEffectFenceStore((await fixture()).orm, 2, clock)
    await refusedBy(stale.hold({ kind: 'invoice-create', invoiceId: 10, clientId: 1, requestDigest: digest('a') }), 'bill_effect_fence_invalid')
    sqlite?.close()
    const { orm } = await fixture(false)
    await refusedBy(createBillEffectFenceStore(orm, 0, clock).hold({ kind: 'invoice-create', invoiceId: 10, clientId: 1, requestDigest: digest('a') }), 'bill_effect_fence_invalid')
  }, 30_000)

  it('[db] releaseHeld settles only the named kinds of one invoice and rows are never deleted', async () => {
    const { sqlite: db, orm } = await fixture()
    const fence = createBillEffectFenceStore(orm, 1, clock)
    await fence.hold({ kind: 'customer-create', invoiceId: 10, clientId: 1, requestDigest: digest('a') })
    await fence.hold({ kind: 'invoice-send', invoiceId: 10, clientId: 1, requestDigest: digest('b') })
    await fence.releaseHeld(10, ['invoice-send'])
    expect(db.prepare("SELECT kind, state FROM bill_effect_fences ORDER BY kind").all())
      .toEqual([{ kind: 'customer-create', state: 'held' }, { kind: 'invoice-send', state: 'released' }])
    expect(() => db.exec('DELETE FROM bill_effect_fences')).toThrow(/bill_effect_fence_retained/)
  })
})
