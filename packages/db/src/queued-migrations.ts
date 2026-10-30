import {
  parseMigrationLoadOptions,
  parseMigrationSnapshotCatalog,
  QueuedMigrationError,
  type MigrationLoadMessage,
  type MigrationLoadStatus,
  type MigrationLoadOptions,
  type MigrationSnapshotCatalog,
} from '@ezacto/core'

export const migrationLoadStatusProjection = `id,status,snapshot_sha256 AS snapshotSha256,source_rows AS sourceRows,
  resource,rows_done AS rowsDone,sequence,attempts,error_code AS errorCode,
  created_at AS createdAt,started_at AS startedAt,completed_at AS completedAt,source_cleaned_at AS sourceCleanedAt,updated_at AS updatedAt`
export const migrationAccessSql = `SELECT EXISTS(SELECT 1 FROM migration_loads
  WHERE status<>'completed' AND (status<>'cancelled' OR started_at IS NOT NULL)) AS blocked,
  EXISTS(SELECT 1 FROM users) AS populated`
export interface QueuedMigrationJob extends MigrationLoadStatus {
  catalog: MigrationSnapshotCatalog
  options: MigrationLoadOptions
}
export interface MigrationLeaseAuthority {
  holder: string
  fence: number
  now: () => number
}
export const createQueuedMigrationStore = (db: D1Database) => {
  const status = (id: string) =>
    db
      .prepare(`SELECT ${migrationLoadStatusProjection} FROM migration_loads WHERE id=?`)
      .bind(id)
      .first<MigrationLoadStatus>()
  const job = async (id: string): Promise<QueuedMigrationJob | null> => {
    const row = await db
      .prepare(
        `SELECT ${migrationLoadStatusProjection},catalog_json,options_json FROM migration_loads WHERE id=?`,
      )
      .bind(id)
      .first<MigrationLoadStatus & { catalog_json: string; options_json: string }>()
    if (!row) return null
    const { catalog_json, options_json, ...state } = row
    return {
      ...state,
      catalog: parseMigrationSnapshotCatalog(JSON.parse(catalog_json)),
      options: parseMigrationLoadOptions(JSON.parse(options_json)),
    }
  }
  const create = async (input: unknown, options: unknown, now: string) => {
    const catalog = parseMigrationSnapshotCatalog(input),
      decisions = parseMigrationLoadOptions(options)
    // The INSERT trigger and unique destination slot serialize bootstrap and operator races.
    await db
      .prepare(
        `INSERT INTO migration_loads(id,catalog_json,options_json,snapshot_sha256,source_rows,status,created_at,updated_at)
      VALUES(?,?,?,?,?,'ready',?,?)`,
      )
      .bind(
        catalog.jobId,
        JSON.stringify(catalog),
        JSON.stringify(decisions),
        catalog.snapshotSha256,
        catalog.sourceRows,
        now,
        now,
      )
      .run()
    return (await status(catalog.jobId))!
  }
  const pending = async (id: string): Promise<MigrationLoadMessage | null> => {
    const row = await db
      .prepare(
        `SELECT job.id,job.sequence FROM migration_loads job
      JOIN migration_load_intents intent ON intent.run_id=job.id AND intent.sequence=job.sequence
      WHERE job.id=? AND job.status IN ('queued','running')`,
      )
      .bind(id)
      .first<{ id: string; sequence: number }>()
    return row ? { kind: 'migration-load-v1', runId: row.id, sequence: row.sequence } : null
  }
  const start = async (id: string, now: string) => {
    await db.batch([
      db
        .prepare(
          `UPDATE migration_loads SET status='queued',updated_at=? WHERE id=? AND status='ready'`,
        )
        .bind(now, id),
      db
        .prepare(
          `INSERT OR IGNORE INTO migration_load_intents(run_id,sequence,created_at)
        SELECT id,sequence,? FROM migration_loads WHERE id=? AND status='queued'`,
        )
        .bind(now, id),
    ])
    const message = await pending(id)
    if (!message) throw new QueuedMigrationError('migration_not_startable', 'id')
    return message
  }
  const sent = async (message: MigrationLoadMessage, now: string) => {
    await db.batch([
      db
        .prepare('UPDATE migration_load_intents SET sent_at=? WHERE run_id=? AND sequence=?')
        .bind(now, message.runId, message.sequence),
      db
        .prepare(
          "UPDATE migration_loads SET error_code=NULL,updated_at=? WHERE id=? AND sequence=? AND error_code='migration_queue_publish_failed'",
        )
        .bind(now, message.runId, message.sequence),
    ])
  }
  const publicationFailed = async (message: MigrationLoadMessage, now: string) => {
    await db
      .prepare(
        "UPDATE migration_loads SET error_code='migration_queue_publish_failed',updated_at=? WHERE id=? AND sequence=? AND status IN ('queued','running')",
      )
      .bind(now, message.runId, message.sequence)
      .run()
  }
  const begin = async (message: MigrationLoadMessage, now: string) => {
    const result = await db
      .prepare(
        `UPDATE migration_loads SET status='running',started_at=coalesce(started_at,?),
      updated_at=?,attempts=attempts+1 WHERE id=? AND sequence=? AND status IN ('queued','running')`,
      )
      .bind(now, now, message.runId, message.sequence)
      .run()
    return result.meta.changes === 1
  }
  const authority = (id: string, lease: MigrationLeaseAuthority) =>
    db
      .prepare(
        `INSERT INTO _ezacto_migration_write_context
    (singleton,run_id,holder,fence,at_ms,allowed) SELECT 1,?,?,?,?,CASE WHEN EXISTS(
      SELECT 1 FROM migration_loads job JOIN _ezacto_load_lease lease ON lease.singleton=1
      WHERE job.id=? AND job.status='running' AND job.snapshot_sha256=lease.snapshot_sha256
        AND lease.holder=? AND lease.fence=? AND lease.released_at IS NULL AND lease.expires_at>?
    ) THEN 1 ELSE 0 END`,
      )
      .bind(id, lease.holder, lease.fence, lease.now(), id, lease.holder, lease.fence, lease.now())
  const guarded = async <T = unknown>(
    id: string,
    lease: MigrationLeaseAuthority,
    statements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]> => {
    try {
      const results = await db.batch<T>([
        authority(id, lease),
        ...statements,
        db.prepare('DELETE FROM _ezacto_migration_write_context'),
      ])
      return results.slice(1, -1)
    } catch (error) {
      if (error instanceof Error && /allowed\s*=\s*1/.test(error.message))
        throw new QueuedMigrationError('migration_lease_lost')
      throw error
    }
  }
  const checkpoint = async (
    message: MigrationLoadMessage,
    lease: MigrationLeaseAuthority,
    progress: { resource: string | null; rowsDone: number; complete: boolean },
    now: string,
  ) => {
    await guarded(message.runId, lease, [
      db
        .prepare(
          `UPDATE migration_loads SET status=?,resource=?,rows_done=?,sequence=sequence+1,
        completed_at=?,updated_at=?,error_code=NULL WHERE id=? AND sequence=? AND status='running'`,
        )
        .bind(
          progress.complete ? 'completed' : 'queued',
          progress.resource,
          progress.rowsDone,
          progress.complete ? now : null,
          now,
          message.runId,
          message.sequence,
        ),
      db
        .prepare(
          `INSERT OR IGNORE INTO migration_load_intents(run_id,sequence,created_at)
        SELECT id,sequence,? FROM migration_loads WHERE id=? AND status='queued'`,
        )
        .bind(now, message.runId),
    ])
    return pending(message.runId)
  }
  const fail = async (
    message: MigrationLoadMessage,
    code: string,
    now: string,
    lease?: MigrationLeaseAuthority,
  ) => {
    if (!/^[a-z][a-z0-9_]{0,79}$/.test(code))
      throw new QueuedMigrationError('invalid_migration_error_code')
    await db
      .prepare(
        `UPDATE migration_loads SET status='failed',error_code=?,updated_at=?
      WHERE id=? AND sequence=? AND status IN ('queued','running')
        AND (? IS NULL OR EXISTS(SELECT 1 FROM _ezacto_load_lease WHERE singleton=1 AND holder=? AND fence=? AND released_at IS NULL AND expires_at>?))`,
      )
      .bind(
        code,
        now,
        message.runId,
        message.sequence,
        lease?.holder ?? null,
        lease?.holder ?? null,
        lease?.fence ?? null,
        lease?.now() ?? null,
      )
      .run()
  }
  const cancel = async (id: string, now: string) => {
    await db
      .prepare(
        `UPDATE migration_loads SET status='cancelled',updated_at=?
      WHERE id=? AND status IN ('ready','queued','running','failed')`,
      )
      .bind(now, id)
      .run()
    return status(id)
  }
  const sourceCleaned = async (id: string, now: string) => {
    await db
      .prepare(
        "UPDATE migration_loads SET source_cleaned_at=coalesce(source_cleaned_at,?),error_code=NULL,updated_at=? WHERE id=? AND status='completed'",
      )
      .bind(now, now, id)
      .run()
  }
  const cleanupFailed = async (id: string, now: string) => {
    await db
      .prepare(
        "UPDATE migration_loads SET error_code='migration_cleanup_failed',updated_at=? WHERE id=? AND status='completed' AND source_cleaned_at IS NULL",
      )
      .bind(now, id)
      .run()
  }
  const access = async () => {
    const row = await db.prepare(migrationAccessSql).first<{ blocked: number; populated: number }>()
    if (!row) throw new QueuedMigrationError('migration_access_unavailable')
    return { blocked: row.blocked === 1, populated: row.populated === 1 }
  }
  const blocked = async () => (await access()).blocked
  const retry = async (id: string, now: string) => {
    await db.batch([
      db
        .prepare(
          `UPDATE migration_loads SET status='queued',error_code=NULL,updated_at=? WHERE id=? AND status='failed'`,
        )
        .bind(now, id),
      db
        .prepare(
          `INSERT OR IGNORE INTO migration_load_intents(run_id,sequence,created_at) SELECT id,sequence,? FROM migration_loads WHERE id=? AND status='queued'`,
        )
        .bind(now, id),
    ])
    const message = await pending(id)
    if (!message) throw new QueuedMigrationError('migration_not_retryable', 'id')
    return message
  }
  return {
    status,
    job,
    create,
    start,
    pending,
    sent,
    publicationFailed,
    begin,
    guarded,
    checkpoint,
    fail,
    cancel,
    sourceCleaned,
    cleanupFailed,
    retry,
    blocked,
    access,
  }
}
