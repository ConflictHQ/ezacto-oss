import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { hostname } from 'node:os'
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
import { type ChildLineage } from './jsonl.js'
import { readManifest, type Manifest } from './manifest.js'
import { RESOURCES } from './resources.js'
import { acquireSnapshotLock, releaseSnapshotLock } from './snapshot-lock.js'
import {
  accessRoles,
  billingMethod,
  canonicalHarvestTime,
  hoursLiteralToSeconds,
  moneyLiteralToCents,
  rateLiteralToCents,
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
const RATE_CLEANUP_ROWS_PER_INVOCATION = 100
const LINEAGE_RECOVERY_ROWS_PER_INVOCATION = 100
const CHILD_INDEX_REMOTE_LOCK_STALE_MS = 5 * 60 * 1000

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

/**
 * The source shape of a timer still going: either Harvest is holding the start
 * instant, or the entry opened at a wall-clock time and never closed. It is the
 * `time_entries_one_running_per_user` predicate read off the source row, and
 * one definition serves both the pre-flight and the insert so the two cannot
 * come to disagree about which rows the index counts. Canonicalizing a Harvest
 * time never turns a value into null or back, so asking the raw strings is the
 * same question the loaded columns answer.
 */
const isRunningEntry = (row: Record<string, unknown>): boolean =>
  stringValue(row, 'timer_started_at') !== null ||
  (stringValue(row, 'started_time') !== null && stringValue(row, 'ended_time') === null)

const bool = (row: Record<string, unknown>, key: string, fallback = false): boolean => {
  const value = row[key]
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error(`${key} must be boolean`)
  return value
}

/**
 * Harvest emits an embedded reference as `{id: null, name: null}` when there is
 * nothing to point at — a payment taken outside a gateway, an invoice whose
 * creator has since been deleted — rather than omitting the object. A present
 * object therefore does not imply a present reference. Narrow to the object
 * only when it actually identifies something, so `nestedId` keeps meaning
 * "this reference is required" everywhere else.
 */
const identifiedReference = (value: Record<string, unknown> | null): boolean =>
  value !== null && value.id != null

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

/**
 * A row that cannot ride in a batched insert with its neighbours: either it
 * carries a guard of its own, or it binds one parameter more than it has
 * columns and the batcher sizes a batch by column count alone — four
 * twenty-six-binding time entries would ask D1 for a hundred and four. Dropping
 * the batch metadata leaves the statement standing on its own.
 */
const standalone = (statement: PlannedStatement, guard?: string): PlannedStatement => ({
  sql: guard === undefined ? statement.sql : `${statement.sql}\n      AND ${guard}`,
  bindings: statement.bindings,
})

const idFrom = (table: string, harvestId: number | string): SqlExpression =>
  expression(`(SELECT id FROM ${table} WHERE harvest_id = ?)`, harvestId)

const canonicalJson = (value: unknown): string | null =>
  value == null ? null : JSON.stringify(value)

export interface LoadAnomaly {
  resource: string
  source_id: number | string | null
  kind:
    | 'hours_residue'
    | 'rate_residue'
    | 'unresolved_estimate_reference'
    | 'billing_conflict'
    | 'payment_date_disagreement'
    | 'invoice_state_disagreement'
    | 'rate_chain_mismatch'
    | 'receipt_download_missing'
    | 'duplicate_user_squashed'
    | 'duplicate_row_merged'
  detail: string
}

/**
 * One person, two Harvest accounts. Harvest happily creates a second user for
 * someone who already exists — an account of any age carries more user rows
 * than people — and nothing in the source marks the pair. So the pairs are
 * handed to the loader rather than inferred by it: a name-and-time heuristic
 * over one such account produced scores of candidates of pure noise, which is
 * precisely why guessing has no place at load time.
 */
export interface UserAlias {
  /** The Harvest user squashed away; no record of it survives the load. */
  duplicate: number
  /** The Harvest user that survives and adopts every reference to the duplicate. */
  canonical: number
}

/**
 * A second address for someone who already exists. Harvest holds exactly one
 * address per person and for nearly every active person here it is a personal
 * one, so SSO — which binds by verified address alone — would mint a new empty
 * account the first time they signed in with work credentials. The Harvest
 * address stays primary because it is what reconciles against the payroll and
 * payment accounts; this one rides beside it, verified. The addresses are
 * input for the same reason the pairs are: the first-initial-plus-surname
 * convention that generates the list has real exceptions, and a convention
 * with exceptions is a list, not a rule.
 */
export interface UserWorkEmail {
  /** The surviving Harvest user, never a squashed duplicate. */
  user: number
  address: string
}

export interface UserIdentityInput {
  aliases?: readonly UserAlias[]
  workEmails?: readonly UserWorkEmail[]
}

export interface LoadNextChunkOptions {
  database: ImportDatabase
  snapshotDir: string
  organizationCurrency?: string
  organizationAddress?: string | null
  maxStatements?: number
  maxRows?: number
  /** Duplicate accounts to squash and work addresses to seed; see {@link UserIdentityInput}. */
  userIdentity?: UserIdentityInput
  /** Required for D1: the executor promises these artifacts are immutable and pinned to this digest. */
  immutableSnapshotSha256?: string
}

interface ResolvedUserIdentity {
  /** Duplicate Harvest id to the Harvest id that survives in its place. */
  canonicalOf: ReadonlyMap<number, number>
  /** Surviving Harvest id to every duplicate whose address it adopts. */
  duplicatesOf: ReadonlyMap<number, readonly number[]>
  workEmails: ReadonlyMap<number, readonly string[]>
  /** Canonical serialization, folded into the durable load options; null when empty. */
  json: string | null
}

const EMPTY_USER_IDENTITY: ResolvedUserIdentity = {
  canonicalOf: new Map(),
  duplicatesOf: new Map(),
  workEmails: new Map(),
  json: null,
}

const resolvedIdentities = new WeakMap<UserIdentityInput, ResolvedUserIdentity>()

const identityHarvestId = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new Error(`user identity ${field} must be a positive Harvest user id`)
  return value
}

const resolveUserIdentity = (input?: UserIdentityInput): ResolvedUserIdentity => {
  if (input === undefined) return EMPTY_USER_IDENTITY
  const cached = resolvedIdentities.get(input)
  if (cached !== undefined) return cached
  const canonicalOf = new Map<number, number>()
  const duplicatesOf = new Map<number, number[]>()
  for (const alias of input.aliases ?? []) {
    const duplicate = identityHarvestId(alias.duplicate, 'duplicate')
    const canonical = identityHarvestId(alias.canonical, 'canonical')
    if (duplicate === canonical) throw new Error(`harvest user ${duplicate} cannot alias itself`)
    if (canonicalOf.has(duplicate)) throw new Error(`harvest user ${duplicate} is aliased twice`)
    canonicalOf.set(duplicate, canonical)
    duplicatesOf.set(canonical, [...(duplicatesOf.get(canonical) ?? []), duplicate])
  }
  // A chain would make the survivor depend on the order the pairs happen to be
  // applied in, which is not something an input list promises. Every canonical
  // must be a record that survives the load in its own right.
  for (const canonical of duplicatesOf.keys()) {
    if (canonicalOf.has(canonical))
      throw new Error(`harvest user ${canonical} is both a squashed duplicate and a survivor`)
  }
  const workEmails = new Map<number, string[]>()
  const claimants = new Map<string, number>()
  for (const entry of input.workEmails ?? []) {
    const user = identityHarvestId(entry.user, 'user')
    const address = typeof entry.address === 'string' ? entry.address.trim() : ''
    if (address === '') throw new Error(`harvest user ${user} work email must be an address`)
    if (canonicalOf.has(user))
      throw new Error(`harvest user ${user} is squashed away; seed its work email on the survivor`)
    const key = address.toLowerCase()
    const claimant = claimants.get(key)
    // Two people cannot hold one verified address, and asserting it here would
    // surface as an opaque unique-index failure a thousand rows into the load.
    if (claimant !== undefined && claimant !== user)
      throw new Error(`work email ${address} is claimed by harvest users ${claimant} and ${user}`)
    claimants.set(key, user)
    const addresses = workEmails.get(user) ?? []
    if (!addresses.some((existing) => existing.toLowerCase() === key)) addresses.push(address)
    workEmails.set(user, addresses)
  }
  const aliases = [...canonicalOf]
    .sort(([left], [right]) => left - right)
    .map(([duplicate, canonical]) => ({ duplicate, canonical }))
  const seeds = [...workEmails]
    .sort(([left], [right]) => left - right)
    .flatMap(([user, addresses]) =>
      [...addresses]
        .sort((left, right) => (left.toLowerCase() < right.toLowerCase() ? -1 : 1))
        .map((address) => ({ user, address })),
    )
  const resolved: ResolvedUserIdentity = {
    canonicalOf,
    duplicatesOf,
    workEmails,
    json:
      aliases.length === 0 && seeds.length === 0
        ? null
        : JSON.stringify({ aliases, work_emails: seeds }),
  }
  resolvedIdentities.set(input, resolved)
  return resolved
}

/** Every foreign key to a user resolves through here, so a squash moves all of them. */
const canonicalUser = (identity: ResolvedUserIdentity, harvestId: number): number =>
  identity.canonicalOf.get(harvestId) ?? harvestId

/**
 * True when this reference lands on an account that absorbed another. Two
 * accounts for one person are ordinarily assigned to the same project and paid
 * at the same rate from the same date, so anything the schema allows a user
 * only one of has to be planned differently for these — and only for these,
 * because every other row must keep the statement it has always been loaded by.
 */
const mergedUser = (identity: ResolvedUserIdentity, harvestId: number): boolean =>
  identity.duplicatesOf.has(canonicalUser(identity, harvestId))

const userEmailStatement = (
  userHarvestId: number,
  address: string,
  isPrimary: boolean,
  createdAt: string,
  updatedAt: string,
): PlannedStatement => ({
  sql: `INSERT INTO user_emails
    (user_id, address, verified_at, is_primary, created_at, updated_at)
    SELECT user.id, ?, ?, ?, ?, ? FROM users user WHERE user.harvest_id = ?
      AND NOT EXISTS (SELECT 1 FROM user_emails existing
        WHERE existing.user_id = user.id AND lower(existing.address) = lower(?))`,
  bindings: [address, createdAt, isPrimary ? 1 : 0, createdAt, updatedAt, userHarvestId, address],
})

/**
 * The squashed account's address is the point of the merge, not a casualty of
 * it: whoever signs in or is invoiced under it must land on the survivor. It is
 * emitted while planning the *survivor's* row, so it never depends on which of
 * the pair the source file happens to list first.
 */
const squashedEmailStatements = async (
  snapshotDir: string,
  manifest: Manifest,
  identity: ResolvedUserIdentity,
  canonicalHarvestId: number,
): Promise<PlannedStatement[]> => {
  const duplicates = identity.duplicatesOf.get(canonicalHarvestId)
  if (duplicates === undefined) return []
  const statements: PlannedStatement[] = []
  for (const duplicate of duplicates) {
    const source = await findRawRowById(
      snapshotDir,
      'users',
      manifest.resources.users?.count ?? 0,
      duplicate,
    )
    if (source === null) throw new Error(`squashed harvest user ${duplicate} is absent from users`)
    statements.push(
      userEmailStatement(
        canonicalHarvestId,
        requiredText(source.row, 'email'),
        false,
        requiredText(source.row, 'created_at'),
        requiredText(source.row, 'updated_at'),
      ),
    )
  }
  return statements
}

/**
 * Every account the map names must be one the snapshot holds. The alias side
 * said so already, but a seeded address did not: its insert selects from
 * `users WHERE harvest_id = ?`, and a Harvest id the snapshot has never heard
 * of simply matches nothing — no error, no anomaly, no count. #273's list is
 * thirteen hand-built pairs, so one stale id would leave that person unseeded
 * under a green load, and SSO would mint them the empty account the seeding
 * exists to prevent. A seeded address that already belongs to somebody else is
 * checked in the same pass, because the unique index on a verified address
 * would otherwise abort the load a thousand rows in. Both are asked before the
 * snapshot is admitted: an identity map is wrong from the first row or not at
 * all, and the only failure this load cannot recover from is the one that
 * stops halfway.
 */
const assertIdentityInSnapshot = async (
  snapshotDir: string,
  manifest: Manifest,
  identity: ResolvedUserIdentity,
): Promise<void> => {
  if (identity.json === null) return
  const named = new Set<number>([
    ...identity.canonicalOf.keys(),
    ...identity.duplicatesOf.keys(),
    ...identity.workEmails.keys(),
  ])
  const present = new Set<number>()
  const holders = new Map<string, number>()
  const total = manifest.resources.users?.count ?? 0
  let rowOffset = 0
  let byteOffset = 0
  while (rowOffset < total) {
    const chunk = await rawChunkFrom(snapshotDir, 'users', byteOffset, rowOffset, 100)
    if (chunk.rows.length === 0) break
    for (const source of chunk.rows) {
      const harvestId = safeIntegerAt(source, '/id', 'users.id')
      if (named.has(harvestId)) present.add(harvestId)
      holders.set(requiredText(source.row, 'email').toLowerCase(), harvestId)
    }
    rowOffset += chunk.rows.length
    byteOffset = chunk.nextByteOffset
  }
  for (const harvestId of named) {
    if (!present.has(harvestId)) throw new Error(`harvest user ${harvestId} is absent from users`)
  }
  for (const [user, addresses] of identity.workEmails) {
    for (const address of addresses) {
      const holder = holders.get(address.toLowerCase())
      if (holder !== undefined && canonicalUser(identity, holder) !== user) {
        throw new Error(`work email ${address} is the Harvest address of harvest user ${holder}`)
      }
    }
  }
  await assertOneRunningTimer(snapshotDir, manifest, identity)
}

/**
 * A running timer is per account in Harvest and per person here — `UNIQUE
 * (user_id) WHERE running`, under the trigger that stops whatever the arriving
 * timer displaces. Two accounts for one person can each hold one, and a timer
 * left going on the account being retired is an ordinary thing to find in an
 * account being decommissioned, so the squash walks into that pair the way it
 * walked into the shared assignment and the shared rate date.
 *
 * It is refused rather than merged, and refused here, because neither outcome
 * at the insert is one this load may choose. Whichever entry the source lists
 * second either aborts on the trigger's backward-boundary guard — mid load,
 * and no identity map gets a resume past it — or is accepted, and the trigger
 * closes the entry already loaded at the incoming start, inventing hours for
 * the merged person on the payroll grain that no anomaly can honestly account
 * for. Nor can the loader land the second one stopped: this account keeps
 * timestamps, so a stopped entry needs an `ended_time` the source never gave
 * it. Which of two live timers is the real one is a question for whoever runs
 * the cutover, answered in Harvest by stopping one, and asking it before the
 * snapshot is admitted costs a re-extract rather than a half-loaded database.
 */
const assertOneRunningTimer = async (
  snapshotDir: string,
  manifest: Manifest,
  identity: ResolvedUserIdentity,
): Promise<void> => {
  if (identity.canonicalOf.size === 0) return
  const running = new Map<number, { user: number; entry: string }>()
  const total = manifest.resources.time_entries?.count ?? 0
  let rowOffset = 0
  let byteOffset = 0
  while (rowOffset < total) {
    const chunk = await rawChunkFrom(snapshotDir, 'time_entries', byteOffset, rowOffset, 100)
    if (chunk.rows.length === 0) break
    for (const source of chunk.rows) {
      if (!isRunningEntry(source.row)) continue
      const user = nestedId(source.row, 'user')!
      if (!mergedUser(identity, user)) continue
      const survivor = canonicalUser(identity, user)
      const entry = numberAt(source, '/id', 'time_entries.id')
      const held = running.get(survivor)
      if (held !== undefined) {
        throw new Error(
          `harvest users ${held.user} and ${user} hold running time entries ${held.entry} and ` +
            `${entry}; harvest user ${survivor} can keep only one running`,
        )
      }
      running.set(survivor, { user, entry })
    }
    rowOffset += chunk.rows.length
    byteOffset = chunk.nextByteOffset
  }
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
  const rateProgressPresent = await first<{ present: number }>(
    database,
    `SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = '_ezacto_load_rate_progress'`,
  )
  const currencyProgressPresent = await first<{ present: number }>(
    database,
    `SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = '_ezacto_load_currency_progress'`,
  )
  const lineageProgressPresent = await first<{ present: number }>(
    database,
    `SELECT 1 AS present FROM sqlite_master
      WHERE type = 'table' AND name = '_ezacto_load_lineage_progress'`,
  )
  const statements: PlannedStatement[] = []
  if (!admissionPresent)
    statements.push({
      sql: `CREATE TABLE IF NOT EXISTS _ezacto_load_admission (
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
      sql: `CREATE TABLE IF NOT EXISTS _ezacto_load_progress (
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
  if (!lineageProgressPresent)
    statements.push({
      sql: `CREATE TABLE IF NOT EXISTS _ezacto_load_lineage_progress (
      resource TEXT PRIMARY KEY,
      snapshot_sha256 TEXT NOT NULL,
      byte_offset INTEGER NOT NULL CHECK (byte_offset >= 0),
      rows_scanned INTEGER NOT NULL CHECK (rows_scanned >= 0)
    ) STRICT`,
      bindings: [],
    })
  if (!subprogressPresent)
    statements.push({
      sql: `CREATE TABLE IF NOT EXISTS _ezacto_load_subprogress (
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
      sql: `CREATE TABLE IF NOT EXISTS _ezacto_load_anomalies (
      snapshot_sha256 TEXT NOT NULL,
      resource TEXT NOT NULL,
      source_id TEXT,
      kind TEXT NOT NULL,
      detail TEXT NOT NULL,
      PRIMARY KEY (snapshot_sha256, resource, source_id, kind, detail)
    ) STRICT`,
      bindings: [],
    })
  if (!rateProgressPresent) {
    statements.push(
      {
        sql: `CREATE TABLE IF NOT EXISTS _ezacto_load_rate_progress (
        resource TEXT PRIMARY KEY,
        snapshot_sha256 TEXT NOT NULL,
        source_byte_offset INTEGER NOT NULL CHECK (source_byte_offset >= 0),
        source_lineage_byte_offset INTEGER NOT NULL CHECK (source_lineage_byte_offset >= 0),
        staged_rows INTEGER NOT NULL CHECK (staged_rows >= 0),
        loaded_rows INTEGER NOT NULL CHECK (loaded_rows >= 0),
        cleaned_rows INTEGER NOT NULL CHECK (cleaned_rows >= 0),
        last_user_harvest_id INTEGER,
        last_sort_start_date TEXT,
        last_harvest_id INTEGER,
        CHECK (cleaned_rows <= loaded_rows),
        CHECK (loaded_rows <= staged_rows),
        CHECK ((last_user_harvest_id IS NULL) = (last_sort_start_date IS NULL)),
        CHECK ((last_user_harvest_id IS NULL) = (last_harvest_id IS NULL))
      ) STRICT`,
        bindings: [],
      },
      ...['_ezacto_load_billable_rates', '_ezacto_load_cost_rates'].flatMap(
        (table): PlannedStatement[] => [
          {
            sql: `CREATE TABLE IF NOT EXISTS ${table} (
            harvest_id INTEGER PRIMARY KEY,
            source_row_index INTEGER NOT NULL UNIQUE CHECK (source_row_index >= 0),
            user_harvest_id INTEGER NOT NULL,
            amount_cents INTEGER NOT NULL,
            start_date TEXT,
            sort_start_date TEXT NOT NULL,
            source_end_date TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          ) STRICT`,
            bindings: [],
          },
          {
            sql: `CREATE INDEX IF NOT EXISTS ${table}_load_order
              ON ${table}(user_harvest_id, sort_start_date, harvest_id)`,
            bindings: [],
          },
        ],
      ),
    )
  }
  if (!currencyProgressPresent)
    statements.push({
      sql: `CREATE TABLE IF NOT EXISTS _ezacto_load_currency_progress (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      snapshot_sha256 TEXT NOT NULL,
      source_byte_offset INTEGER NOT NULL CHECK (source_byte_offset >= 0),
      rows_scanned INTEGER NOT NULL CHECK (rows_scanned >= 0),
      currency TEXT CHECK (currency IS NULL OR length(currency) = 3),
      completed INTEGER NOT NULL CHECK (completed IN (0, 1))
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

interface LineageProgress {
  snapshotSha256: string
  byteOffset: number
  rowsScanned: number
}

const lineageProgress = async (
  database: RawDatabase,
  resource: string,
): Promise<LineageProgress | null> =>
  first<LineageProgress>(
    database,
    `SELECT snapshot_sha256 AS snapshotSha256, byte_offset AS byteOffset,
      rows_scanned AS rowsScanned
     FROM _ezacto_load_lineage_progress WHERE resource = ?`,
    [resource],
  )

const lineageProgressStatement = (
  resource: string,
  digest: string,
  byteOffset: number,
  rowsScanned: number,
): PlannedStatement => ({
  sql: `INSERT INTO _ezacto_load_lineage_progress
      (resource, snapshot_sha256, byte_offset, rows_scanned)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(resource) DO UPDATE SET
      byte_offset = excluded.byte_offset, rows_scanned = excluded.rows_scanned
    WHERE _ezacto_load_lineage_progress.snapshot_sha256 = excluded.snapshot_sha256`,
  bindings: [resource, digest, byteOffset, rowsScanned],
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

/**
 * An anomaly whose truth only the statement stream knows. Whether a squashed
 * account's row was merged away or loaded in its own right depends on what the
 * rows before it left behind, and the anomaly list is assembled while planning,
 * before any of them run — so the condition travels into SQL and is answered
 * where it can be. The digest comes off the admission row rather than a binding
 * because it is the same value the planner would bind, and asking for it there
 * keeps this out of every signature between here and the chunk loop.
 */
const conditionalAnomalyStatement = (
  anomaly: LoadAnomaly,
  condition: SqlExpression,
): PlannedStatement => {
  const sourceId = anomaly.source_id === null ? null : String(anomaly.source_id)
  return {
    sql: `INSERT INTO _ezacto_load_anomalies
        (snapshot_sha256, resource, source_id, kind, detail)
      SELECT admission.snapshot_sha256, ?, ?, ?, ?
      FROM _ezacto_load_admission admission WHERE admission.singleton = 1
        AND ${condition.sql}
        AND NOT EXISTS (
          SELECT 1 FROM _ezacto_load_anomalies existing
          WHERE existing.snapshot_sha256 = admission.snapshot_sha256 AND existing.resource = ?
            AND existing.source_id IS ? AND existing.kind = ? AND existing.detail = ?
        )`,
    bindings: [
      anomaly.resource,
      sourceId,
      anomaly.kind,
      anomaly.detail,
      ...condition.bindings,
      anomaly.resource,
      sourceId,
      anomaly.kind,
      anomaly.detail,
    ],
  }
}

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

const rate = (
  source: RawRow,
  path: string,
  anomalies: LoadAnomaly[],
  resource: string,
): number => {
  const transformed = rateLiteralToCents(numberAt(source, path), path)
  if (transformed.residue !== null) {
    anomalies.push({
      resource,
      source_id: source.numbers.get('/id') ?? null,
      kind: 'rate_residue',
      detail: `${path}=${transformed.residue}`,
    })
  }
  return transformed.cents
}

const nullableRate = (
  source: RawRow,
  path: string,
  anomalies: LoadAnomaly[],
  resource: string,
): number | null => {
  const literal = nullableNumberAt(source, path)
  if (literal === null) return null
  const transformed = rateLiteralToCents(literal, path)
  if (transformed.residue !== null) {
    anomalies.push({
      resource,
      source_id: source.numbers.get('/id') ?? null,
      kind: 'rate_residue',
      detail: `${path}=${transformed.residue}`,
    })
  }
  return transformed.cents
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
const CHILD_INDEX_WORK_ROWS_PER_INVOCATION = 100

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

const childIndexPartialPath = (snapshotDir: string, resource: string, digest: string): string =>
  `${childIndexPath(snapshotDir, resource, digest)}.partial`

const childIndexStatePath = (snapshotDir: string, resource: string, digest: string): string =>
  `${childIndexPath(snapshotDir, resource, digest)}.state.json`

const childIndexDirectory = (snapshotDir: string): string => join(snapshotDir, 'raw', '.load-index')

interface ChildIndexLock {
  path: string
  directory: string
  token: string
}

interface ChildIndexLockOwner {
  pid: number
  host: string
  token: string
  startedAt: number
}

const childIndexQueues = new Map<string, Promise<void>>()

const childIndexPidIsLive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

const syncDirectory = async (path: string): Promise<void> => {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const createChildIndexLock = async (snapshotDir: string): Promise<ChildIndexLock> => {
  const directory = childIndexDirectory(snapshotDir)
  const path = join(directory, '.builder.lock')
  const token = randomUUID()
  const temporary = join(directory, `.builder.lock.claim-${process.pid}-${token}`)
  await mkdir(temporary)
  const ownerPath = join(temporary, 'owner.json')
  let installed = false
  try {
    const owner = await open(ownerPath, 'wx')
    try {
      const value: ChildIndexLockOwner = {
        pid: process.pid,
        host: hostname(),
        token,
        startedAt: Date.now(),
      }
      await owner.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
      await owner.sync()
    } finally {
      await owner.close()
    }
    await syncDirectory(temporary)
    await rename(temporary, path)
    installed = true
    await syncDirectory(directory)
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    if (installed) await rm(path, { recursive: true, force: true })
    throw error
  }
  return { path, directory, token }
}

const acquireChildIndexLock = async (snapshotDir: string): Promise<ChildIndexLock> => {
  const directory = childIndexDirectory(snapshotDir)
  const path = join(directory, '.builder.lock')
  await mkdir(directory, { recursive: true })
  try {
    return await createChildIndexLock(snapshotDir)
  } catch (error) {
    if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
  }
  let owner: ChildIndexLockOwner
  try {
    owner = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8')) as ChildIndexLockOwner
    if (
      !Number.isSafeInteger(owner.pid) ||
      owner.pid < 1 ||
      typeof owner.host !== 'string' ||
      typeof owner.token !== 'string' ||
      !Number.isSafeInteger(owner.startedAt) ||
      owner.startedAt < 0
    ) {
      throw new Error('invalid child-index lock owner')
    }
  } catch {
    throw new Error(`child index lock at ${path} has no readable owner metadata`)
  }
  const remote = owner.host !== hostname()
  // A child-index turn is capped at 100 source rows and D1 itself caps an
  // invocation at 30 seconds. Preserve fresh cross-host owners, but let a new
  // executor recover a lock whose originating host disappeared long ago.
  const remoteExpired = remote && Date.now() - owner.startedAt > CHILD_INDEX_REMOTE_LOCK_STALE_MS
  if ((!remote && childIndexPidIsLive(owner.pid)) || (remote && !remoteExpired)) {
    throw new Error(`child index is already being built by pid ${owner.pid} on ${owner.host}`)
  }
  const staleGeneration = createHash('sha256').update(owner.token).digest('hex')
  const quarantine = `${path}.stale-${staleGeneration}`
  try {
    await rename(path, quarantine)
    await syncDirectory(directory)
    return await createChildIndexLock(snapshotDir)
  } catch (error) {
    if (['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      throw new Error('child index is being reclaimed by another loader')
    }
    throw error
  }
}

const releaseChildIndexLock = async (lock: ChildIndexLock): Promise<void> => {
  const owner = JSON.parse(
    await readFile(join(lock.path, 'owner.json'), 'utf8'),
  ) as ChildIndexLockOwner
  if (owner.token !== lock.token) throw new Error('refusing to release a changed child-index lock')
  await rm(lock.path, { recursive: true, force: true })
  await syncDirectory(lock.directory)
}

const withChildIndexLock = async <T>(snapshotDir: string, action: () => Promise<T>): Promise<T> => {
  const key = childIndexDirectory(snapshotDir)
  const previous = childIndexQueues.get(key) ?? Promise.resolve()
  let releaseTurn!: () => void
  const turn = new Promise<void>((resolve) => {
    releaseTurn = resolve
  })
  const queued = previous.catch(() => undefined).then(() => turn)
  childIndexQueues.set(key, queued)
  await previous.catch(() => undefined)
  let lock: ChildIndexLock | null = null
  try {
    lock = await acquireChildIndexLock(snapshotDir)
    return await action()
  } finally {
    try {
      if (lock !== null) await releaseChildIndexLock(lock)
    } finally {
      releaseTurn()
      if (childIndexQueues.get(key) === queued) childIndexQueues.delete(key)
    }
  }
}

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

interface IndexedLine {
  line: string
  startByte: number
  endByte: number
}

interface LineCursor {
  next(): Promise<IndexedLine | null>
  close(): void
}

const lineCursor = (path: string, byteOffset: number): LineCursor => {
  const lines = createInterface({
    input: createReadStream(path, byteOffset === 0 ? undefined : { start: byteOffset }),
    crlfDelay: Infinity,
  })
  const iterator = lines[Symbol.asyncIterator]()
  let offset = byteOffset
  return {
    async next() {
      for (;;) {
        const next = await iterator.next()
        if (next.done) return null
        const startByte = offset
        offset += Buffer.byteLength(next.value, 'utf8') + 1
        if (next.value.trim()) return { line: next.value, startByte, endByte: offset }
      }
    },
    close: () => lines.close(),
  }
}

interface ActiveChildIndexParent {
  parentId: number
  startByte: number
  lineageStartByte: number
  startRow: number
  count: number
}

interface ChildIndexBuildState {
  version: 1
  resource: string
  digest: string
  parentOrdinal: number
  parentByteOffset: number
  childByteOffset: number
  lineageByteOffset: number
  childRowOffset: number
  indexRecords: number
  activeParent: ActiveChildIndexParent | null
}

interface ChildIndexCandidate {
  parentId: number
  raw: IndexedLine
  lineage: IndexedLine
}

const nonnegativeSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const parseChildIndexBuildState = (
  raw: string,
  resource: string,
  digest: string,
): ChildIndexBuildState => {
  const value = JSON.parse(raw) as Partial<ChildIndexBuildState>
  const active = value.activeParent
  if (
    value.version !== 1 ||
    value.resource !== resource ||
    value.digest !== digest ||
    !nonnegativeSafeInteger(value.parentOrdinal) ||
    !nonnegativeSafeInteger(value.parentByteOffset) ||
    !nonnegativeSafeInteger(value.childByteOffset) ||
    !nonnegativeSafeInteger(value.lineageByteOffset) ||
    !nonnegativeSafeInteger(value.childRowOffset) ||
    !nonnegativeSafeInteger(value.indexRecords) ||
    value.indexRecords !== value.parentOrdinal ||
    (active !== null &&
      (active === undefined ||
        !nonnegativeSafeInteger(active.parentId) ||
        active.parentId < 1 ||
        !nonnegativeSafeInteger(active.startByte) ||
        !nonnegativeSafeInteger(active.lineageStartByte) ||
        !nonnegativeSafeInteger(active.startRow) ||
        !nonnegativeSafeInteger(active.count) ||
        active.startByte > value.childByteOffset ||
        active.lineageStartByte > value.lineageByteOffset ||
        active.startRow + active.count !== value.childRowOffset))
  ) {
    throw new Error(`${resource} child index checkpoint is corrupt`)
  }
  return value as ChildIndexBuildState
}

const writeChildIndexBuildState = async (
  snapshotDir: string,
  resource: string,
  digest: string,
  state: ChildIndexBuildState,
): Promise<void> => {
  const path = childIndexStatePath(snapshotDir, resource, digest)
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx')
  try {
    await handle.writeFile(`${JSON.stringify(state)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, path)
  await syncDirectory(childIndexDirectory(snapshotDir))
}

const completedChildIndex = async (
  snapshotDir: string,
  resource: string,
  digest: string,
  parentCount: number,
  childCount: number,
): Promise<boolean> => {
  try {
    const handle = await open(childIndexPath(snapshotDir, resource, digest), 'r')
    try {
      if ((await handle.stat()).size !== parentCount * CHILD_INDEX_RECORD_BYTES) return false
      const [rawSize, lineageSize] = await Promise.all([
        stat(join(snapshotDir, 'raw', `${resource}.jsonl`)),
        stat(join(snapshotDir, 'raw', `${resource}.lineage.jsonl`)),
      ])
      if (parentCount === 0) return childCount === 0 && rawSize.size === 0 && lineageSize.size === 0
      const first = await readChildIndexRecord(handle, resource, 0)
      const last = await readChildIndexRecord(handle, resource, parentCount - 1)
      await validateChildIndexNeighborhood(handle, resource, 0, first)
      if (parentCount > 1)
        await validateChildIndexNeighborhood(handle, resource, parentCount - 1, last)
      return (
        last.startRow + last.count === childCount &&
        last.endByte === rawSize.size &&
        last.lineageEndByte === lineageSize.size
      )
    } finally {
      await handle.close()
    }
  } catch {
    return false
  }
}

interface ChildIndexAdvanceResult {
  complete: boolean
  workRows: number
}

const advanceChildIndex = async (
  snapshotDir: string,
  resource: string,
  parentResource: string,
  digest: string,
  parentCount: number,
  childCount: number,
  workBudget: number,
): Promise<ChildIndexAdvanceResult> => {
  if (await completedChildIndex(snapshotDir, resource, digest, parentCount, childCount)) {
    await rm(childIndexStatePath(snapshotDir, resource, digest), { force: true })
    await rm(childIndexPartialPath(snapshotDir, resource, digest), { force: true })
    return { complete: true, workRows: 0 }
  }
  await mkdir(childIndexDirectory(snapshotDir), { recursive: true })
  await rm(childIndexPath(snapshotDir, resource, digest), { force: true })
  const statePath = childIndexStatePath(snapshotDir, resource, digest)
  let state: ChildIndexBuildState
  try {
    state = parseChildIndexBuildState(await readFile(statePath, 'utf8'), resource, digest)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== undefined && code !== 'ENOENT') throw error
    await rm(statePath, { force: true })
    await rm(childIndexPartialPath(snapshotDir, resource, digest), { force: true })
    state = {
      version: 1,
      resource,
      digest,
      parentOrdinal: 0,
      parentByteOffset: 0,
      childByteOffset: 0,
      lineageByteOffset: 0,
      childRowOffset: 0,
      indexRecords: 0,
      activeParent: null,
    }
  }
  if (state.parentOrdinal > parentCount || state.childRowOffset > childCount) {
    throw new Error(`${resource} child index checkpoint exceeds the manifest`)
  }
  const partialPath = childIndexPartialPath(snapshotDir, resource, digest)
  // The index file is always flushed before its state. A crash between those
  // writes can only leave the file ahead, so resumption safely truncates it to
  // the last durable record instead of rescanning any completed parent.
  let output: Awaited<ReturnType<typeof open>>
  try {
    output = await open(partialPath, state.indexRecords === 0 ? 'w+' : 'r+')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || state.indexRecords === 0) throw error
    await rm(statePath, { force: true })
    return advanceChildIndex(
      snapshotDir,
      resource,
      parentResource,
      digest,
      parentCount,
      childCount,
      workBudget,
    )
  }
  const expectedBytes = state.indexRecords * CHILD_INDEX_RECORD_BYTES
  const partialBytes = (await output.stat()).size
  if (partialBytes < expectedBytes) {
    await output.close()
    await rm(statePath, { force: true })
    await rm(partialPath, { force: true })
    return advanceChildIndex(
      snapshotDir,
      resource,
      parentResource,
      digest,
      parentCount,
      childCount,
      workBudget,
    )
  }
  if (partialBytes > expectedBytes) await output.truncate(expectedBytes)
  try {
    if (state.indexRecords === 0) {
      const active = state.activeParent
      if (
        active !== null &&
        (active.startByte !== 0 || active.lineageStartByte !== 0 || active.startRow !== 0)
      ) {
        throw new Error(`${resource} child index checkpoint origin is corrupt`)
      }
    } else {
      const previous = await readChildIndexRecord(output, resource, state.indexRecords - 1)
      await validateChildIndexNeighborhood(output, resource, state.indexRecords - 1, previous)
      const boundary = state.activeParent
      if (
        previous.endByte !== (boundary?.startByte ?? state.childByteOffset) ||
        previous.lineageEndByte !== (boundary?.lineageStartByte ?? state.lineageByteOffset) ||
        previous.startRow + previous.count !== (boundary?.startRow ?? state.childRowOffset)
      ) {
        throw new Error(`${resource} child index checkpoint boundary is corrupt`)
      }
    }
  } catch {
    await output.close()
    await rm(statePath, { force: true })
    await rm(partialPath, { force: true })
    return advanceChildIndex(
      snapshotDir,
      resource,
      parentResource,
      digest,
      parentCount,
      childCount,
      workBudget,
    )
  }

  const parent = lineCursor(
    join(snapshotDir, 'raw', `${parentResource}.jsonl`),
    state.parentByteOffset,
  )
  const raw = lineCursor(join(snapshotDir, 'raw', `${resource}.jsonl`), state.childByteOffset)
  const lineage = lineCursor(
    join(snapshotDir, 'raw', `${resource}.lineage.jsonl`),
    state.lineageByteOffset,
  )
  let pendingChild: ChildIndexCandidate | null = null
  let workRows = 0
  const nextChild = async (): Promise<ChildIndexCandidate | null> => {
    const [sourceLine, lineageLine] = await Promise.all([raw.next(), lineage.next()])
    if (sourceLine === null && lineageLine === null) return null
    if (sourceLine === null || lineageLine === null) {
      throw new Error(`${resource} raw data and lineage have different row counts`)
    }
    const source = JSON.parse(sourceLine.line) as Record<string, unknown>
    const witness = JSON.parse(lineageLine.line) as Partial<ChildLineage>
    if (
      !Number.isSafeInteger(source.id) ||
      !Number.isSafeInteger(witness.source_id) ||
      !Number.isSafeInteger(witness.parent_id) ||
      source.id !== witness.source_id ||
      (witness.parent_id ?? 0) < 1
    ) {
      throw new Error(`${resource} lineage is misaligned while indexing`)
    }
    return {
      parentId: witness.parent_id!,
      raw: sourceLine,
      lineage: lineageLine,
    }
  }
  try {
    while (workRows < workBudget) {
      if (state.activeParent === null) {
        if (state.parentOrdinal === parentCount) break
        const sourceParent = await parent.next()
        workRows += 1
        if (sourceParent === null) {
          throw new Error(`${parentResource} ended before manifest count ${parentCount}`)
        }
        const parentIdLiteral = numberLexemes(sourceParent.line).get('/id')
        const parentId = parentIdLiteral === undefined ? Number.NaN : Number(parentIdLiteral)
        if (!Number.isSafeInteger(parentId) || parentId < 1) {
          throw new Error(`${parentResource} child-index parent id is invalid`)
        }
        state.parentByteOffset = sourceParent.endByte
        state.activeParent = {
          parentId,
          startByte: state.childByteOffset,
          lineageStartByte: state.lineageByteOffset,
          startRow: state.childRowOffset,
          count: 0,
        }
        if (workRows === workBudget) break
      }

      const active = state.activeParent
      if (active === null) continue
      const child: ChildIndexCandidate | null = pendingChild ?? (await nextChild())
      if (pendingChild === null) workRows += 1
      pendingChild = null
      if (child !== null && child.parentId === active.parentId) {
        state.childByteOffset = child.raw.endByte
        state.lineageByteOffset = child.lineage.endByte
        state.childRowOffset += 1
        active.count += 1
        continue
      }
      await output.write(
        childIndexLine({
          parentId: active.parentId,
          startByte: active.startByte,
          endByte: state.childByteOffset,
          lineageStartByte: active.lineageStartByte,
          lineageEndByte: state.lineageByteOffset,
          startRow: active.startRow,
          count: active.count,
        }),
        state.indexRecords * CHILD_INDEX_RECORD_BYTES,
        'utf8',
      )
      state.indexRecords += 1
      state.parentOrdinal += 1
      state.activeParent = null
      pendingChild = child
    }
    await output.sync()
    await syncDirectory(childIndexDirectory(snapshotDir))
    if (state.parentOrdinal === parentCount && state.activeParent === null) {
      if (state.childRowOffset !== childCount) {
        throw new Error(
          `${resource} indexed ${state.childRowOffset} rows; manifest claims ${childCount}`,
        )
      }
      await output.close()
      await rename(partialPath, childIndexPath(snapshotDir, resource, digest))
      await syncDirectory(childIndexDirectory(snapshotDir))
      await rm(statePath, { force: true })
      await syncDirectory(childIndexDirectory(snapshotDir))
      return { complete: true, workRows }
    }
    await writeChildIndexBuildState(snapshotDir, resource, digest, state)
    return { complete: false, workRows }
  } finally {
    parent.close()
    raw.close()
    lineage.close()
    try {
      await output.close()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EBADF') throw error
    }
  }
}

const parseChildIndexRecord = (line: string, resource: string): ChildIndexRecord => {
  const match = /^(\d{16}) (\d{16}) (\d{16}) (\d{16}) (\d{16}) (\d{12}) (\d{12})\n$/.exec(line)
  if (!match) throw new Error(`${resource} child index is corrupt`)
  const record = {
    parentId: Number(match[1]),
    startByte: Number(match[2]),
    endByte: Number(match[3]),
    lineageStartByte: Number(match[4]),
    lineageEndByte: Number(match[5]),
    startRow: Number(match[6]),
    count: Number(match[7]),
  }
  if (
    !Number.isSafeInteger(record.parentId) ||
    record.parentId < 1 ||
    !Number.isSafeInteger(record.startByte) ||
    !Number.isSafeInteger(record.endByte) ||
    !Number.isSafeInteger(record.lineageStartByte) ||
    !Number.isSafeInteger(record.lineageEndByte) ||
    !Number.isSafeInteger(record.startRow) ||
    !Number.isSafeInteger(record.count)
  ) {
    throw new Error(`${resource} child index exceeds safe integer bounds`)
  }
  return record
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

const validateChildIndexNeighborhood = async (
  handle: Awaited<ReturnType<typeof open>>,
  resource: string,
  ordinal: number,
  record: ChildIndexRecord,
): Promise<void> => {
  const records = (await handle.stat()).size / CHILD_INDEX_RECORD_BYTES
  if (!Number.isInteger(records) || ordinal < 0 || ordinal >= records) {
    throw new Error(`${resource} child index ordinal is corrupt`)
  }
  if (
    record.startByte > record.endByte ||
    record.lineageStartByte > record.lineageEndByte ||
    (record.count === 0) !== (record.startByte === record.endByte) ||
    (record.count === 0) !== (record.lineageStartByte === record.lineageEndByte) ||
    !Number.isSafeInteger(record.startRow + record.count)
  ) {
    throw new Error(`${resource} child index range is corrupt`)
  }
  if (ordinal === 0) {
    if (record.startByte !== 0 || record.lineageStartByte !== 0 || record.startRow !== 0) {
      throw new Error(`${resource} child index does not start at the source origin`)
    }
  } else {
    const previous = await readChildIndexRecord(handle, resource, ordinal - 1)
    if (
      previous.endByte !== record.startByte ||
      previous.lineageEndByte !== record.lineageStartByte ||
      previous.startRow + previous.count !== record.startRow
    ) {
      throw new Error(`${resource} child index has a gap or overlap`)
    }
  }
  if (ordinal + 1 < records) {
    const next = await readChildIndexRecord(handle, resource, ordinal + 1)
    if (
      record.endByte !== next.startByte ||
      record.lineageEndByte !== next.lineageStartByte ||
      record.startRow + record.count !== next.startRow
    ) {
      throw new Error(`${resource} child index has a gap or overlap`)
    }
  }
}

const advanceChildIndexes = async (
  snapshotDir: string,
  manifest: Manifest,
  digest: string,
  workBudget: number,
): Promise<boolean> => {
  const indexDirectory = childIndexDirectory(snapshotDir)
  try {
    for (const entry of await readdir(indexDirectory)) {
      if (entry.includes('.state.json.') && entry.endsWith('.tmp')) {
        await rm(join(indexDirectory, entry), { force: true })
      } else if (entry.startsWith('.builder.lock.claim-')) {
        await rm(join(indexDirectory, entry), { recursive: true, force: true })
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  let remaining = Math.min(workBudget, CHILD_INDEX_WORK_ROWS_PER_INVOCATION)
  for (const step of RESOURCES) {
    const expectedCount = manifest.resources[step.name]?.count ?? 0
    if (step.kind !== 'child' || expectedCount === 0) continue
    if (remaining < 1) return false
    const advanced = await advanceChildIndex(
      snapshotDir,
      step.name,
      step.parent,
      digest,
      manifest.resources[step.parent]?.count ?? 0,
      expectedCount,
      remaining,
    )
    remaining -= advanced.workRows
    if (!advanced.complete) return false
  }
  return true
}

const findChildIndex = async (
  snapshotDir: string,
  resource: string,
  digest: string,
  parentOrdinal: number,
  parentId: number,
): Promise<ChildIndexRecord | null> => {
  try {
    const handle = await open(childIndexPath(snapshotDir, resource, digest), 'r')
    try {
      const size = (await handle.stat()).size
      if (size % CHILD_INDEX_RECORD_BYTES !== 0)
        throw new Error(`${resource} child index is corrupt`)
      if (parentOrdinal < 0 || parentOrdinal >= size / CHILD_INDEX_RECORD_BYTES) return null
      const record = await readChildIndexRecord(handle, resource, parentOrdinal)
      await validateChildIndexNeighborhood(handle, resource, parentOrdinal, record)
      if (record.parentId !== parentId)
        throw new Error(`${resource} child index parent is misaligned`)
      return record.count === 0 ? null : record
    } finally {
      await handle.close()
    }
  } catch (error) {
    await rm(childIndexPath(snapshotDir, resource, digest), { force: true })
    throw error
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
  try {
    const handle = await open(childIndexPath(snapshotDir, resource, digest), 'r')
    try {
      const size = (await handle.stat()).size
      if (size % CHILD_INDEX_RECORD_BYTES !== 0)
        throw new Error(`${resource} child index is corrupt`)
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
        await validateChildIndexNeighborhood(handle, resource, ordinal, record)
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
  } catch (error) {
    await rm(childIndexPath(snapshotDir, resource, digest), { force: true })
    throw error
  }
}

const lineageChunkFrom = async (
  snapshotDir: string,
  resource: string,
  record: ChildIndexRecord,
  skip: number,
  count: number,
): Promise<{ rows: ChildLineage[]; endByteOffsets: number[] }> => {
  const rows: ChildLineage[] = []
  const endByteOffsets: number[] = []
  let seen = 0
  let byteOffset = record.lineageStartByte
  const lines = createInterface({
    input: createReadStream(join(snapshotDir, 'raw', `${resource}.lineage.jsonl`), {
      start: record.lineageStartByte,
      end: record.lineageEndByte - 1,
    }),
    crlfDelay: Infinity,
  })
  try {
    for await (const line of lines) {
      byteOffset += Buffer.byteLength(line, 'utf8') + 1
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
      endByteOffsets.push(byteOffset)
      if (rows.length === count) break
    }
  } finally {
    lines.close()
  }
  if (rows.length !== count) throw new Error(`${resource} child lineage range is truncated`)
  return { rows, endByteOffsets }
}

const lineageChunkAt = async (
  snapshotDir: string,
  resource: string,
  record: ChildIndexRecord,
  byteOffset: number,
  count: number,
): Promise<{ rows: ChildLineage[]; nextByteOffset: number; endByteOffsets: number[] }> => {
  if (byteOffset < record.lineageStartByte || byteOffset > record.lineageEndByte) {
    throw new Error(`${resource} child lineage checkpoint is outside its indexed range`)
  }
  const rows: ChildLineage[] = []
  const endByteOffsets: number[] = []
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
      endByteOffsets.push(nextByteOffset)
      if (rows.length === count) break
    }
  } finally {
    lines.close()
  }
  if (rows.length !== count) throw new Error(`${resource} child lineage range is truncated`)
  return { rows, nextByteOffset, endByteOffsets }
}

const sequentialLineageChunk = async (
  snapshotDir: string,
  resource: string,
  byteOffset: number,
  count: number,
): Promise<{ rows: ChildLineage[]; nextByteOffset: number }> => {
  const rows: ChildLineage[] = []
  let nextByteOffset = byteOffset
  const lines = createInterface({
    input: createReadStream(
      join(snapshotDir, 'raw', `${resource}.lineage.jsonl`),
      byteOffset === 0 ? undefined : { start: byteOffset },
    ),
    crlfDelay: Infinity,
  })
  try {
    for await (const line of lines) {
      nextByteOffset += Buffer.byteLength(line, 'utf8') + 1
      if (!line.trim()) continue
      const witness = JSON.parse(line) as Partial<ChildLineage>
      if (
        !Number.isSafeInteger(witness.source_id) ||
        (witness.source_id ?? 0) < 1 ||
        !Number.isSafeInteger(witness.parent_id) ||
        (witness.parent_id ?? 0) < 1
      ) {
        throw new Error(`${resource} lineage checkpoint reached an invalid row`)
      }
      rows.push(witness as ChildLineage)
      if (rows.length === count) break
    }
  } finally {
    lines.close()
  }
  if (rows.length !== count) throw new Error(`${resource} lineage ended before its staged rows`)
  return { rows, nextByteOffset }
}

const lineageFor = async (
  snapshotDir: string,
  resource: string,
  digest: string,
  offset: number,
  lineageByteOffset: number,
  rows: readonly RawRow[],
): Promise<{ rows: ChildLineage[]; endByteOffsets: number[] }> => {
  const slices = await childIndexSlices(snapshotDir, resource, digest, offset, rows.length)
  const lineage: ChildLineage[] = []
  const endByteOffsets: number[] = []
  let source = 0
  for (const [sliceIndex, slice] of slices.entries()) {
    const witnesses = await lineageChunkAt(
      snapshotDir,
      resource,
      slice.record,
      sliceIndex === 0 ? lineageByteOffset : slice.record.lineageStartByte,
      slice.count,
    )
    for (const [witnessIndex, witness] of witnesses.rows.entries()) {
      const row = rows[source++]!
      if (witness.source_id !== safeIntegerAt(row, '/id', `${resource}.id`)) {
        throw new Error(`${resource} child lineage is misaligned`)
      }
      lineage.push(witness)
      endByteOffsets.push(witnesses.endByteOffsets[witnessIndex]!)
    }
  }
  return { rows: lineage, endByteOffsets }
}

const advanceLineageCursor = async (
  snapshotDir: string,
  resource: string,
  digest: string,
  rowOffset: number,
  byteOffset: number,
  count: number,
): Promise<number> => {
  const slices = await childIndexSlices(snapshotDir, resource, digest, rowOffset, count)
  let nextByteOffset = byteOffset
  for (const [sliceIndex, slice] of slices.entries()) {
    const advanced = await lineageChunkAt(
      snapshotDir,
      resource,
      slice.record,
      sliceIndex === 0 ? nextByteOffset : slice.record.lineageStartByte,
      slice.count,
    )
    nextByteOffset = advanced.nextByteOffset
  }
  return nextByteOffset
}

type RateResource = 'billable_rates' | 'cost_rates'

interface RateStageProgress {
  snapshotSha256: string
  sourceByteOffset: number
  sourceLineageByteOffset: number
  stagedRows: number
  loadedRows: number
  cleanedRows: number
  lastUserHarvestId: number | null
  lastSortStartDate: string | null
  lastHarvestId: number | null
}

interface StagedRate {
  harvestId: number
  userHarvestId: number
  amountCents: number
  startDate: string | null
  sortStartDate: string
  sourceEndDate: string | null
  createdAt: string
  updatedAt: string
}

const rateStageTable = (resource: RateResource): string =>
  resource === 'billable_rates' ? '_ezacto_load_billable_rates' : '_ezacto_load_cost_rates'

const rateTargetTable = (resource: RateResource): string =>
  resource === 'billable_rates' ? 'user_billable_rates' : 'user_cost_rates'

const rateStageProgress = async (
  database: RawDatabase,
  resource: RateResource,
): Promise<RateStageProgress | null> =>
  first<RateStageProgress>(
    database,
    `SELECT snapshot_sha256 AS snapshotSha256, source_byte_offset AS sourceByteOffset,
      source_lineage_byte_offset AS sourceLineageByteOffset,
      staged_rows AS stagedRows, loaded_rows AS loadedRows, cleaned_rows AS cleanedRows,
      last_user_harvest_id AS lastUserHarvestId,
      last_sort_start_date AS lastSortStartDate, last_harvest_id AS lastHarvestId
    FROM _ezacto_load_rate_progress WHERE resource = ?`,
    [resource],
  )

const rateStageProgressStatement = (
  resource: RateResource,
  digest: string,
  sourceByteOffset: number,
  sourceLineageByteOffset: number,
  stagedRows: number,
  loadedRows: number,
  cleanedRows: number,
  lastUserHarvestId: number | null,
  lastSortStartDate: string | null,
  lastHarvestId: number | null,
): PlannedStatement => ({
  sql: `INSERT INTO _ezacto_load_rate_progress (
      resource, snapshot_sha256, source_byte_offset, source_lineage_byte_offset,
      staged_rows, loaded_rows, cleaned_rows,
      last_user_harvest_id, last_sort_start_date, last_harvest_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(resource) DO UPDATE SET
      source_byte_offset = excluded.source_byte_offset,
      source_lineage_byte_offset = excluded.source_lineage_byte_offset,
      staged_rows = excluded.staged_rows,
      loaded_rows = excluded.loaded_rows,
      cleaned_rows = excluded.cleaned_rows,
      last_user_harvest_id = excluded.last_user_harvest_id,
      last_sort_start_date = excluded.last_sort_start_date,
      last_harvest_id = excluded.last_harvest_id
    WHERE _ezacto_load_rate_progress.snapshot_sha256 = excluded.snapshot_sha256`,
  bindings: [
    resource,
    digest,
    sourceByteOffset,
    sourceLineageByteOffset,
    stagedRows,
    loadedRows,
    cleanedRows,
    lastUserHarvestId,
    lastSortStartDate,
    lastHarvestId,
  ],
})

const dayBefore = (value: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`rate start_date ${value} is invalid`)
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(milliseconds)) throw new Error(`rate start_date ${value} is invalid`)
  return new Date(milliseconds - 86_400_000).toISOString().slice(0, 10)
}

const stagedRates = async (
  database: RawDatabase,
  resource: RateResource,
  cursor: Pick<RateStageProgress, 'lastUserHarvestId' | 'lastSortStartDate' | 'lastHarvestId'>,
  limit: number,
): Promise<StagedRate[]> => {
  const table = rateStageTable(resource)
  const columns = `harvest_id AS harvestId, user_harvest_id AS userHarvestId,
    amount_cents AS amountCents, start_date AS startDate,
    sort_start_date AS sortStartDate, source_end_date AS sourceEndDate,
    created_at AS createdAt, updated_at AS updatedAt`
  if (cursor.lastUserHarvestId === null) {
    return all<StagedRate>(
      database,
      `SELECT ${columns} FROM ${table}
       ORDER BY user_harvest_id, sort_start_date, harvest_id LIMIT ?`,
      [limit],
    )
  }
  return all<StagedRate>(
    database,
    `SELECT ${columns} FROM ${table}
     WHERE (user_harvest_id, sort_start_date, harvest_id) > (?, ?, ?)
     ORDER BY user_harvest_id, sort_start_date, harvest_id LIMIT ?`,
    [cursor.lastUserHarvestId, cursor.lastSortStartDate, cursor.lastHarvestId, limit],
  )
}

const loadRateChunk = async (
  options: LoadNextChunkOptions,
  resource: RateResource,
  digest: string,
  loadOptionsJson: string,
  timestamp: string,
  total: number,
  maxStatements: number,
): Promise<LoadChunkResult> => {
  const identity = resolveUserIdentity(options.userIdentity)
  const prior = await rateStageProgress(options.database.$client, resource)
  if (prior !== null && prior.snapshotSha256 !== digest) {
    throw new Error(`${resource} staging progress belongs to a different snapshot`)
  }
  const stage =
    prior ??
    ({
      snapshotSha256: digest,
      sourceByteOffset: 0,
      sourceLineageByteOffset: 0,
      stagedRows: 0,
      loadedRows: 0,
      cleanedRows: 0,
      lastUserHarvestId: null,
      lastSortStartDate: null,
      lastHarvestId: null,
    } satisfies RateStageProgress)
  if (stage.stagedRows < total) {
    // Harvest does not promise chronological rate history. Stage source-order
    // windows durably, then let this indexed table provide a keyset-ordered
    // stream; no invocation retains or re-sorts a whole user's history.
    const limit = Math.min(options.maxRows ?? 100, maxStatements - 1, total - stage.stagedRows)
    if (limit < 1) throw new Error(`${resource} has no staging statement budget`)
    const chunk = await rawChunkFrom(
      options.snapshotDir,
      resource,
      stage.sourceByteOffset,
      stage.stagedRows,
      limit,
    )
    if (chunk.rows.length === 0) throw new Error(`${resource} ended before manifest count ${total}`)
    const lineage = await sequentialLineageChunk(
      options.snapshotDir,
      resource,
      stage.sourceLineageByteOffset,
      chunk.rows.length,
    )
    const table = rateStageTable(resource)
    const statements = chunk.rows.map((source, index) => {
      const witness = lineage.rows[index]
      const harvestId = safeIntegerAt(source, '/id', `${resource}.id`)
      if (witness?.source_id !== harvestId) throw new Error(`${resource} lineage is misaligned`)
      const startDate = stringValue(source.row, 'start_date')
      return insertByHarvestId(
        table,
        [
          'harvest_id',
          'source_row_index',
          'user_harvest_id',
          'amount_cents',
          'start_date',
          'sort_start_date',
          'source_end_date',
          'created_at',
          'updated_at',
        ],
        [
          harvestId,
          source.index,
          // Staged under the survivor so a squashed pair's histories interleave
          // into one chain here, rather than two chains that each derive an
          // open-ended end date for the same person.
          canonicalUser(identity, witness.parent_id),
          moneyLiteralToCents(numberAt(source, '/amount'), `${resource}.amount`),
          startDate,
          startDate ?? '',
          stringValue(source.row, 'end_date'),
          requiredText(source.row, 'created_at'),
          requiredText(source.row, 'updated_at'),
        ],
        harvestId,
      )
    })
    statements.push(
      rateStageProgressStatement(
        resource,
        digest,
        chunk.nextByteOffset,
        lineage.nextByteOffset,
        stage.stagedRows + chunk.rows.length,
        stage.loadedRows,
        stage.cleanedRows,
        stage.lastUserHarvestId,
        stage.lastSortStartDate,
        stage.lastHarvestId,
      ),
    )
    await execute(options.database.$client, statements)
    return {
      complete: false,
      resource,
      loadedRows: 0,
      statements: statements.length,
      snapshotSha256: digest,
      anomalies: [],
    }
  }

  if (stage.loadedRows === total) {
    if (stage.cleanedRows < total) {
      const cleanupLimit = Math.min(
        options.maxRows ?? 100,
        RATE_CLEANUP_ROWS_PER_INVOCATION,
        total - stage.cleanedRows,
      )
      if (cleanupLimit < 1) throw new Error(`${resource} has no cleanup row budget`)
      const cleanedRows = stage.cleanedRows + cleanupLimit
      const statements = [
        {
          sql: `DELETE FROM ${rateStageTable(resource)}
            WHERE source_row_index >= ? AND source_row_index < ?`,
          bindings: [stage.cleanedRows, cleanedRows],
        },
        rateStageProgressStatement(
          resource,
          digest,
          stage.sourceByteOffset,
          stage.sourceLineageByteOffset,
          stage.stagedRows,
          stage.loadedRows,
          cleanedRows,
          stage.lastUserHarvestId,
          stage.lastSortStartDate,
          stage.lastHarvestId,
        ),
      ]
      await execute(options.database.$client, statements)
      return {
        complete: false,
        resource,
        loadedRows: 0,
        statements: statements.length,
        snapshotSha256: digest,
        anomalies: [],
      }
    }
    const statements = [
      { sql: 'DELETE FROM _ezacto_load_rate_progress WHERE resource = ?', bindings: [resource] },
      progressStatement(
        resource,
        digest,
        loadOptionsJson,
        stage.sourceByteOffset,
        total,
        total,
        true,
        timestamp,
      ),
    ]
    await execute(options.database.$client, statements)
    return {
      complete: false,
      resource,
      loadedRows: 0,
      statements: statements.length,
      snapshotSha256: digest,
      anomalies: [],
    }
  }

  const capacity = Math.floor((maxStatements - 3) / 2)
  if (capacity < 1) throw new Error(`${resource} has no load statement budget`)
  const take = Math.min(options.maxRows ?? 100, capacity, total - stage.loadedRows)
  // A merged pair can hold two rates that start on the same day, which one
  // chain cannot: `UNIQUE (user_id, start_date)` refuses the second and the
  // chronological trigger refuses it again. Read far enough past the window to
  // see such a run whole, so the rate that keeps the date still derives its end
  // from the next real one.
  const runLength = Math.max(0, ...[...identity.duplicatesOf.values()].map((of) => of.length))
  const ordered = await stagedRates(options.database.$client, resource, stage, take + 1 + runLength)
  const selected = ordered.slice(0, take)
  if (selected.length === 0) {
    throw new Error(`${resource} staging ended before manifest count ${total}`)
  }
  const anomalies: LoadAnomaly[] = []
  const target = rateTargetTable(resource)
  const statements: PlannedStatement[] = []
  let previous: Pick<StagedRate, 'userHarvestId' | 'sortStartDate'> | null =
    stage.lastUserHarvestId === null
      ? null
      : { userHarvestId: stage.lastUserHarvestId, sortStartDate: stage.lastSortStartDate ?? '' }
  for (const [index, rate] of selected.entries()) {
    const sharesDate =
      previous !== null &&
      previous.userHarvestId === rate.userHarvestId &&
      previous.sortStartDate === rate.sortStartDate
    previous = rate
    // Only a survivor can reach this, and only because two accounts were paid
    // from the same date. The keyset order puts the older Harvest record first
    // and it keeps the date; the other is recorded rather than loaded, because
    // inserting it aborts the load and every resume re-plans the same abort.
    if (sharesDate && identity.duplicatesOf.has(rate.userHarvestId)) {
      anomalies.push({
        resource,
        source_id: rate.harvestId,
        kind: 'duplicate_row_merged',
        detail: `harvest user ${rate.userHarvestId} already starts a rate on ${rate.startDate ?? 'no date'}; ${rate.amountCents} cents dropped`,
      })
      continue
    }
    const next = ordered
      .slice(index + 1)
      .find(
        (candidate) =>
          candidate.userHarvestId !== rate.userHarvestId ||
          candidate.sortStartDate !== rate.sortStartDate,
      )
    const expectedEndDate =
      next?.userHarvestId === rate.userHarvestId && next.startDate !== null
        ? dayBefore(next.startDate)
        : null
    if (rate.sourceEndDate !== expectedEndDate) {
      anomalies.push({
        resource,
        source_id: rate.harvestId,
        kind: 'rate_chain_mismatch',
        detail: `source end_date=${rate.sourceEndDate ?? 'null'}; derived end_date=${expectedEndDate ?? 'null'}`,
      })
    }
    statements.push(
      insertByHarvestId(
        target,
        ['harvest_id', 'user_id', 'amount_cents', 'start_date', 'created_at', 'updated_at'],
        [
          rate.harvestId,
          idFrom('users', rate.userHarvestId),
          rate.amountCents,
          rate.startDate,
          rate.createdAt,
          rate.updatedAt,
        ],
        rate.harvestId,
      ),
    )
  }
  const last = selected[selected.length - 1]!
  const loaded = stage.loadedRows + selected.length
  statements.push(...anomalyStatements(digest, anomalies))
  statements.push(
    rateStageProgressStatement(
      resource,
      digest,
      stage.sourceByteOffset,
      stage.sourceLineageByteOffset,
      stage.stagedRows,
      loaded,
      stage.cleanedRows,
      last.userHarvestId,
      last.sortStartDate,
      last.harvestId,
    ),
  )
  statements.push(
    progressStatement(
      resource,
      digest,
      loadOptionsJson,
      stage.sourceByteOffset,
      loaded,
      total,
      false,
      timestamp,
    ),
  )
  await execute(options.database.$client, statements)
  return {
    complete: false,
    resource,
    loadedRows: selected.length,
    statements: statements.length,
    snapshotSha256: digest,
    anomalies,
  }
}

const rowStatements = (
  resource: Exclude<
    LoadResource,
    'organization' | 'billable_rates' | 'cost_rates' | 'estimates' | 'invoices' | 'expenses'
  >,
  source: RawRow,
  manifest: Manifest,
  identity: ResolvedUserIdentity,
  anomalies: LoadAnomaly[],
  lineage?: ChildLineage,
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
      const userHarvestId = safeIntegerAt(source, '/id', 'users.id')
      const survivor = identity.canonicalOf.get(userHarvestId)
      if (survivor !== undefined) {
        // The duplicate leaves no record behind: every reference to it was
        // redirected at resolution, and its address is adopted by the survivor
        // while that row is planned. Sixty source users become fifty-eight,
        // which the reconciliation report has to be able to account for.
        anomalies.push({
          resource: 'users',
          source_id: harvestId,
          kind: 'duplicate_user_squashed',
          detail: `squashed into harvest user ${survivor}`,
        })
        return []
      }
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
        // The Harvest address stays primary. It is the one that matches the
        // payroll and payment accounts, so a seeded work address joins it
        // rather than replacing it.
        userEmailStatement(userHarvestId, email, true, createdAt, updatedAt),
        ...(identity.workEmails.get(userHarvestId) ?? []).map((address) =>
          userEmailStatement(userHarvestId, address, false, createdAt, updatedAt),
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
            bindings: [createdAt, updatedAt, canonicalUser(identity, userId), harvestId],
          })
        }
      }
      return statements
    }
    case 'teammates': {
      if (!lineage || lineage.source_id !== harvestId)
        throw new Error('teammates lineage is misaligned')
      const manager = canonicalUser(identity, lineage.parent_id)
      const teammate = canonicalUser(identity, lineage.source_id)
      return [
        // A manager who lists both halves of a squashed pair, or who is one
        // half of it, loses a row here to the guards below. Say which, or the
        // reconciliation report reads a source teammate row as unaccounted for.
        ...(mergedUser(identity, lineage.parent_id) || mergedUser(identity, lineage.source_id)
          ? [
              conditionalAnomalyStatement(
                {
                  resource: 'teammates',
                  source_id: lineage.source_id,
                  kind: 'duplicate_row_merged',
                  detail: `teammate of harvest user ${lineage.parent_id} merged into harvest user ${manager}'s teammate ${teammate}`,
                },
                expression(
                  `EXISTS (SELECT 1 FROM users manager, users teammate
                    WHERE manager.harvest_id = ? AND teammate.harvest_id = ?
                      AND (manager.id = teammate.id
                        OR EXISTS (SELECT 1 FROM teammate_assignments existing
                          WHERE existing.manager_id = manager.id
                            AND existing.user_id = teammate.id)))`,
                  manager,
                  teammate,
                ),
              ),
            ]
          : []),
        {
          sql: `INSERT INTO teammate_assignments (manager_id, user_id, created_at, updated_at)
          SELECT manager.id, teammate.id, ?, ? FROM users manager, users teammate
          WHERE manager.harvest_id = ? AND teammate.harvest_id = ?
            AND manager.id <> teammate.id
            AND NOT EXISTS (SELECT 1 FROM teammate_assignments existing
              WHERE existing.manager_id = manager.id AND existing.user_id = teammate.id)`,
          // Squashing a manager's second account into the manager would make
          // them their own teammate, which the table forbids outright.
          bindings: [createdAt, updatedAt, manager, teammate],
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
            nullableRate(source, '/unit_price', anomalies, 'expense_categories'),
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
    case 'user_assignments': {
      const projectHarvestId = nestedId(row, 'project')!
      const userHarvestId = nestedId(row, 'user')!
      const insert = insertByHarvestId(
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
          idFrom('projects', projectHarvestId),
          idFrom('users', canonicalUser(identity, userHarvestId)),
          bool(row, 'is_active', true) ? 1 : 0,
          bool(row, 'is_project_manager') ? 1 : 0,
          bool(row, 'use_default_rates', true) ? 1 : 0,
          money(source, '/hourly_rate'),
          seconds(source, '/budget', anomalies, resource),
          createdAt,
          updatedAt,
        ],
        harvestId,
      )
      if (!mergedUser(identity, userHarvestId)) return [insert]
      // Both halves of a pair are ordinarily assigned to the same project, and
      // the survivor can hold one assignment there — `UNIQUE (project_id,
      // user_id)`. Two accounts, one assignment: the first the source lists
      // wins and the second merges into it, decided here rather than in the
      // planner because only the statement stream knows what has landed. The
      // alternative is the abort that leaves a half-loaded database no resume
      // can get past, since every retry re-plans the same colliding insert.
      return [
        standalone(
          insert,
          `NOT EXISTS (SELECT 1 FROM user_assignments held
        WHERE held.project_id = incoming.column2 AND held.user_id = incoming.column3)`,
        ),
        conditionalAnomalyStatement(
          {
            resource: 'user_assignments',
            source_id: harvestId,
            kind: 'duplicate_row_merged',
            detail: `merged into the assignment harvest user ${canonicalUser(identity, userHarvestId)} holds on project ${projectHarvestId}`,
          },
          expression(`NOT EXISTS (SELECT 1 FROM user_assignments WHERE harvest_id = ?)`, harvestId),
        ),
      ]
    }
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
      if (!isRunningEntry(row) && secondsWithoutTimer !== rawSeconds) {
        throw new Error('stopped time entry hours_without_timer must equal hours')
      }
      const entryProjectId = nestedId(row, 'project')!
      const entryUserId = nestedId(row, 'user')!
      const merged = mergedUser(identity, entryUserId)
      // Where a pair merged, which of their two assignment ids survives on a
      // shared project depends on the order the source lists them in, and the
      // composite foreign key wants the assignment for *this* entry's project
      // and user anyway. Ask for that instead of for an id that may have
      // yielded; `UNIQUE (project_id, user_id)` makes it the same row.
      const userAssignment = merged
        ? expression(
            `(SELECT held.id FROM user_assignments held
            WHERE held.project_id = (SELECT id FROM projects WHERE harvest_id = ?)
              AND held.user_id = (SELECT id FROM users WHERE harvest_id = ?))`,
            entryProjectId,
            canonicalUser(identity, entryUserId),
          )
        : idFrom('user_assignments', nestedId(row, 'user_assignment')!)
      const entry = insertByHarvestId(
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
          'source_approval_status',
        ],
        [
          harvestId,
          idFrom('users', canonicalUser(identity, entryUserId)),
          idFrom('projects', entryProjectId),
          idFrom('tasks', nestedId(row, 'task')!),
          userAssignment,
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
          nestedId(row, 'invoice') === null ? null : idFrom('invoices', nestedId(row, 'invoice')!),
          'unsubmitted',
          stringValue(row, 'approval_status', 'unsubmitted'),
        ],
        harvestId,
      )
      return [merged ? standalone(entry) : entry]
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

/**
 * Resolve a reference that may point at a resource the snapshot never swept.
 * An account with the estimates module disabled still has invoices carrying an
 * `estimate.id`; there is nothing to link to and nothing to recover, so the
 * link is dropped rather than aborting an otherwise faithful invoice.
 */
const optionalNativeId = async (
  database: RawDatabase,
  table: string,
  harvestId: number | string,
): Promise<number | null> => {
  const row = await first<{ id: number }>(
    database,
    `SELECT id FROM ${table} WHERE harvest_id = ?`,
    [harvestId],
  )
  return row === null ? null : row.id
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
  identity: ResolvedUserIdentity,
  anomalies: LoadAnomaly[],
  lineOffset = 0,
  lineLimit = Number.POSITIVE_INFINITY,
): PlannedStatement[] => {
  const row = source.row
  const harvestId = safeIntegerAt(source, '/id', 'estimates.id')
  const clientId = nestedId(row, 'client')
  if (clientId === null) throw new Error(`estimate ${harvestId} has no client`)
  const creator = objectValue(row, 'creator')
  const creatorId = identifiedReference(creator) ? nestedId({ creator }, 'creator') : null
  const creatorName = creator === null ? null : stringValue(creator, 'name')
  // Harvest scrubs the name of a deleted user but keeps the creator id, so
  // `{id, name: null}` is real provenance, not a half-written record — one
  // departed user raised a great many invoices this way. Keep the id; only
  // a name with nothing to anchor it to is incoherent.
  if (creatorId === null && creatorName !== null) {
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
    creatorId === null ? null : idFrom('users', canonicalUser(identity, creatorId)),
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
    const unitPrice = rate(
      source,
      `/line_items/${position}/unit_price`,
      anomalies,
      'estimates',
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
  for (const [index, witness] of lineage.rows.entries()) {
    if (witness.source_id !== safeIntegerAt(chunk.rows[index]!, '/id', `${resource}.id`)) {
      throw new Error(`${resource} child index disagrees with aligned source lineage`)
    }
  }
  return {
    rows: chunk.rows,
    lineage: lineage.rows,
  }
}

const resolveOptionalEstimate = async (
  database: ImportDatabase,
  estimateHarvestId: number,
  invoiceHarvestId: number,
  anomalies: LoadAnomaly[],
): Promise<number | null> => {
  const resolved = await optionalNativeId(database.$client, 'estimates', estimateHarvestId)
  if (resolved === null) {
    anomalies.push({
      resource: 'invoices',
      source_id: invoiceHarvestId,
      kind: 'unresolved_estimate_reference',
      detail: `estimate=${estimateHarvestId} was not swept`,
    })
  }
  return resolved
}

const invoiceInput = async (
  database: ImportDatabase,
  source: RawRow,
  messages: readonly RawRow[],
  messageLineage: readonly ChildLineage[],
  payments: readonly RawRow[],
  paymentLineage: readonly ChildLineage[],
  identity: ResolvedUserIdentity,
  anomalies: LoadAnomaly[],
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
  const sourceCreatorId = identifiedReference(creator) ? nestedId({ creator }, 'creator') : null
  const sourceCreatorName = creator === null ? null : stringValue(creator, 'name')
  // Harvest scrubs the name of a deleted user but keeps the creator id, so
  // `{id, name: null}` is real provenance, not a half-written record — one
  // departed user raised a great many invoices this way. Keep the id; only
  // a name with nothing to anchor it to is incoherent.
  if (sourceCreatorId === null && sourceCreatorName !== null) {
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
          canonicalUser(identity, sourceCreatorId),
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
    rateLiteralToCents(
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
        : await resolveOptionalEstimate(database, estimateHarvestId, harvestId, anomalies),
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
      unitPriceCents: rate(
        source,
        `/line_items/${position}/unit_price`,
        anomalies,
        'invoices',
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
    const gatewayIdentified = identifiedReference(gateway)
    const recordedByEmail = stringValue(p, 'recorded_by_email')
    // A receipt is signed. Harvest closes a $0 invoice with a $0 payment and a
    // credit note with a negative one, and invoice_payments.amount_cents now
    // holds both — skipping them restated the seven invoices they settled as
    // open, because state is derived from the payments that load (#283).
    const paymentAmountCents = moneyLiteralToCents(
      numberAt(payment, '/amount'),
      'invoice_payment.amount',
    )
    importedPayments.push({
      harvestId: paymentId,
      amountCents: paymentAmountCents,
      sourcePaidAt: paidAt,
      sourcePaidDate: paidDate,
      sourceRecordedByName: stringValue(p, 'recorded_by'),
      sourceRecordedByEmail: recordedByEmail,
      sourceGatewayId: gatewayIdentified ? nestedId({ gateway }, 'gateway') : null,
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

interface CurrencyInferenceProgress {
  snapshotSha256: string
  sourceByteOffset: number
  rowsScanned: number
  currency: string | null
  completed: number
}

const currencyInferenceProgress = async (
  database: RawDatabase,
): Promise<CurrencyInferenceProgress | null> =>
  first<CurrencyInferenceProgress>(
    database,
    `SELECT snapshot_sha256 AS snapshotSha256, source_byte_offset AS sourceByteOffset,
      rows_scanned AS rowsScanned, currency, completed
     FROM _ezacto_load_currency_progress WHERE singleton = 1`,
  )

const currencyInferenceStatement = (
  digest: string,
  sourceByteOffset: number,
  rowsScanned: number,
  currency: string | null,
  completed: boolean,
): PlannedStatement => ({
  sql: `INSERT INTO _ezacto_load_currency_progress
    (singleton, snapshot_sha256, source_byte_offset, rows_scanned, currency, completed)
    VALUES (1, ?, ?, ?, ?, ?)
    ON CONFLICT(singleton) DO UPDATE SET
      source_byte_offset = excluded.source_byte_offset,
      rows_scanned = excluded.rows_scanned,
      currency = excluded.currency,
      completed = excluded.completed
    WHERE _ezacto_load_currency_progress.snapshot_sha256 = excluded.snapshot_sha256`,
  bindings: [digest, sourceByteOffset, rowsScanned, currency, completed ? 1 : 0],
})

const resolveOrganizationCurrency = async (
  database: RawDatabase,
  snapshotDir: string,
  manifest: Manifest,
  digest: string,
  override: string | undefined,
): Promise<string | null> => {
  if (override) return override.toUpperCase()
  if (manifest.preflight.organization_currency)
    return manifest.preflight.organization_currency.toUpperCase()
  const total = manifest.resources.clients?.count ?? 0
  if (total === 0) {
    throw new Error(
      'Harvest Company omits organization currency; pass --organization-currency (there are no client currencies to infer)',
    )
  }
  const prior = await currencyInferenceProgress(database)
  if (prior !== null && prior.snapshotSha256 !== digest) {
    throw new Error('organization currency inference belongs to a different snapshot')
  }
  if (prior?.completed === 1) {
    if (prior.currency === null)
      throw new Error('completed organization currency inference is empty')
    return prior.currency
  }
  const rowsScanned = prior?.rowsScanned ?? 0
  const sourceByteOffset = prior?.sourceByteOffset ?? 0
  if (rowsScanned > total) throw new Error('organization currency inference exceeds client count')
  const chunk = await rawChunkFrom(
    snapshotDir,
    'clients',
    sourceByteOffset,
    rowsScanned,
    Math.min(100, total - rowsScanned),
  )
  if (chunk.rows.length === 0 && rowsScanned < total) {
    throw new Error(`clients ended before manifest count ${total}`)
  }
  let currency = prior?.currency ?? null
  for (const source of chunk.rows) {
    const candidate = stringValue(source.row, 'currency')?.toUpperCase() ?? null
    if (candidate === null) continue
    if (currency !== null && candidate !== currency) {
      throw new Error(
        'Harvest Company omits organization currency; pass --organization-currency (client currencies are absent or mixed)',
      )
    }
    currency = candidate
  }
  const scanned = rowsScanned + chunk.rows.length
  const complete = scanned === total
  if (complete && currency === null) {
    throw new Error(
      'Harvest Company omits organization currency; pass --organization-currency (client currencies are absent or mixed)',
    )
  }
  await execute(database, [
    currencyInferenceStatement(digest, chunk.nextByteOffset, scanned, currency, complete),
  ])
  return complete ? currency : null
}

const organizationStatement = async (
  manifest: Manifest,
  options: LoadNextChunkOptions,
  currency: string,
): Promise<PlannedStatement> => {
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

interface SnapshotAdmission {
  snapshotSha256: string
  indexingComplete: boolean
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
): Promise<SnapshotAdmission> => {
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
      processAdmissions.set(options.database.$client, expectedDigest)
    }
    return {
      snapshotSha256: existing.snapshotSha256,
      indexingComplete: await withChildIndexLock(options.snapshotDir, () =>
        advanceChildIndexes(
          options.snapshotDir,
          manifest,
          expectedDigest,
          CHILD_INDEX_WORK_ROWS_PER_INVOCATION,
        ),
      ),
    }
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
  processAdmissions.set(options.database.$client, actualDigest)
  const indexingComplete = await withChildIndexLock(options.snapshotDir, () =>
    advanceChildIndexes(
      options.snapshotDir,
      manifest,
      actualDigest,
      CHILD_INDEX_WORK_ROWS_PER_INVOCATION,
    ),
  )
  if (!indexingComplete) return { snapshotSha256: actualDigest, indexingComplete: false }
  await execute(options.database.$client, [
    {
      sql: `INSERT INTO _ezacto_load_admission
      (singleton, snapshot_sha256, manifest_sha256, load_options_json, admitted_at)
      SELECT 1, ?, ?, ?, ? WHERE NOT EXISTS (
        SELECT 1 FROM _ezacto_load_admission WHERE singleton = 1)`,
      bindings: [actualDigest, manifestSha256, loadOptionsJson, timestamp],
    },
    {
      sql: 'DELETE FROM _ezacto_load_currency_progress WHERE singleton = 1',
      bindings: [],
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
  return { snapshotSha256: actualDigest, indexingComplete: true }
}

const loadExpense = async (
  options: LoadNextChunkOptions,
  source: RawRow,
  anomalies: LoadAnomaly[],
): Promise<number> => {
  const { database, snapshotDir } = options
  const identity = resolveUserIdentity(options.userIdentity)
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
        'source_approval_status',
        'invoice_id',
        'created_at',
        'updated_at',
      ],
      [
        harvestId,
        idFrom('users', canonicalUser(identity, nestedId(row, 'user')!)),
        idFrom('projects', nestedId(row, 'project')!),
        idFrom('expense_categories', nestedId(row, 'expense_category')!),
        requiredText(row, 'spent_date'),
        stringValue(row, 'notes'),
        units,
        moneyLiteralToCents(numberAt(source, '/total_cost'), 'expense.total_cost'),
        bool(row, 'billable', true) ? 1 : 0,
        'unsubmitted',
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
  const identity = resolveUserIdentity(options.userIdentity)
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
        ...estimateStatements(source, [], [], identity, anomalies, aggregateOffset, take),
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
        ...estimateStatements(source, [], [], identity, anomalies, 0, 0),
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
      ...estimateStatements(source, childChunk.rows, childLineage.rows, identity, anomalies, 0, 0),
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
    identity,
    anomalies,
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
    // State is derived from the payments that loaded, so a payment this import
    // could not represent silently restates a settled invoice as outstanding.
    // The importer already raises this; dropping it here is what let settled
    // invoices read `open` against Harvest's `paid` unnoticed.
    if (diagnostic.code === 'source_state_disagrees')
      anomalies.push({
        resource: 'invoices',
        source_id: parentId,
        kind: 'invoice_state_disagreement',
        detail: `Harvest state ${diagnostic.source_state} but ezacto derives ${diagnostic.derived_state}`,
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
  const identity = resolveUserIdentity(options.userIdentity)
  const priorAdmission = await first<{ loadOptionsJson: string }>(
    options.database.$client,
    `SELECT load_options_json AS loadOptionsJson FROM _ezacto_load_admission WHERE singleton = 1`,
  )
  let loadOptionsJson: string
  if (priorAdmission !== null) {
    const persisted = JSON.parse(priorAdmission.loadOptionsJson) as {
      organization_currency: string
      organization_address: string | null
      user_identity?: unknown
    }
    const requestedCurrency =
      options.organizationCurrency?.toUpperCase() ??
      manifest.preflight.organization_currency?.toUpperCase()
    const requestedAddress = options.organizationAddress ?? manifest.preflight.organization_address
    // Resuming with a different identity map would leave the rows loaded so far
    // pointing at accounts the rest of the load has squashed away.
    if (
      (requestedCurrency !== undefined && requestedCurrency !== persisted.organization_currency) ||
      requestedAddress !== persisted.organization_address ||
      canonicalJson(persisted.user_identity) !== identity.json
    ) {
      throw new Error('load admission belongs to different snapshot load options')
    }
    loadOptionsJson = priorAdmission.loadOptionsJson
  } else {
    await assertIdentityInSnapshot(options.snapshotDir, manifest, identity)
    const expectedDigest = await checksumDigest(options.snapshotDir)
    if (isD1(options.database.$client) && options.immutableSnapshotSha256 !== expectedDigest) {
      throw new Error('D1 load requires immutableSnapshotSha256 matching checksums.json')
    }
    const organizationCurrency = await resolveOrganizationCurrency(
      options.database.$client,
      options.snapshotDir,
      manifest,
      expectedDigest,
      options.organizationCurrency,
    )
    if (organizationCurrency === null) {
      return {
        complete: false,
        resource: null,
        loadedRows: 0,
        statements: 1,
        snapshotSha256: expectedDigest,
        anomalies: [],
      }
    }
    loadOptionsJson = JSON.stringify({
      organization_currency: organizationCurrency,
      organization_address: options.organizationAddress ?? manifest.preflight.organization_address,
      ...(identity.json === null
        ? {}
        : { user_identity: JSON.parse(identity.json) as UserIdentityInput }),
    })
  }
  const admission = await admitSnapshot(options, manifest, loadOptionsJson, timestamp)
  const digest = admission.snapshotSha256
  if (!admission.indexingComplete) {
    return {
      complete: false,
      resource: null,
      loadedRows: 0,
      statements: 0,
      snapshotSha256: digest,
      anomalies: [],
    }
  }
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
    if (resource === 'billable_rates' || resource === 'cost_rates') {
      return loadRateChunk(
        options,
        resource,
        digest,
        loadOptionsJson,
        timestamp,
        total,
        maxStatements,
      )
    }
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
      const persistedOptions = JSON.parse(loadOptionsJson) as { organization_currency: string }
      const statement = await organizationStatement(
        manifest,
        options,
        persistedOptions.organization_currency,
      )
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
      // The owner row anchors the organization, so it cannot be the half of a
      // pair that gets squashed away; say so here rather than fail on the
      // owner foreign key several resources later.
      if (identity.canonicalOf.has(manifest.preflight.user.id)) {
        throw new Error(
          `authenticated Harvest user ${manifest.preflight.user.id} cannot be squashed into another account`,
        )
      }
      const ownerStatements = [
        ...rowStatements('users', owner, manifest, identity, anomalies),
        ...(await squashedEmailStatements(
          options.snapshotDir,
          manifest,
          identity,
          manifest.preflight.user.id,
        )),
      ]
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
    const step = RESOURCES.find((item) => item.name === resource)
    let childCursor: LineageProgress | null = null
    if (step?.kind === 'child') {
      childCursor = await lineageProgress(options.database.$client, resource)
      if (childCursor !== null && childCursor.snapshotSha256 !== digest) {
        throw new Error(`${resource} lineage progress belongs to a different snapshot`)
      }
      const rowsScanned = childCursor?.rowsScanned ?? 0
      if (rowsScanned > offset) {
        throw new Error(`${resource} lineage progress is ahead of source progress`)
      }
      if (rowsScanned < offset) {
        const take = Math.min(LINEAGE_RECOVERY_ROWS_PER_INVOCATION, offset - rowsScanned)
        const nextByteOffset = await advanceLineageCursor(
          options.snapshotDir,
          resource,
          digest,
          rowsScanned,
          childCursor?.byteOffset ?? 0,
          take,
        )
        await execute(options.database.$client, [
          lineageProgressStatement(resource, digest, nextByteOffset, rowsScanned + take),
        ])
        return {
          complete: false,
          resource,
          loadedRows: 0,
          statements: 1,
          snapshotSha256: digest,
          anomalies,
        }
      }
    }
    const complex = resource === 'estimates' || resource === 'invoices' || resource === 'expenses'
    const checkpointStatements = step?.kind === 'child' ? 2 : 1
    const limit =
      complex || resource === 'roles'
        ? 1
        : Math.min(options.maxRows ?? 100, maxStatements - checkpointStatements, total - offset)
    if (limit < 1) throw new Error(`${resource} row exceeds the invocation statement budget`)
    const sourceChunk = await rawChunkFrom(
      options.snapshotDir,
      resource,
      prior?.sourceByteOffset ?? 0,
      offset,
      limit,
    )
    const rows = sourceChunk.rows
    if (rows.length === 0) throw new Error(`${resource} ended before manifest count ${total}`)
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
        identity,
        anomalies,
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
    const lineage =
      step && 'parent' in step
        ? await lineageFor(
            options.snapshotDir,
            resource,
            digest,
            offset,
            childCursor?.byteOffset ?? 0,
            rows,
          )
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
        identity,
        anomalies,
        lineage?.rows[index],
        taskBudgetBy,
      )
      if (resource === 'users') {
        planned.push(
          ...(await squashedEmailStatements(
            options.snapshotDir,
            manifest,
            identity,
            safeIntegerAt(row, '/id', 'users.id'),
          )),
        )
      }
      if (
        statements.length + planned.length + anomalies.length + checkpointStatements >
        maxStatements
      ) {
        anomalies.splice(anomalyCount)
        break
      }
      statements.push(...planned)
      consumed++
    }
    if (consumed === 0) throw new Error(`${resource} row exceeds the invocation statement budget`)
    const loaded = offset + consumed
    const sourceByteOffset = rows[consumed - 1]!.endByteOffset
    const lineageByteOffset = lineage?.endByteOffsets[consumed - 1] ?? 0
    statements.push(...anomalyStatements(digest, anomalies))
    if (lineage) {
      statements.push(lineageProgressStatement(resource, digest, lineageByteOffset, loaded))
    }
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
