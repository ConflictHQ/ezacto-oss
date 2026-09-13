/**
 * Recording what Wise told us, and settling the payout it named (#543).
 *
 * Two operations that have to happen in that order and only once. Wise retries
 * anything it did not get a 2xx for, so the ledger is claimed first: a second
 * delivery finds the row already there and does nothing, which is what stops a
 * transfer settling a payout twice.
 *
 * The settle itself is deliberately narrow. It matches on Wise's own transfer
 * id, moves a payout out of 'planned', and refuses to touch anything already
 * settled -- the schema makes a sent row immutable, and a retry that tried to
 * rewrite one would fail as a constraint error rather than as the no-op it
 * actually is.
 */

import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'

type Database =
  | BetterSQLite3Database<typeof schema>
  | DrizzleD1Database<typeof schema>

export interface WiseDeliveryInput {
  deliveryId: string
  subscriptionId: string
  eventType: string
  transferId: string | null
  currentState: string | null
  occurredAt: string | null
  now: string
}

/**
 * Whether this delivery is ours to act on.
 *
 * `duplicate` is a success, not a failure: Wise has told us this already and
 * the right answer to the retry is 2xx and no further work.
 */
export type WiseDeliveryClaim = { claim: 'fresh' } | { claim: 'duplicate' }

/** How a delivery was disposed of, for the ledger and for an operator reading it. */
export type WiseSettlement =
  | { settled: 'sent'; transferId: string }
  | { settled: 'failed'; transferId: string }
  | { settled: 'none'; reason: string }

export interface WiseDeliveryStore {
  /** Claims the delivery. Only the first caller for an id gets `fresh`. */
  claim(input: WiseDeliveryInput): Promise<WiseDeliveryClaim>
  /** Marks a claimed delivery done, with why it was not acted on if it was not. */
  finish(deliveryId: string, now: string, skippedReason: string | null): Promise<void>
  /**
   * Moves the payout this transfer paid for out of 'planned'.
   *
   * Returns what happened rather than a boolean, because "no such transfer" and
   * "already settled" send an operator to completely different places.
   */
  settleTransfer(input: {
    transferId: string
    outcome: 'sent' | 'failed'
    failureReason: string | null
    now: string
  }): Promise<WiseSettlement>
  /** What Wise has said about one transfer, newest first. */
  historyForTransfer(transferId: string): Promise<readonly WiseDeliveryRecord[]>
}

export interface WiseDeliveryRecord {
  deliveryId: string
  eventType: string
  transferId: string | null
  currentState: string | null
  occurredAt: string | null
  receivedAt: string
  processedAt: string | null
  skippedReason: string | null
}

interface DeliveryRow {
  delivery_id: string
  event_type: string
  transfer_id: string | null
  current_state: string | null
  occurred_at: string | null
  received_at: string
  processed_at: string | null
  skipped_reason: string | null
}

const record = (row: DeliveryRow): WiseDeliveryRecord => ({
  deliveryId: row.delivery_id,
  eventType: row.event_type,
  transferId: row.transfer_id,
  currentState: row.current_state,
  occurredAt: row.occurred_at,
  receivedAt: row.received_at,
  processedAt: row.processed_at,
  skippedReason: row.skipped_reason,
})

const columns = `delivery_id, event_type, transfer_id, current_state, occurred_at,
  received_at, processed_at, skipped_reason`

export const createWiseDeliveryStore = (database: Database): WiseDeliveryStore => ({
  /**
   * `INSERT ... ON CONFLICT DO NOTHING` and read what came back.
   *
   * Checking for the row first and inserting after would let two concurrent
   * retries both see nothing and both act, which is exactly the double-settle
   * this table exists to prevent. The primary key is the arbiter.
   */
  claim: async (input) => {
    const inserted = await database.all<{ delivery_id: string }>(sql`
      INSERT INTO wise_webhook_deliveries
        (delivery_id, subscription_id, event_type, transfer_id, current_state,
         occurred_at, received_at)
      VALUES (${input.deliveryId}, ${input.subscriptionId}, ${input.eventType},
        ${input.transferId}, ${input.currentState}, ${input.occurredAt}, ${input.now})
      ON CONFLICT (delivery_id) DO NOTHING
      RETURNING delivery_id`)
    return inserted.length > 0 ? { claim: 'fresh' } : { claim: 'duplicate' }
  },

  finish: async (deliveryId, now, skippedReason) => {
    await database.all(sql`
      UPDATE wise_webhook_deliveries
      SET processed_at = ${now}, skipped_reason = ${skippedReason}
      WHERE delivery_id = ${deliveryId}
      RETURNING delivery_id`)
  },

  settleTransfer: async (input) => {
    const existing = await database.all<{ id: number; state: string }>(sql`
      SELECT id, state FROM payout_transfers
      WHERE external_transfer_id = ${input.transferId}`)
    const row = existing[0]
    // A transfer nobody planned. Somebody may have moved money at Wise directly,
    // which is their business and not something to invent a payout for.
    if (row === undefined) return { settled: 'none', reason: 'no matching payout transfer' }
    if (row.state !== 'planned') {
      // Already settled. A retry landing here is the expected case, and the
      // schema would refuse the write anyway -- saying so beats a constraint
      // error that reads like a bug.
      return { settled: 'none', reason: `payout transfer already ${row.state}` }
    }
    const updated = await database.all<{ id: number }>(sql`
      UPDATE payout_transfers
      SET state = ${input.outcome},
          failure_reason = ${input.outcome === 'failed' ? input.failureReason : null},
          updated_at = ${input.now}
      WHERE id = ${row.id} AND state = 'planned'
      RETURNING id`)
    return updated.length > 0
      ? { settled: input.outcome, transferId: input.transferId }
      : { settled: 'none', reason: 'payout transfer changed while settling' }
  },

  historyForTransfer: async (transferId) =>
    (
      await database.all<DeliveryRow>(sql`
        SELECT ${sql.raw(columns)} FROM wise_webhook_deliveries
        WHERE transfer_id = ${transferId}
        ORDER BY received_at DESC`)
    ).map(record),
})
