import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { createContainerDatabase, createD1Database } from '../../src/adapters.js'
import { migrateContainer, migrateD1 } from '../../src/migrate.js'
import { createContainerSessionStore, createD1SessionStore } from '../../src/sessions.js'
import { createCalendarOperatorCleanupStore } from '../../src/calendar-operator-cleanup.js'
import { createCalendarConnectionStore } from '../../src/calendar-connections.js'
import { createCalendarOAuthStore } from '../../src/calendar-oauth.js'
export const calendarOperatorFixture = async (kind: 'sqlite' | 'd1') => {
  const sqlite = kind === 'sqlite' ? new BetterSqlite3(':memory:') : null
  const mf = sqlite
    ? null
    : new Miniflare({
        modules: true,
        script: 'export default {fetch(){return new Response("ok")}}',
        d1Databases: ['DB'],
      })
  const d1 = mf ? await mf.getD1Database('DB') : null
  if (sqlite) migrateContainer(sqlite)
  else await migrateD1(d1!)
  const run = async (sql: string, ...values: unknown[]) => {
    if (sqlite) sqlite.prepare(sql).run(...values)
    else
      await d1!
        .prepare(sql)
        .bind(...values)
        .run()
  }
  const rows = async (sql: string, ...values: unknown[]): Promise<Record<string, unknown>[]> =>
    sqlite
      ? (sqlite.prepare(sql).all(...values) as Record<string, unknown>[])
      : (
          await d1!
            .prepare(sql)
            .bind(...values)
            .all()
        ).results
  const now = new Date().toISOString()
  await run(
    "INSERT INTO organizations(id,name,modules,created_at,updated_at) VALUES(1,'Owned','{}',?,?)",
    now,
    now,
  )
  await run(
    "INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(1,'Owned','Administrator','administrator','[]',?,?),(2,'Owned','Member','member','[]',?,?),(3,'Owned','Subject','member','[]',?,?)",
    now,
    now,
    now,
    now,
    now,
    now,
  )
  const db = sqlite ? createContainerDatabase(sqlite) : createD1Database(d1!)
  const sessions = sqlite ? createContainerSessionStore(sqlite) : createD1SessionStore(d1!)
  const issued = await sessions.issue(1),
    member = await sessions.issue(2)
  const actor = { userId: 1, sessionId: issued.session.id }
  const store = createCalendarOperatorCleanupStore(db),
    connections = createCalendarConnectionStore(db)
  const instance = String((await rows('SELECT nonce FROM calendar_sync_instance'))[0]!.nonce)
  const old = 'b'.repeat(64)
  const seed = async (
    id = 'owned-custody',
    options: Partial<{
      instance: string
      reason: string
      request: string | null
      provider: string
      generation: number
      status: string
    }> = {},
  ) => {
    await run(
      "INSERT INTO calendar_cleanup_obligations(id,user_id,provider,instance_nonce,generation,credential_revision,key_id,sealed_grant,request_id,reason,status,created_at) VALUES(?,3,?,?,?,1,'owned-key','PRIVATE_SEALED_GRANT',?,?,?,?)",
      id,
      options.provider ?? 'google',
      options.instance ?? old,
      options.generation ?? 1,
      options.request ?? null,
      options.reason ?? 'restore',
      options.status ?? 'manual_required',
      now,
    )
    return (await store.list(actor)).data.find((row) => row.id === id)!
  }
  return {
    sqlite,
    d1,
    db,
    run,
    rows,
    store,
    connections,
    oauth: createCalendarOAuthStore(db),
    sessions,
    actor,
    issued,
    member,
    instance,
    old,
    seed,
    now,
    close: async () => {
      sqlite?.close()
      await mf?.dispose()
    },
  }
}
