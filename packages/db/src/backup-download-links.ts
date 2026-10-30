import { sql } from 'drizzle-orm'
import type { InvoiceStateDatabase } from './invoice-state.js'
import {
  constantTimeEqual,
  hashViewLinkToken,
  mintViewLinkToken,
  viewLinkTokenPattern,
} from './invoice-view-links.js'

/**
 * Issue 39, operator export: the signed download link for a completed backup
 * run.
 *
 * The link hands out a copy of the database, credential hashes included, so
 * the token in it is treated as the bearer secret it is. It is 256 random
 * bits, shown once when it is minted, and stored only as a SHA-256: a copy of
 * the database cannot mint or replay a download. Every way a redemption can
 * fail -- wrong shape, never minted, expired, already spent -- is the same
 * `null`, so nothing here tells a guesser which of those it was.
 *
 * The link is single-use because the statement that spends it is also the one
 * that decides who gets the file: one UPDATE that matches only an unspent,
 * unexpired row and returns it. Two requests racing for the same link cannot
 * both be handed a row. This module owns the rows; who may mint and what is
 * streamed are the routes' business.
 */

/** A link lives ten minutes: long enough to paste into curl, short enough to leak little. */
export const BACKUP_LINK_LIFETIME_MS = 10 * 60 * 1000

/** Links one administrator may mint in a minute. */
export const BACKUP_LINK_MINTS_PER_MINUTE = 5

/** Redemption attempts one caller may make in a minute, guesses included. */
export const BACKUP_DOWNLOAD_REQUESTS_PER_MINUTE = 30

/** 32 random bytes, base64url without padding. */
export const backupDownloadTokenPattern = viewLinkTokenPattern

export interface MintedBackupDownloadLink {
  readonly id: number
  /** The only time the token exists in the clear. */
  readonly token: string
  readonly backupRunId: number
  readonly expiresAt: string
}

export interface ConsumedBackupDownloadLink {
  readonly id: number
  readonly backupRunId: number
  readonly createdByUserId: number
}

export const backupDownloadLinkExpiry = (now: string): string =>
  new Date(Date.parse(now) + BACKUP_LINK_LIFETIME_MS).toISOString()

/** The newest completed run, or null when there is nothing to export yet. */
export const latestCompletedBackupRunId = async (
  database: InvoiceStateDatabase,
): Promise<number | null> => {
  const rows = await database.all<{ id: number }>(
    sql`SELECT id FROM backup_runs WHERE status = 'completed'
        ORDER BY started_at DESC, id DESC LIMIT 1`,
  )
  return rows[0]?.id ?? null
}

/**
 * Mints a link for a completed run, or null when the run does not exist or did
 * not complete. The status check is inside the insert, so a run cannot change
 * between the check and the row.
 */
export const mintBackupDownloadLink = async (
  database: InvoiceStateDatabase,
  input: { readonly backupRunId: number; readonly userId: number; readonly now: string },
): Promise<MintedBackupDownloadLink | null> => {
  const token = mintViewLinkToken()
  const tokenHash = await hashViewLinkToken(token)
  const expiresAt = backupDownloadLinkExpiry(input.now)
  const rows = await database.all<{ id: number }>(
    sql`INSERT INTO backup_download_links
          (backup_run_id, created_by_user_id, token_hash, expires_at, created_at)
        SELECT id, ${input.userId}, ${tokenHash}, ${expiresAt}, ${input.now}
        FROM backup_runs WHERE id = ${input.backupRunId} AND status = 'completed'
        RETURNING id`,
  )
  const id = rows[0]?.id
  return id === undefined ? null : { id, token, backupRunId: input.backupRunId, expiresAt }
}

/**
 * Spends the link a token names and says what it was for, or null for anything
 * that is not a live, unspent link. The spend is one statement, so exactly one
 * of any number of concurrent redemptions gets a row back. The stored hash that
 * comes back is compared in constant time before the answer is trusted.
 */
export const consumeBackupDownloadLink = async (
  database: InvoiceStateDatabase,
  token: string,
  now: string,
): Promise<ConsumedBackupDownloadLink | null> => {
  if (!backupDownloadTokenPattern.test(token)) return null
  const tokenHash = await hashViewLinkToken(token)
  const rows = await database.all<{
    id: number
    backupRunId: number
    createdByUserId: number
    tokenHash: string
  }>(
    sql`UPDATE backup_download_links SET consumed_at = ${now}
        WHERE token_hash = ${tokenHash} AND consumed_at IS NULL
          AND unixepoch(expires_at) > unixepoch(${now})
        RETURNING id, backup_run_id AS backupRunId,
                  created_by_user_id AS createdByUserId, token_hash AS tokenHash`,
  )
  const row = rows[0]
  if (row === undefined || !constantTimeEqual(row.tokenHash, tokenHash)) return null
  return { id: row.id, backupRunId: row.backupRunId, createdByUserId: row.createdByUserId }
}

/**
 * Counts one request against the caller's minute within a scope; false once
 * they are over. The key is hashed, so the table never holds an address.
 */
export const allowBackupDownloadRequest = async (
  database: InvoiceStateDatabase,
  scope: 'mint' | 'redeem',
  key: string,
  now: string,
): Promise<boolean> => {
  const limit =
    scope === 'mint' ? BACKUP_LINK_MINTS_PER_MINUTE : BACKUP_DOWNLOAD_REQUESTS_PER_MINUTE
  const window = Math.floor(Date.parse(now) / 60_000)
  const client = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(`backup-download-limit\u001f${scope}\u001f${key}`),
      ),
    ),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('')
  const rows = await database.all<{ attempts: number }>(
    sql`INSERT INTO backup_download_limits (window_minute, client_hash, attempts)
        VALUES (${window}, ${client}, 1)
        ON CONFLICT (window_minute, client_hash)
        DO UPDATE SET attempts = min(attempts + 1, ${limit + 1})
        RETURNING attempts`,
  )
  await database.run(sql`DELETE FROM backup_download_limits WHERE window_minute < ${window - 2}`)
  return (rows[0]?.attempts ?? limit + 1) <= limit
}
