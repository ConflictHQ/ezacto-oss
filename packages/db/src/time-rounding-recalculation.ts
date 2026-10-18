import {
  assertTimeRoundingPolicy,
  effectiveTimeRounding,
  roundTimeSeconds,
  type EffectiveTimeRounding,
  type TimeRoundingPolicy,
  type TimeRoundingRecalculationPreview,
  type TimeRoundingRecalculationResult,
  type TimeRoundingRecalculationScope,
} from '@ezacto/core'
import type BetterSqlite3 from 'better-sqlite3'
import { sql, type SQL } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'

export type {
  TimeRoundingRecalculationPreview,
  TimeRoundingRecalculationProject,
  TimeRoundingRecalculationResult,
  TimeRoundingRecalculationScope,
} from '@ezacto/core'

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>
type NativeClient = BetterSqlite3.Database | D1Database

/**
 * Re-rounding open time under the rules as they stand now (issue 949).
 *
 * Changing a rounding rule rewrites nothing: an entry's rounded figure is fixed
 * when it is saved. This is the explicit way to apply a new rule to time that
 * was saved before it -- and only to time that could still be edited one entry
 * at a time. "Open" is exactly the rule a single edit has to pass
 * (`tracked-state.ts`): stopped, not on an invoice, not approved, on a date no
 * timesheet lock covers, under a client, project and task that are all still
 * active. A negative entry is an imported correction and keeps its source's
 * figure.
 *
 * It is two steps on purpose. The preview says what would change, and its
 * fingerprint names exactly that set -- each entry, the figure it holds, the
 * figure it would get, and the version it was read at. The apply recomputes
 * the set and refuses if the fingerprint no longer matches, so what is written
 * is what was shown and nothing else.
 */

export type LockedDates = (spentDates: readonly string[]) => Promise<ReadonlyMap<string, boolean>>

interface OpenEntryRow {
  id: number
  projectId: number
  projectName: string
  spentDate: string
  seconds: number
  roundedSeconds: number
  updatedAt: string
  projectMode: string | null
  projectMinutes: number | null
}

interface Change {
  readonly id: number
  readonly projectId: number
  readonly spentDate: string
  readonly from: number
  readonly to: number
  readonly updatedAt: string
}

const datePattern = /^\d{4}-\d{2}-\d{2}$/u

const assertScope = (scope: Readonly<TimeRoundingRecalculationScope>): void => {
  if (
    scope.projectId !== undefined &&
    (!Number.isSafeInteger(scope.projectId) || scope.projectId < 1)
  ) {
    throw new RangeError('project id must be a positive safe integer')
  }
  for (const [field, value] of [
    ['from', scope.from],
    ['to', scope.to],
  ] as const) {
    if (value !== undefined && !datePattern.test(value)) {
      throw new RangeError(`${field} must be a canonical YYYY-MM-DD date`)
    }
  }
  if (scope.from !== undefined && scope.to !== undefined && scope.from > scope.to) {
    throw new RangeError('from must not be after to')
  }
}

const scopeSql = (scope: Readonly<TimeRoundingRecalculationScope>): SQL => {
  const conditions: SQL[] = [sql`1 = 1`]
  if (scope.projectId !== undefined) conditions.push(sql`entry.project_id = ${scope.projectId}`)
  if (scope.from !== undefined) conditions.push(sql`entry.spent_date >= ${scope.from}`)
  if (scope.to !== undefined) conditions.push(sql`entry.spent_date <= ${scope.to}`)
  return sql.join(conditions, sql` AND `)
}

/**
 * The single-edit rule in SQL, for the entry `table` names. Locks are the one
 * fact this cannot see on its own -- a weekly deadline lock is materialized
 * lazily -- so they are asked of the lock policy separately.
 */
const openCondition = (table: string): string => `${table}.timer_started_at IS NULL
  AND NOT (${table}.started_time IS NOT NULL AND ${table}.ended_time IS NULL)
  AND ${table}.invoice_id IS NULL
  AND ${table}.approval_status <> 'approved'
  AND ${table}.seconds >= 0
  AND EXISTS (
    SELECT 1 FROM projects active_project
    JOIN clients active_client ON active_client.id = active_project.client_id
    WHERE active_project.id = ${table}.project_id
      AND active_project.is_active = 1
      AND active_client.is_active = 1
  )
  AND EXISTS (
    SELECT 1 FROM tasks active_task
    WHERE active_task.id = ${table}.task_id AND active_task.is_active = 1
  )`

const organizationRule = async (database: Database): Promise<TimeRoundingPolicy> => {
  const rows = await database.all<{ mode: string; minutes: number }>(
    sql`SELECT time_rounding_mode AS mode, time_rounding_minutes AS minutes
        FROM organizations WHERE id = 1`,
  )
  const row = rows[0]
  if (row === undefined) throw new Error('organization must exist before recalculating time')
  return assertTimeRoundingPolicy(row)
}

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

const digest = async (value: string): Promise<string> => {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  )
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const sum = (values: readonly number[]): number => {
  const total = values.reduce((running, value) => running + value, 0)
  if (!Number.isSafeInteger(total)) throw new RangeError('time total exceeds safe integer range')
  return total
}

const lockedDatesFor = async (
  spentDates: readonly string[],
  lockedDates: LockedDates,
): Promise<ReadonlySet<string>> => {
  const unique = [...new Set(spentDates)]
  if (unique.length === 0) return new Set()
  const answers = await lockedDates(unique)
  return new Set(unique.filter((date) => answers.get(date) === true))
}

const plan = async (
  database: Database,
  scope: Readonly<TimeRoundingRecalculationScope>,
  lockedDates: LockedDates,
): Promise<{ preview: TimeRoundingRecalculationPreview; changes: readonly Change[] }> => {
  assertScope(scope)
  const organization = await organizationRule(database)
  const where = scopeSql(scope)
  const [candidates, totals] = await Promise.all([
    database.all<OpenEntryRow>(
      sql`SELECT entry.id AS "id", entry.project_id AS "projectId", project.name AS "projectName",
            entry.spent_date AS "spentDate", entry.seconds AS "seconds",
            entry.rounded_seconds AS "roundedSeconds", entry.updated_at AS "updatedAt",
            project.time_rounding_mode AS "projectMode",
            project.time_rounding_minutes AS "projectMinutes"
          FROM time_entries entry
          JOIN projects project ON project.id = entry.project_id
          WHERE ${where} AND ${sql.raw(openCondition('entry'))}
          ORDER BY entry.id`,
    ),
    database.all<{ total: number; invoiced: number | null; approved: number | null }>(
      sql`SELECT count(*) AS "total",
            sum(CASE WHEN entry.invoice_id IS NOT NULL THEN 1 ELSE 0 END) AS "invoiced",
            sum(CASE WHEN entry.invoice_id IS NULL AND entry.approval_status = 'approved'
              THEN 1 ELSE 0 END) AS "approved"
          FROM time_entries entry
          WHERE ${where}`,
    ),
  ])
  const locked = await lockedDatesFor(
    candidates.map(({ spentDate }) => spentDate),
    lockedDates,
  )
  const open = candidates.filter(({ spentDate }) => !locked.has(spentDate))
  const rules = new Map<number, EffectiveTimeRounding>()
  const changes: Change[] = []
  for (const row of open) {
    let rule = rules.get(row.projectId)
    if (rule === undefined) {
      rule = effectiveTimeRounding(
        organization,
        row.projectMode === null
          ? null
          : assertTimeRoundingPolicy({ mode: row.projectMode, minutes: row.projectMinutes }),
      )
      rules.set(row.projectId, rule)
    }
    const to = roundTimeSeconds(row.seconds, rule)
    if (to === row.roundedSeconds) continue
    changes.push({
      id: row.id,
      projectId: row.projectId,
      spentDate: row.spentDate,
      from: row.roundedSeconds,
      to,
      updatedAt: row.updatedAt,
    })
  }

  const names = new Map(open.map((row) => [row.projectId, row.projectName]))
  const byProject = new Map<number, Change[]>()
  for (const change of changes) {
    const group = byProject.get(change.projectId)
    if (group === undefined) byProject.set(change.projectId, [change])
    else group.push(change)
  }
  const dates = changes.map(({ spentDate }) => spentDate).sort()
  const total = totals[0]
  const invoiced = total?.invoiced ?? 0
  const approved = total?.approved ?? 0
  const lockedCount = candidates.length - open.length
  const normalizedScope: TimeRoundingRecalculationScope = {
    ...(scope.projectId === undefined ? {} : { projectId: scope.projectId }),
    ...(scope.from === undefined ? {} : { from: scope.from }),
    ...(scope.to === undefined ? {} : { to: scope.to }),
  }
  const fingerprint = await digest(
    canonicalJson({
      version: 1,
      scope: normalizedScope,
      changes: changes.map(({ id, from, to, updatedAt }) => [id, from, to, updatedAt]),
    }),
  )
  return {
    changes,
    preview: {
      scope: normalizedScope,
      openEntries: open.length,
      changedEntries: changes.length,
      roundedSecondsBefore: sum(changes.map(({ from }) => from)),
      roundedSecondsAfter: sum(changes.map(({ to }) => to)),
      earliestSpentDate: dates[0] ?? null,
      latestSpentDate: dates.at(-1) ?? null,
      projects: [...byProject.entries()]
        .map(([projectId, group]) => ({
          projectId,
          projectName: names.get(projectId) ?? `Project ${projectId}`,
          timeRounding: rules.get(projectId)!,
          changedEntries: group.length,
          roundedSecondsBefore: sum(group.map(({ from }) => from)),
          roundedSecondsAfter: sum(group.map(({ to }) => to)),
        }))
        .sort(
          (left, right) =>
            left.projectName.localeCompare(right.projectName, 'en') ||
            left.projectId - right.projectId,
        ),
      kept: {
        invoiced,
        approved,
        locked: lockedCount,
        other: Math.max(0, (total?.total ?? 0) - invoiced - approved - candidates.length),
      },
      fingerprint,
    },
  }
}

export const previewTimeRoundingRecalculation = async (
  database: Database,
  scope: Readonly<TimeRoundingRecalculationScope>,
  lockedDates: LockedDates,
): Promise<TimeRoundingRecalculationPreview> =>
  (await plan(database, scope, lockedDates)).preview

/**
 * D1 binds at most a hundred parameters and caps a value at two megabytes, so
 * the changes travel as one JSON parameter per statement, a few thousand at a
 * time; the statements run as one batch, so they land together or not at all.
 */
const changesPerStatement = 2_000

export const applyTimeRoundingRecalculation = async (
  database: Database,
  scope: Readonly<TimeRoundingRecalculationScope>,
  fingerprint: string,
  updatedAt: string,
  lockedDates: LockedDates,
): Promise<TimeRoundingRecalculationResult> => {
  const { preview, changes } = await plan(database, scope, lockedDates)
  if (preview.fingerprint !== fingerprint) return { status: 'stale', preview }
  if (changes.length === 0) return { status: 'applied', recalculatedEntries: 0, preview }

  // Every guard is the plan's again, row by row: the figure and the version
  // the preview read, still open, and on a date no lock now covers. A row that
  // moved since is skipped rather than overwritten, and the count says so.
  const update = `UPDATE time_entries
    SET rounded_seconds = change.rounded_to, updated_at = ?
    FROM (
      SELECT CAST(json_extract(value, '$.id') AS INTEGER) AS id,
        CAST(json_extract(value, '$.from') AS INTEGER) AS rounded_from,
        CAST(json_extract(value, '$.to') AS INTEGER) AS rounded_to,
        json_extract(value, '$.version') AS version
      FROM json_each(?)
    ) AS change
    WHERE time_entries.id = change.id
      AND time_entries.rounded_seconds = change.rounded_from
      AND time_entries.updated_at = change.version
      AND ${openCondition('time_entries')}
      AND NOT EXISTS (
        SELECT 1 FROM timesheet_lock_windows lock
        WHERE lock.unlocked_at IS NULL
          AND time_entries.spent_date <= lock.period_end
          AND (lock.period_start IS NULL OR time_entries.spent_date >= lock.period_start)
      )
    RETURNING time_entries.id AS id`
  const statements: NativeStatement[] = []
  for (let start = 0; start < changes.length; start += changesPerStatement) {
    const chunk = changes
      .slice(start, start + changesPerStatement)
      .map(({ id, from, to, updatedAt: version }) => ({ id, from, to, version }))
    statements.push({ text: update, params: [updatedAt, JSON.stringify(chunk)] })
  }
  const results = await runAtomic(database, statements)
  return {
    status: 'applied',
    recalculatedEntries: results.reduce((total, rows) => total + rows.length, 0),
    preview,
  }
}

interface NativeStatement {
  readonly text: string
  readonly params: readonly unknown[]
}

const isD1Client = (client: NativeClient): client is D1Database => 'batch' in client

/** One transaction on the container, one batch on D1: the chunks land together or not at all. */
const runAtomic = async (
  database: Database,
  statements: readonly NativeStatement[],
): Promise<readonly (readonly unknown[])[]> => {
  const client = (database as Database & { $client: NativeClient }).$client
  if (isD1Client(client)) {
    const results = await client.batch(
      statements.map((statement) => client.prepare(statement.text).bind(...statement.params)),
    )
    return results.map((result) => result.results ?? [])
  }
  return client
    .transaction(() =>
      statements.map((statement) => client.prepare(statement.text).all(...statement.params)),
    )
    .immediate()
}
