import {
  assertTrackedMutationAllowed,
  deriveTrackedState,
  type ApprovalStatus,
  type TrackedState,
  type TrackedStateFacts,
} from '@ezacto/core'
import { sql, type SQL } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import { clients, expenses, projects, tasks, timeEntries } from './schema.js'

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>

export type TrackedEntityType = 'time_entry' | 'expense'

export interface TrackedEntityReference {
  entityType: TrackedEntityType
  entityId: number
  /** Already computed by the policy subsystem; required so callers cannot silently omit it. */
  policyLocked: boolean
}

interface TrackedStateFactRow {
  approval_status: ApprovalStatus
  invoice_id: number | null
  client_active: number
  project_active: number
  task_active: number
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

const assertReference = (reference: TrackedEntityReference): void => {
  if (!Number.isSafeInteger(reference.entityId) || reference.entityId <= 0) {
    throw new RangeError('tracked entity id must be a positive safe integer')
  }
  if (typeof reference.policyLocked !== 'boolean') {
    throw new TypeError('policyLocked must be an already-computed boolean fact')
  }
}

/**
 * The authorization half of a mutation must live in the UPDATE statement that
 * changes the row. A prior guard read is useful for rendering an error, but it
 * cannot authorize a later write without a time-of-check/time-of-use race.
 */
const atomicTrackedMutationPredicate = (reference: TrackedEntityReference): SQL => {
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

/** Loads only persisted and parent facts. Policy remains an explicit caller-owned input. */
export const loadTrackedStateFacts = async (
  database: Database,
  reference: TrackedEntityReference,
): Promise<TrackedStateFacts> => {
  assertReference(reference)
  const rows = await database.all<TrackedStateFactRow>(sql`
    SELECT
      entry.approval_status,
      entry.invoice_id,
      client.is_active AS client_active,
      project.is_active AS project_active,
      task.is_active AS task_active
    FROM time_entries entry
    JOIN projects project ON project.id = entry.project_id
    JOIN clients client ON client.id = project.client_id
    JOIN tasks task ON task.id = entry.task_id
    WHERE ${reference.entityType} = 'time_entry' AND entry.id = ${reference.entityId}
    UNION ALL
    SELECT
      expense.approval_status,
      expense.invoice_id,
      client.is_active AS client_active,
      project.is_active AS project_active,
      1 AS task_active
    FROM expenses expense
    JOIN projects project ON project.id = expense.project_id
    JOIN clients client ON client.id = project.client_id
    WHERE ${reference.entityType} = 'expense' AND expense.id = ${reference.entityId}
    LIMIT 1
  `)
  const row = rows[0]
  if (!row) throw new TrackedEntityNotFoundError(reference)
  return {
    approvalStatus: row.approval_status,
    invoiceId: row.invoice_id,
    policyLocked: reference.policyLocked,
    clientArchived: row.client_active === 0,
    projectArchived: row.project_active === 0,
    taskArchived: row.task_active === 0,
  }
}

export const getTrackedState = async (
  database: Database,
  reference: TrackedEntityReference,
): Promise<TrackedState> => deriveTrackedState(await loadTrackedStateFacts(database, reference))

/**
 * Executes one mutation whose UPDATE embeds the supplied predicate. A zero-row
 * result is classified afterward so callers receive the typed lock reason; the
 * classification read never authorizes the write.
 */
export const executeAtomicTrackedMutation = async <Result>(
  database: Database,
  reference: TrackedEntityReference,
  mutate: (predicate: SQL) => Promise<Result | undefined>,
  unlockedFailure: () => Error,
): Promise<Result> => {
  const result = await mutate(atomicTrackedMutationPredicate(reference))
  if (result !== undefined) return result
  assertTrackedMutationAllowed(await loadTrackedStateFacts(database, reference))
  throw unlockedFailure()
}
