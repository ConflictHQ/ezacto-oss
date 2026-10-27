import {
  CalendarConnectionError,
  type CalendarConnectionAuthority,
  type CalendarOperatorCleanupConfirmation,
  type CalendarOperatorCleanupReceipt,
  type CalendarOperatorCleanupReview,
  type CalendarOperatorCleanupStore,
} from '@ezacto/core'
import { atomicStatements } from './atomic-statements.js'
import type { InvoiceStateDatabase } from './invoice-state.js'

const authority = `EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
 WHERE s.id=? AND s.user_id=? AND s.revoked_at IS NULL AND u.is_active=1 AND u.profile='administrator'
 AND s.profile_snapshot=u.profile AND s.manager_grants_snapshot=u.manager_grants
 AND julianday(s.idle_expires_at)>julianday('now') AND julianday(s.absolute_expires_at)>julianday('now')
 AND NOT EXISTS(SELECT 1 FROM account_closures WHERE user_id=u.id))
 AND NOT EXISTS(SELECT 1 FROM account_restore_quarantine WHERE id=1 AND quarantined=1)
 AND NOT EXISTS(SELECT 1 FROM migration_loads WHERE status<>'completed' AND (status<>'cancelled' OR started_at IS NOT NULL))`
const eligible = `(c.instance_nonce<>(SELECT nonce FROM calendar_sync_instance WHERE singleton=1) OR c.reason IN ('closure','restore','reset'))`
const identityMatch = `c.id=? AND c.user_id=? AND c.provider=? AND c.instance_nonce=? AND c.generation=?
 AND c.credential_revision=? AND c.key_id=? AND c.request_id IS ? AND c.reason=?`
const identityValues = (input: CalendarOperatorCleanupConfirmation) => [
  input.id,
  input.user_id,
  input.provider,
  input.instance_nonce,
  input.generation,
  input.credential_revision,
  input.key_id,
  input.request_id,
  input.reason,
]
const digest = async (value: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
const receipt = (row: Record<string, unknown>): CalendarOperatorCleanupReceipt => ({
  obligation_id: String(row.obligation_id),
  kind: 'operator_attestation',
  provider_verified: false,
  attested_at: String(row.attested_at),
  evidence_sha256: String(row.evidence_sha256),
})
export const createCalendarOperatorCleanupStore = (
  database: InvoiceStateDatabase,
): CalendarOperatorCleanupStore => {
  const authorize = async (actor: CalendarConnectionAuthority) => {
    const result = await atomicStatements(database, [
      { text: `SELECT 1 WHERE ${authority}`, params: [actor.sessionId, actor.userId] },
    ])
    if (!result[0]?.length) throw new CalendarConnectionError('forbidden')
  }
  return {
    async list(actor, after = '') {
      await authorize(actor)
      const result = await atomicStatements(database, [
        {
          text: `SELECT c.id,c.user_id,c.provider,c.instance_nonce,c.generation,c.credential_revision,c.key_id,c.request_id,c.reason,c.status,c.created_at,
        (SELECT nonce FROM calendar_sync_instance WHERE singleton=1) AS review_instance,
        CASE WHEN c.lease_holder IS NOT NULL AND julianday(c.lease_expires_at)>julianday('now') THEN 1 ELSE 0 END AS provider_cleanup_in_progress
        FROM calendar_cleanup_obligations c WHERE c.id>? AND c.status<>'revoked' AND ${eligible} AND ${authority} ORDER BY c.id LIMIT 101`,
          params: [after, actor.sessionId, actor.userId],
        },
      ])
      const rows = result[0] ?? []
      const page = rows.slice(0, 100).map((row) => ({
        ...row,
        provider_cleanup_in_progress: row.provider_cleanup_in_progress === 1,
      })) as unknown as CalendarOperatorCleanupReview[]
      return { data: page, next_cursor: rows.length > 100 ? page.at(-1)!.id : null }
    },
    async confirm(actor, input) {
      await authorize(actor)
      const evidence = input.evidence_reference.trim()
      if (
        evidence.length < 20 ||
        evidence.length > 1000 ||
        /\p{Cc}/u.test(evidence) ||
        input.confirm_provider_removed !== true
      )
        throw new CalendarConnectionError('invalid')
      const evidenceHash = await digest(evidence),
        now = new Date().toISOString()
      const values = identityValues(input)
      const prior = await atomicStatements(database, [
        {
          text: `SELECT r.* FROM calendar_operator_cleanup_receipts r JOIN calendar_cleanup_obligations c ON c.id=r.obligation_id
        WHERE ${identityMatch} AND r.review_instance=? AND r.review_instance=(SELECT nonce FROM calendar_sync_instance WHERE singleton=1) AND r.previous_status=? AND r.evidence_sha256=? AND r.administrator_user_id=? AND ${authority}`,
          params: [
            ...values,
            input.review_instance,
            input.expected_status,
            evidenceHash,
            actor.userId,
            actor.sessionId,
            actor.userId,
          ],
        },
      ])
      if (prior[0]?.length) return receipt(prior[0][0]!)
      try {
        const rows = await atomicStatements(database, [
          {
            text: `INSERT INTO calendar_sync_guard(allowed) SELECT CASE WHEN ${authority} AND ?=(SELECT nonce FROM calendar_sync_instance WHERE singleton=1)
            AND EXISTS(SELECT 1 FROM calendar_cleanup_obligations c WHERE ${identityMatch} AND ${eligible} AND c.status=?
              AND (c.lease_holder IS NULL OR julianday(c.lease_expires_at)<=julianday('now')))
            AND NOT EXISTS(SELECT 1 FROM calendar_operator_cleanup_receipts WHERE obligation_id=?) THEN 1 ELSE 0 END RETURNING allowed`,
            params: [
              actor.sessionId,
              actor.userId,
              input.review_instance,
              ...values,
              input.expected_status,
              input.id,
            ],
          },
          {
            text: `INSERT INTO calendar_operator_cleanup_receipts(obligation_id,subject_user_id,provider,instance_nonce,generation,credential_revision,key_id,request_id,reason,previous_status,review_instance,administrator_user_id,administrator_session_id,evidence_reference,evidence_sha256,attested_at,assertion)
            SELECT c.id,c.user_id,c.provider,c.instance_nonce,c.generation,c.credential_revision,c.key_id,c.request_id,c.reason,c.status,?,?,?,?,?,?,'operator_confirmed_provider_permission_removal' FROM calendar_cleanup_obligations c WHERE c.id=? RETURNING *`,
            params: [
              input.review_instance,
              actor.userId,
              actor.sessionId,
              evidence,
              evidenceHash,
              now,
              input.id,
            ],
          },
          {
            text: `UPDATE calendar_cleanup_obligations SET status='revoked',sealed_grant=NULL,sealed_receipt=?,completed_at=?,lease_holder=NULL,lease_expires_at=NULL WHERE id=? RETURNING id`,
            params: [
              JSON.stringify({
                kind: 'operator_attestation',
                provider_verified: false,
                evidence_sha256: evidenceHash,
                attested_at: now,
              }),
              now,
              input.id,
            ],
          },
          { text: 'DELETE FROM calendar_sync_guard RETURNING allowed', params: [] },
        ])
        return receipt(rows[1]![0]!)
      } catch (error) {
        if (
          error instanceof Error &&
          /CHECK constraint failed:\s*allowed\s*=\s*1/i.test(error.message)
        )
          throw new CalendarConnectionError('changed')
        throw error
      }
    },
  }
}
