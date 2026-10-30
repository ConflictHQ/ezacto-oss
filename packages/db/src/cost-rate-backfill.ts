/**
 * Pricing the cost of hours tracked before a person had a cost rate (#750).
 *
 * An entry carries the cost rate it was stamped with, and adding a rate to a
 * person does not reach backwards, so years of tracked hours stay unpriced and
 * every figure derived from cost answers nothing for the periods they worked.
 *
 * ## The rate is the operator's, never ours
 *
 * Nobody's cost was the same in 2019 and today, and nothing in the data can
 * reconstruct what it was. One figure across a range is the honest option
 * available rather than the true one, so the caller supplies it, and supplies
 * the range: there is no default rate and no default "all of history". The
 * report is the thing to read before approving, and it says what the figures
 * are -- per month, in the person's own entries.
 *
 * ## Through the reprice record, never the column
 *
 * The write is an insert into `time_entry_rate_reprices`, whose trigger applies
 * the snapshot, so every change names the actor and the run and the row cannot
 * move without its audit. The whole run is one statement: it lands completely
 * or not at all.
 *
 * ## Idempotent by selection
 *
 * An entry that already carries a cost rate is not selected, so a second run
 * finds nothing to stamp. `replaceCaptured` widens that to entries carrying a
 * different rate, and still never restamps one already at the supplied rate.
 * Running entries are left alone: their snapshot is taken when they stop.
 */

import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>

export interface CostRateBackfillInput {
  readonly userId: number
  /** Inclusive range of `spent_date`, both required. */
  readonly from: string
  readonly to: string
  /** The effective cost rate to stamp, in cents per hour. */
  readonly costRateCents: number
  /** Recorded on every reprice row the run writes. */
  readonly reason: string
  readonly actorUserId: number
  readonly runId: string
  readonly occurredAt: string
  /** Also restamp entries carrying a different cost rate. Default: leave them. */
  readonly replaceCaptured?: boolean
  /** Default false: a run that writes nothing is the one read before approving. */
  readonly apply?: boolean
}

export interface CostRateBackfillPeriod {
  /** `YYYY-MM`. */
  month: string
  entryCount: number
  seconds: number
  costCents: number
}

export interface CostRateBackfillReport {
  runId: string
  applied: boolean
  userId: number
  from: string
  to: string
  costRateCents: number
  /** What the run stamps (or, in a rehearsal, would stamp). */
  entryCount: number
  seconds: number
  costCents: number
  periods: CostRateBackfillPeriod[]
  /** In range, left alone because they carry a cost rate already. */
  capturedEntryCount: number
  /** In range, left alone because the timer is still running. */
  runningEntryCount: number
}

const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const assertDate = (value: string, label: string): void => {
  const match = datePattern.exec(value)
  const date = new Date(`${value}T00:00:00.000Z`)
  if (
    !match ||
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() !== Number(match[2]) - 1 ||
    date.getUTCDate() !== Number(match[3])
  ) {
    throw new TypeError(`${label} must be a real YYYY-MM-DD date`)
  }
}

const assertPositive = (value: number, label: string): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`)
  }
}

export const backfillCostRates = async (
  database: Database,
  input: Readonly<CostRateBackfillInput>,
): Promise<CostRateBackfillReport> => {
  assertPositive(input.userId, 'user id')
  assertPositive(input.actorUserId, 'actor user id')
  assertDate(input.from, 'from')
  assertDate(input.to, 'to')
  if (input.from > input.to) throw new TypeError('from must not be after to')
  if (!Number.isSafeInteger(input.costRateCents) || input.costRateCents < 0) {
    throw new TypeError('cost rate must be a non-negative integer number of cents')
  }
  if (input.reason.trim().length === 0 || input.reason.length > 500) {
    throw new TypeError('reason must be 1 to 500 characters')
  }
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.runId)) {
    throw new TypeError('run id must be 1 to 128 of letters, digits and ._:-')
  }
  if (!instantPattern.test(input.occurredAt)) {
    throw new TypeError('occurredAt must be a canonical millisecond ISO UTC timestamp')
  }
  const apply = input.apply === true
  const replace = input.replaceCaptured === true ? 1 : 0

  const [person] = await database.all<{ id: number }>(
    sql`SELECT id FROM users WHERE id = ${input.userId}`,
  )
  if (person === undefined) throw new TypeError('the named person must exist')

  // One definition of "what this run stamps", shared by the rehearsal and the
  // write, so what was read is what is done.
  const selected = sql`user_id = ${input.userId}
    AND spent_date BETWEEN ${input.from} AND ${input.to}
    AND timer_started_at IS NULL
    AND (cost_rate_cents IS NULL
      OR (${replace} = 1 AND cost_rate_cents <> ${input.costRateCents}))`

  // Priced as every cost report prices an entry: half up, once per entry, so
  // the figure here is the one the report shows afterwards.
  const periods = await database.all<CostRateBackfillPeriod>(sql`
    SELECT substr(spent_date, 1, 7) AS "month", count(*) AS "entryCount",
      coalesce(sum(rounded_seconds), 0) AS "seconds",
      coalesce(sum((CASE WHEN rounded_seconds < 0 THEN -1 ELSE 1 END)
        * ((abs(rounded_seconds) * CAST(${input.costRateCents} AS INTEGER) + 1800) / 3600)), 0) AS "costCents"
    FROM time_entries WHERE ${selected}
    GROUP BY 1 ORDER BY 1
  `)
  const [left] = await database.all<{ captured: number; running: number }>(sql`
    SELECT
      coalesce(sum(timer_started_at IS NULL AND cost_rate_cents IS NOT NULL
        AND NOT (${replace} = 1 AND cost_rate_cents <> ${input.costRateCents})), 0) AS "captured",
      coalesce(sum(timer_started_at IS NOT NULL), 0) AS "running"
    FROM time_entries
    WHERE user_id = ${input.userId} AND spent_date BETWEEN ${input.from} AND ${input.to}
  `)

  if (apply && periods.length > 0) {
    await database.run(sql`
      INSERT INTO time_entry_rate_reprices (
        time_entry_id, previous_billable_rate_cents, billable_rate_cents,
        previous_cost_rate_cents, cost_rate_cents, reason, repriced_at, run_id, actor_user_id
      )
      SELECT id, billable_rate_cents, billable_rate_cents,
        cost_rate_cents, ${input.costRateCents}, ${input.reason}, ${input.occurredAt},
        ${input.runId}, ${input.actorUserId}
      FROM time_entries WHERE ${selected}
      ORDER BY id
    `)
  }

  let entryCount = 0
  let seconds = 0
  let costCents = 0
  for (const period of periods) {
    entryCount += period.entryCount
    seconds += period.seconds
    costCents += period.costCents
  }
  return {
    runId: input.runId,
    applied: apply,
    userId: input.userId,
    from: input.from,
    to: input.to,
    costRateCents: input.costRateCents,
    entryCount,
    seconds,
    costCents,
    periods,
    capturedEntryCount: left?.captured ?? 0,
    runningEntryCount: left?.running ?? 0,
  }
}
