/**
 * Reading and writing the link between a person and their account at a payout
 * provider (#421, #433).
 *
 * Migration 0042 built this table and nothing has ever touched it, which is why
 * a payout export still has nothing to join on. The rules it encodes are the
 * reason the store is this shape rather than a generic upsert:
 *
 * - An external id is immutable, and detaching is final. Repointing a link at a
 *   different account is detaching one and attaching another, so both stay in
 *   the history; an update would leave neither.
 * - One current account per person per provider, and one person per provider
 *   account. Two people on one Deel id means one is being paid for the other's
 *   work, and a bank statement is the wrong place to find that out.
 * - `verified_at` stays null until the provider itself confirmed the id
 *   resolves. A link nobody checked is a claim, and paying against a claim is
 *   the failure the table exists to prevent.
 */

import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'

type Database =
  | BetterSQLite3Database<typeof schema>
  | DrizzleD1Database<typeof schema>

export type PayoutProvider = 'deel' | 'wise'

export const payoutProviders: readonly PayoutProvider[] = ['deel', 'wise']

export interface PayoutAccountRecord {
  id: number
  userId: number
  provider: PayoutProvider
  externalId: string
  linkedByUserId: number
  linkedAt: string
  verifiedAt: string | null
  detachedAt: string | null
}

export interface PayoutAccountLink {
  userId: number
  provider: PayoutProvider
  externalId: string
  linkedByUserId: number
  now: string
}

/**
 * Why a link was refused, where the reason is a fact about the data rather than
 * a malformed request. Each maps to something an operator can act on, which is
 * the only reason to tell them apart.
 */
export type PayoutLinkRefusal =
  | 'already_linked'
  | 'external_id_taken'
  | 'unknown_user'

export type PayoutLinkOutcome =
  | { outcome: 'linked'; account: PayoutAccountRecord }
  | { outcome: PayoutLinkRefusal }

interface Row {
  id: number
  user_id: number
  provider: PayoutProvider
  external_id: string
  linked_by_user_id: number
  linked_at: string
  verified_at: string | null
  detached_at: string | null
}

const record = (row: Row): PayoutAccountRecord => ({
  id: row.id,
  userId: row.user_id,
  provider: row.provider,
  externalId: row.external_id,
  linkedByUserId: row.linked_by_user_id,
  linkedAt: row.linked_at,
  verifiedAt: row.verified_at,
  detachedAt: row.detached_at,
})

const columns = `id, user_id, provider, external_id, linked_by_user_id,
  linked_at, verified_at, detached_at`

export interface PayoutAccountStore {
  /** The accounts a person is currently payable through. */
  listForUser(userId: number): Promise<readonly PayoutAccountRecord[]>
  /** Everything ever linked for a person, detached rows included. */
  historyForUser(userId: number): Promise<readonly PayoutAccountRecord[]>
  /**
   * One account by id, detached ones included -- a caller deciding whether it
   * may detach this account needs to know whose it is even after it is gone.
   */
  read(id: number): Promise<PayoutAccountRecord | null>
  /** Current accounts for a provider, for an export that needs the whole set. */
  listForProvider(provider: PayoutProvider): Promise<readonly PayoutAccountRecord[]>
  link(input: PayoutAccountLink): Promise<PayoutLinkOutcome>
  /** Records that the provider confirmed the id resolves. */
  markVerified(id: number, now: string): Promise<PayoutAccountRecord | null>
  /** Final. Re-attaching is a new row, which the schema enforces. */
  detach(id: number, now: string): Promise<boolean>
}

export const createPayoutAccountStore = (database: Database): PayoutAccountStore => ({
  listForUser: async (userId) =>
    (
      await database.all<Row>(sql`
        SELECT ${sql.raw(columns)} FROM user_payout_accounts
        WHERE user_id = ${userId} AND detached_at IS NULL
        ORDER BY provider`)
    ).map(record),

  historyForUser: async (userId) =>
    (
      await database.all<Row>(sql`
        SELECT ${sql.raw(columns)} FROM user_payout_accounts
        WHERE user_id = ${userId}
        ORDER BY provider, linked_at DESC`)
    ).map(record),

  read: async (id) => {
    const rows = await database.all<Row>(sql`
      SELECT ${sql.raw(columns)} FROM user_payout_accounts WHERE id = ${id}`)
    return rows[0] === undefined ? null : record(rows[0])
  },

  listForProvider: async (provider) =>
    (
      await database.all<Row>(sql`
        SELECT ${sql.raw(columns)} FROM user_payout_accounts
        WHERE provider = ${provider} AND detached_at IS NULL
        ORDER BY user_id`)
    ).map(record),

  /**
   * Attaches an account, or says which rule refused it.
   *
   * The two uniqueness rules are checked before the insert so the caller gets a
   * reason rather than a constraint failure -- "this person already has a Deel
   * account" and "that Deel id belongs to somebody else" send an operator to
   * different places. The indexes remain the guarantee: a racing writer loses
   * at the index, and the answer it gets back is the same one.
   */
  link: async (input) => {
    const externalId = input.externalId.trim()
    const users = await database.all<{ id: number }>(sql`
      SELECT id FROM users WHERE id = ${input.userId}`)
    if (users.length === 0) return { outcome: 'unknown_user' }

    const mine = await database.all<{ id: number }>(sql`
      SELECT id FROM user_payout_accounts
      WHERE user_id = ${input.userId} AND provider = ${input.provider}
        AND detached_at IS NULL`)
    if (mine.length > 0) return { outcome: 'already_linked' }

    const theirs = await database.all<{ id: number }>(sql`
      SELECT id FROM user_payout_accounts
      WHERE provider = ${input.provider} AND external_id = ${externalId}
        AND detached_at IS NULL`)
    if (theirs.length > 0) return { outcome: 'external_id_taken' }

    const inserted = await database.all<Row>(sql`
      INSERT INTO user_payout_accounts
        (user_id, provider, external_id, linked_by_user_id, linked_at,
         created_at, updated_at)
      VALUES (${input.userId}, ${input.provider}, ${externalId},
        ${input.linkedByUserId}, ${input.now}, ${input.now}, ${input.now})
      RETURNING ${sql.raw(columns)}`)
    const row = inserted[0]
    // Unreachable through the checks above, and the indexes are what actually
    // hold: a racing writer loses there rather than here.
    return row === undefined
      ? { outcome: 'external_id_taken' }
      : { outcome: 'linked', account: record(row) }
  },

  markVerified: async (id, now) => {
    const rows = await database.all<Row>(sql`
      UPDATE user_payout_accounts
      SET verified_at = ${now}, updated_at = ${now}
      WHERE id = ${id} AND detached_at IS NULL
      RETURNING ${sql.raw(columns)}`)
    return rows[0] === undefined ? null : record(rows[0])
  },

  detach: async (id, now) => {
    const rows = await database.all<{ id: number }>(sql`
      UPDATE user_payout_accounts
      SET detached_at = ${now}, updated_at = ${now}
      WHERE id = ${id} AND detached_at IS NULL
      RETURNING id`)
    return rows.length > 0
  },
})
