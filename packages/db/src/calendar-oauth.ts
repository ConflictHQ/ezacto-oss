import { sql } from 'drizzle-orm'
import { type CalendarOAuthStore } from '@ezacto/core'
import type { InvoiceStateDatabase } from './invoice-state.js'
import { atomicStatements } from './atomic-statements.js'

// The write itself checks the live native session, not a preflight timestamp.
const authority = `EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
 WHERE s.id=? AND s.user_id=? AND s.revoked_at IS NULL AND u.is_active=1
 AND s.profile_snapshot=u.profile AND s.manager_grants_snapshot=u.manager_grants
 AND julianday(s.idle_expires_at)>julianday('now') AND julianday(s.absolute_expires_at)>julianday('now')
 AND NOT EXISTS(SELECT 1 FROM account_closures WHERE user_id=u.id))
 AND NOT EXISTS(SELECT 1 FROM account_restore_quarantine WHERE id=1 AND quarantined=1)
 AND NOT EXISTS(SELECT 1 FROM migration_loads WHERE status<>'completed' AND (status<>'cancelled' OR started_at IS NOT NULL))`
const guard = (condition: string, params: readonly unknown[]) => ({
  text: `INSERT INTO calendar_sync_guard(allowed) SELECT CASE WHEN ${condition} THEN 1 ELSE 0 END RETURNING allowed`,
  params,
})
export const createCalendarOAuthStore = (database: InvoiceStateDatabase): CalendarOAuthStore => ({
  async begin(a, expiresAt) {
    await atomicStatements(database, [
      guard(
        `${authority} AND ?=(SELECT nonce FROM calendar_sync_instance WHERE singleton=1)
       AND coalesce((SELECT generation FROM calendar_connections WHERE user_id=? AND provider=?),0)=?
       AND NOT EXISTS(SELECT 1 FROM calendar_connections WHERE user_id=? AND provider=? AND status='connected')
       AND NOT EXISTS(SELECT 1 FROM calendar_cleanup_obligations WHERE user_id=? AND provider=? AND instance_nonce=? AND status<>'revoked')`,
        [
          a.authority.sessionId,
          a.authority.userId,
          a.instance,
          a.authority.userId,
          a.provider,
          a.generation,
          a.authority.userId,
          a.provider,
          a.authority.userId,
          a.provider,
          a.instance,
        ],
      ),
      {
        text: "DELETE FROM calendar_oauth_attempts WHERE julianday(expires_at)<=julianday('now') OR (user_id=? AND session_id=? AND provider=?) RETURNING state_hash",
        params: [a.authority.userId, a.authority.sessionId, a.provider],
      },
      {
        text: 'INSERT INTO calendar_oauth_attempts(state_hash,requester_hash,user_id,session_id,provider,instance_nonce,expected_generation,expires_at) VALUES(?,?,?,?,?,?,?,?) RETURNING state_hash',
        params: [
          a.stateHash,
          a.requesterHash,
          a.authority.userId,
          a.authority.sessionId,
          a.provider,
          a.instance,
          a.generation,
          expiresAt,
        ],
      },
      { text: 'DELETE FROM calendar_sync_guard RETURNING allowed', params: [] },
    ])
  },
  async consume(actor, provider, stateHash, requesterHash) {
    const result = await atomicStatements(database, [
      {
        text: `UPDATE calendar_oauth_attempts SET consumed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE state_hash=? AND requester_hash=? AND user_id=? AND session_id=? AND provider=?
      AND consumed_at IS NULL AND julianday(expires_at)>julianday('now')
      AND instance_nonce=(SELECT nonce FROM calendar_sync_instance WHERE singleton=1)
      AND expected_generation=coalesce((SELECT generation FROM calendar_connections WHERE user_id=? AND provider=?),0)
      AND ${authority} RETURNING instance_nonce,expected_generation`,
        params: [
          stateHash,
          requesterHash,
          actor.userId,
          actor.sessionId,
          provider,
          actor.userId,
          provider,
          actor.sessionId,
          actor.userId,
        ],
      },
    ])
    const row = result[0]?.[0] as
      { instance_nonce: string; expected_generation: number } | undefined
    return row
      ? {
          stateHash,
          requesterHash,
          authority: actor,
          provider,
          instance: row.instance_nonce,
          generation: row.expected_generation,
        }
      : null
  },
  async orphan(a, c, now) {
    await database.run(sql`INSERT OR IGNORE INTO calendar_cleanup_obligations(id,user_id,provider,instance_nonce,generation,credential_revision,key_id,sealed_grant,reason,status,created_at)
    VALUES(${a.stateHash},${a.authority.userId},${a.provider},${c.instance},${c.generation},${c.credentialRevision},${c.keyId},${c.sealedGrant},'reauth',
    CASE WHEN ${a.provider}='microsoft' OR ${c.instance}<>(SELECT nonce FROM calendar_sync_instance WHERE singleton=1) THEN 'manual_required' ELSE 'pending' END,${now})`)
  },
  async claimCleanup(keyId, holder, now) {
    // A changed deployment key or incarnation must never revoke another installation's grant.
    await database.run(sql`UPDATE calendar_cleanup_obligations SET status='manual_required'
      WHERE status='pending' AND (key_id<>${keyId} OR instance_nonce<>(SELECT nonce FROM calendar_sync_instance WHERE singleton=1) OR provider='microsoft')`)
    const rows = await database.all<
      Record<string, unknown>
    >(sql`UPDATE calendar_cleanup_obligations SET lease_holder=${holder},lease_expires_at=${new Date(Date.parse(now) + 60000).toISOString()},attempts=attempts+1
      WHERE id IN(SELECT id FROM calendar_cleanup_obligations WHERE status='pending' AND provider='google' AND key_id=${keyId}
      AND instance_nonce=(SELECT nonce FROM calendar_sync_instance WHERE singleton=1)
      AND (lease_holder IS NULL OR julianday(lease_expires_at)<=julianday(${now})) AND (next_attempt_at IS NULL OR julianday(next_attempt_at)<=julianday(${now})) ORDER BY created_at,id LIMIT 5)
      RETURNING *`)
    return rows.map((r) => ({
      id: String(r.id),
      userId: Number(r.user_id),
      provider: r.provider as 'google',
      instance: String(r.instance_nonce),
      generation: Number(r.generation),
      credentialRevision: Number(r.credential_revision),
      keyId: String(r.key_id),
      sealedGrant: String(r.sealed_grant),
      holder,
    }))
  },
  async finishCleanup(c, outcome, now) {
    const receipt = JSON.stringify({
      provider: c.provider,
      completed_at: now,
      evidence: 'provider_token_revocation',
    })
    await database.run(sql`UPDATE calendar_cleanup_obligations SET status=CASE WHEN ${outcome}='retry' THEN status ELSE ${outcome} END,
      sealed_grant=CASE WHEN ${outcome}='revoked' THEN NULL ELSE sealed_grant END,
      sealed_receipt=CASE WHEN ${outcome}='revoked' THEN ${receipt} ELSE NULL END,
      completed_at=CASE WHEN ${outcome}='revoked' THEN ${now} ELSE NULL END,
      next_attempt_at=CASE WHEN ${outcome}='retry' THEN ${new Date(Date.parse(now) + 60000).toISOString()} ELSE NULL END,
      lease_holder=NULL,lease_expires_at=NULL
      WHERE id=${c.id} AND status='pending' AND lease_holder=${c.holder} AND sealed_grant=${c.sealedGrant}`)
  },
  async dueConnections(now) {
    return database.all<{
      userId: number
      provider: 'google' | 'microsoft'
    }>(sql`SELECT c.user_id AS userId,c.provider FROM calendar_connections c JOIN users u ON u.id=c.user_id
      WHERE c.status='connected' AND u.is_active=1 AND c.instance_nonce=(SELECT nonce FROM calendar_sync_instance WHERE singleton=1)
      AND NOT EXISTS(SELECT 1 FROM account_closures WHERE user_id=c.user_id)
      AND (c.last_synced_at IS NULL OR julianday(c.last_synced_at)<=julianday(${now})-5.0/1440)
      AND (c.last_error IS NULL OR julianday(c.updated_at)<=julianday(${now})-5.0/1440)
      AND (c.lease_holder IS NULL OR julianday(c.lease_expires_at)<=julianday(${now}))
      ORDER BY coalesce(c.last_synced_at,c.updated_at),c.user_id,c.provider LIMIT 5`)
  },
})
