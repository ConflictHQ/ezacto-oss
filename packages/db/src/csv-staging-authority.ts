import type { CsvStagingAuthority } from '@ezacto/core'
import type { CompiledQuery } from './tracked-state.js'
/** A native session row proof, evaluated on SQLite's live statement clock.
 * Null target is only for initial metadata authorization; writers bind the
 * concrete nonce returned by that read. No cookie material enters this port. */
export const csvStagingSessionFence = (
  authority: CsvStagingAuthority,
  targetNonce: string | null,
  actorUserId = authority.userId,
): CompiledQuery => {
  if (
    !Number.isSafeInteger(authority.userId) ||
    authority.userId < 1 ||
    !Number.isSafeInteger(authority.sessionRowId) ||
    authority.sessionRowId < 1 ||
    (targetNonce !== null && !/^[a-f0-9]{64}$/.test(targetNonce))
  )
    throw new RangeError('Invalid CSV session proof')
  if (actorUserId !== authority.userId) return { sql: '0', params: [] }
  return {
    sql: `EXISTS(SELECT 1 FROM sessions session JOIN users actor ON actor.id=session.user_id
    CROSS JOIN csv_staging_instance target WHERE session.id=? AND actor.id=?
      AND actor.is_active=1 AND actor.profile='administrator' AND session.profile_snapshot='administrator'
      AND json(session.manager_grants_snapshot)=json(actor.manager_grants)
      AND session.revoked_at IS NULL AND julianday(session.idle_expires_at)>julianday('now')
      AND julianday(session.absolute_expires_at)>julianday('now')
      AND NOT EXISTS(SELECT 1 FROM account_closures WHERE user_id=actor.id)
      AND (? IS NULL OR target.nonce=?))`,
    params: [authority.sessionRowId, authority.userId, targetNonce, targetNonce],
  }
}
