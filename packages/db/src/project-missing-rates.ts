import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import type { LockedDates } from './time-rounding-recalculation.js'

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>
export interface ProjectMissingRatesReport {
  project_id: number
  hourly_rate_cents: number
  entry_count: number
  seconds: number
  earliest_date: string | null
  latest_date: string | null
  fingerprint: string
  applied_entries: number
}
interface Row {
  id: number
  spentDate: string
  seconds: number
  updatedAt: string
}
const open = (table: string): string => `${table}.billable_rate_cents IS NULL
  AND ${table}.billable = 1 AND ${table}.invoice_id IS NULL
  AND ${table}.approval_status NOT IN ('approved', 'submitted')
  AND ${table}.timer_started_at IS NULL AND ${table}.seconds >= 0
  AND NOT (${table}.started_time IS NOT NULL AND ${table}.ended_time IS NULL)
  AND EXISTS (SELECT 1 FROM tasks WHERE tasks.id = ${table}.task_id AND tasks.is_active = 1)
  AND NOT EXISTS (SELECT 1 FROM timesheet_lock_windows lock
    WHERE lock.unlocked_at IS NULL AND ${table}.spent_date <= lock.period_end
      AND (lock.period_start IS NULL OR ${table}.spent_date >= lock.period_start))`

/** Explicit repair of missing project-rate snapshots; never replaces captured rates or costs. */
export const recoverProjectMissingRates = async (
  database: Database,
  input: { projectId: number; actorUserId: number; fingerprint?: string; occurredAt: string },
  lockedDates: LockedDates,
): Promise<ProjectMissingRatesReport> => {
  const [project] = await database.all<{ rate: number | null; updatedAt: string }>(sql`
    SELECT project.hourly_rate_cents AS rate, project.updated_at AS updatedAt
    FROM projects project JOIN clients client ON client.id = project.client_id
    WHERE project.id = ${input.projectId} AND project.bill_by = 'project'
      AND project.billing_method = 'time_materials' AND project.is_active = 1 AND client.is_active = 1
      AND EXISTS (SELECT 1 FROM users WHERE id = ${input.actorUserId} AND profile = 'administrator' AND is_active = 1)
  `)
  if (project?.rate === null || project === undefined) {
    throw new RangeError(
      'set an hourly rate on an active time-and-materials project billed by project before repairing missing rates',
    )
  }
  const candidates = await database.all<Row>(sql`
    SELECT entry.id AS id, entry.spent_date AS spentDate,
      entry.rounded_seconds AS seconds, entry.updated_at AS updatedAt
    FROM time_entries entry WHERE entry.project_id = ${input.projectId}
      AND ${sql.raw(open('entry'))} ORDER BY entry.id LIMIT 1000
  `)
  const locks = await lockedDates(candidates.map((row) => row.spentDate))
  const rows = candidates.filter((row) => locks.get(row.spentDate) !== true)
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify({ projectId: input.projectId, project, rows })),
  )
  const fingerprint = [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  if (input.fingerprint !== undefined && input.fingerprint !== fingerprint) {
    throw new Error('missing_rate_preview_stale')
  }
  const seconds = rows.reduce((sum, row) => sum + row.seconds, 0)
  if (!Number.isSafeInteger(seconds)) throw new RangeError('time total exceeds safe integer range')
  let appliedEntries = 0
  if (input.fingerprint !== undefined && rows.length > 0) {
    // One statement: every snapshot change and its audit land together. The
    // current project, actor, entry versions and materialized locks are fenced
    // again at the write, including a rate or role change after the preview.
    const changed = await database.all<{ id: number }>(sql`
      INSERT INTO time_entry_rate_reprices (
        time_entry_id, previous_billable_rate_cents, billable_rate_cents,
        previous_cost_rate_cents, cost_rate_cents, reason, repriced_at, run_id, actor_user_id
      )
      SELECT entry.id, NULL, project.hourly_rate_cents, entry.cost_rate_cents, entry.cost_rate_cents,
        'Explicit missing project-rate repair', ${input.occurredAt}, ${`project-rate:${fingerprint}`}, ${input.actorUserId}
      FROM time_entries entry
      JOIN json_each(${JSON.stringify(rows)}) change ON entry.id = json_extract(change.value, '$.id')
      JOIN projects project ON project.id = entry.project_id
      JOIN clients client ON client.id = project.client_id
      WHERE entry.project_id = ${input.projectId}
        AND entry.updated_at = json_extract(change.value, '$.updatedAt')
        AND entry.rounded_seconds = json_extract(change.value, '$.seconds')
        AND ${sql.raw(open('entry'))}
        AND project.updated_at = ${project.updatedAt} AND project.hourly_rate_cents = ${project.rate}
        AND project.bill_by = 'project' AND project.billing_method = 'time_materials'
        AND project.is_active = 1 AND client.is_active = 1
        AND EXISTS (SELECT 1 FROM users WHERE id = ${input.actorUserId} AND profile = 'administrator' AND is_active = 1)
      RETURNING time_entry_id AS id
    `)
    appliedEntries = changed.length
  }
  const dates = rows.map((row) => row.spentDate).sort()
  return {
    project_id: input.projectId,
    hourly_rate_cents: project.rate,
    entry_count: rows.length,
    seconds,
    earliest_date: dates[0] ?? null,
    latest_date: dates.at(-1) ?? null,
    fingerprint,
    applied_entries: appliedEntries,
  }
}
