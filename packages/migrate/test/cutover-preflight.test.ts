import BetterSqlite3 from 'better-sqlite3'
import { migrateContainer, migrationIds } from '@ezacto/db'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runCutoverPreflight } from '../src/cutover-preflight.js'

describe('cutover migration preflight', () => {
  let directory: string
  let databasePath: string
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ezacto-cutover-preflight-'))
    databasePath = join(directory, 'candidate.db')
    const database = new BetterSqlite3(databasePath)
    migrateContainer(database)
    database.close()
  })
  afterEach(async () => rm(directory, { recursive: true, force: true }))

  it('[security #468] checks a local artifact without changing any bytes', async () => {
    const before = await readFile(databasePath)
    expect(await runCutoverPreflight({ databasePath })).toEqual({
      ledgerRows: migrationIds.length,
      pending: [],
    })
    expect(await readFile(databasePath)).toEqual(before)
  })

  it('[security #468] checks remote query evidence and rejects partial or failed results', async () => {
    const database = new BetterSqlite3(databasePath, { readonly: true })
    const rows = database.prepare('SELECT id, statements_sha256 FROM _ezacto_migrations').all()
    database.close()
    const inputPath = join(directory, 'ledger.json')
    await writeFile(inputPath, JSON.stringify([{ success: true, results: rows }]))
    expect(await runCutoverPreflight({ inputPath })).toEqual({
      ledgerRows: migrationIds.length,
      pending: [],
    })
    for (const value of [[], [{ success: false, results: rows }], [{ success: true, results: [{ id: 'x' }] }]]) {
      await writeFile(inputPath, JSON.stringify(value))
      await expect(runCutoverPreflight({ inputPath })).rejects.toThrow(/cutover_migration_ledger_invalid/)
    }
    await writeFile(inputPath, JSON.stringify([{ success: true, results: rows.slice(0, -6) }]))
    await expect(runCutoverPreflight({ inputPath })).rejects.toThrow(/cutover_migration_ledger_mismatch/)
  })

  it('[unit] an ordinary deploy is allowed to be ahead of the database it deploys over', async () => {
    // The cutover rule refuses a build carrying a migration that has not
    // shipped, which is every build carrying a migration. Running it on ordinary
    // releases deadlocked the pipeline on the first one written after cutover.
    const database = new BetterSqlite3(databasePath)
    for (const id of migrationIds.slice(-6)) database.prepare('DELETE FROM _ezacto_migrations WHERE id = ?').run(id)
    database.close()

    await expect(runCutoverPreflight({ databasePath })).rejects.toThrow(/cutover_migration_ledger_mismatch/)
    expect(await runCutoverPreflight({ databasePath, upgrade: true })).toEqual({
      ledgerRows: migrationIds.length - 6,
      pending: migrationIds.slice(-6),
    })
  })

  it('[security #468] names missing migrations and unverifiable legacy evidence without upgrading it', async () => {
    const database = new BetterSqlite3(databasePath)
    for (const id of migrationIds.slice(-6)) database.prepare('DELETE FROM _ezacto_migrations WHERE id = ?').run(id)
    database.exec('ALTER TABLE _ezacto_migrations DROP COLUMN statements_sha256')
    database.close()
    const before = await readFile(databasePath)
    await expect(runCutoverPreflight({ databasePath })).rejects.toThrow(`missing=${migrationIds.slice(-6).join(',')}`)
    await expect(runCutoverPreflight({ databasePath })).rejects.toThrow(/unverifiable=0000_org_people/)
    expect(await readFile(databasePath)).toEqual(before)
  })

  it('[security #468] never creates a missing artifact or accepts ambiguous inputs', async () => {
    const missing = join(directory, 'missing.db')
    await expect(runCutoverPreflight({ databasePath: missing })).rejects.toThrow()
    await expect(readFile(missing)).rejects.toThrow()
    await expect(runCutoverPreflight({})).rejects.toThrow(/exactly one/)
    await expect(runCutoverPreflight({ databasePath, inputPath: missing })).rejects.toThrow(/exactly one/)
  })
})
