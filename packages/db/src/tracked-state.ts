import {
  assertTrackedMutationAllowed,
  deriveTrackedState,
  type ApprovalStatus,
  type TrackedState,
  type TrackedStateFacts,
} from '@ezacto/core'
import type BetterSqlite3 from 'better-sqlite3'
import { sql, type SQL } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import { clients, expenses, projects, tasks, timeEntries } from './schema.js'

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>
type NativeClient = BetterSqlite3.Database | D1Database

export type TrackedEntityType = 'time_entry' | 'expense'

export interface TrackedEntityReference {
  entityType: TrackedEntityType
  entityId: number
  /** Already computed by the policy subsystem; required so callers cannot silently omit it. */
  policyLocked: boolean
}

/**
 * Describes the running entry that a start/restart trigger would stop. The
 * reference is optional by nature: no matching running entry means no guard
 * subject and therefore no policy lock to apply.
 */
export interface RunningTimeEntryReplacementReference {
  entityType: 'running_time_entry_replacement'
  userId: number
  /** Policy fact for the current running entry, if one exists. */
  policyLocked: boolean
}

export type TrackedMutationReference = TrackedEntityReference | RunningTimeEntryReplacementReference

interface TrackedStateFactRow {
  approval_status: ApprovalStatus
  invoice_id: number | null
  client_active: number
  project_active: number
  task_active: number
}

interface CompiledQuery {
  sql: string
  params: unknown[]
}

interface CompilableQuery {
  toSQL(): CompiledQuery
}

interface AtomicResult {
  factRows: Array<TrackedStateFactRow | undefined>
  mutationRow: Record<string, unknown> | undefined
}

export class TrackedEntityNotFoundError extends Error {
  readonly code = 'tracked_entity_not_found' as const
  readonly entityType: TrackedEntityType
  readonly entityId: number

  constructor(reference: Pick<TrackedEntityReference, 'entityType' | 'entityId'>) {
    super(`${reference.entityType} ${reference.entityId} does not exist`)
    this.name = 'TrackedEntityNotFoundError'
    this.entityType = reference.entityType
    this.entityId = reference.entityId
  }
}

const assertBooleanPolicyFact = (policyLocked: boolean): void => {
  if (typeof policyLocked !== 'boolean') {
    throw new TypeError('policyLocked must be an already-computed boolean fact')
  }
}

const assertReference = (reference: TrackedMutationReference): void => {
  assertBooleanPolicyFact(reference.policyLocked)
  if (reference.entityType === 'running_time_entry_replacement') {
    if (!Number.isSafeInteger(reference.userId) || reference.userId <= 0) {
      throw new RangeError('running time-entry user id must be a positive safe integer')
    }
    return
  }
  if (!Number.isSafeInteger(reference.entityId) || reference.entityId <= 0) {
    throw new RangeError('tracked entity id must be a positive safe integer')
  }
}

const factsFromRow = (row: TrackedStateFactRow, policyLocked: boolean): TrackedStateFacts => ({
  approvalStatus: row.approval_status,
  invoiceId: row.invoice_id,
  policyLocked,
  clientArchived: row.client_active === 0,
  projectArchived: row.project_active === 0,
  taskArchived: row.task_active === 0,
})

const factsQuery = (reference: TrackedMutationReference): CompiledQuery => {
  assertReference(reference)
  if (reference.entityType === 'time_entry') {
    return {
      sql: `SELECT
              entry.approval_status,
              entry.invoice_id,
              client.is_active AS client_active,
              project.is_active AS project_active,
              task.is_active AS task_active
            FROM time_entries entry
            JOIN projects project ON project.id = entry.project_id
            JOIN clients client ON client.id = project.client_id
            JOIN tasks task ON task.id = entry.task_id
            WHERE entry.id = ?
            LIMIT 1`,
      params: [reference.entityId],
    }
  }
  if (reference.entityType === 'expense') {
    return {
      sql: `SELECT
              expense.approval_status,
              expense.invoice_id,
              client.is_active AS client_active,
              project.is_active AS project_active,
              1 AS task_active
            FROM expenses expense
            JOIN projects project ON project.id = expense.project_id
            JOIN clients client ON client.id = project.client_id
            WHERE expense.id = ?
            LIMIT 1`,
      params: [reference.entityId],
    }
  }
  const replacementReference = reference as RunningTimeEntryReplacementReference
  return {
    sql: `SELECT
            entry.approval_status,
            entry.invoice_id,
            client.is_active AS client_active,
            project.is_active AS project_active,
            task.is_active AS task_active
          FROM time_entries entry
          JOIN projects project ON project.id = entry.project_id
          JOIN clients client ON client.id = project.client_id
          JOIN tasks task ON task.id = entry.task_id
          WHERE entry.user_id = ?
            AND (
              entry.timer_started_at IS NOT NULL
              OR (entry.started_time IS NOT NULL AND entry.ended_time IS NULL)
            )
          LIMIT 1`,
    params: [replacementReference.userId],
  }
}

/**
 * The authorization half of a mutation lives in the same statement that
 * changes the row. Fact reads are executed in the same serialized transaction
 * so they can classify a denial without a later TOCTOU read.
 */
const atomicTrackedMutationPredicate = (reference: TrackedMutationReference): SQL => {
  assertReference(reference)
  const policyAllowsMutation = reference.policyLocked ? 0 : 1
  if (reference.entityType === 'time_entry') {
    return sql`
      ${timeEntries.id} = ${reference.entityId}
      AND ${policyAllowsMutation} = 1
      AND ${timeEntries.invoiceId} IS NULL
      AND ${timeEntries.approvalStatus} <> 'approved'
      AND EXISTS (
        SELECT 1
        FROM ${projects}
        JOIN ${clients} ON ${clients.id} = ${projects.clientId}
        WHERE ${projects.id} = ${timeEntries.projectId}
          AND ${projects.isActive} = 1
          AND ${clients.isActive} = 1
      )
      AND EXISTS (
        SELECT 1
        FROM ${tasks}
        WHERE ${tasks.id} = ${timeEntries.taskId}
          AND ${tasks.isActive} = 1
      )
    `
  }
  if (reference.entityType === 'expense') {
    return sql`
      ${expenses.id} = ${reference.entityId}
      AND ${policyAllowsMutation} = 1
      AND ${expenses.invoiceId} IS NULL
      AND ${expenses.approvalStatus} <> 'approved'
      AND EXISTS (
        SELECT 1
        FROM ${projects}
        JOIN ${clients} ON ${clients.id} = ${projects.clientId}
        WHERE ${projects.id} = ${expenses.projectId}
          AND ${projects.isActive} = 1
          AND ${clients.isActive} = 1
      )
    `
  }
  const replacementReference = reference as RunningTimeEntryReplacementReference
  return sql`
    NOT EXISTS (
      SELECT 1
      FROM ${timeEntries} AS current_entry
      JOIN ${projects} AS current_project
        ON current_project.id = current_entry.project_id
      JOIN ${clients} AS current_client
        ON current_client.id = current_project.client_id
      JOIN ${tasks} AS current_task
        ON current_task.id = current_entry.task_id
      WHERE current_entry.user_id = ${replacementReference.userId}
        AND (
          current_entry.timer_started_at IS NOT NULL
          OR (current_entry.started_time IS NOT NULL AND current_entry.ended_time IS NULL)
        )
        AND (
          ${policyAllowsMutation} = 0
          OR current_entry.invoice_id IS NOT NULL
          OR current_entry.approval_status = 'approved'
          OR current_client.is_active = 0
          OR current_project.is_active = 0
          OR current_task.is_active = 0
        )
    )
  `
}

const combinePredicates = (references: readonly TrackedMutationReference[]): SQL => {
  if (references.length === 0) throw new RangeError('at least one mutation guard is required')
  return references
    .map(atomicTrackedMutationPredicate)
    .reduce((combined, predicate) => sql`(${combined}) AND (${predicate})`)
}

const isD1Client = (client: NativeClient): client is D1Database => 'batch' in client

const nativeClient = (database: Database): NativeClient =>
  (database as Database & { $client: NativeClient }).$client

const executeContainerAtomic = (
  client: BetterSqlite3.Database,
  factQueries: readonly CompiledQuery[],
  mutationQuery: CompiledQuery,
): AtomicResult => {
  const execute = client.transaction(() => ({
    factRows: factQueries.map(
      (query) => client.prepare(query.sql).get(...query.params) as TrackedStateFactRow | undefined,
    ),
    mutationRow: client.prepare(mutationQuery.sql).get(...mutationQuery.params) as
      Record<string, unknown> | undefined,
  }))
  return execute.immediate()
}

const executeD1Atomic = async (
  client: D1Database,
  factQueries: readonly CompiledQuery[],
  mutationQuery: CompiledQuery,
): Promise<AtomicResult> => {
  const statements = [...factQueries, mutationQuery].map((query) =>
    client.prepare(query.sql).bind(...query.params),
  )
  const results = await client.batch(statements)
  return {
    factRows: results
      .slice(0, -1)
      .map((result) => result.results[0] as TrackedStateFactRow | undefined),
    mutationRow: results.at(-1)?.results[0] as Record<string, unknown> | undefined,
  }
}

/** Loads only persisted and parent facts. Policy remains an explicit caller-owned input. */
export const loadTrackedStateFacts = async (
  database: Database,
  reference: TrackedEntityReference,
): Promise<TrackedStateFacts> => {
  const query = factsQuery(reference)
  const client = nativeClient(database)
  const row = isD1Client(client)
    ? await client
        .prepare(query.sql)
        .bind(...query.params)
        .first<TrackedStateFactRow>()
    : (client.prepare(query.sql).get(...query.params) as TrackedStateFactRow | undefined)
  if (!row) throw new TrackedEntityNotFoundError(reference)
  return factsFromRow(row, reference.policyLocked)
}

export const getTrackedState = async (
  database: Database,
  reference: TrackedEntityReference,
): Promise<TrackedState> => deriveTrackedState(await loadTrackedStateFacts(database, reference))

/**
 * Executes fact capture and the guarded mutation as one serialized unit. A
 * denied mutation is classified from the captured snapshot, never from an
 * ambient post-write read that could already have changed again.
 *
 * The mutation returns the exact raw RETURNING row captured by the serialized
 * unit. Callers that expose a domain row must map its driver values rather than
 * reload ambient state after the transaction has completed.
 */
export const executeAtomicTrackedMutation = async (
  database: Database,
  referenceOrReferences: TrackedMutationReference | readonly TrackedMutationReference[],
  mutate: (predicate: SQL) => CompilableQuery,
  unlockedFailure: () => Error,
): Promise<Record<string, unknown>> => {
  const references = Array.isArray(referenceOrReferences)
    ? referenceOrReferences
    : [referenceOrReferences]
  const factQueries = references.map(factsQuery)
  const mutationQuery = mutate(combinePredicates(references)).toSQL()
  const client = nativeClient(database)
  const result = isD1Client(client)
    ? await executeD1Atomic(client, factQueries, mutationQuery)
    : executeContainerAtomic(client, factQueries, mutationQuery)

  if (result.mutationRow) return result.mutationRow
  for (const [index, reference] of references.entries()) {
    const row = result.factRows[index]
    if (!row) {
      if (reference.entityType !== 'running_time_entry_replacement') {
        throw new TrackedEntityNotFoundError(reference)
      }
      continue
    }
    assertTrackedMutationAllowed(factsFromRow(row, reference.policyLocked))
  }
  throw unlockedFailure()
}
