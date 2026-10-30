import { Miniflare } from 'miniflare'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { isOrdinaryD1SchemaStatement } from '../src/internal/d1-cold-migrations.js'
import { migrateD1, migrateD1Through, migrationIds } from '../src/migrate.js'
import { clientsMigration } from '../src/migrations/0001_clients.js'

describe('conservative cold D1 schema classification', () => {
  it.each([
    'CREATE TABLE example (id INTEGER PRIMARY KEY, note TEXT DEFAULT \';\')',
    'CREATE INDEX example_idx ON example(id);',
    'CREATE VIEW example_view AS SELECT id FROM example',
    "CREATE TRIGGER example_trigger AFTER INSERT ON example BEGIN SELECT CASE WHEN NEW.id=1 THEN ';END' ELSE 'ok' END; END;",
    'ALTER TABLE example ADD COLUMN other TEXT',
  ])('accepts one reviewed schema statement: %s', (sql) => {
    expect(isOrdinaryD1SchemaStatement(sql)).toBe(true)
  })

  it.each([
    '/* unknown leading grammar */ CREATE TABLE example(id)',
    'CREATE TABLE example AS SELECT 1',
    'INSERT INTO example VALUES(1)',
    'UPDATE example SET id=1',
    'DELETE FROM example',
    'PRAGMA defer_foreign_keys=ON',
    'CREATE TABLE example(id REFERENCES parent DEFERRABLE INITIALLY DEFERRED)',
    'ALTER TABLE example RENAME TO other',
    'DROP TABLE example',
    'CREATE TABLE example(id); INSERT INTO example VALUES(1)',
    'CREATE TRIGGER x AFTER INSERT ON example BEGIN SELECT 1; END; DELETE FROM example;',
    'CREATE TRIGGER x AFTER INSERT ON example BEGIN BEGIN SELECT 1; END; END;',
    "CREATE TABLE example(note TEXT DEFAULT 'unfinished)",
    'CREATE TABLE example(id) /* unfinished',
  ])('isolates unknown, data-moving or ambiguous SQL: %s', (sql) => {
    expect(isOrdinaryD1SchemaStatement(sql)).toBe(false)
  })
})

describe('native cold D1 transaction boundaries', () => {
  let miniflare: Miniflare | undefined
  afterEach(async () => miniflare?.dispose())

  const open = async () => {
    miniflare = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'] })
    return miniflare.getD1Database('DB')
  }

  const observe = (database: D1Database, before?: (statements: D1PreparedStatement[], index: number) => Promise<void>) => {
    const batches: number[] = []
    const proxy = new Proxy(database, {
      get(target, property) {
        if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
          batches.push(statements.length)
          await before?.(statements, batches.length - 1)
          return target.batch(statements)
        }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    return { proxy, batches }
  }

  const ids = async (database: D1Database) => (await database.prepare('SELECT id FROM _ezacto_migrations ORDER BY id').all<{id:string}>()).results.map(({id}) => id)

  it('[db] groups empty schema work and stops exactly at the requested prefix', async () => {
    const database = await open()
    const {proxy, batches} = observe(database)
    await migrateD1Through(proxy, '0005_invoice_payments_totals')
    expect(await ids(database)).toEqual(migrationIds.slice(0, 6))
    expect(batches.length).toBeLessThan(6)
    expect(Math.max(...batches)).toBeLessThanOrEqual(100)
    expect(await database.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='invoice_state_events'").first()).toEqual({count:0})
  })

  it('[db] keeps every receipt before its DDL and isolates preflight, data and foreign-key boundaries', async () => {
    const database = await open()
    const recorded = new WeakMap<object, {sql:string; values:unknown[]}>()
    const groups: {sql:string; values:unknown[]}[][] = []
    const proxy = new Proxy(database, {
      get(target, property) {
        if (property === 'prepare') return (sql:string) => {
          const statement = target.prepare(sql)
          recorded.set(statement, {sql, values:[]})
          const wrapped = new Proxy(statement, {
            get(native, key) {
              if (key === 'bind') return (...values:unknown[]) => {
                const bound = native.bind(...values)
                recorded.set(bound, {sql, values})
                return bound
              }
              const value = Reflect.get(native, key)
              return typeof value === 'function' ? value.bind(native) : value
            },
          })
          recorded.set(wrapped, {sql, values:[]})
          return wrapped
        }
        if (property === 'batch') return (statements:D1PreparedStatement[]) => {
          // Unbound statements pass through the proxy above. Read their SQL
          // through a parallel prepare log rather than inspecting D1 internals.
          groups.push(statements.map((statement) => recorded.get(statement)!))
          return target.batch(statements)
        }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    await migrateD1(proxy)
    expect(await ids(database)).toEqual(migrationIds)
    const receipts:string[] = []
    for (const group of groups) {
      expect(group.length).toBeLessThanOrEqual(100)
      expect(group[0]?.sql).toContain('INSERT INTO _ezacto_migrations')
      const batchIds = group.filter(({sql}) => sql.includes('INSERT INTO _ezacto_migrations')).map(({values}) => String(values[0]))
      receipts.push(...batchIds)
      if (batchIds.length > 1) {
        for (const {sql} of group) {
          if (!sql.includes('INSERT INTO _ezacto_migrations')) expect(isOrdinaryD1SchemaStatement(sql)).toBe(true)
        }
      }
      for (const boundary of ['0006_invoice_state_events', '0026_invoice_generation', '0027_timesheet_approvals', '0037_recurring_generate_command', '0019_attachments', '0137_staff_invoices']) {
        if (batchIds.includes(boundary)) expect(batchIds).toEqual([boundary])
      }
    }
    expect(receipts).toEqual(migrationIds)
  })

  it('[db] preserves individual upgrade transactions for nonempty ledgers', async () => {
    const database = await open()
    await migrateD1Through(database, '0000_org_people')
    const {proxy, batches} = observe(database)
    await migrateD1Through(proxy, '0005_invoice_payments_totals')
    expect(batches).toHaveLength(5)
    expect(await ids(database)).toEqual(migrationIds.slice(0, 6))
  })

  it('[db] preserves individual transactions when untracked application tables exist', async () => {
    const database = await open()
    await database.prepare('CREATE TABLE owned_existing_data(id INTEGER PRIMARY KEY)').run()
    const {proxy, batches} = observe(database)
    await migrateD1Through(proxy, '0005_invoice_payments_totals')
    expect(batches).toHaveLength(6)
  })

  it('[db] rolls back every receipt and schema change in a genuinely failing group', async () => {
    const database = await open()
    let calls = 0
    const proxy = new Proxy(database, {
      get(target, property) {
        if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
          calls++
          return target.batch([...statements, target.prepare('CREATE TABLE organizations(id INTEGER)')])
        }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    await expect(migrateD1Through(proxy, '0005_invoice_payments_totals')).rejects.toThrow(/organizations already exists/)
    expect(calls).toBe(1)
    expect(await ids(database)).toEqual([])
    expect(await database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='organizations'").all()).toMatchObject({results:[]})
  })

  it('[db] reconciles a lost successful reply from exact native checksummed progress', async () => {
    const database = await open()
    let calls = 0
    const proxy = new Proxy(database, {
      get(target, property) {
        if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
          const result = await target.batch(statements)
          if (calls++ === 0) throw new Error('owned lost reply')
          return result
        }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    await migrateD1Through(proxy, '0005_invoice_payments_totals')
    expect(await ids(database)).toEqual(migrationIds.slice(0, 6))
  })

  it('[db] disables grouping after a concurrent isolate commits a valid prefix', async () => {
    const database = await open()
    const {proxy, batches} = observe(database, async (_statements, index) => {
      if (index === 0) await migrateD1Through(database, '0000_org_people')
    })
    await migrateD1Through(proxy, '0005_invoice_payments_totals')
    expect(batches).toHaveLength(6) // failed cold group, then five isolated upgrades
    expect(await ids(database)).toEqual(migrationIds.slice(0, 6))
  })

  it.each([
    { id:'0000_org_people', checksum:null },
    { id:'0001_clients', checksum:createHash('sha256').update(clientsMigration.join('\u0000')).digest('hex') },
  ])('[security] does not treat an out-of-order or null-checksum receipt as progress: $id', async ({id,checksum}) => {
    const database = await open()
    let calls = 0
    const {proxy} = observe(database, async () => {
      calls++
      await database.prepare("INSERT INTO _ezacto_migrations(id,applied_at,statements_sha256) VALUES(?,'2026-10-25T12:00:00.000Z',?)").bind(id,checksum).run()
      throw new Error('owned original failure')
    })
    await expect(migrateD1Through(proxy, '0005_invoice_payments_totals')).rejects.toThrow('owned original failure')
    expect(calls).toBe(1)
  })
})
