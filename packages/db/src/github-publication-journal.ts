import type { PublicationJournal, PublicationKey, PublicationRecord } from '@ezacto/integrations'
import { atomicStatements } from './atomic-statements.js'
import type { InvoiceStateDatabase } from './invoice-state.js'

const sql = (text: string, ...params: unknown[]) => ({ text, params })
export const publicationRecord = (row: Record<string, unknown>): PublicationRecord => ({
  connectionId: String(row.connection_id),
  entryId: String(row.entry_id),
  itemId: String(row.issue_number),
  status: row.status as PublicationRecord['status'],
  sourceVersion: Number(row.source_version),
  remoteId: row.remote_id === null ? null : String(row.remote_id),
  lastBody: row.last_body === null ? null : String(row.last_body),
  lastPublished:
    row.last_date === null
      ? null
      : { spentDate: String(row.last_date), seconds: Number(row.last_seconds) },
  attemptedAt: row.attempted_at === null ? null : Number(row.attempted_at),
  pendingWrite:
    row.pending_write === null
      ? null
      : (JSON.parse(String(row.pending_write)) as PublicationRecord['pendingWrite']),
  retryAt: row.retry_at === null ? null : Number(row.retry_at),
  fence: Number(row.fence),
  createAttempts: Number(row.create_attempts),
})

/** The row is created only by explicit per-link consent. A lease is shared across
 * destinations for an entry, so moving it cannot race two outbound comments. */
export class NativeGithubPublicationJournal implements PublicationJournal {
  private incarnation: string | null = null
  constructor(
    private readonly database: InvoiceStateDatabase,
    readonly id: number,
    private readonly now: () => number,
  ) {}
  async claim(key: PublicationKey, sourceVersion: number): Promise<PublicationRecord | null> {
    const now = this.now()
    const [rows] = await atomicStatements(this.database, [
      sql(
        `UPDATE github_publications SET fence=fence+1,lease_until=?
      WHERE id=? AND connection_id=? AND entry_id=? AND issue_number=? AND source_version=?
        AND status NOT IN ('unlinked','adopted') AND (lease_until IS NULL OR lease_until<=?)
        AND NOT EXISTS(SELECT 1 FROM github_publications other WHERE other.entry_id=github_publications.entry_id AND other.id<>github_publications.id AND (other.lease_until>? OR (github_publications.desired_date IS NOT NULL AND other.status NOT IN ('retired','unlinked') AND (other.remote_id IS NOT NULL OR other.attempted_at IS NOT NULL))))
        AND EXISTS(SELECT 1 FROM github_publication_policy p JOIN github_read_connections c ON c.id=p.connection_id
          WHERE p.connection_id=github_publications.connection_id AND p.enabled=1 AND p.instance_nonce=(SELECT nonce FROM github_publication_instance WHERE singleton=1) AND c.state='active')
      RETURNING *, (SELECT nonce FROM github_publication_instance WHERE singleton=1) incarnation`,
        now + 120000,
        this.id,
        key.connectionId,
        Number(key.entryId),
        key.itemId,
        sourceVersion,
        now,
        now,
      ),
    ])
    this.incarnation = rows?.[0] ? String(rows[0].incarnation) : null
    return rows?.[0] ? publicationRecord(rows[0]) : null
  }
  async save(record: PublicationRecord): Promise<boolean> {
    const [rows] = await atomicStatements(this.database, [
      sql(
        `UPDATE github_publications SET status=?,remote_id=?,last_body=?,last_date=?,last_seconds=?,attempted_at=?,pending_write=?,retry_at=?,create_attempts=?
      WHERE id=? AND fence=? AND lease_until>? AND (SELECT nonce FROM github_publication_instance WHERE singleton=1)=? RETURNING id`,
        record.status,
        record.remoteId,
        record.lastBody,
        record.lastPublished?.spentDate ?? null,
        record.lastPublished?.seconds ?? null,
        record.attemptedAt,
        record.pendingWrite === null ? null : JSON.stringify(record.pendingWrite),
        record.retryAt,
        record.createAttempts ?? 0,
        this.id,
        record.fence,
        this.now(),
        this.incarnation,
      ),
    ])
    return rows?.length === 1
  }
  async release(_key: PublicationKey, fence: number): Promise<void> {
    await atomicStatements(this.database, [
      sql(
        'UPDATE github_publications SET lease_until=NULL WHERE id=? AND fence=? RETURNING id',
        this.id,
        fence,
      ),
    ])
  }
  /** Called immediately before HTTP mutation. Acknowledgements remain saveable
   * after revocation, but a fresh remote write needs all current authorizations. */
  async permit(
    fence: number,
    version: number,
    generation: number,
    policyGeneration: number,
  ): Promise<boolean> {
    const [rows] = await atomicStatements(this.database, [
      sql(
        `SELECT p.id FROM github_publications p
      JOIN github_publication_policy policy ON policy.connection_id=p.connection_id
      JOIN github_read_connections c ON c.id=p.connection_id
      JOIN github_read_resources r ON r.connection_id=c.id AND r.repository_id=p.repository_id
      WHERE p.id=? AND p.fence=? AND p.lease_until>? AND p.source_version=? AND p.status NOT IN ('unlinked','adopted')
        AND c.state='active' AND c.generation=? AND policy.enabled=1 AND policy.generation=? AND policy.instance_nonce=(SELECT nonce FROM github_publication_instance WHERE singleton=1) AND r.state IN ('active','renamed')
        AND NOT EXISTS(SELECT 1 FROM migration_loads WHERE status<>'completed' AND (status<>'cancelled' OR started_at IS NOT NULL))
        AND NOT EXISTS(SELECT 1 FROM account_closures WHERE user_id=c.owner_user_id)
        AND NOT EXISTS(SELECT 1 FROM account_restore_quarantine WHERE id=1 AND quarantined=1)`,
        this.id,
        fence,
        this.now(),
        version,
        generation,
        policyGeneration,
      ),
    ])
    return rows?.length === 1
  }
}
