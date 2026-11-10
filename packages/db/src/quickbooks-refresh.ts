import type { ManagedQuickBooksRefreshStore } from '@ezacto/integrations'
import type { InvoiceStateDatabase } from './invoice-state.js'
import { atomicStatements } from './atomic-statements.js'

const validTime = (value: string): boolean => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const validate = (attemptId: string, now: string): void => {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(attemptId) || !validTime(now)) {
    throw new Error('Invalid managed QuickBooks refresh command')
  }
}
const digest = async (value: unknown): Promise<string> => {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('')
}

/** Supply a native database whose statements each commit durably. A transaction
 * adapter owned by a replayable request is not a supported managed binding.
 * No provider transport is accepted by this repository.
 */
export const createManagedQuickBooksRefreshStore = (database: InvoiceStateDatabase): ManagedQuickBooksRefreshStore => ({
  status: async () => {
    const result = await atomicStatements(database, [{ text: `SELECT
      CASE WHEN EXISTS(SELECT 1 FROM migration_loads WHERE status<>'completed' AND (status<>'cancelled' OR started_at IS NOT NULL)) THEN 'unavailable'
        WHEN EXISTS(SELECT 1 FROM quickbooks_revocations WHERE status<>'revoked') THEN 'unavailable'
        WHEN EXISTS(SELECT 1 FROM quickbooks_refresh_attempts WHERE status IN ('unknown','orphaned')) THEN 'unavailable'
        WHEN EXISTS(SELECT 1 FROM quickbooks_refresh_attempts WHERE status='attempting') THEN 'pending'
        ELSE 'ready' END AS state`, params: [] }])
    return result[0]?.[0]?.state as 'ready' | 'pending' | 'unavailable'
  },
  claim: async ({ attemptId, connection, now }) => {
    validate(attemptId, now)
    const hash = await digest([connection.realmId, connection.connectedAt, connection.refreshToken, connection.accessToken, connection.accessTokenExpiresAt])
    const result = await atomicStatements(database, [{ text: `INSERT INTO quickbooks_refresh_attempts
      (attempt_id,generation,realm_id,connected_at,actor_id,credential_hash,status,expected_refresh_token,created_at,updated_at)
      SELECT ?,generation.generation,c.realm_id,c.connected_at,c.connected_by_user_id,?,'attempting',c.refresh_token,?,?
      FROM quickbooks_connections c JOIN quickbooks_connection_generation generation ON generation.singleton=1
      WHERE c.id=1 AND c.disconnected_at IS NULL AND c.realm_id=? AND c.connected_at=? AND c.refresh_token=?
        AND c.access_token=? AND c.access_token_expires_at=?
        AND NOT EXISTS(SELECT 1 FROM migration_loads WHERE status<>'completed' AND (status<>'cancelled' OR started_at IS NOT NULL))
        AND EXISTS(SELECT 1 FROM quickbooks_managed_grants grant_receipt WHERE grant_receipt.realm_id=c.realm_id
          AND grant_receipt.recorded_at=c.connected_at AND grant_receipt.accepted_generation=generation.generation)
        AND NOT EXISTS(SELECT 1 FROM quickbooks_refresh_attempts WHERE status NOT IN ('completed','cancelled'))
        AND NOT EXISTS(SELECT 1 FROM quickbooks_refresh_attempts previous WHERE previous.generation=generation.generation AND previous.credential_hash=? AND previous.status<>'cancelled')
      RETURNING attempt_id`, params: [attemptId,hash,now,now,connection.realmId,connection.connectedAt,connection.refreshToken,
      connection.accessToken,connection.accessTokenExpiresAt,hash] }])
    return result[0]?.[0]?.attempt_id === attemptId
  },
  unknown: async ({ attemptId, now }) => {
    validate(attemptId, now)
    await atomicStatements(database, [{ text: `UPDATE quickbooks_refresh_attempts SET status='unknown',updated_at=?
      WHERE attempt_id=? AND status='attempting' RETURNING attempt_id`, params: [now,attemptId] }])
  },
  cancelBeforeExchange: async ({ attemptId, now }) => {
    validate(attemptId, now)
    await atomicStatements(database, [{ text: `UPDATE quickbooks_refresh_attempts SET status='cancelled',expected_refresh_token=NULL,updated_at=?
      WHERE attempt_id=? AND status='attempting' AND result_hash IS NULL RETURNING attempt_id`, params: [now,attemptId] }])
  },
  finish: async ({ attemptId, tokens, now }) => {
    validate(attemptId, now)
    if (!tokens.accessToken || !tokens.refreshToken || !validTime(tokens.accessTokenExpiresAt) || !validTime(tokens.refreshTokenExpiresAt)) {
      throw new Error('Invalid managed QuickBooks refresh result')
    }
    const resultHash = await digest([tokens.accessToken,tokens.refreshToken,tokens.accessTokenExpiresAt,tokens.refreshTokenExpiresAt])
    const current = `EXISTS(SELECT 1 FROM quickbooks_connections c JOIN quickbooks_connection_generation generation ON generation.singleton=1
      WHERE c.id=1 AND c.disconnected_at IS NULL AND c.realm_id=receipt.realm_id AND c.connected_at=receipt.connected_at
        AND generation.generation=receipt.generation AND c.refresh_token=? AND c.access_token=?)`
    const result = await atomicStatements(database, [
      { text: `UPDATE quickbooks_refresh_attempts SET result_hash=?,candidate_access_token=?,candidate_refresh_token=?,updated_at=?
        WHERE attempt_id=? AND status='attempting' AND result_hash IS NULL RETURNING attempt_id`,
        params: [resultHash,tokens.accessToken,tokens.refreshToken,now,attemptId] },
      { text: `UPDATE quickbooks_connections SET access_token=?,refresh_token=?,access_token_expires_at=?,refresh_token_expires_at=?,updated_at=?
        WHERE id=1 AND disconnected_at IS NULL AND EXISTS(SELECT 1 FROM quickbooks_refresh_attempts receipt
          JOIN quickbooks_connection_generation generation ON generation.singleton=1
          WHERE receipt.attempt_id=? AND receipt.status='attempting' AND receipt.generation=generation.generation
            AND receipt.realm_id=quickbooks_connections.realm_id AND receipt.connected_at=quickbooks_connections.connected_at
            AND receipt.expected_refresh_token=quickbooks_connections.refresh_token AND receipt.result_hash=?) RETURNING id`, params: [tokens.accessToken,tokens.refreshToken,
        tokens.accessTokenExpiresAt,tokens.refreshTokenExpiresAt,now,attemptId,resultHash] },
      { text: `UPDATE quickbooks_refresh_attempts AS receipt SET
          status=CASE WHEN ${current} THEN 'completed' ELSE 'orphaned' END,
          expected_refresh_token=CASE WHEN ${current} THEN NULL ELSE expected_refresh_token END,
          retained_refresh_token=CASE WHEN ${current} THEN NULL ELSE ? END,candidate_access_token=NULL,candidate_refresh_token=NULL,updated_at=?
        WHERE attempt_id=? AND status='attempting' AND result_hash=? RETURNING attempt_id`, params: [tokens.refreshToken,tokens.accessToken,
        tokens.refreshToken,tokens.accessToken,tokens.refreshToken,tokens.accessToken,tokens.refreshToken,now,attemptId,resultHash] },
      { text: 'SELECT status FROM quickbooks_refresh_attempts WHERE attempt_id=? AND result_hash=?', params: [attemptId,resultHash] },
    ])
    const state = result[3]?.[0]?.status
    return state === 'completed' || state === 'orphaned' ? state : 'unavailable'
  },
})
