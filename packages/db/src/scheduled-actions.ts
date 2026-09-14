/**
 * Proposing a run, and settling it (#63).
 *
 * The two rules this exists to hold are the issue's own acceptance, and they
 * pull in opposite directions:
 *
 * - a manifest lists concrete items, never a count. An operator confirming a
 *   month-end pack is agreeing to those rows, and disagreeing with one of them
 *   means being shown it.
 * - nothing expires into action. A run nobody answered before its deadline is
 *   settled as expired and can never become confirmed afterwards.
 *
 * Both are enforced in the schema as well as here. The triggers are what holds
 * against a writer that goes around this module; the outcomes below are so a
 * caller hears a reason rather than a constraint failure.
 */

import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'

type Database =
  | BetterSQLite3Database<typeof schema>
  | DrizzleD1Database<typeof schema>

export type RunState = 'proposed' | 'confirmed' | 'cancelled' | 'expired' | 'completed'
export type RunItemState = 'pending' | 'running' | 'done' | 'failed'

export interface RunItemInput {
  subjectType: string
  subjectId: number
  description: string
  amountCents?: number | null
  currency?: string | null
  target?: string | null
}

export interface RunItemRecord extends RunItemInput {
  id: number
  amountCents: number | null
  currency: string | null
  target: string | null
  state: RunItemState
  attemptCount: number
  failureReason: string | null
  completedAt: string | null
}

export interface ProposedRunRecord {
  id: number
  jobId: number
  occurrenceKey: string
  state: RunState
  proposedAt: string
  expiresAt: string
  confirmedByUserId: number | null
  confirmedAt: string | null
  settledReason: string | null
}

/** Why a proposal or confirmation was refused, where the reason is a fact. */
export type RunRefusal =
  | 'already_proposed'
  | 'empty_manifest'
  | 'not_proposed'
  | 'expired'
  | 'unknown_run'

export type ProposeOutcome =
  | { outcome: 'proposed'; run: ProposedRunRecord }
  | { outcome: RunRefusal }

export type ConfirmOutcome =
  | { outcome: 'confirmed'; run: ProposedRunRecord }
  | { outcome: RunRefusal }

interface RunRow {
  id: number
  job_id: number
  occurrence_key: string
  state: RunState
  proposed_at: string
  expires_at: string
  confirmed_by_user_id: number | null
  confirmed_at: string | null
  settled_reason: string | null
}

const run = (row: RunRow): ProposedRunRecord => ({
  id: row.id,
  jobId: row.job_id,
  occurrenceKey: row.occurrence_key,
  state: row.state,
  proposedAt: row.proposed_at,
  expiresAt: row.expires_at,
  confirmedByUserId: row.confirmed_by_user_id,
  confirmedAt: row.confirmed_at,
  settledReason: row.settled_reason,
})

const columns = `id, job_id, occurrence_key, state, proposed_at, expires_at,
  confirmed_by_user_id, confirmed_at, settled_reason`

interface ItemRow {
  id: number
  subject_type: string
  subject_id: number
  description: string
  amount_cents: number | null
  currency: string | null
  target: string | null
  state: RunItemState
  attempt_count: number
  failure_reason: string | null
  completed_at: string | null
}

const item = (row: ItemRow): RunItemRecord => ({
  id: row.id,
  subjectType: row.subject_type,
  subjectId: row.subject_id,
  description: row.description,
  amountCents: row.amount_cents,
  currency: row.currency,
  target: row.target,
  state: row.state,
  attemptCount: row.attempt_count,
  failureReason: row.failure_reason,
  completedAt: row.completed_at,
})

const itemColumns = `id, subject_type, subject_id, description, amount_cents,
  currency, target, state, attempt_count, failure_reason, completed_at`

export interface ScheduledActionStore {
  /**
   * Materializes a run with its manifest, or refuses.
   *
   * The items are required rather than optional: a run that cannot render its
   * manifest does not propose, and the cheapest way to mean that is to make it
   * impossible to create one without.
   */
  propose(input: {
    jobId: number
    occurrenceKey: string
    items: readonly RunItemInput[]
    proposedAt: string
    expiresAt: string
  }): Promise<ProposeOutcome>
  read(runId: number): Promise<ProposedRunRecord | null>
  /** The rows a person is agreeing to. */
  manifest(runId: number): Promise<readonly RunItemRecord[]>
  confirm(runId: number, userId: number, now: string): Promise<ConfirmOutcome>
  cancel(runId: number, now: string, reason: string): Promise<boolean>
  /**
   * Settles everything whose deadline has passed. Returns what it settled, so
   * a caller can say what lapsed rather than only that something did.
   */
  expire(now: string): Promise<readonly number[]>

  /**
   * The items this run still owes, oldest first (#62).
   *
   * Everything not already done: pending, failed, and anything left `running`
   * by a process that died holding it. That last one is the point -- a resume
   * has to pick those up, and it is safe to because a done item can never be
   * claimed again.
   */
  outstanding(runId: number): Promise<readonly RunItemRecord[]>
  /**
   * Marks an item as being worked on, before the work.
   *
   * Returns false where the item is already done, which is how a second worker
   * -- or a resume racing the original -- is told to leave it alone. Writing
   * only on success would make a kill between the work and the write look
   * identical to a kill before it, and the safe reading of that ambiguity is to
   * redo the work: for an email, that is sending it twice.
   */
  claimItem(itemId: number, now: string): Promise<boolean>
  completeItem(itemId: number, now: string): Promise<boolean>
  failItem(itemId: number, now: string, reason: string): Promise<boolean>
  /**
   * Moves the run to completed once nothing is outstanding.
   *
   * Returns false while anything is still pending or failed, so a partial run
   * stays visibly partial rather than reading as finished with some items
   * quietly never done.
   */
  settleRun(runId: number, now: string): Promise<boolean>
}

export const createScheduledActionStore = (database: Database): ScheduledActionStore => ({
  propose: async (input) => {
    // An empty manifest is refused before anything is written. The trigger
    // refuses a confirmation without items; this refuses the proposal, because
    // a run an operator cannot read is not worth showing them.
    if (input.items.length === 0) return { outcome: 'empty_manifest' }

    const existing = await database.all<{ id: number }>(sql`
      SELECT id FROM proposed_runs
      WHERE job_id = ${input.jobId} AND occurrence_key = ${input.occurrenceKey}`)
    // A scheduler that fired twice for the same month finds the run already
    // there rather than proposing the pack a second time.
    if (existing.length > 0) return { outcome: 'already_proposed' }

    const inserted = await database.all<RunRow>(sql`
      INSERT INTO proposed_runs
        (job_id, occurrence_key, state, proposed_at, expires_at, created_at, updated_at)
      VALUES (${input.jobId}, ${input.occurrenceKey}, 'proposed',
        ${input.proposedAt}, ${input.expiresAt}, ${input.proposedAt}, ${input.proposedAt})
      RETURNING ${sql.raw(columns)}`)
    const row = inserted[0]
    if (row === undefined) return { outcome: 'already_proposed' }

    for (const item of input.items) {
      await database.all(sql`
        INSERT INTO run_items
          (run_id, subject_type, subject_id, description, amount_cents, currency, target, created_at)
        VALUES (${row.id}, ${item.subjectType}, ${item.subjectId}, ${item.description},
          ${item.amountCents ?? null}, ${item.currency ?? null}, ${item.target ?? null},
          ${input.proposedAt})
        RETURNING id`)
    }
    return { outcome: 'proposed', run: run(row) }
  },

  read: async (runId) => {
    const rows = await database.all<RunRow>(sql`
      SELECT ${sql.raw(columns)} FROM proposed_runs WHERE id = ${runId}`)
    return rows[0] === undefined ? null : run(rows[0])
  },

  manifest: async (runId) =>
    (
      await database.all<ItemRow>(sql`
        SELECT ${sql.raw(itemColumns)} FROM run_items WHERE run_id = ${runId} ORDER BY id`)
    ).map(item),

  /**
   * Confirms a standing run.
   *
   * The deadline is checked here rather than trusted to have been swept. A run
   * whose expiry passed a minute ago is not confirmable just because nothing
   * has run the sweep yet -- otherwise the guarantee would be "nothing expires
   * into action, unless you are quick".
   */
  confirm: async (runId, userId, now) => {
    const rows = await database.all<RunRow>(sql`
      SELECT ${sql.raw(columns)} FROM proposed_runs WHERE id = ${runId}`)
    const current = rows[0]
    if (current === undefined) return { outcome: 'unknown_run' }
    if (current.state !== 'proposed') return { outcome: 'not_proposed' }
    if (current.expires_at <= now) return { outcome: 'expired' }

    const updated = await database.all<RunRow>(sql`
      UPDATE proposed_runs
      SET state = 'confirmed', confirmed_by_user_id = ${userId}, confirmed_at = ${now},
          updated_at = ${now}
      WHERE id = ${runId} AND state = 'proposed' AND expires_at > ${now}
      RETURNING ${sql.raw(columns)}`)
    return updated[0] === undefined
      ? { outcome: 'not_proposed' }
      : { outcome: 'confirmed', run: run(updated[0]) }
  },

  cancel: async (runId, now, reason) => {
    const rows = await database.all<{ id: number }>(sql`
      UPDATE proposed_runs
      SET state = 'cancelled', settled_at = ${now}, settled_reason = ${reason},
          updated_at = ${now}
      WHERE id = ${runId} AND state = 'proposed'
      RETURNING id`)
    return rows.length > 0
  },

  expire: async (now) =>
    (
      await database.all<{ id: number }>(sql`
        UPDATE proposed_runs
        SET state = 'expired', settled_at = ${now},
            settled_reason = 'nobody confirmed it before the deadline',
            updated_at = ${now}
        WHERE state = 'proposed' AND expires_at <= ${now}
        RETURNING id`)
    ).map((row) => row.id),

  outstanding: async (runId) =>
    (
      await database.all<ItemRow>(sql`
        SELECT ${sql.raw(itemColumns)} FROM run_items
        WHERE run_id = ${runId} AND state <> 'done'
        ORDER BY id`)
    ).map(item),

  claimItem: async (itemId, now) => {
    const rows = await database.all<{ id: number }>(sql`
      UPDATE run_items
      SET state = 'running', attempted_at = ${now}, attempt_count = attempt_count + 1
      WHERE id = ${itemId} AND state <> 'done'
      RETURNING id`)
    return rows.length > 0
  },

  completeItem: async (itemId, now) => {
    const rows = await database.all<{ id: number }>(sql`
      UPDATE run_items
      SET state = 'done', completed_at = ${now}, failure_reason = NULL
      WHERE id = ${itemId} AND state <> 'done'
      RETURNING id`)
    return rows.length > 0
  },

  failItem: async (itemId, now, reason) => {
    const rows = await database.all<{ id: number }>(sql`
      UPDATE run_items
      SET state = 'failed', failure_reason = ${reason}, attempted_at = ${now}
      WHERE id = ${itemId} AND state <> 'done'
      RETURNING id`)
    return rows.length > 0
  },

  settleRun: async (runId, now) => {
    const rows = await database.all<{ id: number }>(sql`
      UPDATE proposed_runs
      SET state = 'completed', settled_at = ${now}, updated_at = ${now}
      WHERE id = ${runId} AND state = 'confirmed'
        AND NOT EXISTS (
          SELECT 1 FROM run_items WHERE run_id = ${runId} AND state <> 'done'
        )
      RETURNING id`)
    return rows.length > 0
  },
})
