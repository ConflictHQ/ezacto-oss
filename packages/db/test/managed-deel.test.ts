import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { sql } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { createApiSessionService } from '../../api/src/sessions.js'
import { createManagedDeelConnectionCommands } from '../../api/src/index.js'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { createDeelSyncSettingsStore, createDeelSyncStore } from '../src/deel-time-sync.js'
import { createDeelCredentialSource, createManagedDeelConnectionStore } from '../src/index.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { createContainerSessionStore, createD1SessionStore } from '../src/sessions.js'

/**
 * Issue 1238. The connection's guarantees are the schema's and the SQL fence's,
 * so they are proven against a real migrated SQLite database and a real D1.
 * No request reaches Deel; the token is a sentinel that must never come back out.
 */

const initial = '2026-10-24T18:00:00.000Z'
const SENTINEL = 'DEEL_PRIVATE_TOKEN_SENTINEL'
let dispose: (() => Promise<void>) | undefined
afterEach(async () => {
  await dispose?.()
  dispose = undefined
})

const fixture = async (runtime: 'sqlite' | 'd1') => {
  let db: ReturnType<typeof createContainerDatabase> | ReturnType<typeof createD1Database>
  let sessions:
    ReturnType<typeof createContainerSessionStore> | ReturnType<typeof createD1SessionStore>
  let now = initial
  if (runtime === 'sqlite') {
    const native = new BetterSqlite3(':memory:')
    migrateContainer(native)
    db = createContainerDatabase(native)
    sessions = createContainerSessionStore(native, { now: () => now })
    dispose = async () => {
      native.close()
    }
  } else {
    const mf = new Miniflare({
      modules: true,
      script: 'export default {fetch(){return new Response("ok")}}',
      d1Databases: ['DB'],
    })
    const binding = await mf.getD1Database('DB')
    await migrateD1(binding)
    db = createD1Database(binding)
    sessions = createD1SessionStore(binding, { now: () => now })
    dispose = () => mf.dispose()
  }
  const execute = (text: string) => db.run(sql.raw(text))
  await execute(
    `INSERT INTO organizations(name,modules,created_at,updated_at) VALUES('Owned fixture','{}','${now}','${now}')`,
  )
  await execute(`INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES
    (1,'Owner','Fixture','administrator','[]','${now}','${now}'),
    (2,'Administrator','Fixture','administrator','[]','${now}','${now}'),
    (3,'Member','Fixture','member','[]','${now}','${now}')`)
  const admin = await sessions.issue(2)
  const member = await sessions.issue(3)
  const store = createManagedDeelConnectionStore(db)
  const errors: Error[] = []
  const commands = createManagedDeelConnectionCommands({
    store,
    reportError: (error) => {
      errors.push(error)
    },
    authentication: { sessions: createApiSessionService(sessions) },
    now: () => now,
  })
  const request = (token = admin.token, origin = 'https://owned.example') =>
    new Request('https://owned.example/_hosted/deel/connection', {
      method: 'POST',
      headers: { cookie: `__Host-ezacto_session=${token}`, origin },
    })
  return {
    db,
    store,
    commands,
    errors,
    sessions,
    admin,
    member,
    request,
    execute,
    credentials: createDeelCredentialSource(db),
    rows: (table: string) => db.all<Record<string, unknown>>(sql.raw(`SELECT * FROM ${table}`)),
    tick: (ms: number) => {
      now = new Date(Date.parse(now) + ms).toISOString()
    },
  }
}
const connectCommand = (generation = 0, token = SENTINEL, startDate = '2026-09-01') => ({
  expectedActorUserId: 2,
  expectedGeneration: generation,
  token,
  startDate,
})
const data = <T>(value: T | Response): T => {
  if (value instanceof Response) throw new Error(`Unexpected status ${value.status}`)
  return value
}
const refusal = async (value: unknown, status: number) => {
  expect(value).toBeInstanceOf(Response)
  expect((value as Response).status).toBe(status)
  expect(await (value as Response).text()).not.toContain(SENTINEL)
}

describe.each(['sqlite', 'd1'] as const)('managed Deel connection %s', (runtime) => {
  it('connects, reports state without the token, rotates and disconnects with erasure', async () => {
    const f = await fixture(runtime)
    expect(data(await f.commands.state(f.request()))).toMatchObject({
      generation: 0,
      connected: false,
      startDate: null,
    })
    expect(await f.credentials.current()).toBeNull()

    const connected = data(await f.commands.connect(f.request(), connectCommand()))
    expect(connected).toMatchObject({
      generation: 1,
      connected: true,
      startDate: '2026-09-01',
      connectedByUserId: 2,
      actorUserId: 2,
    })
    expect(JSON.stringify(connected)).not.toContain(SENTINEL)
    expect(await f.credentials.current()).toEqual({
      token: SENTINEL,
      startDate: '2026-09-01',
      generation: 1,
    })

    // Rotation changes the token and the start date and is a new lifecycle.
    const rotated = data(
      await f.commands.connect(f.request(), connectCommand(1, 'ROTATED_TOKEN', '2026-10-01')),
    )
    expect(rotated).toMatchObject({ generation: 2, startDate: '2026-10-01' })
    expect((await f.credentials.current())?.token).toBe('ROTATED_TOKEN')

    const gone = data(
      await f.commands.disconnect(f.request(), { expectedActorUserId: 2, expectedGeneration: 2 }),
    )
    expect(gone).toMatchObject({ generation: 3, connected: false, startDate: null })
    expect(await f.credentials.current()).toBeNull()
    expect(JSON.stringify(await f.rows('deel_connection'))).toBe('[]')
    // A second disconnect still advances, so an in-flight command cannot outlive it.
    expect(
      data(
        await f.commands.disconnect(f.request(), { expectedActorUserId: 2, expectedGeneration: 3 }),
      ),
    ).toMatchObject({ generation: 4, connected: false })
    expect(await f.credentials.generation()).toBe(4)
  })

  it('returns an automatic schedule to manual on every lifecycle change', async () => {
    const f = await fixture(runtime)
    const settings = createDeelSyncSettingsStore(f.db)
    const automatic = () =>
      settings.save({ mode: 'automatic', runTime: '03:00', userId: 2 }, initial)
    await automatic()
    data(await f.commands.connect(f.request(), connectCommand()))
    expect((await settings.get()).mode).toBe('manual')
    await automatic()
    data(await f.commands.connect(f.request(), connectCommand(1, 'ROTATED')))
    expect((await settings.get()).mode).toBe('manual')
    await automatic()
    data(
      await f.commands.disconnect(f.request(), { expectedActorUserId: 2, expectedGeneration: 2 }),
    )
    expect((await settings.get()).mode).toBe('manual')
  })

  it('refuses members, foreign origins, bearer-less callers and stale sessions without echoing the token', async () => {
    const f = await fixture(runtime)
    await refusal(await f.commands.connect(f.request(f.member.token), connectCommand()), 403)
    await refusal(
      await f.commands.connect(
        f.request(f.admin.token, 'https://foreign.example'),
        connectCommand(),
      ),
      403,
    )
    await refusal(await f.commands.connect(f.request('not-a-session'), connectCommand()), 401)
    // Signed in more than fifteen minutes ago: reads still work, a change does not.
    f.tick(16 * 60_000)
    expect(data(await f.commands.state(f.request()))).toMatchObject({ connected: false })
    await refusal(await f.commands.connect(f.request(), connectCommand()), 403)
    await refusal(
      await f.commands.disconnect(f.request(), { expectedActorUserId: 2, expectedGeneration: 0 }),
      403,
    )
    expect(await f.rows('deel_connection')).toEqual([])
    expect(await f.credentials.generation()).toBe(0)
  })

  it('refuses a revoked session, a deactivated administrator and a stolen actor id', async () => {
    const f = await fixture(runtime)
    await refusal(
      await f.commands.connect(f.request(), { ...connectCommand(), expectedActorUserId: 3 }),
      403,
    )
    await f.execute(`UPDATE sessions SET revoked_at='${initial}', revocation_reason='user_revoked'`)
    await refusal(await f.commands.connect(f.request(), connectCommand()), 401)
    const g = await fixture(runtime)
    await g.execute(`UPDATE users SET is_active=0 WHERE id=2`)
    await refusal(await g.commands.connect(g.request(), connectCommand()), 401)
    expect(await g.credentials.current()).toBeNull()
  })

  it('refuses a stale expected generation and invalid values, and writes nothing', async () => {
    const f = await fixture(runtime)
    data(await f.commands.connect(f.request(), connectCommand()))
    await refusal(await f.commands.connect(f.request(), connectCommand(0, 'REPLAYED')), 409)
    await refusal(
      await f.commands.disconnect(f.request(), { expectedActorUserId: 2, expectedGeneration: 0 }),
      409,
    )
    for (const bad of [
      connectCommand(1, ''),
      connectCommand(1, 'has space'),
      connectCommand(1, 'x'.repeat(4097)),
      connectCommand(1, SENTINEL, '2026-02-31'),
      connectCommand(1, SENTINEL, 'last month'),
      connectCommand(-1),
    ])
      await refusal(await f.commands.connect(f.request(), bad), 422)
    expect(await f.credentials.current()).toEqual({
      token: SENTINEL,
      startDate: '2026-09-01',
      generation: 1,
    })
  })

  it('keeps the generation append-only and the token out of every other table', async () => {
    const f = await fixture(runtime)
    data(await f.commands.connect(f.request(), connectCommand()))
    await expect(
      (async () => f.execute(`UPDATE deel_connection_generation SET generation=9`))(),
    ).rejects.toThrow()
    await expect(
      (async () => f.execute(`DELETE FROM deel_connection_generation`))(),
    ).rejects.toThrow()
    expect(f.errors).toEqual([])
    const others = [
      'deel_sync_settings',
      'deel_sync_runs',
      'deel_transfer_log',
      'deel_transfer_intents',
      'sessions',
    ]
    for (const table of others) expect(JSON.stringify(await f.rows(table))).not.toContain(SENTINEL)
  })

  it('keeps an intent until the log row lands, across a restart', async () => {
    const f = await fixture(runtime)
    const first = createDeelSyncStore(f.db)
    await first.intents.begin(
      {
        contractId: 'con_1',
        entries: [
          { entryId: 11, fingerprint: 'fp11' },
          { entryId: 12, fingerprint: 'fp12' },
        ],
      },
      initial,
    )
    // A restart is a new store over the same database: the intents are still open.
    const restarted = createDeelSyncStore(f.db)
    expect(await restarted.intents.open()).toEqual([11, 12])
    // The same entry cannot be intended twice.
    await expect(
      restarted.intents.begin(
        { contractId: 'con_1', entries: [{ entryId: 12, fingerprint: 'fp12' }] },
        initial,
      ),
    ).rejects.toThrow()
    await restarted.record({ entryId: 11, fingerprint: 'fp11', timesheetId: 'tms_1' }, initial)
    expect(await restarted.intents.open()).toEqual([12])
    await restarted.intents.release([12])
    expect(await restarted.intents.open()).toEqual([])
  })
})
