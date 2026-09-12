/**
 * The payout seam (#543), and the guarantee #103 asks for: the same work cannot
 * be paid twice.
 *
 * One seam with two providers behind it rather than two vendor-shaped paths. A
 * contractor is paid through Deel or through their own Wise account, and which
 * one is *their* choice; two implementations of "has this period been paid?"
 * would eventually disagree, and the first time they did somebody would be paid
 * twice.
 *
 * The resolution is the other half. A payout resolves to a stored payout
 * account and never to an email match -- matching on address is a guess, and
 * the failure mode of a wrong guess is money reaching the wrong person. A
 * person with no account is a state this reports, not one it skips: somebody
 * who worked and cannot be paid is exactly what a payroll run has to say out
 * loud.
 */

import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import type { PayoutProvider } from './payout-accounts.js'

type Database =
  | BetterSQLite3Database<typeof schema>
  | DrizzleD1Database<typeof schema>

export interface PayoutPeriod {
  /** Inclusive, as a timesheet period is. */
  start: string
  end: string
}

export interface PayoutCandidate {
  userId: number
  amountCents: number
  currency: string
}

export type PayoutPlanEntry =
  | {
      status: 'payable'
      userId: number
      amountCents: number
      currency: string
      provider: PayoutProvider
      payoutAccountId: number
      /** Null until the provider confirmed the account resolves. */
      verifiedAt: string | null
    }
  /** Worked, and cannot be paid. Reported rather than skipped. */
  | { status: 'no_account'; userId: number; amountCents: number; currency: string }
  /** Already claimed for this period by a transfer that has not failed. */
  | {
      status: 'already_transferred'
      userId: number
      transferId: number
      transferState: 'planned' | 'sent'
    }

export interface PayoutTransferRecord {
  id: number
  userId: number
  periodStart: string
  periodEnd: string
  payoutAccountId: number
  amountCents: number
  currency: string
  state: 'planned' | 'sent' | 'failed'
  externalTransferId: string | null
  failureReason: string | null
}

interface TransferRow {
  id: number
  user_id: number
  period_start: string
  period_end: string
  payout_account_id: number
  amount_cents: number
  currency: string
  state: 'planned' | 'sent' | 'failed'
  external_transfer_id: string | null
  failure_reason: string | null
}

const record = (row: TransferRow): PayoutTransferRecord => ({
  id: row.id,
  userId: row.user_id,
  periodStart: row.period_start,
  periodEnd: row.period_end,
  payoutAccountId: row.payout_account_id,
  amountCents: row.amount_cents,
  currency: row.currency,
  state: row.state,
  externalTransferId: row.external_transfer_id,
  failureReason: row.failure_reason,
})

const columns = `id, user_id, period_start, period_end, payout_account_id,
  amount_cents, currency, state, external_transfer_id, failure_reason`

export type ClaimOutcome =
  | { outcome: 'claimed'; transfer: PayoutTransferRecord }
  | { outcome: 'already_claimed'; transfer: PayoutTransferRecord }

export interface PayoutTransferStore {
  /**
   * What a payroll run would do, before it does anything.
   *
   * Every candidate comes back with a status, including the ones that cannot be
   * paid: a plan that silently dropped them would be a plan that looks complete
   * and is not.
   */
  plan(
    period: PayoutPeriod,
    candidates: readonly PayoutCandidate[],
    provider?: PayoutProvider,
  ): Promise<readonly PayoutPlanEntry[]>
  /**
   * Claims a person's period before anything is sent. The claim is what makes
   * a double payment impossible: a second attempt finds this row rather than
   * a gap.
   */
  claim(input: {
    userId: number
    period: PayoutPeriod
    payoutAccountId: number
    amountCents: number
    currency: string
    now: string
  }): Promise<ClaimOutcome>
  /** Records that money moved, with the provider's own id for it. */
  markSent(id: number, externalTransferId: string, now: string): Promise<boolean>
  /** Releases the period so the run can be tried again. */
  markFailed(id: number, reason: string, now: string): Promise<boolean>
  listForPeriod(period: PayoutPeriod): Promise<readonly PayoutTransferRecord[]>
}

export const createPayoutTransferStore = (database: Database): PayoutTransferStore => ({
  plan: async (period, candidates, provider) => {
    const entries: PayoutPlanEntry[] = []
    for (const candidate of candidates) {
      const claimed = await database.all<{
        id: number
        state: 'planned' | 'sent' | 'failed'
      }>(sql`
        SELECT id, state FROM payout_transfers
        WHERE user_id = ${candidate.userId}
          AND period_start = ${period.start} AND period_end = ${period.end}
          AND state <> 'failed'`)
      const existing = claimed[0]
      if (existing !== undefined) {
        entries.push({
          status: 'already_transferred',
          userId: candidate.userId,
          transferId: existing.id,
          transferState: existing.state as 'planned' | 'sent',
        })
        continue
      }

      // The account, never an email. This is the line that closes the guess.
      const accounts = await database.all<{
        id: number
        provider: PayoutProvider
        verified_at: string | null
      }>(sql`
        SELECT id, provider, verified_at FROM user_payout_accounts
        WHERE user_id = ${candidate.userId} AND detached_at IS NULL
          ${provider === undefined ? sql`` : sql`AND provider = ${provider}`}
        ORDER BY provider
        LIMIT 1`)
      const account = accounts[0]
      if (account === undefined) {
        entries.push({
          status: 'no_account',
          userId: candidate.userId,
          amountCents: candidate.amountCents,
          currency: candidate.currency,
        })
        continue
      }
      entries.push({
        status: 'payable',
        userId: candidate.userId,
        amountCents: candidate.amountCents,
        currency: candidate.currency,
        provider: account.provider,
        payoutAccountId: account.id,
        verifiedAt: account.verified_at,
      })
    }
    return entries
  },

  claim: async (input) => {
    const existing = await database.all<TransferRow>(sql`
      SELECT ${sql.raw(columns)} FROM payout_transfers
      WHERE user_id = ${input.userId}
        AND period_start = ${input.period.start} AND period_end = ${input.period.end}
        AND state <> 'failed'`)
    if (existing[0] !== undefined) {
      return { outcome: 'already_claimed', transfer: record(existing[0]) }
    }
    const inserted = await database.all<TransferRow>(sql`
      INSERT INTO payout_transfers
        (user_id, period_start, period_end, payout_account_id, amount_cents,
         currency, state, created_at, updated_at)
      VALUES (${input.userId}, ${input.period.start}, ${input.period.end},
        ${input.payoutAccountId}, ${input.amountCents}, ${input.currency},
        'planned', ${input.now}, ${input.now})
      RETURNING ${sql.raw(columns)}`)
    const row = inserted[0]
    // Unreachable through the check above; the partial unique index is what
    // actually holds, and a racing run loses there rather than here.
    if (row === undefined) {
      const raced = await database.all<TransferRow>(sql`
        SELECT ${sql.raw(columns)} FROM payout_transfers
        WHERE user_id = ${input.userId}
          AND period_start = ${input.period.start} AND period_end = ${input.period.end}
          AND state <> 'failed'`)
      return { outcome: 'already_claimed', transfer: record(raced[0]!) }
    }
    return { outcome: 'claimed', transfer: record(row) }
  },

  markSent: async (id, externalTransferId, now) => {
    const rows = await database.all<{ id: number }>(sql`
      UPDATE payout_transfers
      SET state = 'sent', external_transfer_id = ${externalTransferId}, updated_at = ${now}
      WHERE id = ${id} AND state = 'planned'
      RETURNING id`)
    return rows.length > 0
  },

  markFailed: async (id, reason, now) => {
    const rows = await database.all<{ id: number }>(sql`
      UPDATE payout_transfers
      SET state = 'failed', failure_reason = ${reason}, updated_at = ${now}
      WHERE id = ${id} AND state = 'planned'
      RETURNING id`)
    return rows.length > 0
  },

  listForPeriod: async (period) =>
    (
      await database.all<TransferRow>(sql`
        SELECT ${sql.raw(columns)} FROM payout_transfers
        WHERE period_start = ${period.start} AND period_end = ${period.end}
        ORDER BY user_id`)
    ).map(record),
})
