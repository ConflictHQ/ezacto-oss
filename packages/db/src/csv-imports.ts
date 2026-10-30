import { and, eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { csvImportEntries, csvImportRuns } from './schema.js'
import type * as schema from './schema.js'
import type { CompiledQuery } from './tracked-state.js'

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>

export type CsvImportRun = typeof csvImportRuns.$inferSelect
export type CsvImportRunStatus = CsvImportRun['status']

export interface StartCsvImportRun {
  sourceId: string
  fileSha256: string
  mappingJson: string
  mappingSha256: string
  totalRows: number
  now: string
}

export interface FinishCsvImportRun {
  status: CsvImportRunStatus
  rejectedRows: number
  lastError: string | null
  now: string
}

/** Whether a write failed because its source key was already recorded. */
export const isDuplicateCsvImportKey = (error: unknown): boolean => {
  let current = error
  for (let depth = 0; current instanceof Error && depth < 8; depth += 1) {
    if (
      /csv_import_entries\.source_id, csv_import_entries\.source_key|csv_import_entries_source_key/.test(
        current.message,
      )
    ) {
      return true
    }
    current = (current as Error & { cause?: unknown }).cause
  }
  return false
}

/**
 * The source identity of the CSV time import (issue 1012). It holds nothing
 * about how a file is read; it answers which rows of which source already
 * became time, and records the run that is doing it.
 */
export const createCsvImportStore = (database: Database) => ({
  /** False on a database that predates the tables, where nothing was ever imported. */
  async available(): Promise<boolean> {
    const rows = await database.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'csv_import_runs'`,
    )
    return rows.length > 0
  },

  async findRun(sourceId: string, fileSha256: string): Promise<CsvImportRun | null> {
    const [run] = await database
      .select()
      .from(csvImportRuns)
      .where(and(eq(csvImportRuns.sourceId, sourceId), eq(csvImportRuns.fileSha256, fileSha256)))
      .limit(1)
    return run ?? null
  },

  async startRun(input: StartCsvImportRun): Promise<CsvImportRun> {
    const [run] = await database
      .insert(csvImportRuns)
      .values({
        sourceId: input.sourceId,
        fileSha256: input.fileSha256,
        mappingJson: input.mappingJson,
        mappingSha256: input.mappingSha256,
        status: 'partial',
        totalRows: input.totalRows,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning()
    return run!
  },

  async finishRun(runId: number, input: FinishCsvImportRun): Promise<void> {
    await database
      .update(csvImportRuns)
      .set({
        status: input.status,
        rejectedRows: input.rejectedRows,
        lastError: input.lastError === null ? null : input.lastError.slice(0, 2000),
        updatedAt: input.now,
        finishedAt: input.status === 'complete' ? input.now : null,
      })
      .where(eq(csvImportRuns.id, runId))
  },

  /** Every source key this source has already turned into time. */
  async importedKeys(sourceId: string): Promise<Set<string>> {
    const rows = await database
      .select()
      .from(csvImportEntries)
      .where(eq(csvImportEntries.sourceId, sourceId))
    return new Set(rows.map(({ sourceKey }) => sourceKey))
  },

  /**
   * The statement that records a row's source key. It reads the id of the time
   * entry inserted just before it, so it only means anything as a follow-up
   * that commits with that insert or not at all.
   */
  recordEntry(input: {
    runId: number
    sourceId: string
    sourceKey: string
    /** Optional evidence supplied by a modern adapter at the original write. Never inferred later. */
    sourceLine?: number
    sourceSeconds?: number
    now: string
  }): CompiledQuery {
    if (input.sourceLine === undefined && input.sourceSeconds === undefined) {
      // Preserve the original CLI statement, including compatibility with
      // pre-browser schemas. Unknown historical metadata stays unknown.
      return {
        sql: `INSERT INTO csv_import_entries (run_id, source_id, source_key, time_entry_id, created_at)
          VALUES (?, ?, ?, last_insert_rowid(), ?)`,
        params: [input.runId, input.sourceId, input.sourceKey, input.now],
      }
    }
    if (
      !Number.isSafeInteger(input.sourceLine) ||
      (input.sourceLine ?? 0) < 1 ||
      !Number.isSafeInteger(input.sourceSeconds) ||
      (input.sourceSeconds ?? -1) < 0
    )
      throw new RangeError('Invalid CSV source evidence')
    return {
      sql: `INSERT INTO csv_import_entries (run_id, source_id, source_key, time_entry_id, created_at, source_line, source_seconds)
        VALUES (?, ?, ?, last_insert_rowid(), ?, ?, ?)`,
      params: [
        input.runId,
        input.sourceId,
        input.sourceKey,
        input.now,
        input.sourceLine ?? null,
        input.sourceSeconds ?? null,
      ],
    }
  },
})

export type CsvImportStore = ReturnType<typeof createCsvImportStore>
