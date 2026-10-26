import { atomicStatements } from './atomic-statements.js'
import type { InvoiceStateDatabase } from './invoice-state.js'

export interface GithubReaderWork {
  connectionId: string
  generation: number
  repositoryId: string
  fullName: string
  attempt: number
  token: string
}
/** Read-only provider work leases: one page, at most five persisted failures.
 * Read/token HTTP is outside each native batch and never automatically retried.
 */
export class NativeGithubReaderWork {
  constructor(private readonly database: InvoiceStateDatabase) {}
  async claim(now: number): Promise<GithubReaderWork | null> {
    const token = crypto.randomUUID()
    const result = await atomicStatements(this.database, [
      {
        text: `UPDATE github_read_resources SET lease_token=?,lease_expires_at=?,attempts=attempts+1
   WHERE (connection_id,repository_id)=(SELECT r.connection_id,r.repository_id FROM github_read_resources r JOIN github_read_connections c ON c.id=r.connection_id
    WHERE c.state='active' AND r.state IN ('active','renamed') AND r.project_id IS NOT NULL AND r.task_id IS NOT NULL
      AND r.attempts<5 AND r.next_due<=? AND (r.lease_expires_at IS NULL OR r.lease_expires_at<=?) AND (c.cooldown IS NULL OR c.cooldown<=?)
    ORDER BY r.next_due,r.connection_id,r.repository_id LIMIT 1)
   RETURNING connection_id,repository_id,full_name,attempts`,
        params: [token, now + 120000, now, now, now],
      },
      {
        text: 'SELECT generation FROM github_read_connections WHERE id=(SELECT connection_id FROM github_read_resources WHERE lease_token=?)',
        params: [token],
      },
    ])
    const row = result[0]?.[0],
      generation = result[1]?.[0]?.generation
    return row && generation !== undefined
      ? {
          connectionId: String(row.connection_id),
          repositoryId: String(row.repository_id),
          fullName: String(row.full_name),
          generation: Number(generation),
          attempt: Number(row.attempts),
          token,
        }
      : null
  }
  async finish(
    work: GithubReaderWork,
    now: number,
    outcome: 'applied' | 'conflict' | 'deferred' | 'unavailable' | 'revoked',
    code: string | null = null,
  ): Promise<void> {
    // Only this exact unexpired holder may update its lease. A later holder or
    // connection generation cannot have progress overwritten by a stale completion.
    await atomicStatements(this.database, [
      {
        text: `UPDATE github_read_resources SET lease_token=NULL,lease_expires_at=NULL,
    attempts=CASE WHEN ? IN ('applied','conflict') THEN 0 ELSE attempts END,
    next_due=CASE WHEN ?='deferred' THEN max(?,COALESCE((SELECT cooldown FROM github_read_connections WHERE id=connection_id),?)) ELSE ? END,
    failure_code=? WHERE connection_id=? AND repository_id=? AND lease_token=? AND lease_expires_at>? AND EXISTS(SELECT 1 FROM github_read_connections c WHERE c.id=connection_id AND c.generation=?) RETURNING repository_id`,
        params: [
          outcome,
          outcome,
          now + 1000,
          now + 1000,
          now + 60000,
          code,
          work.connectionId,
          work.repositoryId,
          work.token,
          now,
          work.generation,
        ],
      },
    ])
  }
}
