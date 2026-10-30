import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { sql } from 'drizzle-orm'
import { expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { readEffectiveUserTimezone, readUserTimezone } from '../src/operations.js'

const now = '2026-10-24T00:00:00.000Z'

for (const runtime of ['sqlite', 'd1'] as const) {
  it(`[api #1201] resolves the same personal/organization filing zone without changing preferences (${runtime})`, async () => {
    const sqlite = runtime === 'sqlite' ? new BetterSqlite3(':memory:') : null
    const worker =
      runtime === 'd1'
        ? new Miniflare({
            modules: true,
            script: 'export default { fetch() { return new Response("ok") } }',
            d1Databases: ['DB'],
          })
        : null
    const binding = await worker?.getD1Database('DB')
    const database = sqlite ? createContainerDatabase(sqlite) : createD1Database(binding!)
    try {
      if (sqlite) migrateContainer(sqlite)
      else await migrateD1(binding!)
      await database.run(sql`INSERT INTO organizations(id,name,modules,timezone,created_at,updated_at)
        VALUES(1,'Synthetic timezone','{}','America/Costa_Rica',${now},${now})`)
      await database.run(sql`INSERT INTO users(id,first_name,last_name,profile,manager_grants,timezone,created_at,updated_at)
        VALUES(1,'Default','Synthetic','member','[]','UTC',${now},${now}),
          (2,'Personal','Synthetic','member','[]','Europe/Warsaw',${now},${now})`)
      expect(await readUserTimezone(database, 1)).toBe('UTC')
      expect(await readEffectiveUserTimezone(database, 1)).toBe('America/Costa_Rica')
      expect(await readEffectiveUserTimezone(database, 2)).toBe('Europe/Warsaw')
      await database.run(sql`UPDATE users SET timezone='Central America' WHERE id=1`)
      expect(await readEffectiveUserTimezone(database, 1)).toBe('America/Costa_Rica')
      expect(await readUserTimezone(database, 1)).toBe('Central America')
      await database.run(sql`UPDATE organizations SET timezone='Legacy invalid zone' WHERE id=1`)
      expect(await readEffectiveUserTimezone(database, 1)).toBe('UTC')
      expect(await readEffectiveUserTimezone(database, 2)).toBe('Europe/Warsaw')
    } finally {
      sqlite?.close()
      await worker?.dispose()
    }
  }, 60_000)
}
