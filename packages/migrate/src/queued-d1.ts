import {
  createQueuedMigrationStore,
  type MigrationLeaseAuthority,
} from '@ezacto/db/queued-migrations'

/**
 * Include the run and lease guard in the same atomic D1 batch as EVERY loader write,
 * including writes performed by the shared invoice/attachment import repositories.
 * A process cannot leave a context row behind when it dies between requests.
 */
export const migrationD1 = (
  db: D1Database,
  runId: string,
  lease: MigrationLeaseAuthority,
): D1Database => {
  const store = createQueuedMigrationStore(db)
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>()
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const read = /^\s*(?:SELECT\b|EXPLAIN\b)/i.test(sql)
    const proxy = new Proxy(statement, {
      get(target, key) {
        if (key === 'bind') return (...args: unknown[]) => wrap(target.bind(...args), sql)
        if (key === 'run') return async () => (await store.guarded(runId, lease, [target]))[0]!
        if (!read && ['all', 'first', 'raw'].includes(String(key)))
          return async () => {
            // Drizzle's returning() uses all(); mutation first/raw is deliberately unsupported.
            if (key !== 'all') throw new Error('Queued migration writes must use run() or all()')
            return (await store.guarded(runId, lease, [target]))[0]!
          }
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    originals.set(proxy, statement)
    return proxy
  }
  return new Proxy(db, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql)
      if (key === 'batch')
        return (statements: D1PreparedStatement[]) =>
          store.guarded(
            runId,
            lease,
            statements.map((statement) => {
              const original = originals.get(statement)
              if (!original) throw new Error('Queued migration batch contains an unbound statement')
              return original
            }),
          )
      if (key === 'exec' || key === 'withSession')
        return () => {
          throw new Error('Queued migration requires fenced prepared statements')
        }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
