import { readFile } from 'node:fs/promises'
import BetterSqlite3 from 'better-sqlite3'
import { assertCutoverMigrationLedger, type MigrationLedgerRow } from '@ezacto/db'

export const runCutoverPreflight = async (options: { databasePath?: string; inputPath?: string }): Promise<number> => {
  if ((options.databasePath === undefined) === (options.inputPath === undefined)) {
    throw new Error('preflight-migrations requires exactly one of --database or --input (wrangler --json output)')
  }
  let rows: unknown
  if (options.databasePath !== undefined) {
    const database = new BetterSqlite3(options.databasePath, { readonly: true, fileMustExist: true })
    try {
      const columns = database.pragma('table_info(_ezacto_migrations)') as Array<{ name: string }>
      if (!columns.some(({ name }) => name === 'id')) throw new Error('cutover_migration_ledger_invalid: migration ledger is absent')
      const checksum = columns.some(({ name }) => name === 'statements_sha256') ? 'statements_sha256' : 'NULL AS statements_sha256'
      rows = database.prepare(`SELECT id, ${checksum} FROM _ezacto_migrations ORDER BY id`).all()
    } finally {
      database.close()
    }
  } else {
    const result: unknown = JSON.parse(await readFile(options.inputPath!, 'utf8'))
    if (!Array.isArray(result) || result.length !== 1 || result[0]?.success !== true || !Array.isArray(result[0]?.results)) {
      throw new Error('cutover_migration_ledger_invalid: expected one successful wrangler query result')
    }
    rows = result[0].results
  }
  if (!Array.isArray(rows) || !rows.every((row: unknown) => typeof row === 'object' && row !== null &&
      'id' in row && typeof row.id === 'string' && 'statements_sha256' in row &&
      (row.statements_sha256 === null || typeof row.statements_sha256 === 'string'))) {
    throw new Error('cutover_migration_ledger_invalid: malformed migration rows')
  }
  assertCutoverMigrationLedger(rows as MigrationLedgerRow[])
  return rows.length
}
