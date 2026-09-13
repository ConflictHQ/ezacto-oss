/**
 * The grants a contractor's Wise authorisation leaves behind (#543).
 *
 * Reading and writing two tables that only ever move together with a third:
 * `wise_oauth_states` is the single-use value proving a callback answers a
 * request we made, `wise_grants` holds the credential, and
 * `user_payout_accounts` -- not here -- holds the identifier a payout resolves
 * to. Keeping the last of those out of this module is deliberate: the callback
 * records a grant and links an account, and those are separate facts with
 * separate lifetimes. A grant whose tokens were revoked yesterday must not take
 * last month's payout destination down with it.
 *
 * The rules the schema enforces and this store surfaces as outcomes rather than
 * constraint failures:
 *
 * - A state is single-use. `claimState` deletes it and returns what it said, so
 *   a replayed callback finds nothing. An expired one is likewise consumed:
 *   leaving it would let a slow replay of the same link succeed later.
 * - One live grant per person, one person per Wise profile. Two people behind
 *   one profile means one is paid for the other's work.
 * - Revoking is final, and a revoked grant's tokens are frozen. Refreshing one
 *   would hand back a working credential for an account somebody disconnected.
 */

import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'

type Database =
  | BetterSQLite3Database<typeof schema>
  | DrizzleD1Database<typeof schema>

export type WiseEnvironment = 'sandbox' | 'live'
export type WiseProfileType = 'personal' | 'business'

export interface WiseGrantRecord {
  id: number
  userId: number
  environment: WiseEnvironment
  profileId: string
  profileType: WiseProfileType
  accessToken: string
  refreshToken: string
  accessTokenExpiresAt: string
  grantedAt: string
  revokedAt: string | null
}

export interface WiseOAuthStateRecord {
  state: string
  requestedByUserId: number
  environment: WiseEnvironment
  redirectUri: string
  expiresAt: string
}

export interface WiseGrantInput {
  userId: number
  environment: WiseEnvironment
  profileId: string
  profileType: WiseProfileType
  accessToken: string
  refreshToken: string
  accessTokenExpiresAt: string
  now: string
}

/**
 * Why a grant was refused, where the reason is a fact about the data rather
 * than a malformed request. Each sends a person somewhere different: their own
 * stale connection is theirs to replace, somebody else's is not.
 */
export type WiseGrantRefusal = 'already_connected' | 'profile_taken' | 'unknown_user'

export type WiseGrantOutcome =
  | { outcome: 'granted'; grant: WiseGrantRecord }
  | { outcome: WiseGrantRefusal }

/** What `claimState` says about a callback it was handed. */
export type WiseStateClaim =
  | { claim: 'valid'; state: WiseOAuthStateRecord }
  | { claim: 'expired' }
  | { claim: 'unknown' }

interface GrantRow {
  id: number
  user_id: number
  environment: WiseEnvironment
  profile_id: string
  profile_type: WiseProfileType
  access_token: string
  refresh_token: string
  access_token_expires_at: string
  granted_at: string
  revoked_at: string | null
}

interface StateRow {
  state: string
  requested_by_user_id: number
  environment: WiseEnvironment
  redirect_uri: string
  expires_at: string
}

const grant = (row: GrantRow): WiseGrantRecord => ({
  id: row.id,
  userId: row.user_id,
  environment: row.environment,
  profileId: row.profile_id,
  profileType: row.profile_type,
  accessToken: row.access_token,
  refreshToken: row.refresh_token,
  accessTokenExpiresAt: row.access_token_expires_at,
  grantedAt: row.granted_at,
  revokedAt: row.revoked_at,
})

const grantColumns = `id, user_id, environment, profile_id, profile_type,
  access_token, refresh_token, access_token_expires_at, granted_at, revoked_at`

export interface WiseGrantStore {
  /** The grant a person is currently payable through, if any. */
  readCurrent(userId: number): Promise<WiseGrantRecord | null>
  /** Everything ever granted for a person, revoked rows included. */
  historyForUser(userId: number): Promise<readonly WiseGrantRecord[]>
  /** Records that an authorisation is about to be asked for. */
  beginAuthorization(input: {
    state: string
    userId: number
    environment: WiseEnvironment
    redirectUri: string
    now: string
    expiresAt: string
  }): Promise<void>
  /** Consumes a state. Single-use whether or not it was still valid. */
  claimState(state: string, now: string): Promise<WiseStateClaim>
  record(input: WiseGrantInput): Promise<WiseGrantOutcome>
  /** Rotates the credential in place. Identity columns are untouched. */
  refreshTokens(
    id: number,
    tokens: { accessToken: string; refreshToken: string; accessTokenExpiresAt: string },
    now: string,
  ): Promise<WiseGrantRecord | null>
  /** Final. Re-authorising is a new row, which the schema enforces. */
  revoke(userId: number, now: string): Promise<boolean>
  /** Housekeeping for states nobody came back for. */
  pruneStates(now: string): Promise<number>
}

export const createWiseGrantStore = (database: Database): WiseGrantStore => ({
  readCurrent: async (userId) => {
    const rows = await database.all<GrantRow>(sql`
      SELECT ${sql.raw(grantColumns)} FROM wise_grants
      WHERE user_id = ${userId} AND revoked_at IS NULL`)
    return rows[0] === undefined ? null : grant(rows[0])
  },

  historyForUser: async (userId) =>
    (
      await database.all<GrantRow>(sql`
        SELECT ${sql.raw(grantColumns)} FROM wise_grants
        WHERE user_id = ${userId}
        ORDER BY granted_at DESC`)
    ).map(grant),

  beginAuthorization: async (input) => {
    await database.all(sql`
      INSERT INTO wise_oauth_states
        (state, requested_by_user_id, environment, redirect_uri, created_at, expires_at)
      VALUES (${input.state}, ${input.userId}, ${input.environment},
        ${input.redirectUri}, ${input.now}, ${input.expiresAt})
      RETURNING state`)
  },

  /**
   * Deletes first and judges afterwards.
   *
   * An expired state is still consumed: leaving the row would let the same link
   * be replayed for as long as somebody kept it, and the only thing standing
   * between a stale link and a connected account is that the state is gone.
   */
  claimState: async (state, now) => {
    const rows = await database.all<StateRow>(sql`
      DELETE FROM wise_oauth_states WHERE state = ${state}
      RETURNING state, requested_by_user_id, environment, redirect_uri, expires_at`)
    const row = rows[0]
    if (row === undefined) return { claim: 'unknown' }
    if (row.expires_at <= now) return { claim: 'expired' }
    return {
      claim: 'valid',
      state: {
        state: row.state,
        requestedByUserId: row.requested_by_user_id,
        environment: row.environment,
        redirectUri: row.redirect_uri,
        expiresAt: row.expires_at,
      },
    }
  },

  /**
   * Records a grant, or says which rule refused it.
   *
   * Both uniqueness rules are checked before the insert so the caller gets a
   * reason rather than a constraint failure. The indexes remain the guarantee:
   * a racing writer loses at the index, and the answer it gets is the same one.
   */
  record: async (input) => {
    const profileId = input.profileId.trim()
    const users = await database.all<{ id: number }>(sql`
      SELECT id FROM users WHERE id = ${input.userId}`)
    if (users.length === 0) return { outcome: 'unknown_user' }

    const mine = await database.all<{ id: number }>(sql`
      SELECT id FROM wise_grants WHERE user_id = ${input.userId} AND revoked_at IS NULL`)
    if (mine.length > 0) return { outcome: 'already_connected' }

    const theirs = await database.all<{ id: number }>(sql`
      SELECT id FROM wise_grants
      WHERE environment = ${input.environment} AND profile_id = ${profileId}
        AND revoked_at IS NULL`)
    if (theirs.length > 0) return { outcome: 'profile_taken' }

    const inserted = await database.all<GrantRow>(sql`
      INSERT INTO wise_grants
        (user_id, environment, profile_id, profile_type, access_token,
         refresh_token, access_token_expires_at, granted_at, created_at, updated_at)
      VALUES (${input.userId}, ${input.environment}, ${profileId}, ${input.profileType},
        ${input.accessToken}, ${input.refreshToken}, ${input.accessTokenExpiresAt},
        ${input.now}, ${input.now}, ${input.now})
      RETURNING ${sql.raw(grantColumns)}`)
    const row = inserted[0]
    // Unreachable through the checks above; the indexes are what actually hold.
    return row === undefined
      ? { outcome: 'profile_taken' }
      : { outcome: 'granted', grant: grant(row) }
  },

  refreshTokens: async (id, tokens, now) => {
    const rows = await database.all<GrantRow>(sql`
      UPDATE wise_grants
      SET access_token = ${tokens.accessToken},
          refresh_token = ${tokens.refreshToken},
          access_token_expires_at = ${tokens.accessTokenExpiresAt},
          updated_at = ${now}
      WHERE id = ${id} AND revoked_at IS NULL
      RETURNING ${sql.raw(grantColumns)}`)
    return rows[0] === undefined ? null : grant(rows[0])
  },

  revoke: async (userId, now) => {
    const rows = await database.all<{ id: number }>(sql`
      UPDATE wise_grants SET revoked_at = ${now}, updated_at = ${now}
      WHERE user_id = ${userId} AND revoked_at IS NULL
      RETURNING id`)
    return rows.length > 0
  },

  pruneStates: async (now) => {
    const rows = await database.all<{ state: string }>(sql`
      DELETE FROM wise_oauth_states WHERE expires_at <= ${now} RETURNING state`)
    return rows.length
  },
})
