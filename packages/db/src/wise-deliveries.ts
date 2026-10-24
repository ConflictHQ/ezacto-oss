/**
 * Recording what Wise told us, and settling the payout it named (#543).
 *
 * The webhook uses process(): trusted claim, local settlement and completion
 * share one database transaction/batch. A verified pending claim can resume;
 * completed replays leave receipt history and money unchanged. The split
 * methods remain available for existing internal callers, not webhook dispatch.
 *
 * The settle itself is deliberately narrow. It matches on Wise's own transfer
 * id, moves a payout out of 'planned', and refuses to touch anything already
 * settled -- the schema makes a sent row immutable, and a retry that tried to
 * rewrite one would fail as a constraint error rather than as the no-op it
 * actually is.
 */

import { sql } from 'drizzle-orm'
import { atomicStatements } from './atomic-statements.js'
import type { InvoiceStateDatabase } from './invoice-state.js'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>

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

export interface WiseDeliveryProcessInput extends WiseDeliveryInput {
  outcome: 'sent' | 'failed' | null
  skippedReason: string | null
}

export interface WiseDeliveryStore {
  /** Claim, local settlement and disposition share one atomic database command. */
  process(input: WiseDeliveryProcessInput): Promise<void>
  /** Claims a verified raw-body identity in the trusted ledger only. */
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
  identitySource: 'legacy-header' | 'signed-payload'
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
  identity_source: 'legacy-header' | 'signed-payload'
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
  identitySource: row.identity_source,
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
  received_at, processed_at, skipped_reason, identity_source`

export const createWiseDeliveryStore = (database: Database): WiseDeliveryStore => ({
  process: async (input) => {
    if (!/^wise-body-sha256:[a-f0-9]{64}$/.test(input.deliveryId))
      throw new Error('Wise processing requires a signed body identity')
    const matching = `delivery_id=? AND subscription_id=? AND event_type=?
      AND transfer_id IS ? AND current_state IS ? AND occurred_at IS ?`
    const tuple = [
      input.deliveryId,
      input.subscriptionId,
      input.eventType,
      input.transferId,
      input.currentState,
      input.occurredAt,
    ]
    const pending = `${matching} AND processed_at IS NULL`
    // Classify against the same first local payout the existing settle path
    // used, before changing it. An external id is not a unique DB constraint.
    const payoutId = '(SELECT id FROM payout_transfers WHERE external_transfer_id=? LIMIT 1)'
    const results = await atomicStatements(database as InvoiceStateDatabase, [
      {
        text: `INSERT INTO wise_signed_webhook_deliveries
          (delivery_id,subscription_id,event_type,transfer_id,current_state,occurred_at,received_at)
          VALUES (?,?,?,?,?,?,?) ON CONFLICT(delivery_id) DO NOTHING RETURNING delivery_id`,
        params: [...tuple, input.now],
      },
      {
        text: `UPDATE wise_signed_webhook_deliveries SET skipped_reason = ${
          input.outcome === null
            ? '?'
            : `CASE WHEN (SELECT state FROM payout_transfers WHERE id=${payoutId})='planned' THEN NULL
              WHEN EXISTS(SELECT 1 FROM payout_transfers WHERE id=${payoutId})
                THEN 'payout transfer already '||(SELECT state FROM payout_transfers WHERE id=${payoutId})
              ELSE 'no matching payout transfer' END`
        }
          WHERE ${pending} RETURNING delivery_id`,
        params: [
          ...(input.outcome === null
            ? [input.skippedReason]
            : [input.transferId, input.transferId, input.transferId]),
          ...tuple,
        ],
      },
      ...(input.outcome === null
        ? []
        : [
            {
              text: `UPDATE payout_transfers SET state=?,failure_reason=?,updated_at=?
          WHERE id=${payoutId} AND state='planned'
            AND EXISTS(SELECT 1 FROM wise_signed_webhook_deliveries WHERE ${pending}) RETURNING id`,
              params: [
                input.outcome,
                input.outcome === 'failed' ? `wise reported ${input.currentState}` : null,
                input.now,
                input.transferId,
                ...tuple,
              ],
            },
          ]),
      {
        text: `UPDATE wise_signed_webhook_deliveries SET processed_at=?
          WHERE ${pending} RETURNING delivery_id`,
        params: [input.now, ...tuple],
      },
      {
        text: `SELECT * FROM wise_signed_webhook_deliveries WHERE delivery_id=?`,
        params: [input.deliveryId],
      },
    ])
    const row = results.at(-1)?.[0]
    // Hash identity is established by the verified caller. Still fail closed
    // if an internal caller reuses that key for different immutable metadata.
    if (
      !row ||
      row.subscription_id !== input.subscriptionId ||
      row.event_type !== input.eventType ||
      row.transfer_id !== input.transferId ||
      row.current_state !== input.currentState ||
      row.occurred_at !== input.occurredAt ||
      row.processed_at === null
    )
      throw new Error('Wise delivery identity does not match its recorded event')
  },
  /**
   * `INSERT ... ON CONFLICT DO NOTHING` and read what came back.
   *
   * Checking for the row first and inserting after would let two concurrent
   * retries both see nothing and both act, which is exactly the double-settle
   * this table exists to prevent. The primary key is the arbiter.
   */
  claim: async (input) => {
    const inserted = await database.all<{ delivery_id: string }>(sql`
      INSERT INTO wise_signed_webhook_deliveries
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
      UPDATE wise_signed_webhook_deliveries
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
        SELECT ${sql.raw(columns)} FROM wise_all_webhook_deliveries
        WHERE transfer_id = ${transferId}
        ORDER BY received_at DESC, identity_source DESC, delivery_id DESC`)
    ).map(record),
})
