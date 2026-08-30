import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import {
  ensureHarvestExpenseReceipt,
  ensureHarvestRecurringInvoiceStub,
  ensureHarvestRetainerStub,
  ensureImportedInvoiceHeader,
  reconcileHarvestInvoice,
  validateHarvestInvoiceReconciliation,
  type HarvestInvoiceReconciliation,
  type ImportDatabase,
} from '@ezacto/db/importer'
import { readIds, type ChildLineage } from './jsonl.js'
import { readManifest, type Manifest } from './manifest.js'
import { RESOURCES } from './resources.js'
import { acquireSnapshotLock, releaseSnapshotLock } from './snapshot-lock.js'
import {
  accessRoles,
  billingMethod,
  canonicalHarvestTime,
  hoursLiteralToSeconds,
  moneyLiteralToCents,
  numberLexemes,
  percentLiteralToPpm,
} from './transform.js'
import {
  checksumReportDigest,
  snapshotDigest,
  verifySnapshot,
  type ChecksumReport,
} from './verify.js'

export const D1_MAX_BOUND_PARAMETERS = 100
export const D1_MAX_STATEMENTS = 1000
export const D1_INVOCATION_QUERY_RESERVE = 250
export const DEFAULT_INVOCATION_STATEMENT_BUDGET = 700

export interface PlannedStatement {
  sql: string
  bindings: readonly unknown[]
  [INSERT_METADATA]?: InsertMetadata
}

const INSERT_METADATA = Symbol('insert-metadata')

interface InsertMetadata {
  table: string
  columns: readonly string[]
  rowSql: string
  harvestColumn: number
}

const renderInsertBatch = (
  metadata: InsertMetadata,
  statements: readonly PlannedStatement[],
): PlannedStatement => ({
  sql: `INSERT INTO ${metadata.table} (${metadata.columns.join(', ')})
    SELECT * FROM (VALUES ${statements.map(() => `(${metadata.rowSql})`).join(', ')}) AS incoming
    WHERE NOT EXISTS (SELECT 1 FROM ${metadata.table} existing
      WHERE existing.harvest_id = incoming.column${metadata.harvestColumn + 1})`,
  bindings: statements.flatMap((statement) => [...statement.bindings]),
})

const compactInsertStatements = (statements: readonly PlannedStatement[]): PlannedStatement[] => {
  const compacted: PlannedStatement[] = []
  for (let at = 0; at < statements.length;) {
    const metadata = statements[at]?.[INSERT_METADATA]
    if (!metadata) {
      compacted.push(statements[at]!)
      at += 1
      continue
    }
    const compatible: PlannedStatement[] = []
    while (at < statements.length) {
      const candidate = statements[at]!
      const candidateMetadata = candidate[INSERT_METADATA]
      if (
        !candidateMetadata ||
        candidateMetadata.table !== metadata.table ||
        candidateMetadata.rowSql !== metadata.rowSql ||
        candidateMetadata.columns.join('\0') !== metadata.columns.join('\0')
      )
        break
      compatible.push(candidate)
      at += 1
    }
    for (const batch of boundedInsertBatches(compatible, metadata.columns.length)) {
      compacted.push(renderInsertBatch(metadata, batch))
    }
  }
  return compacted
}

export const assertD1Statements = (statements: readonly PlannedStatement[]): void => {
  for (const [index, statement] of statements.entries()) {
    if (statement.bindings.length > D1_MAX_BOUND_PARAMETERS) {
      throw new Error(
        `load statement ${index + 1} binds ${statement.bindings.length} parameters; D1 permits 100`,
      )
    }
  }
  if (statements.length > D1_MAX_STATEMENTS) {
    throw new Error(`load batch has ${statements.length} statements; D1 permits 1000`)
  }
}

/** Property-testable batching rule from migration-spec §3.1. */
export const boundedInsertBatches = <T>(rows: readonly T[], columnCount: number): T[][] => {
  if (!Number.isSafeInteger(columnCount) || columnCount < 1 || columnCount > 100) {
    throw new Error('columnCount must be between 1 and 100')
  }
  const size = Math.floor(D1_MAX_BOUND_PARAMETERS / columnCount)
  const batches: T[][] = []
  for (let at = 0; at < rows.length; at += size) batches.push(rows.slice(at, at + size))
  return batches
}

type RawDatabase = ImportDatabase['$client']

const isD1 = (database: RawDatabase): database is D1Database => 'batch' in database

const first = async <T>(
  database: RawDatabase,
  sql: string,
  bindings: readonly unknown[] = [],
): Promise<T | null> => {
  if (isD1(database))
    return (
      (await database
        .prepare(sql)
        .bind(...bindings)
        .first<T>()) ?? null
    )
  return (database.prepare(sql).get(...bindings) as T | undefined) ?? null
}

const all = async <T>(
  database: RawDatabase,
  sql: string,
  bindings: readonly unknown[] = [],
): Promise<T[]> => {
  if (isD1(database))
    return (
      await database
        .prepare(sql)
        .bind(...bindings)
        .all<T>()
    ).results
  return database.prepare(sql).all(...bindings) as T[]
}

const execute = async (
  database: RawDatabase,
  statements: readonly PlannedStatement[],
): Promise<void> => {
  const planned = compactInsertStatements(statements)
  assertD1Statements(planned)
  if (isD1(database)) {
    await database.batch(
      planned.map((statement) => database.prepare(statement.sql).bind(...statement.bindings)),
    )
    return
  }
  database.transaction(() => {
    for (const statement of planned) database.prepare(statement.sql).run(...statement.bindings)
  })()
}

interface RawRow {
  line: string
  row: Record<string, unknown>
  numbers: Map<string, string>
  index: number
  endByteOffset: number
}

interface RawChunk {
  rows: RawRow[]
  nextByteOffset: number
}

const rawChunkFrom = async (
  snapshotDir: string,
  resource: string,
  byteOffset: number,
  rowOffset: number,
  limit: number,
): Promise<RawChunk> => {
  const path = join(snapshotDir, 'raw', `${resource}.jsonl`)
  const rows: RawRow[] = []
  let nextByteOffset = byteOffset
  const lines = createInterface({
    input: createReadStream(path, byteOffset === 0 ? undefined : { start: byteOffset }),
    crlfDelay: Infinity,
  })
  try {
    for await (const line of lines) {
      nextByteOffset += Buffer.byteLength(line, 'utf8') + 1
      if (!line.trim()) continue
      const parsed = JSON.parse(line) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(`${path}:${rowOffset + rows.length + 1} is not a JSON object`)
      }
      rows.push({
        line,
        row: parsed as Record<string, unknown>,
        numbers: numberLexemes(line),
        index: rowOffset + rows.length,
        endByteOffset: nextByteOffset,
      })
      if (rows.length >= limit) break
    }
  } finally {
    lines.close()
  }
  return { rows, nextByteOffset }
}

const findRawRowById = async (
  snapshotDir: string,
  resource: string,
  total: number,
  targetId: number,
): Promise<RawRow | null> => {
  let rowOffset = 0
  let byteOffset = 0
  while (rowOffset < total) {
    const chunk = await rawChunkFrom(snapshotDir, resource, byteOffset, rowOffset, 100)
    if (chunk.rows.length === 0) return null
    const match = chunk.rows.find(
      (candidate) => safeIntegerAt(candidate, '/id', `${resource}.id`) === targetId,
    )
    if (match) return match
    rowOffset += chunk.rows.length
    byteOffset = chunk.nextByteOffset
  }
  return null
}

const numberAt = (source: RawRow, path: string, field = path): string => {
  const literal = source.numbers.get(path)
  if (literal === undefined) throw new Error(`${field} has no lossless number token`)
  return literal
}

const nullableNumberAt = (source: RawRow, path: string): string | null =>
  source.numbers.get(path) ?? null

const safeIntegerAt = (source: RawRow, path: string, field = path): number => {
  const literal = numberAt(source, path, field)
  if (!/^\d+$/.test(literal)) throw new Error(`${field} must be a positive integer`)
  const value = Number(literal)
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${field} is outside the safe range`)
  return value
}

const stringValue = (
  row: Record<string, unknown>,
  key: string,
  fallback: string | null = null,
): string | null => {
  const value = row[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') throw new Error(`${key} must be a string or null`)
  return value
}

const bool = (row: Record<string, unknown>, key: string, fallback = false): boolean => {
  const value = row[key]
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error(`${key} must be boolean`)
  return value
}

const nestedId = (row: Record<string, unknown>, key: string): number | null => {
  const nested = row[key]
  if (nested === null || nested === undefined) return null
  if (typeof nested !== 'object' || Array.isArray(nested))
    throw new Error(`${key} must be an object`)
  const id = (nested as Record<string, unknown>).id
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) {
    throw new Error(`${key}.id must be a positive safe integer`)
  }
  return id
}

interface SqlExpression {
  sql: string
  bindings: readonly unknown[]
}
type Cell = unknown | SqlExpression
const expression = (sql: string, ...bindings: unknown[]): SqlExpression => ({ sql, bindings })
const isExpression = (cell: Cell): cell is SqlExpression =>
  typeof cell === 'object' && cell !== null && Object.hasOwn(cell, 'sql')

const renderCells = (cells: readonly Cell[]): { sql: string; bindings: unknown[] } => {
  const bindings: unknown[] = []
  const sql = cells
    .map((cell) => {
      if (!isExpression(cell)) {
        bindings.push(cell)
        return '?'
      }
      bindings.push(...cell.bindings)
      return cell.sql
    })
    .join(', ')
  return { sql, bindings }
}

const insertByHarvestId = (
  table: string,
  columns: readonly string[],
  cells: readonly Cell[],
  harvestId: string | number,
): PlannedStatement => {
  const rendered = renderCells(cells)
  const harvestColumn = columns.indexOf('harvest_id')
  if (harvestColumn < 0 || isExpression(cells[harvestColumn])) {
    throw new Error(`${table} source insert must bind a harvest_id column`)
  }
  if (cells[harvestColumn] !== harvestId)
    throw new Error(`${table} source identity is inconsistent`)
  const metadata: InsertMetadata = { table, columns, rowSql: rendered.sql, harvestColumn }
  return {
    ...renderInsertBatch(metadata, [{ sql: '', bindings: rendered.bindings }]),
    [INSERT_METADATA]: metadata,
  }
}

const idFrom = (table: string, harvestId: number | string): SqlExpression =>
  expression(`(SELECT id FROM ${table} WHERE harvest_id = ?)`, harvestId)

const canonicalJson = (value: unknown): string | null =>
  value == null ? null : JSON.stringify(value)

export interface LoadAnomaly {
  resource: string
  source_id: number | string | null
  kind:
    | 'hours_residue'
    | 'billing_conflict'
    | 'payment_date_disagreement'
    | 'rate_chain_mismatch'
    | 'receipt_download_missing'
  detail: string
}

export interface LoadNextChunkOptions {
  database: ImportDatabase
  snapshotDir: string
  organizationCurrency?: string
  organizationAddress?: string | null
  maxStatements?: number
  maxRows?: number
  /** Required for D1: the executor promises these artifacts are immutable and pinned to this digest. */
  immutableSnapshotSha256?: string
}

export interface LoadChunkResult {
  complete: boolean
  resource: string | null
  loadedRows: number
  statements: number
  snapshotSha256: string
  anomalies: LoadAnomaly[]
}

export const LOAD_RESOURCES = [
  'organization',
  'users',
  'billable_rates',
  'cost_rates',
  'roles',
  'teammates',
  'clients',
  'contacts',
  'tasks',
  'expense_categories',
  'invoice_item_categories',
  'estimate_item_categories',
  'projects',
  'task_assignments',
  'user_assignments',
  'estimates',
  'invoices',
  'time_entries',
  'expenses',
] as const

export type LoadResource = (typeof LOAD_RESOURCES)[number]

export interface LoadResourcePlan {
  resource: LoadResource
  sourceResource: string | null
  absorbs: readonly string[]
}

/** Stable hand-off surface for sync/reconciliation stories. */
export const LOAD_RESOURCE_PLAN: readonly LoadResourcePlan[] = LOAD_RESOURCES.map((resource) => ({
  resource,
  sourceResource: resource === 'organization' ? null : resource,
  absorbs:
    resource === 'estimates'
      ? ['estimate_messages']
      : resource === 'invoices'
        ? ['invoice_messages', 'invoice_payments']
        : [],
}))

const ensureProgressSchema = async (database: RawDatabase): Promise<void> => {
  const progressPresent = await first<{ present: number }>(
    database,
    `SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = '_ezacto_load_progress'`,
  )
  const anomalyPresent = await first<{ present: number }>(
    database,
    `SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = '_ezacto_load_anomalies'`,
  )
  const admissionPresent = await first<{ present: number }>(
    database,
    `SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = '_ezacto_load_admission'`,
  )
  const subprogressPresent = await first<{ present: number }>(
    database,
    `SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = '_ezacto_load_subprogress'`,
  )
  const statements: PlannedStatement[] = []
  if (!admissionPresent)
    statements.push({
      sql: `CREATE TABLE _ezacto_load_admission (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      snapshot_sha256 TEXT NOT NULL,
      manifest_sha256 TEXT NOT NULL,
      load_options_json TEXT NOT NULL CHECK (json_valid(load_options_json)),
      admitted_at TEXT NOT NULL
    ) STRICT`,
      bindings: [],
    })
  if (!progressPresent)
    statements.push({
      sql: `CREATE TABLE _ezacto_load_progress (
      resource TEXT PRIMARY KEY,
      snapshot_sha256 TEXT NOT NULL,
      load_options_json TEXT NOT NULL CHECK (json_valid(load_options_json)),
      source_byte_offset INTEGER NOT NULL CHECK (source_byte_offset >= 0),
      rows_loaded INTEGER NOT NULL CHECK (rows_loaded >= 0),
      total_rows INTEGER NOT NULL CHECK (total_rows >= 0),
      completed INTEGER NOT NULL CHECK (completed IN (0,1)),
      updated_at TEXT NOT NULL
    ) STRICT`,
      bindings: [],
    })
  if (!subprogressPresent)
    statements.push({
      sql: `CREATE TABLE _ezacto_load_subprogress (
      resource TEXT NOT NULL,
      row_index INTEGER NOT NULL CHECK (row_index >= 0),
      child_offset INTEGER NOT NULL CHECK (child_offset >= 0),
      child_byte_offset INTEGER NOT NULL CHECK (child_byte_offset >= 0),
      lineage_byte_offset INTEGER NOT NULL CHECK (lineage_byte_offset >= 0),
      PRIMARY KEY (resource, row_index)
    ) STRICT`,
      bindings: [],
    })
  if (!anomalyPresent)
    statements.push({
      sql: `CREATE TABLE _ezacto_load_anomalies (
      snapshot_sha256 TEXT NOT NULL,
      resource TEXT NOT NULL,
      source_id TEXT,
      kind TEXT NOT NULL,
      detail TEXT NOT NULL,
      PRIMARY KEY (snapshot_sha256, resource, source_id, kind, detail)
    ) STRICT`,
      bindings: [],
    })
  if (statements.length > 0) await execute(database, statements)
}

export interface LoadProgressRecord {
  resource: string
  snapshotSha256: string
  loadOptionsJson: string
  sourceByteOffset: number
  rowsLoaded: number
  totalRows: number
  completed: boolean
}

export const readLoadProgress = async (database: ImportDatabase): Promise<LoadProgressRecord[]> => {
  await ensureProgressSchema(database.$client)
  const rows = await all<Omit<LoadProgressRecord, 'completed'> & { completed: number }>(
    database.$client,
    `SELECT resource, snapshot_sha256 AS snapshotSha256, source_byte_offset AS sourceByteOffset,
      rows_loaded AS rowsLoaded,
      load_options_json AS loadOptionsJson, total_rows AS totalRows, completed
      FROM _ezacto_load_progress ORDER BY resource`,
  )
  return rows.map((row) => ({ ...row, completed: row.completed === 1 }))
}

export interface DurableLoadReport {
  snapshot_sha256: string
  complete: boolean
  resources: LoadProgressRecord[]
  anomalies: LoadAnomaly[]
}

export const readLoadReport = async (
  database: ImportDatabase,
  snapshotSha256: string,
): Promise<DurableLoadReport> => {
  const resources = (await readLoadProgress(database)).filter(
    (row) => row.snapshotSha256 === snapshotSha256,
  )
  const anomalyRows = await all<{
    resource: string
    sourceId: string | null
    kind: LoadAnomaly['kind']
    detail: string
  }>(
    database.$client,
    `SELECT resource, source_id AS sourceId, kind, detail FROM _ezacto_load_anomalies
      WHERE snapshot_sha256 = ? ORDER BY resource, source_id, kind, detail`,
    [snapshotSha256],
  )
  return {
    snapshot_sha256: snapshotSha256,
    complete: LOAD_RESOURCES.every((resource) =>
      resources.some(
        (row) => row.resource === resource && row.completed && row.rowsLoaded === row.totalRows,
      ),
    ),
    resources,
    anomalies: anomalyRows.map((row) => ({
      resource: row.resource,
      source_id: row.sourceId,
      kind: row.kind,
      detail: row.detail,
    })),
  }
}

export const assertLoadComplete = async (
  database: ImportDatabase,
  snapshotSha256: string,
): Promise<DurableLoadReport> => {
  const report = await readLoadReport(database, snapshotSha256)
  if (!report.complete) throw new Error(`snapshot ${snapshotSha256} load is incomplete`)
  return report
}

const progress = async (database: RawDatabase, resource: string) =>
  first<{
    snapshotSha256: string
    loadOptionsJson: string
    sourceByteOffset: number
    rowsLoaded: number
    totalRows: number
    completed: number
  }>(
    database,
    `SELECT snapshot_sha256 AS snapshotSha256, load_options_json AS loadOptionsJson,
      source_byte_offset AS sourceByteOffset, rows_loaded AS rowsLoaded,
      total_rows AS totalRows, completed FROM _ezacto_load_progress WHERE resource = ?`,
    [resource],
  )

const progressStatement = (
  resource: string,
  digest: string,
  loadOptionsJson: string,
  sourceByteOffset: number,
  rowsLoaded: number,
  totalRows: number,
  completed: boolean,
  timestamp: string,
): PlannedStatement => ({
  sql: `INSERT INTO _ezacto_load_progress
      (resource, snapshot_sha256, load_options_json, source_byte_offset,
        rows_loaded, total_rows, completed, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(resource) DO UPDATE SET
      source_byte_offset = excluded.source_byte_offset,
      rows_loaded = excluded.rows_loaded, total_rows = excluded.total_rows,
      completed = excluded.completed, updated_at = excluded.updated_at
    WHERE _ezacto_load_progress.snapshot_sha256 = excluded.snapshot_sha256`,
  bindings: [
    resource,
    digest,
    loadOptionsJson,
    sourceByteOffset,
    rowsLoaded,
    totalRows,
    completed ? 1 : 0,
    timestamp,
  ],
})

interface LoadSubprogress {
  childOffset: number
  childByteOffset: number
  lineageByteOffset: number
}

const subprogress = async (
  database: RawDatabase,
  resource: string,
  rowIndex: number,
): Promise<LoadSubprogress | null> =>
  first<LoadSubprogress>(
    database,
    `SELECT child_offset AS childOffset, child_byte_offset AS childByteOffset,
    lineage_byte_offset AS lineageByteOffset
   FROM _ezacto_load_subprogress WHERE resource = ? AND row_index = ?`,
    [resource, rowIndex],
  )

const subprogressStatement = (
  resource: string,
  rowIndex: number,
  childOffset: number,
  childByteOffset: number,
  lineageByteOffset: number,
): PlannedStatement => ({
  sql: `INSERT INTO _ezacto_load_subprogress
      (resource, row_index, child_offset, child_byte_offset, lineage_byte_offset)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(resource, row_index) DO UPDATE SET
      child_offset = excluded.child_offset,
      child_byte_offset = excluded.child_byte_offset,
      lineage_byte_offset = excluded.lineage_byte_offset`,
  bindings: [resource, rowIndex, childOffset, childByteOffset, lineageByteOffset],
})

const deleteSubprogressStatement = (resource: string, rowIndex: number): PlannedStatement => ({
  sql: `DELETE FROM _ezacto_load_subprogress WHERE resource = ? AND row_index = ?`,
  bindings: [resource, rowIndex],
})

const anomalyStatements = (digest: string, anomalies: readonly LoadAnomaly[]): PlannedStatement[] =>
  anomalies.map((anomaly) => ({
    sql: `INSERT INTO _ezacto_load_anomalies
        (snapshot_sha256, resource, source_id, kind, detail)
      SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (
        SELECT 1 FROM _ezacto_load_anomalies
        WHERE snapshot_sha256 = ? AND resource = ? AND source_id IS ? AND kind = ? AND detail = ?
      )`,
    bindings: [
      digest,
      anomaly.resource,
      anomaly.source_id === null ? null : String(anomaly.source_id),
      anomaly.kind,
      anomaly.detail,
      digest,
      anomaly.resource,
      anomaly.source_id === null ? null : String(anomaly.source_id),
      anomaly.kind,
      anomaly.detail,
    ],
  }))

const sourceTimestamp = (manifest: Manifest): string => {
  if (manifest.finished_at === null)
    throw new Error('snapshot is unfinished; load refuses partial input')
  return manifest.finished_at
}

const requiredText = (row: Record<string, unknown>, key: string): string => {
  const value = stringValue(row, key)
  if (value === null) throw new Error(`${key} is required`)
  return value
}

const money = (source: RawRow, path: string): number | null => {
  const literal = nullableNumberAt(source, path)
  return literal === null ? null : moneyLiteralToCents(literal, path)
}

const seconds = (
  source: RawRow,
  path: string,
  anomalies: LoadAnomaly[],
  resource: string,
): number | null => {
  const literal = nullableNumberAt(source, path)
  if (literal === null) return null
  const transformed = hoursLiteralToSeconds(literal, path)
  if (transformed.residue !== null) {
    anomalies.push({
      resource,
      source_id: source.numbers.get('/id') ?? null,
      kind: 'hours_residue',
      detail: `${path}=${transformed.residue}`,
    })
  }
  return transformed.seconds
}

const CHILD_INDEX_RECORD_BYTES = 111

interface ChildIndexRecord {
  parentId: number
  startByte: number
  endByte: number
  lineageStartByte: number
  lineageEndByte: number
  startRow: number
  count: number
}

const childIndexPath = (snapshotDir: string, resource: string, digest: string): string =>
  join(snapshotDir, 'raw', '.load-index', `${resource}.${digest}.idx`)

const childIndexLine = (record: ChildIndexRecord): string => {
  const fields = [
    String(record.parentId).padStart(16, '0'),
    String(record.startByte).padStart(16, '0'),
    String(record.endByte).padStart(16, '0'),
    String(record.lineageStartByte).padStart(16, '0'),
    String(record.lineageEndByte).padStart(16, '0'),
    String(record.startRow).padStart(12, '0'),
    String(record.count).padStart(12, '0'),
  ]
  const line = `${fields.join(' ')}\n`
  if (Buffer.byteLength(line) !== CHILD_INDEX_RECORD_BYTES) {
    throw new Error('child index exceeded its fixed-width bounds')
  }
  return line
}

const buildChildIndex = async (
  snapshotDir: string,
  resource: string,
  parentResource: string,
  digest: string,
): Promise<void> => {
  const raw = createInterface({
    input: createReadStream(join(snapshotDir, 'raw', `${resource}.jsonl`)),
    crlfDelay: Infinity,
  })
  const lineage = createInterface({
    input: createReadStream(join(snapshotDir, 'raw', `${resource}.lineage.jsonl`)),
    crlfDelay: Infinity,
  })
  const rawIterator = raw[Symbol.asyncIterator]()
  const lineageIterator = lineage[Symbol.asyncIterator]()
  let rawOffset = 0
  let lineageOffset = 0
  let childRowOffset = 0
  const nextLine = async (iterator: AsyncIterator<string>): Promise<string | null> => {
    for (;;) {
      const next = await iterator.next()
      if (next.done) return null
      if (next.value.trim()) return next.value
    }
  }
  const nextChild = async (): Promise<{
    parentId: number
    sourceId: number
    startByte: number
    endByte: number
    lineageStartByte: number
    lineageEndByte: number
  } | null> => {
    const [rawLine, lineageLine] = await Promise.all([
      nextLine(rawIterator),
      nextLine(lineageIterator),
    ])
    if (rawLine === null && lineageLine === null) return null
    if (rawLine === null || lineageLine === null) {
      throw new Error(`${resource} raw data and lineage have different row counts`)
    }
    const source = JSON.parse(rawLine) as Record<string, unknown>
    const witness = JSON.parse(lineageLine) as Partial<ChildLineage>
    if (
      !Number.isSafeInteger(source.id) ||
      !Number.isSafeInteger(witness.source_id) ||
      !Number.isSafeInteger(witness.parent_id) ||
      source.id !== witness.source_id ||
      (witness.parent_id ?? 0) < 1
    ) {
      throw new Error(`${resource} lineage is misaligned while indexing`)
    }
    const startByte = rawOffset
    const lineageStartByte = lineageOffset
    rawOffset += Buffer.byteLength(rawLine, 'utf8') + 1
    lineageOffset += Buffer.byteLength(lineageLine, 'utf8') + 1
    return {
      parentId: witness.parent_id!,
      sourceId: witness.source_id!,
      startByte,
      endByte: rawOffset,
      lineageStartByte,
      lineageEndByte: lineageOffset,
    }
  }
  const path = childIndexPath(snapshotDir, resource, digest)
  await mkdir(join(snapshotDir, 'raw', '.load-index'), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  const output = await open(temporary, 'w')
  try {
    let child = await nextChild()
    let indexedRawOffset = 0
    let indexedLineageOffset = 0
    for await (const parentId of readIds(snapshotDir, parentResource)) {
      const startByte = indexedRawOffset
      const lineageStartByte = indexedLineageOffset
      const startRow = childRowOffset
      let count = 0
      while (child !== null && child.parentId === parentId) {
        count += 1
        childRowOffset += 1
        indexedRawOffset = child.endByte
        indexedLineageOffset = child.lineageEndByte
        child = await nextChild()
      }
      await output.writeFile(
        childIndexLine({
          parentId,
          startByte,
          endByte: indexedRawOffset,
          lineageStartByte,
          lineageEndByte: indexedLineageOffset,
          startRow,
          count,
        }),
      )
    }
    if (child !== null) {
      throw new Error(
        `${resource} lineage parent ${child.parentId} is absent or out of parent extraction order`,
      )
    }
    await output.sync()
  } catch (error) {
    await output.close()
    await rm(temporary, { force: true })
    throw error
  } finally {
    raw.close()
    lineage.close()
  }
  await output.close()
  await rename(temporary, path)
}

const parseChildIndexRecord = (line: string, resource: string): ChildIndexRecord => {
  const match = /^(\d{16}) (\d{16}) (\d{16}) (\d{16}) (\d{16}) (\d{12}) (\d{12})\n$/.exec(line)
  if (!match) throw new Error(`${resource} child index is corrupt`)
  return {
    parentId: Number(match[1]),
    startByte: Number(match[2]),
    endByte: Number(match[3]),
    lineageStartByte: Number(match[4]),
    lineageEndByte: Number(match[5]),
    startRow: Number(match[6]),
    count: Number(match[7]),
  }
}

const readChildIndexRecord = async (
  handle: Awaited<ReturnType<typeof open>>,
  resource: string,
  ordinal: number,
): Promise<ChildIndexRecord> => {
  const buffer = Buffer.alloc(CHILD_INDEX_RECORD_BYTES)
  const { bytesRead } = await handle.read(
    buffer,
    0,
    buffer.length,
    ordinal * CHILD_INDEX_RECORD_BYTES,
  )
  if (bytesRead !== buffer.length) throw new Error(`${resource} child index is truncated`)
  return parseChildIndexRecord(buffer.toString('utf8'), resource)
}

const buildChildIndexes = async (
  snapshotDir: string,
  manifest: Manifest,
  digest: string,
): Promise<void> => {
  for (const step of RESOURCES) {
    if (step.kind !== 'child' || (manifest.resources[step.name]?.count ?? 0) === 0) continue
    await buildChildIndex(snapshotDir, step.name, step.parent, digest)
  }
}

const ensureChildIndexes = async (
  snapshotDir: string,
  manifest: Manifest,
  digest: string,
): Promise<void> => {
  for (const step of RESOURCES) {
    const expectedCount = manifest.resources[step.name]?.count ?? 0
    if (step.kind !== 'child' || expectedCount === 0) continue
    let valid = false
    try {
      const handle = await open(childIndexPath(snapshotDir, step.name, digest), 'r')
      try {
        const size = (await handle.stat()).size
        const parentCount = manifest.resources[step.parent]?.count ?? 0
        valid = size === parentCount * CHILD_INDEX_RECORD_BYTES
        let previousEndByte = 0
        let previousLineageEndByte = 0
        let previousEndRow = 0
        for (let ordinal = 0; valid && ordinal < parentCount; ordinal += 1) {
          const record = await readChildIndexRecord(handle, step.name, ordinal)
          valid =
            record.parentId > 0 &&
            record.startByte === previousEndByte &&
            record.lineageStartByte === previousLineageEndByte &&
            record.startRow === previousEndRow &&
            record.endByte >= record.startByte &&
            record.lineageEndByte >= record.lineageStartByte &&
            record.count >= 0 &&
            (record.count > 0 ||
              (record.endByte === record.startByte &&
                record.lineageEndByte === record.lineageStartByte))
          previousEndByte = record.endByte
          previousLineageEndByte = record.lineageEndByte
          previousEndRow = record.startRow + record.count
        }
        valid &&= previousEndRow === expectedCount
      } finally {
        await handle.close()
      }
    } catch {
      valid = false
    }
    if (!valid) await buildChildIndex(snapshotDir, step.name, step.parent, digest)
  }
}

const findChildIndex = async (
  snapshotDir: string,
  resource: string,
  digest: string,
  parentOrdinal: number,
  parentId: number,
): Promise<ChildIndexRecord | null> => {
  const handle = await open(childIndexPath(snapshotDir, resource, digest), 'r')
  try {
    const size = (await handle.stat()).size
    if (size % CHILD_INDEX_RECORD_BYTES !== 0) throw new Error(`${resource} child index is corrupt`)
    if (parentOrdinal < 0 || parentOrdinal >= size / CHILD_INDEX_RECORD_BYTES) return null
    const record = await readChildIndexRecord(handle, resource, parentOrdinal)
    if (record.parentId !== parentId)
      throw new Error(`${resource} child index parent is misaligned`)
    return record.count === 0 ? null : record
  } finally {
    await handle.close()
  }
}

interface ChildIndexSlice {
  record: ChildIndexRecord
  count: number
}

const childIndexSlices = async (
  snapshotDir: string,
  resource: string,
  digest: string,
  rowOffset: number,
  count: number,
): Promise<ChildIndexSlice[]> => {
  if (count === 0) return []
  const handle = await open(childIndexPath(snapshotDir, resource, digest), 'r')
  try {
    const size = (await handle.stat()).size
    if (size % CHILD_INDEX_RECORD_BYTES !== 0) throw new Error(`${resource} child index is corrupt`)
    const records = size / CHILD_INDEX_RECORD_BYTES
    const slices: ChildIndexSlice[] = []
    let at = rowOffset
    let remaining = count
    while (remaining > 0) {
      let low = 0
      let high = records - 1
      let ordinal = -1
      while (low <= high) {
        const middle = Math.floor((low + high) / 2)
        const candidate = await readChildIndexRecord(handle, resource, middle)
        if (candidate.startRow <= at) {
          ordinal = middle
          low = middle + 1
        } else high = middle - 1
      }
      if (ordinal < 0) throw new Error(`${resource} child row ${at} is absent from its index`)
      const record = await readChildIndexRecord(handle, resource, ordinal)
      if (record.count === 0 || at < record.startRow || at >= record.startRow + record.count) {
        throw new Error(`${resource} child row ${at} is absent from its index`)
      }
      const take = Math.min(remaining, record.startRow + record.count - at)
      slices.push({ record, count: take })
      at += take
      remaining -= take
    }
    return slices
  } finally {
    await handle.close()
  }
}

const lineageChunkFrom = async (
  snapshotDir: string,
  resource: string,
  record: ChildIndexRecord,
  skip: number,
  count: number,
): Promise<ChildLineage[]> => {
  const rows: ChildLineage[] = []
  let seen = 0
  const lines = createInterface({
    input: createReadStream(join(snapshotDir, 'raw', `${resource}.lineage.jsonl`), {
      start: record.lineageStartByte,
      end: record.lineageEndByte - 1,
    }),
    crlfDelay: Infinity,
  })
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      if (seen++ < skip) continue
      const witness = JSON.parse(line) as Partial<ChildLineage>
      if (
        !Number.isSafeInteger(witness.source_id) ||
        !Number.isSafeInteger(witness.parent_id) ||
        witness.parent_id !== record.parentId
      ) {
        throw new Error(`${resource} child index disagrees with source lineage`)
      }
      rows.push(witness as ChildLineage)
      if (rows.length === count) break
    }
  } finally {
    lines.close()
  }
  if (rows.length !== count) throw new Error(`${resource} child lineage range is truncated`)
  return rows
}

const lineageChunkAt = async (
  snapshotDir: string,
  resource: string,
  record: ChildIndexRecord,
  byteOffset: number,
  count: number,
): Promise<{ rows: ChildLineage[]; nextByteOffset: number }> => {
  if (byteOffset < record.lineageStartByte || byteOffset > record.lineageEndByte) {
    throw new Error(`${resource} child lineage checkpoint is outside its indexed range`)
  }
  const rows: ChildLineage[] = []
  let nextByteOffset = byteOffset
  const lines = createInterface({
    input: createReadStream(join(snapshotDir, 'raw', `${resource}.lineage.jsonl`), {
      start: byteOffset,
      end: record.lineageEndByte - 1,
    }),
    crlfDelay: Infinity,
  })
  try {
    for await (const line of lines) {
      nextByteOffset += Buffer.byteLength(line, 'utf8') + 1
      if (!line.trim()) continue
      const witness = JSON.parse(line) as Partial<ChildLineage>
      if (!Number.isSafeInteger(witness.source_id) || witness.parent_id !== record.parentId) {
        throw new Error(`${resource} child index disagrees with source lineage`)
      }
      rows.push(witness as ChildLineage)
      if (rows.length === count) break
    }
  } finally {
    lines.close()
  }
  if (rows.length !== count) throw new Error(`${resource} child lineage range is truncated`)
  return { rows, nextByteOffset }
}

const lineageFor = async (
  snapshotDir: string,
  resource: string,
  digest: string,
  offset: number,
  rows: readonly RawRow[],
): Promise<ChildLineage[]> => {
  const slices = await childIndexSlices(snapshotDir, resource, digest, offset, rows.length)
  const lineage: ChildLineage[] = []
  let source = 0
  let at = offset
  for (const slice of slices) {
    const witnesses = await lineageChunkFrom(
      snapshotDir,
      resource,
      slice.record,
      at - slice.record.startRow,
      slice.count,
    )
    for (const witness of witnesses) {
      const row = rows[source++]!
      if (witness.source_id !== safeIntegerAt(row, '/id', `${resource}.id`)) {
        throw new Error(`${resource} child lineage is misaligned`)
      }
      lineage.push(witness)
    }
    at += slice.count
  }
  return lineage
}

interface RateLoadContext {
  expectedEndDate: string | null
}

interface RateLoadRow {
  source: RawRow
  lineage: ChildLineage
  context: RateLoadContext
}

interface RateLoadBatch {
  rows: RateLoadRow[]
  record: ChildIndexRecord
}

const dayBefore = (value: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`rate start_date ${value} is invalid`)
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(milliseconds)) throw new Error(`rate start_date ${value} is invalid`)
  return new Date(milliseconds - 86_400_000).toISOString().slice(0, 10)
}

const rateLoadRows = async (
  snapshotDir: string,
  resource: 'billable_rates' | 'cost_rates',
  digest: string,
  rowOffset: number,
): Promise<RateLoadBatch> => {
  const [slice] = await childIndexSlices(snapshotDir, resource, digest, rowOffset, 1)
  if (!slice) throw new Error(`${resource} child row ${rowOffset} is absent from its index`)
  const { record } = slice
  const chunk = await rawChunkFrom(
    snapshotDir,
    resource,
    record.startByte,
    record.startRow,
    record.count,
  )
  const sourceLineage = await lineageChunkFrom(snapshotDir, resource, record, 0, record.count)
  for (const [index, witness] of sourceLineage.entries()) {
    if (witness.source_id !== safeIntegerAt(chunk.rows[index]!, '/id', `${resource}.id`)) {
      throw new Error(`${resource} child lineage is misaligned`)
    }
  }
  const sorted = chunk.rows
    .map((source, index) => ({ source, lineage: sourceLineage[index]! }))
    .sort((left, right) => {
      const leftStart = stringValue(left.source.row, 'start_date') ?? ''
      const rightStart = stringValue(right.source.row, 'start_date') ?? ''
      return (
        leftStart.localeCompare(rightStart) ||
        safeIntegerAt(left.source, '/id', `${resource}.id`) -
          safeIntegerAt(right.source, '/id', `${resource}.id`)
      )
    })
  const expectedEndDate = new Map<number, string | null>()
  for (const [index, pair] of sorted.entries()) {
    const nextStart =
      index + 1 < sorted.length ? stringValue(sorted[index + 1]!.source.row, 'start_date') : null
    expectedEndDate.set(
      safeIntegerAt(pair.source, '/id', `${resource}.id`),
      nextStart === null ? null : dayBefore(nextStart),
    )
  }
  return {
    record,
    rows: sorted.map((pair) => ({
      ...pair,
      context: {
        expectedEndDate:
          expectedEndDate.get(safeIntegerAt(pair.source, '/id', `${resource}.id`)) ?? null,
      },
    })),
  }
}

const rowStatements = (
  resource: Exclude<LoadResource, 'organization' | 'estimates' | 'invoices' | 'expenses'>,
  source: RawRow,
  manifest: Manifest,
  anomalies: LoadAnomaly[],
  lineage?: ChildLineage,
  rateContext?: RateLoadContext,
  taskBudgetBy?: string,
  childOffset = 0,
  childLimit = Number.POSITIVE_INFINITY,
): PlannedStatement[] => {
  const row = source.row
  const harvestId =
    resource === 'time_entries'
      ? numberAt(source, '/id', 'time_entries.id')
      : safeIntegerAt(source, '/id', `${resource}.id`)
  const createdAt = requiredText(row, 'created_at')
  const updatedAt = requiredText(row, 'updated_at')
  switch (resource) {
    case 'users': {
      const sourceRoles = row.access_roles
      if (!Array.isArray(sourceRoles) || sourceRoles.some((role) => typeof role !== 'string')) {
        throw new Error('users.access_roles must be an array of strings')
      }
      const mapped = accessRoles(sourceRoles as string[])
      const user = insertByHarvestId(
        'users',
        [
          'harvest_id',
          'first_name',
          'last_name',
          'telephone',
          'timezone',
          'is_contractor',
          'is_active',
          'has_access_to_all_future_projects',
          'weekly_capacity',
          'profile',
          'manager_grants',
          'avatar_url',
          'saml_exempt',
          'created_at',
          'updated_at',
        ],
        [
          harvestId,
          requiredText(row, 'first_name'),
          requiredText(row, 'last_name'),
          stringValue(row, 'telephone'),
          stringValue(row, 'timezone', 'UTC'),
          bool(row, 'is_contractor') ? 1 : 0,
          bool(row, 'is_active', true) ? 1 : 0,
          bool(row, 'has_access_to_all_future_projects') ? 1 : 0,
          typeof row.weekly_capacity === 'number'
            ? row.weekly_capacity
            : manifest.preflight.weekly_capacity,
          mapped.profile,
          JSON.stringify(mapped.managerGrants),
          stringValue(row, 'avatar_url'),
          bool(row, 'saml_exempt') ? 1 : 0,
          createdAt,
          updatedAt,
        ],
        harvestId,
      )
      const email = requiredText(row, 'email')
      return [
        user,
        {
          sql: `INSERT INTO user_emails
            (user_id, address, verified_at, is_primary, created_at, updated_at)
            SELECT user.id, ?, ?, 1, ?, ? FROM users user WHERE user.harvest_id = ?
              AND NOT EXISTS (SELECT 1 FROM user_emails existing
                WHERE existing.user_id = user.id AND lower(existing.address) = lower(?))`,
          bindings: [email, createdAt, createdAt, updatedAt, harvestId, email],
        },
      ]
    }
    case 'billable_rates':
    case 'cost_rates': {
      if (!lineage || lineage.source_id !== harvestId)
        throw new Error(`${resource} lineage is misaligned`)
      if (!rateContext) throw new Error(`${resource} derived-chain context is missing`)
      const sourceEndDate = stringValue(row, 'end_date')
      if (sourceEndDate !== rateContext.expectedEndDate) {
        anomalies.push({
          resource,
          source_id: harvestId,
          kind: 'rate_chain_mismatch',
          detail: `source end_date=${sourceEndDate ?? 'null'}; derived end_date=${rateContext.expectedEndDate ?? 'null'}`,
        })
      }
      const table = resource === 'billable_rates' ? 'user_billable_rates' : 'user_cost_rates'
      return [
        insertByHarvestId(
          table,
          ['harvest_id', 'user_id', 'amount_cents', 'start_date', 'created_at', 'updated_at'],
          [
            harvestId,
            idFrom('users', lineage.parent_id),
            moneyLiteralToCents(numberAt(source, '/amount'), `${resource}.amount`),
            stringValue(row, 'start_date'),
            createdAt,
            updatedAt,
          ],
          harvestId,
        ),
      ]
    }
    case 'roles': {
      const statements = [
        insertByHarvestId(
          'roles',
          ['harvest_id', 'name', 'created_at', 'updated_at'],
          [harvestId, requiredText(row, 'name'), createdAt, updatedAt],
          harvestId,
        ),
      ]
      if (Array.isArray(row.user_ids)) {
        const end = Math.min(row.user_ids.length, childOffset + childLimit)
        for (let index = childOffset; index < end; index += 1) {
          const userId = row.user_ids[index]
          if (typeof userId !== 'number' || !Number.isSafeInteger(userId))
            throw new Error('roles.user_ids is invalid')
          statements.push({
            sql: `INSERT INTO user_roles (user_id, role_id, created_at, updated_at)
              SELECT user.id, role.id, ?, ? FROM users user, roles role
              WHERE user.harvest_id = ? AND role.harvest_id = ?
                AND NOT EXISTS (SELECT 1 FROM user_roles existing
                  WHERE existing.user_id = user.id AND existing.role_id = role.id)`,
            bindings: [createdAt, updatedAt, userId, harvestId],
          })
        }
      }
      return statements
    }
    case 'teammates': {
      if (!lineage || lineage.source_id !== harvestId)
        throw new Error('teammates lineage is misaligned')
      return [
        {
          sql: `INSERT INTO teammate_assignments (manager_id, user_id, created_at, updated_at)
          SELECT manager.id, teammate.id, ?, ? FROM users manager, users teammate
          WHERE manager.harvest_id = ? AND teammate.harvest_id = ?
            AND NOT EXISTS (SELECT 1 FROM teammate_assignments existing
              WHERE existing.manager_id = manager.id AND existing.user_id = teammate.id)`,
          bindings: [createdAt, updatedAt, lineage.parent_id, harvestId],
        },
      ]
    }
    case 'clients':
      return [
        insertByHarvestId(
          'clients',
          ['harvest_id', 'name', 'address', 'currency', 'is_active', 'created_at', 'updated_at'],
          [
            harvestId,
            requiredText(row, 'name'),
            stringValue(row, 'address'),
            requiredText(row, 'currency'),
            bool(row, 'is_active', true) ? 1 : 0,
            createdAt,
            updatedAt,
          ],
          harvestId,
        ),
      ]
    case 'contacts':
      return [
        insertByHarvestId(
          'contacts',
          [
            'harvest_id',
            'client_id',
            'title',
            'first_name',
            'last_name',
            'email',
            'phone_office',
            'phone_mobile',
            'fax',
            'invoice_recipient_status',
            'created_at',
            'updated_at',
          ],
          [
            harvestId,
            idFrom('clients', nestedId(row, 'client')!),
            stringValue(row, 'title'),
            requiredText(row, 'first_name'),
            stringValue(row, 'last_name'),
            stringValue(row, 'email'),
            stringValue(row, 'phone_office'),
            stringValue(row, 'phone_mobile'),
            stringValue(row, 'fax'),
            stringValue(row, 'invoice_recipient_status', 'none'),
            createdAt,
            updatedAt,
          ],
          harvestId,
        ),
      ]
    case 'tasks':
      return [
        insertByHarvestId(
          'tasks',
          [
            'harvest_id',
            'name',
            'billable_by_default',
            'default_hourly_rate_cents',
            'is_default',
            'is_active',
            'created_at',
            'updated_at',
          ],
          [
            harvestId,
            requiredText(row, 'name'),
            bool(row, 'billable_by_default', true) ? 1 : 0,
            money(source, '/default_hourly_rate'),
            bool(row, 'is_default') ? 1 : 0,
            bool(row, 'is_active', true) ? 1 : 0,
            createdAt,
            updatedAt,
          ],
          harvestId,
        ),
      ]
    case 'expense_categories':
      return [
        insertByHarvestId(
          'expense_categories',
          [
            'harvest_id',
            'name',
            'unit_name',
            'unit_price_cents',
            'is_active',
            'created_at',
            'updated_at',
          ],
          [
            harvestId,
            requiredText(row, 'name'),
            stringValue(row, 'unit_name'),
            money(source, '/unit_price'),
            bool(row, 'is_active', true) ? 1 : 0,
            createdAt,
            updatedAt,
          ],
          harvestId,
        ),
      ]
    case 'invoice_item_categories':
      return [
        insertByHarvestId(
          'invoice_item_categories',
          ['harvest_id', 'name', 'use_as_service', 'use_as_expense', 'created_at', 'updated_at'],
          [
            harvestId,
            requiredText(row, 'name'),
            bool(row, 'use_as_service') ? 1 : 0,
            bool(row, 'use_as_expense') ? 1 : 0,
            createdAt,
            updatedAt,
          ],
          harvestId,
        ),
      ]
    case 'estimate_item_categories':
      return [
        insertByHarvestId(
          'estimate_item_categories',
          ['harvest_id', 'name', 'created_at', 'updated_at'],
          [harvestId, requiredText(row, 'name'), createdAt, updatedAt],
          harvestId,
        ),
      ]
    case 'projects': {
      const method = billingMethod(bool(row, 'is_billable', true), bool(row, 'is_fixed_fee'))
      if (method.anomaly)
        anomalies.push({
          resource,
          source_id: harvestId,
          kind: 'billing_conflict',
          detail: 'is_billable=false and is_fixed_fee=true',
        })
      const billByRaw = (stringValue(row, 'bill_by', 'Project') ?? 'Project').toLowerCase()
      const billBy = ['project', 'tasks', 'people', 'none'].includes(billByRaw) ? billByRaw : 'none'
      const budgetByRaw = (stringValue(row, 'budget_by', 'none') ?? 'none')
        .toLowerCase()
        .replace(/ /g, '_')
      const budgetBy = ['project', 'project_cost', 'task', 'task_fees', 'person', 'none'].includes(
        budgetByRaw,
      )
        ? budgetByRaw
        : 'none'
      return [
        insertByHarvestId(
          'projects',
          [
            'harvest_id',
            'client_id',
            'name',
            'code',
            'is_active',
            'billing_method',
            'bill_by',
            'hourly_rate_cents',
            'fee_cents',
            'budget_by',
            'budget_seconds',
            'cost_budget_cents',
            'budget_is_monthly',
            'cost_budget_include_expenses',
            'notify_when_over_budget',
            'over_budget_pct',
            'over_budget_notified_on',
            'show_budget_to_all',
            'starts_on',
            'ends_on',
            'notes',
            'billing_currency',
            'created_at',
            'updated_at',
          ],
          [
            harvestId,
            idFrom('clients', nestedId(row, 'client')!),
            requiredText(row, 'name'),
            stringValue(row, 'code', ''),
            bool(row, 'is_active', true) ? 1 : 0,
            method.value,
            billBy,
            money(source, '/hourly_rate'),
            money(source, '/fee'),
            budgetBy,
            seconds(source, '/budget', anomalies, resource),
            money(source, '/cost_budget'),
            bool(row, 'budget_is_monthly') ? 1 : 0,
            bool(row, 'cost_budget_include_expenses') ? 1 : 0,
            bool(row, 'notify_when_over_budget') ? 1 : 0,
            typeof row.over_budget_notification_percentage === 'number'
              ? row.over_budget_notification_percentage
              : null,
            stringValue(row, 'over_budget_notification_date'),
            bool(row, 'show_budget_to_all') ? 1 : 0,
            stringValue(row, 'starts_on'),
            stringValue(row, 'ends_on'),
            stringValue(row, 'notes'),
            stringValue(row, 'billable_rate_currency'),
            createdAt,
            updatedAt,
          ],
          harvestId,
        ),
      ]
    }
    case 'task_assignments': {
      const projectId = nestedId(row, 'project')!
      const budgetSeconds =
        taskBudgetBy === 'task' ? seconds(source, '/budget', anomalies, resource) : null
      const budgetCents = taskBudgetBy === 'task_fees' ? money(source, '/budget') : null
      return [
        insertByHarvestId(
          'task_assignments',
          [
            'harvest_id',
            'project_id',
            'task_id',
            'is_active',
            'billable',
            'hourly_rate_cents',
            'budget_seconds',
            'budget_cents',
            'created_at',
            'updated_at',
          ],
          [
            harvestId,
            idFrom('projects', projectId),
            idFrom('tasks', nestedId(row, 'task')!),
            bool(row, 'is_active', true) ? 1 : 0,
            bool(row, 'billable', true) ? 1 : 0,
            money(source, '/hourly_rate'),
            budgetSeconds,
            budgetCents,
            createdAt,
            updatedAt,
          ],
          harvestId,
        ),
      ]
    }
    case 'user_assignments':
      return [
        insertByHarvestId(
          'user_assignments',
          [
            'harvest_id',
            'project_id',
            'user_id',
            'is_active',
            'is_project_manager',
            'use_default_rates',
            'hourly_rate_cents',
            'budget_seconds',
            'created_at',
            'updated_at',
          ],
          [
            harvestId,
            idFrom('projects', nestedId(row, 'project')!),
            idFrom('users', nestedId(row, 'user')!),
            bool(row, 'is_active', true) ? 1 : 0,
            bool(row, 'is_project_manager') ? 1 : 0,
            bool(row, 'use_default_rates', true) ? 1 : 0,
            money(source, '/hourly_rate'),
            seconds(source, '/budget', anomalies, resource),
            createdAt,
            updatedAt,
          ],
          harvestId,
        ),
      ]
    case 'time_entries': {
      const rawSeconds = seconds(source, '/hours', anomalies, resource) ?? 0
      const secondsWithoutTimer =
        nullableNumberAt(source, '/hours_without_timer') === null
          ? rawSeconds
          : (seconds(source, '/hours_without_timer', anomalies, resource) ?? rawSeconds)
      const roundedSeconds = seconds(source, '/rounded_hours', anomalies, resource) ?? rawSeconds
      const timerStartedAt = stringValue(row, 'timer_started_at')
      const startedTime = canonicalHarvestTime(
        stringValue(row, 'started_time'),
        manifest.preflight.clock,
      )
      const endedTime = canonicalHarvestTime(
        stringValue(row, 'ended_time'),
        manifest.preflight.clock,
      )
      const running = timerStartedAt !== null || (startedTime !== null && endedTime === null)
      if (!running && secondsWithoutTimer !== rawSeconds) {
        throw new Error('stopped time entry hours_without_timer must equal hours')
      }
      return [
        insertByHarvestId(
          'time_entries',
          [
            'harvest_id',
            'user_id',
            'project_id',
            'task_id',
            'user_assignment_id',
            'task_assignment_id',
            'spent_date',
            'seconds',
            'seconds_without_timer',
            'rounded_seconds',
            'timer_started_at',
            'started_time',
            'ended_time',
            'notes',
            'billable',
            'budgeted',
            'billable_rate_cents',
            'cost_rate_cents',
            'external_ref',
            'calendar_event_ref',
            'created_at',
            'updated_at',
            'invoice_id',
            'approval_status',
          ],
          [
            harvestId,
            idFrom('users', nestedId(row, 'user')!),
            idFrom('projects', nestedId(row, 'project')!),
            idFrom('tasks', nestedId(row, 'task')!),
            idFrom('user_assignments', nestedId(row, 'user_assignment')!),
            idFrom('task_assignments', nestedId(row, 'task_assignment')!),
            requiredText(row, 'spent_date'),
            rawSeconds,
            secondsWithoutTimer,
            roundedSeconds,
            timerStartedAt,
            startedTime,
            endedTime,
            stringValue(row, 'notes'),
            bool(row, 'billable') ? 1 : 0,
            bool(row, 'budgeted') ? 1 : 0,
            money(source, '/billable_rate'),
            money(source, '/cost_rate'),
            canonicalJson(row.external_reference),
            canonicalJson(row.calendar_event),
            createdAt,
            updatedAt,
            nestedId(row, 'invoice') === null
              ? null
              : idFrom('invoices', nestedId(row, 'invoice')!),
            stringValue(row, 'approval_status', 'unsubmitted'),
          ],
          harvestId,
        ),
      ]
    }
  }
}

const objectValue = (row: Record<string, unknown>, key: string): Record<string, unknown> | null => {
  const value = row[key]
  if (value === null || value === undefined) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${key} must be an object`)
  return value as Record<string, unknown>
}

const recipients = (row: Record<string, unknown>): Array<{ name: string; email: string }> => {
  if (!Array.isArray(row.recipients)) throw new Error('recipients must be an array')
  return row.recipients.map((value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('recipient must be an object')
    }
    const item = value as Record<string, unknown>
    return { name: stringValue(item, 'name', '') ?? '', email: requiredText(item, 'email') }
  })
}

const nativeId = async (
  database: RawDatabase,
  table: string,
  harvestId: number | string,
): Promise<number> => {
  const row = await first<{ id: number }>(
    database,
    `SELECT id FROM ${table} WHERE harvest_id = ?`,
    [harvestId],
  )
  if (row === null) throw new Error(`${table} source id ${harvestId} has not been loaded`)
  return row.id
}

const nativeIds = async (
  database: RawDatabase,
  table: string,
  harvestIds: readonly number[],
): Promise<Map<number, number>> => {
  const unique = [...new Set(harvestIds)]
  const resolved = new Map<number, number>()
  if (unique.length > 0) {
    const rows = await all<{ id: number; harvestId: number }>(
      database,
      `SELECT id, harvest_id AS harvestId FROM ${table}
       WHERE harvest_id IN (SELECT value FROM json_each(?))`,
      [JSON.stringify(unique)],
    )
    for (const row of rows) resolved.set(row.harvestId, row.id)
  }
  const missing = unique.find((harvestId) => !resolved.has(harvestId))
  if (missing !== undefined) throw new Error(`${table} source id ${missing} has not been loaded`)
  return resolved
}

const userIdsByEmail = async (
  database: RawDatabase,
  addresses: readonly string[],
): Promise<Map<string, number>> => {
  const unique = [...new Set(addresses.map((address) => address.toLowerCase()))]
  const resolved = new Map<string, number>()
  if (unique.length > 0) {
    const rows = await all<{ address: string; id: number }>(
      database,
      `SELECT lower(email.address) AS address, user.id
       FROM user_emails email JOIN users user ON user.id = email.user_id
       WHERE lower(email.address) IN (SELECT value FROM json_each(?))
         AND email.invalidated_at IS NULL
       ORDER BY email.is_primary DESC, email.id`,
      [JSON.stringify(unique)],
    )
    for (const row of rows) if (!resolved.has(row.address)) resolved.set(row.address, row.id)
  }
  return resolved
}

const projectBudgetBys = async (
  database: RawDatabase,
  harvestIds: readonly number[],
): Promise<Map<number, string>> => {
  const unique = [...new Set(harvestIds)]
  if (unique.length === 0) return new Map()
  const rows = await all<{ harvestId: number; budgetBy: string }>(
    database,
    `SELECT harvest_id AS harvestId, budget_by AS budgetBy FROM projects
     WHERE harvest_id IN (SELECT value FROM json_each(?))`,
    [JSON.stringify(unique)],
  )
  const resolved = new Map(rows.map((row) => [row.harvestId, row.budgetBy]))
  const missing = unique.find((harvestId) => !resolved.has(harvestId))
  if (missing !== undefined) throw new Error(`project source id ${missing} has not been loaded`)
  return resolved
}

const paymentTerms = (
  value: string | null,
): 'upon_receipt' | 'net_15' | 'net_30' | 'net_45' | 'net_60' | 'custom' => {
  const normalized = (value ?? '').trim().toLowerCase().replace(/[_ ]+/g, '_')
  return ['upon_receipt', 'net_15', 'net_30', 'net_45', 'net_60'].includes(normalized)
    ? (normalized as 'upon_receipt' | 'net_15' | 'net_30' | 'net_45' | 'net_60')
    : 'custom'
}

const estimateStatements = (
  source: RawRow,
  messages: readonly RawRow[],
  messageLineage: readonly ChildLineage[],
  lineOffset = 0,
  lineLimit = Number.POSITIVE_INFINITY,
): PlannedStatement[] => {
  const row = source.row
  const harvestId = safeIntegerAt(source, '/id', 'estimates.id')
  const clientId = nestedId(row, 'client')
  if (clientId === null) throw new Error(`estimate ${harvestId} has no client`)
  const creator = objectValue(row, 'creator')
  const creatorId = creator === null ? null : nestedId({ creator }, 'creator')
  const creatorName = creator === null ? null : stringValue(creator, 'name')
  if ((creatorId === null) !== (creatorName === null)) {
    throw new Error(`estimate ${harvestId} creator provenance is incomplete`)
  }
  const createdAt = requiredText(row, 'created_at')
  const updatedAt = requiredText(row, 'updated_at')
  const state = stringValue(row, 'state', 'draft') ?? 'draft'
  if (!['draft', 'sent', 'accepted', 'declined'].includes(state)) {
    throw new Error(`estimate ${harvestId} has unsupported state ${state}`)
  }
  const columns = [
    'client_id',
    'created_by_user_id',
    'source_creator_id',
    'source_creator_name',
    'number',
    'purchase_order',
    'subject',
    'notes',
    'currency',
    'state',
    'issue_date',
    'sent_at',
    'accepted_at',
    'declined_at',
    'tax_rate_ppm',
    'tax2_rate_ppm',
    'discount_rate_ppm',
    'amount_cents',
    'tax_amount_cents',
    'tax2_amount_cents',
    'discount_amount_cents',
    'created_at',
    'updated_at',
  ] as const
  const cells: Cell[] = [
    idFrom('clients', clientId),
    creatorId === null ? null : idFrom('users', creatorId),
    creatorId,
    creatorName,
    requiredText(row, 'number'),
    stringValue(row, 'purchase_order'),
    stringValue(row, 'subject'),
    stringValue(row, 'notes'),
    requiredText(row, 'currency'),
    state,
    requiredText(row, 'issue_date'),
    stringValue(row, 'sent_at'),
    stringValue(row, 'accepted_at'),
    stringValue(row, 'declined_at'),
    percentLiteralToPpm(nullableNumberAt(source, '/tax'), 'estimate.tax'),
    percentLiteralToPpm(nullableNumberAt(source, '/tax2'), 'estimate.tax2'),
    percentLiteralToPpm(nullableNumberAt(source, '/discount'), 'estimate.discount'),
    moneyLiteralToCents(numberAt(source, '/amount'), 'estimate.amount'),
    moneyLiteralToCents(numberAt(source, '/tax_amount'), 'estimate.tax_amount'),
    moneyLiteralToCents(numberAt(source, '/tax2_amount'), 'estimate.tax2_amount'),
    moneyLiteralToCents(numberAt(source, '/discount_amount'), 'estimate.discount_amount'),
    createdAt,
    updatedAt,
  ]
  const rendered = renderCells(cells)
  const statements: PlannedStatement[] = [
    {
      sql: `UPDATE estimates SET ${columns
        .map((column, index) => {
          const cell = cells[index]
          return `${column} = ${isExpression(cell) ? cell.sql : '?'}`
        })
        .join(', ')} WHERE harvest_id = ?`,
      bindings: [...rendered.bindings, harvestId],
    },
  ]
  statements.push(
    insertByHarvestId('estimates', ['harvest_id', ...columns], [harvestId, ...cells], harvestId),
  )

  const lineItems = row.line_items
  if (!Array.isArray(lineItems))
    throw new Error(`estimate ${harvestId} line_items must be an array`)
  const lineEnd = Math.min(lineItems.length, lineOffset + lineLimit)
  for (let position = lineOffset; position < lineEnd; position += 1) {
    const value = lineItems[position]
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      throw new Error('estimate line must be an object')
    const line = value as Record<string, unknown>
    const lineId = nestedId({ line }, 'line')
    if (lineId === null) throw new Error('estimate line id is required')
    const unitPrice = moneyLiteralToCents(
      numberAt(source, `/line_items/${position}/unit_price`),
      'estimate.line.unit_price',
    )
    const amount = moneyLiteralToCents(
      numberAt(source, `/line_items/${position}/amount`),
      'estimate.line.amount',
    )
    const lineCells: Cell[] = [
      lineId,
      idFrom('estimates', harvestId),
      position,
      requiredText(line, 'kind'),
      stringValue(line, 'description'),
      Number(line.quantity),
      unitPrice,
      amount,
      bool(line, 'taxed') ? 1 : 0,
      bool(line, 'taxed2') ? 1 : 0,
      createdAt,
      updatedAt,
    ]
    statements.push(
      insertByHarvestId(
        'estimate_line_items',
        [
          'harvest_id',
          'estimate_id',
          'position',
          'kind',
          'description',
          'quantity',
          'unit_price_cents',
          'amount_cents',
          'taxed',
          'taxed2',
          'created_at',
          'updated_at',
        ],
        lineCells,
        lineId,
      ),
    )
  }
  for (const [index, message] of messages.entries()) {
    const messageId = safeIntegerAt(message, '/id', 'estimate_messages.id')
    if (
      messageLineage[index]?.source_id !== messageId ||
      messageLineage[index]?.parent_id !== harvestId
    ) {
      throw new Error(`estimate_messages lineage is misaligned for estimate ${harvestId}`)
    }
    const m = message.row
    const messageCells: Cell[] = [
      messageId,
      idFrom('estimates', harvestId),
      stringValue(m, 'sent_by'),
      stringValue(m, 'sent_by_email'),
      stringValue(m, 'sent_from'),
      stringValue(m, 'sent_from_email'),
      JSON.stringify(recipients(m)),
      stringValue(m, 'subject'),
      stringValue(m, 'body'),
      bool(m, 'send_me_a_copy') ? 1 : 0,
      stringValue(m, 'event_type'),
      requiredText(m, 'created_at'),
      requiredText(m, 'updated_at'),
    ]
    const messageRendered = renderCells(messageCells.slice(2))
    const messageColumns = [
      'sent_by',
      'sent_by_email',
      'sent_from',
      'sent_from_email',
      'recipients',
      'subject',
      'body',
      'send_me_a_copy',
      'event_type',
      'created_at',
      'updated_at',
    ]
    statements.push({
      sql: `UPDATE estimate_messages SET ${messageColumns.map((column) => `${column} = ?`).join(', ')}
        WHERE harvest_id = ? AND estimate_id = (SELECT id FROM estimates WHERE harvest_id = ?)`,
      bindings: [...messageRendered.bindings, messageId, harvestId],
    })
    const insertRendered = renderCells(messageCells)
    statements.push({
      sql: `INSERT INTO estimate_messages (
          harvest_id, estimate_id, sent_by, sent_by_email, sent_from, sent_from_email,
          recipients, subject, body, send_me_a_copy, event_type, created_at, updated_at
        ) SELECT ${insertRendered.sql}
        WHERE NOT EXISTS (
          SELECT 1 FROM estimate_messages existing
          WHERE existing.harvest_id = ?
            AND existing.estimate_id = (SELECT id FROM estimates WHERE harvest_id = ?)
        )`,
      bindings: [...insertRendered.bindings, messageId, harvestId],
    })
  }
  return statements
}

const childRowsForParent = async (
  snapshotDir: string,
  resource: string,
  parentOrdinal: number,
  parentId: number,
  total: number,
  digest: string,
): Promise<{ rows: RawRow[]; lineage: ChildLineage[] }> => {
  if (total === 0) return { rows: [], lineage: [] }
  const record = await findChildIndex(snapshotDir, resource, digest, parentOrdinal, parentId)
  if (record === null) return { rows: [], lineage: [] }
  const chunk = await rawChunkFrom(snapshotDir, resource, record.startByte, 0, record.count)
  if (chunk.rows.length !== record.count || chunk.nextByteOffset !== record.endByte) {
    throw new Error(`${resource} child index no longer matches raw data`)
  }
  const lineage = await lineageChunkFrom(snapshotDir, resource, record, 0, record.count)
  for (const [index, witness] of lineage.entries()) {
    if (witness.source_id !== safeIntegerAt(chunk.rows[index]!, '/id', `${resource}.id`)) {
      throw new Error(`${resource} child index disagrees with aligned source lineage`)
    }
  }
  return {
    rows: chunk.rows,
    lineage,
  }
}

const invoiceInput = async (
  database: ImportDatabase,
  source: RawRow,
  messages: readonly RawRow[],
  messageLineage: readonly ChildLineage[],
  payments: readonly RawRow[],
  paymentLineage: readonly ChildLineage[],
): Promise<{
  ensured: Awaited<ReturnType<typeof ensureImportedInvoiceHeader>>
  reconciliation: HarvestInvoiceReconciliation
  retainerId: number | null
  recurringId: number | null
}> => {
  const row = source.row
  const harvestId = safeIntegerAt(source, '/id', 'invoices.id')
  const clientHarvestId = nestedId(row, 'client')
  if (clientHarvestId === null) throw new Error(`invoice ${harvestId} has no client`)
  const creator = objectValue(row, 'creator')
  const sourceCreatorId = creator === null ? null : nestedId({ creator }, 'creator')
  const sourceCreatorName = creator === null ? null : stringValue(creator, 'name')
  if ((sourceCreatorId === null) !== (sourceCreatorName === null)) {
    throw new Error(`invoice ${harvestId} creator provenance is incomplete`)
  }
  const createdAt = requiredText(row, 'created_at')
  const updatedAt = requiredText(row, 'updated_at')
  const projectHarvestId = nestedId(row, 'project')
  const estimateHarvestId = nestedId(row, 'estimate')
  const clientId = await nativeId(database.$client, 'clients', clientHarvestId)
  const creatorRow =
    sourceCreatorId === null
      ? null
      : await first<{ id: number }>(database.$client, 'SELECT id FROM users WHERE harvest_id = ?', [
          sourceCreatorId,
        ])
  const lineItems = row.line_items
  if (!Array.isArray(lineItems)) throw new Error(`invoice ${harvestId} line_items must be an array`)
  const lineProjectHarvestIds: number[] = []
  // Validate every money token before the header insert. A malformed 3dp child
  // therefore cannot leave a partially imported invoice behind.
  for (const [position, value] of lineItems.entries()) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      throw new Error('invoice line must be an object')
    const lineProject = nestedId(value as Record<string, unknown>, 'project')
    if (lineProject !== null) lineProjectHarvestIds.push(lineProject)
    moneyLiteralToCents(
      numberAt(source, `/line_items/${position}/unit_price`),
      'invoice.line.unit_price',
    )
    moneyLiteralToCents(numberAt(source, `/line_items/${position}/amount`), 'invoice.line.amount')
  }
  for (const payment of payments) {
    moneyLiteralToCents(numberAt(payment, '/amount'), 'invoice_payment.amount')
  }
  const [lineProjectNativeIds, paymentRecorderIds] = await Promise.all([
    nativeIds(database.$client, 'projects', lineProjectHarvestIds),
    userIdsByEmail(
      database.$client,
      payments.flatMap((payment) => {
        const email = stringValue(payment.row, 'recorded_by_email')
        return email === null ? [] : [email]
      }),
    ),
  ])
  const sourceHeader = {
    harvestId,
    clientId,
    createdByUserId: creatorRow?.id ?? null,
    sourceCreatorId,
    sourceCreatorName,
    number: requiredText(row, 'number'),
    subject: stringValue(row, 'subject'),
    purchaseOrder: stringValue(row, 'purchase_order'),
    notes: stringValue(row, 'notes'),
    currency: requiredText(row, 'currency'),
    issueDate: requiredText(row, 'issue_date'),
    dueDate: requiredText(row, 'due_date'),
    paymentTerms: paymentTerms(stringValue(row, 'payment_term')),
    periodStart: stringValue(row, 'period_start'),
    periodEnd: stringValue(row, 'period_end'),
    projectId:
      projectHarvestId === null
        ? null
        : await nativeId(database.$client, 'projects', projectHarvestId),
    estimateId:
      estimateHarvestId === null
        ? null
        : await nativeId(database.$client, 'estimates', estimateHarvestId),
    taxRatePpm:
      nullableNumberAt(source, '/tax') === null
        ? null
        : percentLiteralToPpm(numberAt(source, '/tax'), 'invoice.tax'),
    tax2RatePpm:
      nullableNumberAt(source, '/tax2') === null
        ? null
        : percentLiteralToPpm(numberAt(source, '/tax2'), 'invoice.tax2'),
    discountRatePpm:
      nullableNumberAt(source, '/discount') === null
        ? null
        : percentLiteralToPpm(numberAt(source, '/discount'), 'invoice.discount'),
    createdAt,
    updatedAt,
    initialState: payments.length > 0 ? ('open' as const) : ('draft' as const),
  }
  const lines: Array<HarvestInvoiceReconciliation['lines'][number]> = []
  for (const [position, value] of lineItems.entries()) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      throw new Error('invoice line must be an object')
    const line = value as Record<string, unknown>
    const lineId = nestedId({ line }, 'line')
    if (lineId === null) throw new Error('invoice line id is required')
    const lineProject = nestedId(line, 'project')
    lines.push({
      harvestId: lineId,
      position,
      kind: requiredText(line, 'kind'),
      description: stringValue(line, 'description'),
      quantity: Number(line.quantity),
      unitPriceCents: moneyLiteralToCents(
        numberAt(source, `/line_items/${position}/unit_price`),
        'invoice.line.unit_price',
      ),
      amountCents: moneyLiteralToCents(
        numberAt(source, `/line_items/${position}/amount`),
        'invoice.line.amount',
      ),
      taxed: bool(line, 'taxed'),
      taxed2: bool(line, 'taxed2'),
      projectId: lineProject === null ? null : lineProjectNativeIds.get(lineProject)!,
      createdAt,
      updatedAt,
    })
  }
  const importedMessages: HarvestInvoiceReconciliation['messages'] = messages.map(
    (message, index) => {
      const messageId = safeIntegerAt(message, '/id', 'invoice_messages.id')
      if (
        messageLineage[index]?.source_id !== messageId ||
        messageLineage[index]?.parent_id !== harvestId
      ) {
        throw new Error(`invoice_messages lineage is misaligned for invoice ${harvestId}`)
      }
      const m = message.row
      return {
        harvestId: messageId,
        sentBy: stringValue(m, 'sent_by'),
        sentByEmail: stringValue(m, 'sent_by_email'),
        sentFrom: stringValue(m, 'sent_from'),
        sentFromEmail: stringValue(m, 'sent_from_email'),
        recipients: recipients(m),
        subject: stringValue(m, 'subject'),
        body: stringValue(m, 'body'),
        attachPdf: bool(m, 'attach_pdf'),
        sendMeACopy: bool(m, 'send_me_a_copy'),
        thankYou: bool(m, 'thank_you'),
        reminder: bool(m, 'reminder'),
        sendReminderOn: stringValue(m, 'send_reminder_on'),
        eventType: stringValue(m, 'event_type') as
          'send' | 'view' | 'draft' | 'cancel' | 'write_off' | 're-open' | 'close' | null,
        createdAt: requiredText(m, 'created_at'),
        updatedAt: requiredText(m, 'updated_at'),
      }
    },
  )
  const importedPayments: Array<HarvestInvoiceReconciliation['payments'][number]> = []
  for (const [index, payment] of payments.entries()) {
    const paymentId = safeIntegerAt(payment, '/id', 'invoice_payments.id')
    if (
      paymentLineage[index]?.source_id !== paymentId ||
      paymentLineage[index]?.parent_id !== harvestId
    ) {
      throw new Error(`invoice_payments lineage is misaligned for invoice ${harvestId}`)
    }
    const p = payment.row
    const paidAt = stringValue(p, 'paid_at')
    const paidDate = stringValue(p, 'paid_date')
    const gateway = objectValue(p, 'payment_gateway')
    const recordedByEmail = stringValue(p, 'recorded_by_email')
    importedPayments.push({
      harvestId: paymentId,
      amountCents: moneyLiteralToCents(numberAt(payment, '/amount'), 'invoice_payment.amount'),
      sourcePaidAt: paidAt,
      sourcePaidDate: paidDate,
      sourceRecordedByName: stringValue(p, 'recorded_by'),
      sourceRecordedByEmail: recordedByEmail,
      sourceGatewayId: gateway === null ? null : nestedId({ gateway }, 'gateway'),
      sourceGatewayName: gateway === null ? null : stringValue(gateway, 'name'),
      notes: stringValue(p, 'notes'),
      recordedByUserId:
        recordedByEmail === null
          ? null
          : (paymentRecorderIds.get(recordedByEmail.toLowerCase()) ?? null),
      providerTransactionId: stringValue(p, 'transaction_id'),
      createdAt: requiredText(p, 'created_at'),
      updatedAt: requiredText(p, 'updated_at'),
    })
  }
  const options = row.payment_options
  if (
    options !== null &&
    options !== undefined &&
    (!Array.isArray(options) || options.some((v) => typeof v !== 'string'))
  ) {
    throw new Error(`invoice ${harvestId} payment_options must be an array of strings`)
  }
  const state = stringValue(row, 'state', 'draft') ?? 'draft'
  if (!['draft', 'open', 'paid', 'closed'].includes(state))
    throw new Error(`unsupported invoice state ${state}`)
  const sourceReconciliation: HarvestInvoiceReconciliation = {
    invoiceId: 1,
    sourceBatchComplete: true,
    expectedSourceUpdatedAt: null,
    sourceUpdatedAt: updatedAt,
    sourceState: state as 'draft' | 'open' | 'paid' | 'closed',
    sourceSentAt: stringValue(row, 'sent_at'),
    sourcePaidAt: stringValue(row, 'paid_at'),
    sourcePaidDate: stringValue(row, 'paid_date'),
    sourceClosedAt: stringValue(row, 'closed_at'),
    sourceAmountCents: money(source, '/amount'),
    sourceDueAmountCents: money(source, '/due_amount'),
    sourceTaxAmountCents: money(source, '/tax_amount'),
    sourceTax2AmountCents: money(source, '/tax2_amount'),
    sourceDiscountAmountCents: money(source, '/discount_amount'),
    sourcePaymentOptions: options == null ? null : (options as string[]),
    sourceWrittenOffCents: 0,
    sourceHeader: {
      clientId: sourceHeader.clientId,
      createdByUserId: sourceHeader.createdByUserId,
      sourceCreatorId: sourceHeader.sourceCreatorId,
      sourceCreatorName: sourceHeader.sourceCreatorName,
      number: sourceHeader.number,
      subject: sourceHeader.subject,
      purchaseOrder: sourceHeader.purchaseOrder,
      notes: sourceHeader.notes,
      currency: sourceHeader.currency,
      issueDate: sourceHeader.issueDate,
      dueDate: sourceHeader.dueDate,
      paymentTerms: sourceHeader.paymentTerms,
      periodStart: sourceHeader.periodStart,
      periodEnd: sourceHeader.periodEnd,
      projectId: sourceHeader.projectId,
      estimateId: sourceHeader.estimateId,
      taxRatePpm: sourceHeader.taxRatePpm,
      tax2RatePpm: sourceHeader.tax2RatePpm,
      discountRatePpm: sourceHeader.discountRatePpm,
      createdAt: sourceHeader.createdAt,
      updatedAt: sourceHeader.updatedAt,
    },
    lines,
    messages: importedMessages,
    payments: importedPayments,
  }
  validateHarvestInvoiceReconciliation(sourceReconciliation)
  const ensured = await ensureImportedInvoiceHeader(database, sourceHeader)
  return {
    ensured,
    reconciliation: {
      ...sourceReconciliation,
      invoiceId: ensured.id,
      expectedSourceUpdatedAt: ensured.sourceUpdatedAt,
    },
    retainerId: nestedId(row, 'retainer'),
    recurringId:
      typeof row.recurring_invoice_id === 'number' && Number.isSafeInteger(row.recurring_invoice_id)
        ? row.recurring_invoice_id
        : null,
  }
}

const resolveOrganizationCurrency = async (
  snapshotDir: string,
  manifest: Manifest,
  override: string | undefined,
): Promise<string> => {
  if (override) return override.toUpperCase()
  if (manifest.preflight.organization_currency)
    return manifest.preflight.organization_currency.toUpperCase()
  const total = manifest.resources.clients?.count ?? 0
  const currencies = new Set<string>()
  let rows = 0
  let byteOffset = 0
  while (rows < total && currencies.size <= 1) {
    const chunk = await rawChunkFrom(snapshotDir, 'clients', byteOffset, rows, 100)
    if (chunk.rows.length === 0) break
    for (const source of chunk.rows) {
      const currency = stringValue(source.row, 'currency')
      if (currency) currencies.add(currency.toUpperCase())
    }
    rows += chunk.rows.length
    byteOffset = chunk.nextByteOffset
  }
  if (currencies.size === 1) return [...currencies][0]
  throw new Error(
    'Harvest Company omits organization currency; pass --organization-currency (client currencies are absent or mixed)',
  )
}

const organizationStatement = async (
  snapshotDir: string,
  manifest: Manifest,
  options: LoadNextChunkOptions,
): Promise<PlannedStatement> => {
  const currency = await resolveOrganizationCurrency(
    snapshotDir,
    manifest,
    options.organizationCurrency,
  )
  if (!/^[A-Z]{3}$/.test(currency))
    throw new Error('organization currency must be an ISO three-letter code')
  const p = manifest.preflight
  const teamFeature =
    p.team_feature === 'unknown'
      ? manifest.resources.teammates?.complete === true &&
        manifest.resources.teammates.skipped_reason == null
      : p.team_feature
  const modules = JSON.stringify({
    expenses: p.expense_feature,
    invoices: p.invoice_feature,
    estimates: p.estimate_feature,
    approval: p.approval_feature,
    team: teamFeature,
  })
  return {
    sql: `INSERT INTO organizations (
      id, name, address, week_start_day, time_entry_mode, time_format, clock, date_format,
      currency, currency_code_display, currency_symbol_display, decimal_symbol,
      thousands_separator, weekly_capacity_default, modules, created_at, updated_at
    ) SELECT 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM organizations WHERE id = 1)`,
    bindings: [
      manifest.company_name,
      options.organizationAddress ?? p.organization_address,
      p.week_start_day.toLowerCase(),
      p.wants_timestamp_timers ? 'start_end' : 'duration',
      p.time_format,
      p.clock,
      p.date_format,
      currency,
      p.currency_code_display,
      p.currency_symbol_display,
      p.decimal_symbol,
      p.thousands_separator,
      p.weekly_capacity,
      modules,
      manifest.started_at,
      sourceTimestamp(manifest),
    ],
  }
}

interface LoadAdmission {
  snapshotSha256: string
  manifestSha256: string
  loadOptionsJson: string
}

const processAdmissions = new WeakMap<object, string>()

const checksumDigest = async (snapshotDir: string): Promise<string> => {
  const checksumDocument = JSON.parse(
    await readFile(join(snapshotDir, 'checksums.json'), 'utf8'),
  ) as Partial<ChecksumReport>
  const { report_sha256: reportSha256, ...payload } = checksumDocument
  if (
    typeof reportSha256 !== 'string' ||
    checksumReportDigest(payload as Omit<ChecksumReport, 'report_sha256'>) !== reportSha256
  ) {
    throw new Error('checksums.json report evidence failed its content digest')
  }
  if (
    typeof checksumDocument.snapshot_sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(checksumDocument.snapshot_sha256)
  ) {
    throw new Error('snapshot has not passed verify, or checksums.json is invalid')
  }
  return checksumDocument.snapshot_sha256
}

const admitSnapshot = async (
  options: LoadNextChunkOptions,
  manifest: Manifest,
  loadOptionsJson: string,
  timestamp: string,
): Promise<string> => {
  const expectedDigest = await checksumDigest(options.snapshotDir)
  if (isD1(options.database.$client) && options.immutableSnapshotSha256 !== expectedDigest) {
    throw new Error('D1 load requires immutableSnapshotSha256 matching checksums.json')
  }
  const manifestSha256 = createHash('sha256')
    .update(await readFile(join(options.snapshotDir, 'manifest.json')))
    .digest('hex')
  const existing = await first<LoadAdmission>(
    options.database.$client,
    `SELECT snapshot_sha256 AS snapshotSha256, manifest_sha256 AS manifestSha256,
      load_options_json AS loadOptionsJson FROM _ezacto_load_admission WHERE singleton = 1`,
  )
  if (existing !== null) {
    if (
      existing.snapshotSha256 !== expectedDigest ||
      existing.manifestSha256 !== manifestSha256 ||
      existing.loadOptionsJson !== loadOptionsJson
    ) {
      throw new Error('load admission belongs to a different snapshot or load options')
    }
    const externallyPinned =
      isD1(options.database.$client) && options.immutableSnapshotSha256 === expectedDigest
    if (processAdmissions.get(options.database.$client) !== expectedDigest) {
      if (!externallyPinned) {
        const verification = await verifySnapshot(options.snapshotDir, manifest)
        if (verification.length > 0) {
          throw new Error(
            `snapshot verification failed: ${verification[0].kind} ${verification[0].path}`,
          )
        }
        if ((await snapshotDigest(options.snapshotDir, manifest)) !== expectedDigest) {
          throw new Error('snapshot bytes changed after their persisted load admission')
        }
      }
      await ensureChildIndexes(options.snapshotDir, manifest, expectedDigest)
      processAdmissions.set(options.database.$client, expectedDigest)
    }
    return existing.snapshotSha256
  }

  const externallyPinned =
    isD1(options.database.$client) && options.immutableSnapshotSha256 === expectedDigest
  let actualDigest = expectedDigest
  if (!externallyPinned) {
    const verification = await verifySnapshot(options.snapshotDir, manifest)
    if (verification.length > 0) {
      throw new Error(
        `snapshot verification failed: ${verification[0].kind} ${verification[0].path}`,
      )
    }
    actualDigest = await snapshotDigest(options.snapshotDir, manifest)
    if (actualDigest !== expectedDigest) {
      throw new Error('snapshot has not passed verify, or changed since checksums.json was written')
    }
  }
  await buildChildIndexes(options.snapshotDir, manifest, actualDigest)
  await execute(options.database.$client, [
    {
      sql: `INSERT INTO _ezacto_load_admission
      (singleton, snapshot_sha256, manifest_sha256, load_options_json, admitted_at)
      SELECT 1, ?, ?, ?, ? WHERE NOT EXISTS (
        SELECT 1 FROM _ezacto_load_admission WHERE singleton = 1)`,
      bindings: [actualDigest, manifestSha256, loadOptionsJson, timestamp],
    },
  ])
  const admitted = await first<LoadAdmission>(
    options.database.$client,
    `SELECT snapshot_sha256 AS snapshotSha256, manifest_sha256 AS manifestSha256,
      load_options_json AS loadOptionsJson FROM _ezacto_load_admission WHERE singleton = 1`,
  )
  if (
    admitted?.snapshotSha256 !== actualDigest ||
    admitted.manifestSha256 !== manifestSha256 ||
    admitted.loadOptionsJson !== loadOptionsJson
  ) {
    throw new Error('concurrent load admission selected a different snapshot or load options')
  }
  processAdmissions.set(options.database.$client, actualDigest)
  return actualDigest
}

const loadExpense = async (
  options: LoadNextChunkOptions,
  source: RawRow,
  anomalies: LoadAnomaly[],
): Promise<number> => {
  const { database, snapshotDir } = options
  const row = source.row
  const harvestId = safeIntegerAt(source, '/id', 'expenses.id')
  const units = row.units == null ? null : Number(row.units)
  if (units !== null && (!Number.isSafeInteger(units) || units < 0))
    throw new Error('expense.units must be a non-negative integer')
  const invoiceHarvestId = nestedId(row, 'invoice')
  const statements = [
    insertByHarvestId(
      'expenses',
      [
        'harvest_id',
        'user_id',
        'project_id',
        'expense_category_id',
        'spent_date',
        'notes',
        'units',
        'total_cost_cents',
        'billable',
        'approval_status',
        'invoice_id',
        'created_at',
        'updated_at',
      ],
      [
        harvestId,
        idFrom('users', nestedId(row, 'user')!),
        idFrom('projects', nestedId(row, 'project')!),
        idFrom('expense_categories', nestedId(row, 'expense_category')!),
        requiredText(row, 'spent_date'),
        stringValue(row, 'notes'),
        units,
        moneyLiteralToCents(numberAt(source, '/total_cost'), 'expense.total_cost'),
        bool(row, 'billable', true) ? 1 : 0,
        stringValue(row, 'approval_status', 'unsubmitted'),
        invoiceHarvestId === null ? null : idFrom('invoices', invoiceHarvestId),
        requiredText(row, 'created_at'),
        requiredText(row, 'updated_at'),
      ],
      harvestId,
    ),
  ]
  const receipt = objectValue(row, 'receipt')
  let receiptInput: Parameters<typeof ensureHarvestExpenseReceipt>[1] | null = null
  if (receipt !== null) {
    const manifest = await readManifest(snapshotDir)
    const asset = manifest.binaries?.receipts[String(harvestId)]
    if (!asset) {
      const recorded = manifest.binaries?.anomalies.find(
        (anomaly) => anomaly.resource === 'receipt' && anomaly.source_id === harvestId,
      )
      if (!recorded) throw new Error(`expense ${harvestId} receipt has no archived binary`)
      anomalies.push({
        resource: 'expenses',
        source_id: harvestId,
        kind: 'receipt_download_missing',
        detail: `${recorded.kind}:${recorded.message}`,
      })
    } else {
      const path = join(snapshotDir, asset.path)
      const bytes = await readFile(path)
      const actual = await stat(path)
      const digest = createHash('sha256').update(bytes).digest('hex')
      if (actual.size !== asset.bytes || digest !== asset.sha256)
        throw new Error(`expense ${harvestId} archived receipt failed integrity check`)
      if (typeof receipt.file_size === 'number' && receipt.file_size !== asset.bytes)
        throw new Error(`expense ${harvestId} receipt size differs from Harvest metadata`)
      const contentType = stringValue(receipt, 'content_type') ?? asset.content_type
      if (!contentType) throw new Error(`expense ${harvestId} receipt has no content type`)
      receiptInput = {
        harvestExpenseId: harvestId,
        contentHash: asset.sha256,
        fileKey: asset.path,
        byteSize: asset.bytes,
        contentType,
        name: stringValue(receipt, 'file_name', `receipt-${harvestId}`)!,
        createdAt: requiredText(row, 'created_at'),
        updatedAt: requiredText(row, 'updated_at'),
      }
    }
  }
  await execute(database.$client, statements)
  if (receiptInput) await ensureHarvestExpenseReceipt(database, receiptInput)
  return statements.length + (receiptInput ? 8 : 0)
}

const loadComplexRow = async (
  options: LoadNextChunkOptions,
  resource: 'estimates' | 'invoices' | 'expenses',
  source: RawRow,
  manifest: Manifest,
  anomalies: LoadAnomaly[],
  maxStatements: number,
  digest: string,
): Promise<{ statements: number; complete: boolean }> => {
  const parentId = safeIntegerAt(source, '/id', `${resource}.id`)
  if (resource === 'expenses') {
    if (maxStatements < 10) throw new Error('expense row exceeds the invocation statement budget')
    return { statements: await loadExpense(options, source, anomalies), complete: true }
  }
  if (resource === 'estimates') {
    const lineItems = source.row.line_items
    if (!Array.isArray(lineItems))
      throw new Error(`estimate ${parentId} line_items must be an array`)
    const prior = await subprogress(options.database.$client, resource, source.index)
    const aggregateOffset = prior?.childOffset ?? 0
    if (aggregateOffset < lineItems.length) {
      const lineLimit = maxStatements - 3
      if (lineLimit < 1) throw new Error('estimate row has no line-item statement budget')
      const take = Math.min(lineLimit, lineItems.length - aggregateOffset)
      const linesComplete = aggregateOffset + take === lineItems.length
      const hasMessages = (manifest.resources.estimate_messages?.count ?? 0) > 0
      const complete = linesComplete && !hasMessages
      const statements = [
        ...estimateStatements(source, [], [], aggregateOffset, take),
        complete
          ? deleteSubprogressStatement(resource, source.index)
          : subprogressStatement(resource, source.index, aggregateOffset + take, 0, 0),
      ]
      await execute(options.database.$client, statements)
      return { statements: statements.length, complete }
    }
    const childTotal = manifest.resources.estimate_messages?.count ?? 0
    const record =
      childTotal === 0
        ? null
        : await findChildIndex(
            options.snapshotDir,
            'estimate_messages',
            digest,
            source.index,
            parentId,
          )
    if (record === null) {
      const statements = [
        ...estimateStatements(source, [], [], 0, 0),
        deleteSubprogressStatement(resource, source.index),
      ]
      await execute(options.database.$client, statements)
      return { statements: statements.length, complete: true }
    }
    const childOffset = aggregateOffset - lineItems.length
    if (childOffset > record.count)
      throw new Error('estimate child checkpoint exceeds its indexed range')
    const childLimit = Math.floor((maxStatements - 3) / 2)
    if (childLimit < 1) throw new Error('estimate row has no child statement budget')
    const remaining = record.count - childOffset
    const take = Math.min(childLimit, remaining)
    const childByteOffset =
      childOffset === 0 ? record.startByte : (prior?.childByteOffset ?? record.startByte)
    const lineageByteOffset =
      childOffset === 0
        ? record.lineageStartByte
        : (prior?.lineageByteOffset ?? record.lineageStartByte)
    const childChunk = await rawChunkFrom(
      options.snapshotDir,
      'estimate_messages',
      childByteOffset,
      childOffset,
      take,
    )
    const childLineage = await lineageChunkAt(
      options.snapshotDir,
      'estimate_messages',
      record,
      lineageByteOffset,
      take,
    )
    for (const [index, witness] of childLineage.rows.entries()) {
      if (
        witness.source_id !== safeIntegerAt(childChunk.rows[index]!, '/id', 'estimate_messages.id')
      ) {
        throw new Error('estimate_messages lineage is misaligned')
      }
    }
    const complete = childOffset + take === record.count
    const statements = [
      ...estimateStatements(source, childChunk.rows, childLineage.rows, 0, 0),
      complete
        ? deleteSubprogressStatement(resource, source.index)
        : subprogressStatement(
            resource,
            source.index,
            lineItems.length + childOffset + take,
            childChunk.nextByteOffset,
            childLineage.nextByteOffset,
          ),
    ]
    await execute(options.database.$client, statements)
    return { statements: statements.length, complete }
  }
  // Reconciliation fingerprints the complete source-owned message/payment sets,
  // detects deletions, and derives paid state from all payments. The indexed
  // current-parent group is therefore the irreducible read unit; importantly,
  // this never scans either child resource beyond this invoice. DB mutations are
  // still bounded and resumed through the pending reconciliation receipt below.
  const messages = await childRowsForParent(
    options.snapshotDir,
    'invoice_messages',
    source.index,
    parentId,
    manifest.resources.invoice_messages?.count ?? 0,
    digest,
  )
  const payments = await childRowsForParent(
    options.snapshotDir,
    'invoice_payments',
    source.index,
    parentId,
    manifest.resources.invoice_payments?.count ?? 0,
    digest,
  )
  const lineCount = Array.isArray(source.row.line_items) ? source.row.line_items.length : 0
  const input = await invoiceInput(
    options.database,
    source,
    messages.rows,
    messages.lineage,
    payments.rows,
    payments.lineage,
  )
  if (input.retainerId !== null)
    await ensureHarvestRetainerStub(options.database, {
      invoiceId: input.ensured.id,
      harvestInvoiceId: parentId,
      harvestRetainerId: input.retainerId,
      createdAt: requiredText(source.row, 'created_at'),
      updatedAt: requiredText(source.row, 'updated_at'),
    })
  if (input.recurringId !== null)
    await ensureHarvestRecurringInvoiceStub(options.database, {
      invoiceId: input.ensured.id,
      harvestInvoiceId: parentId,
      harvestRecurringInvoiceId: input.recurringId,
      createdAt: requiredText(source.row, 'created_at'),
      updatedAt: requiredText(source.row, 'updated_at'),
    })
  const reconciliationBudget = maxStatements - 10
  if (reconciliationBudget < 3)
    throw new Error('invoice row has no reconciliation statement budget')
  const result = await reconcileHarvestInvoice(options.database, {
    ...input.reconciliation,
    maximumStatements: reconciliationBudget,
  })
  for (const diagnostic of result.diagnostics) {
    if (diagnostic.code === 'payment_paid_date_disagrees')
      anomalies.push({
        resource: 'invoice_payments',
        source_id: diagnostic.payment_harvest_id,
        kind: 'payment_date_disagreement',
        detail: `${diagnostic.source_paid_at} has UTC date different from ${diagnostic.source_paid_date}`,
      })
  }
  return {
    statements: Math.min(
      maxStatements,
      10 + lineCount * 2 + messages.rows.length * 2 + payments.rows.length * 2,
    ),
    complete: result.complete !== false,
  }
}

export const loadNextChunk = async (options: LoadNextChunkOptions): Promise<LoadChunkResult> => {
  const manifest = await readManifest(options.snapshotDir)
  if (!manifest.preflight.user.is_administrator) {
    throw new Error(
      'load requires the preflight Harvest user to be an administrator; refusing implicit privilege elevation',
    )
  }
  await ensureProgressSchema(options.database.$client)
  const priorAdmission = await first<{ loadOptionsJson: string }>(
    options.database.$client,
    `SELECT load_options_json AS loadOptionsJson FROM _ezacto_load_admission WHERE singleton = 1`,
  )
  let loadOptionsJson: string
  if (priorAdmission !== null) {
    const persisted = JSON.parse(priorAdmission.loadOptionsJson) as {
      organization_currency: string
      organization_address: string | null
    }
    const requestedCurrency =
      options.organizationCurrency?.toUpperCase() ??
      manifest.preflight.organization_currency?.toUpperCase()
    const requestedAddress = options.organizationAddress ?? manifest.preflight.organization_address
    if (
      (requestedCurrency !== undefined && requestedCurrency !== persisted.organization_currency) ||
      requestedAddress !== persisted.organization_address
    ) {
      throw new Error('load admission belongs to different snapshot load options')
    }
    loadOptionsJson = priorAdmission.loadOptionsJson
  } else {
    loadOptionsJson = JSON.stringify({
      organization_currency: await resolveOrganizationCurrency(
        options.snapshotDir,
        manifest,
        options.organizationCurrency,
      ),
      organization_address: options.organizationAddress ?? manifest.preflight.organization_address,
    })
  }
  const timestamp = sourceTimestamp(manifest)
  const maxStatements = options.maxStatements ?? DEFAULT_INVOCATION_STATEMENT_BUDGET
  const maximumStatements = isD1(options.database.$client)
    ? D1_MAX_STATEMENTS - D1_INVOCATION_QUERY_RESERVE
    : D1_MAX_STATEMENTS
  if (
    !Number.isSafeInteger(maxStatements) ||
    maxStatements < 2 ||
    maxStatements > maximumStatements
  ) {
    throw new Error(
      `maxStatements must be between 2 and ${maximumStatements}; D1 reserves query overhead`,
    )
  }
  const digest = await admitSnapshot(options, manifest, loadOptionsJson, timestamp)
  const existing = await all<{ resource: string; digest: string; options: string }>(
    options.database.$client,
    'SELECT resource, snapshot_sha256 AS digest, load_options_json AS options FROM _ezacto_load_progress',
  )
  const foreign = existing.find((row) => row.digest !== digest || row.options !== loadOptionsJson)
  if (foreign)
    throw new Error(`load progress for ${foreign.resource} belongs to a different snapshot`)

  for (const resource of LOAD_RESOURCES) {
    const total = resource === 'organization' ? 1 : (manifest.resources[resource]?.count ?? 0)
    const prior = await progress(options.database.$client, resource)
    if (
      prior &&
      (prior.totalRows !== total ||
        prior.snapshotSha256 !== digest ||
        prior.loadOptionsJson !== loadOptionsJson)
    ) {
      throw new Error(`load progress for ${resource} does not match this snapshot`)
    }
    if (prior?.completed === 1) continue
    const offset = prior?.rowsLoaded ?? 0
    const anomalies: LoadAnomaly[] = []
    if (offset >= total) {
      const checkpoint = progressStatement(
        resource,
        digest,
        loadOptionsJson,
        prior?.sourceByteOffset ?? 0,
        total,
        total,
        true,
        timestamp,
      )
      await execute(options.database.$client, [checkpoint])
      return {
        complete: false,
        resource,
        loadedRows: 0,
        statements: 1,
        snapshotSha256: digest,
        anomalies,
      }
    }
    if (resource === 'organization') {
      const statement = await organizationStatement(options.snapshotDir, manifest, options)
      const userCount = manifest.resources.users?.count ?? 0
      const owner = await findRawRowById(
        options.snapshotDir,
        'users',
        userCount,
        manifest.preflight.user.id,
      )
      if (!owner)
        throw new Error(
          `authenticated Harvest user ${manifest.preflight.user.id} is absent from users`,
        )
      const ownerStatements = rowStatements('users', owner, manifest, anomalies)
      const statements = [
        statement,
        ...ownerStatements,
        progressStatement(resource, digest, loadOptionsJson, 0, 1, 1, true, timestamp),
      ]
      await execute(options.database.$client, statements)
      return {
        complete: false,
        resource,
        loadedRows: 1,
        statements: statements.length,
        snapshotSha256: digest,
        anomalies,
      }
    }
    const complex = resource === 'estimates' || resource === 'invoices' || resource === 'expenses'
    const limit =
      complex || resource === 'roles'
        ? 1
        : Math.min(options.maxRows ?? 100, maxStatements - 1, total - offset)
    const rateBatch =
      resource === 'billable_rates' || resource === 'cost_rates'
        ? await rateLoadRows(options.snapshotDir, resource, digest, offset)
        : undefined
    const sourceChunk =
      rateBatch === undefined
        ? await rawChunkFrom(
            options.snapshotDir,
            resource,
            prior?.sourceByteOffset ?? 0,
            offset,
            limit,
          )
        : null
    const rows = rateBatch?.rows.map((rate) => rate.source) ?? sourceChunk!.rows
    if (rows.length === 0) throw new Error(`${resource} ended before manifest count ${total}`)
    if (rateBatch !== undefined && (resource === 'billable_rates' || resource === 'cost_rates')) {
      const rowIndex = rateBatch.record.startRow
      const priorChild = await subprogress(options.database.$client, resource, rowIndex)
      const childOffset = priorChild?.childOffset ?? 0
      if (childOffset > rateBatch.rows.length)
        throw new Error('rate checkpoint exceeds its indexed group')
      const capacity = Math.floor((maxStatements - 2) / 2)
      if (capacity < 1) throw new Error('rate group has no row statement budget')
      const take = Math.min(options.maxRows ?? 100, capacity, rateBatch.rows.length - childOffset)
      const statements: PlannedStatement[] = []
      for (const rate of rateBatch.rows.slice(childOffset, childOffset + take)) {
        statements.push(
          ...rowStatements(resource, rate.source, manifest, anomalies, rate.lineage, rate.context),
        )
      }
      const complete = childOffset + take === rateBatch.rows.length
      const loaded = offset + (complete ? rateBatch.record.count : 0)
      statements.push(...anomalyStatements(digest, anomalies))
      if (complete) {
        statements.push(deleteSubprogressStatement(resource, rowIndex))
        statements.push(
          progressStatement(
            resource,
            digest,
            loadOptionsJson,
            rateBatch.record.endByte,
            loaded,
            total,
            loaded === total,
            timestamp,
          ),
        )
      } else {
        statements.push(subprogressStatement(resource, rowIndex, childOffset + take, 0, 0))
      }
      await execute(options.database.$client, statements)
      return {
        complete: false,
        resource,
        loadedRows: complete ? rateBatch.record.count : 0,
        statements: statements.length,
        snapshotSha256: digest,
        anomalies,
      }
    }
    if (resource === 'roles') {
      const row = rows[0]!
      const userIds = row.row.user_ids
      if (!Array.isArray(userIds)) throw new Error('roles.user_ids must be an array')
      const priorChild = await subprogress(options.database.$client, resource, row.index)
      const childOffset = priorChild?.childOffset ?? 0
      if (childOffset > userIds.length)
        throw new Error('role child checkpoint exceeds its source array')
      const capacity = maxStatements - 3
      if (capacity < 1 && childOffset < userIds.length) {
        throw new Error('role row has no child statement budget')
      }
      const take = Math.min(Math.max(0, capacity), userIds.length - childOffset)
      const complete = childOffset + take === userIds.length
      const loaded = offset + (complete ? 1 : 0)
      const statements = rowStatements(
        resource,
        row,
        manifest,
        anomalies,
        undefined,
        undefined,
        undefined,
        childOffset,
        take,
      )
      if (complete) {
        statements.push(deleteSubprogressStatement(resource, row.index))
        statements.push(
          progressStatement(
            resource,
            digest,
            loadOptionsJson,
            row.endByteOffset,
            loaded,
            total,
            loaded === total,
            timestamp,
          ),
        )
      } else {
        statements.push(subprogressStatement(resource, row.index, childOffset + take, 0, 0))
      }
      await execute(options.database.$client, statements)
      return {
        complete: false,
        resource,
        loadedRows: complete ? 1 : 0,
        statements: statements.length,
        snapshotSha256: digest,
        anomalies,
      }
    }
    if (complex) {
      const container = isD1(options.database.$client) ? null : options.database.$client
      if (container) container.exec('BEGIN IMMEDIATE')
      try {
        const outcome = await loadComplexRow(
          options,
          resource,
          rows[0],
          manifest,
          anomalies,
          maxStatements,
          digest,
        )
        if (!outcome.complete) {
          if (container) container.exec('COMMIT')
          return {
            complete: false,
            resource,
            loadedRows: 0,
            statements: outcome.statements,
            snapshotSha256: digest,
            anomalies: [],
          }
        }
        const loaded = offset + 1
        await execute(options.database.$client, [
          ...anomalyStatements(digest, anomalies),
          progressStatement(
            resource,
            digest,
            loadOptionsJson,
            rows[0].endByteOffset,
            loaded,
            total,
            loaded === total,
            timestamp,
          ),
        ])
        if (container) container.exec('COMMIT')
        return {
          complete: false,
          resource,
          loadedRows: 1,
          statements: outcome.statements + 1,
          snapshotSha256: digest,
          anomalies,
        }
      } catch (error) {
        if (container?.inTransaction) container.exec('ROLLBACK')
        throw error
      }
    }
    const step = RESOURCES.find((item) => item.name === resource)
    const lineage =
      step && 'parent' in step
        ? await lineageFor(options.snapshotDir, resource, digest, offset, rows)
        : undefined
    const statements: PlannedStatement[] = []
    const taskBudgetByProject =
      resource === 'task_assignments'
        ? await projectBudgetBys(
            options.database.$client,
            rows.map((row) => {
              const projectHarvestId = nestedId(row.row, 'project')
              if (projectHarvestId === null) throw new Error('task assignment project is required')
              return projectHarvestId
            }),
          )
        : null
    let consumed = 0
    for (const [index, row] of rows.entries()) {
      const anomalyCount = anomalies.length
      let taskBudgetBy: string | undefined
      if (resource === 'task_assignments') {
        const projectHarvestId = nestedId(row.row, 'project')
        if (projectHarvestId === null) throw new Error('task assignment project is required')
        taskBudgetBy = taskBudgetByProject?.get(projectHarvestId)
        if (taskBudgetBy === undefined)
          throw new Error(`project source id ${projectHarvestId} has not been loaded`)
      }
      const planned = rowStatements(
        resource,
        row,
        manifest,
        anomalies,
        lineage?.[index],
        undefined,
        taskBudgetBy,
      )
      if (statements.length + planned.length + anomalies.length + 1 > maxStatements) {
        anomalies.splice(anomalyCount)
        break
      }
      statements.push(...planned)
      consumed++
    }
    if (consumed === 0) throw new Error(`${resource} row exceeds the invocation statement budget`)
    const loaded = offset + consumed
    const sourceByteOffset = rows[consumed - 1]!.endByteOffset
    statements.push(...anomalyStatements(digest, anomalies))
    statements.push(
      progressStatement(
        resource,
        digest,
        loadOptionsJson,
        sourceByteOffset,
        loaded,
        total,
        loaded === total,
        timestamp,
      ),
    )
    await execute(options.database.$client, statements)
    return {
      complete: false,
      resource,
      loadedRows: consumed,
      statements: statements.length,
      snapshotSha256: digest,
      anomalies,
    }
  }
  return {
    complete: true,
    resource: null,
    loadedRows: 0,
    statements: 0,
    snapshotSha256: digest,
    anomalies: [],
  }
}

export interface RunLoadOptions extends Omit<LoadNextChunkOptions, 'database'> {
  databasePath: string
}

export interface RunLoadResult {
  snapshotSha256: string
  loadedRows: number
  invocations: number
  anomalies: LoadAnomaly[]
}

export const runLoad = async (options: RunLoadOptions): Promise<RunLoadResult> => {
  const lock = await acquireSnapshotLock(options.snapshotDir, 'load')
  try {
    const [{ default: BetterSqlite3 }, databaseModule] = await Promise.all([
      import('better-sqlite3'),
      import('@ezacto/db'),
    ])
    const sqlite = new BetterSqlite3(options.databasePath)
    try {
      databaseModule.migrateContainer(sqlite)
      const database = databaseModule.createContainerDatabase(sqlite) as ImportDatabase
      let loadedRows = 0
      let invocations = 0
      let snapshotSha256 = ''
      while (true) {
        const result = await loadNextChunk({ ...options, database })
        snapshotSha256 = result.snapshotSha256
        loadedRows += result.loadedRows
        invocations++
        if (result.complete) {
          const report = await assertLoadComplete(database, snapshotSha256)
          return { snapshotSha256, loadedRows, invocations, anomalies: report.anomalies }
        }
      }
    } finally {
      sqlite.close()
    }
  } finally {
    await releaseSnapshotLock(lock)
  }
}
