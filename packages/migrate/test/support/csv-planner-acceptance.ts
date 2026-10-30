import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { migrateContainer } from '@ezacto/db'

export const plannerFixtureNow = '2026-09-08T12:00:00.000Z'
export const plannerAdministrator = { kind: 'administrator', userId: '2' } as const
const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Every persisted table, not just the importer business tables. No raw row values in failure output. */
export const completeSqliteFingerprint = (database: BetterSqlite3.Database) => {
  const schema = database.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all()
  const names = database.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all() as { name: string }[]
  const tables = Object.fromEntries(names.map(({ name }) => {
    const rows = database.prepare(`SELECT * FROM ${identifier(name)}`).all()
    const canonical = rows.map(row => JSON.stringify(row)).sort()
    return [name, { count: rows.length, sha256: hash(canonical) }]
  }))
  return {
    schema: hash(schema),
    schemaVersion: database.pragma('schema_version', { simple: true }),
    userVersion: database.pragma('user_version', { simple: true }),
    tables,
  }
}

export const createOwnedPlannerDestination = async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ezacto-csv-planner-acceptance-')))
  const path = join(directory, 'instance.sqlite')
  const writer = new BetterSqlite3(path)
  let reader: BetterSqlite3.Database | null = null
  try {
    migrateContainer(writer)
    writer.exec(await readFile(new URL('../fixtures/csv-browser-planner/native-instance.sql', import.meta.url), 'utf8'))
  } catch (error) {
    writer.close()
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  return {
    writer,
    path,
    /** Call only after setup. File readonly AND query_only protect the acceptance boundary. */
    readonly() {
      if (reader !== null) return reader
      reader = new BetterSqlite3(path, { readonly: true, fileMustExist: true })
      reader.pragma('query_only = ON')
      return reader
    },
    async close() {
      reader?.close()
      writer.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}
