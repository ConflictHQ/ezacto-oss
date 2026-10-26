import type { CsvStagingAuthority } from '@ezacto/core'
import { csvStagingSessionFence } from './csv-staging-authority.js'

export interface CsvWorkerExecution {
  stageId: string
  targetNonce: string
  authority: CsvStagingAuthority
  generation: number
  holder: string
}

/** Every native write and its revision acknowledgement share one real D1 batch.
 * SELECT-only preview never uses this adapter and never mutates durable state. */
export const csvWorkerDatabase = (database: D1Database, execution: CsvWorkerExecution): D1Database => {
  const statements = new WeakMap<D1PreparedStatement, { original: D1PreparedStatement; sql: string }>()
  const guard = () => {
    const authority = csvStagingSessionFence(execution.authority, execution.targetNonce)
    return {
      sql: `(${authority.sql}) AND NOT EXISTS(SELECT 1 FROM account_restore_quarantine WHERE id=1 AND quarantined=1) AND NOT EXISTS(SELECT 1 FROM migration_loads WHERE status<>'completed' AND (status<>'cancelled' OR started_at IS NOT NULL)) AND EXISTS(SELECT 1 FROM csv_worker_stages s JOIN csv_worker_revision r ON r.singleton=1
        WHERE s.id=? AND s.target_nonce=? AND s.owner_id=? AND s.session_id=? AND s.status IN('confirmed','running')
        AND s.revision=r.revision AND s.lease_generation=? AND s.lease_holder=?
        AND julianday(s.lease_expires_at)>julianday('now') AND julianday(s.expires_at)>julianday('now') AND s.cancellation_id IS NULL)`,
      params: [...authority.params, execution.stageId, execution.targetNonce, execution.authority.userId, execution.authority.sessionRowId, execution.generation, execution.holder],
    }
  }
  const execute = async (items: D1PreparedStatement[]): Promise<D1Result[]> => {
    const values = items.map(item => {
      const bound = statements.get(item)
      if (!bound) throw new Error('CSV D1 statement is not bound to this execution')
      return bound
    })
    if (values.every(value => /^\s*(?:SELECT|EXPLAIN)\b/iu.test(value.sql))) return database.batch(values.map(value => value.original))
    const proof = guard()
    const result = await database.batch([
      database.prepare(`INSERT INTO csv_worker_fence(allowed) VALUES(CASE WHEN ${proof.sql} THEN 1 ELSE 0 END)`).bind(...proof.params),
      ...values.map(value => value.original),
      database.prepare(`UPDATE csv_worker_stages SET revision=(SELECT revision FROM csv_worker_revision WHERE singleton=1) WHERE id=? AND lease_generation=? AND lease_holder=?`).bind(execution.stageId, execution.generation, execution.holder),
      database.prepare('DELETE FROM csv_worker_fence'),
    ])
    return result.slice(1, -2)
  }
  const wrap = (original: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const statement = new Proxy(original, { get(target, key) {
      if (key === 'bind') return (...params: unknown[]) => wrap(target.bind(...params), sql)
      if (key === 'run' || key === 'all') return async () => (await execute([statement]))[0]!
      if (key === 'first') return async (column?: string) => {
        const row = (await execute([statement]))[0]?.results[0] as Record<string, unknown> | undefined
        return column === undefined ? row ?? null : row?.[column] ?? null
      }
      if (key === 'raw') return async (options?: {columnNames?: boolean}) => {
        if (/^\s*(?:SELECT|EXPLAIN)\b/iu.test(sql)) return options?.columnNames ? target.raw({columnNames:true}) : target.raw()
        const rows = (await execute([statement]))[0]?.results as Record<string,unknown>[]
        const values = rows.map(row => Object.values(row))
        return options?.columnNames && rows[0] ? [Object.keys(rows[0]),...values] : values
      }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
    statements.set(statement, { original, sql })
    return statement
  }
  return new Proxy(database, { get(target, key) {
    if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql)
    if (key === 'batch') return execute
    if (key === 'exec' || key === 'withSession') return () => { throw new Error('CSV D1 execution requires fenced prepared statements') }
    const value = Reflect.get(target, key, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
}
