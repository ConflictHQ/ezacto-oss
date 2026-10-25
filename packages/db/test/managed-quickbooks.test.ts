import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { sql } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import {
  migrateContainer,
  migrateD1,
  migrateContainerThrough,
  migrateD1Through,
} from '../src/migrate.js'
import { createContainerSessionStore, createD1SessionStore } from '../src/sessions.js'
import { createQuickBooksStore } from '../src/quickbooks.js'
import { createManagedQuickBooksGrantStore, createManagedQuickBooksLifecycleStore } from '../src/index.js'
import { createApiSessionService } from '../../api/src/sessions.js'
import { createManagedQuickBooksGrantCommands } from '../../api/src/index.js'
import type { ManagedQuickBooksGrantCommand } from '@ezacto/core'
import { createAccountRetentionRepository } from '../src/account-retention.js'
import { createAccountDeletionRequestRepository } from '../src/account-deletion-requests.js'
import { createAccountClosureRepository } from '../src/account-closure.js'

const initial = '2026-10-24T18:00:00.000Z'
let dispose: (() => Promise<void>) | undefined
afterEach(async () => {
  await dispose?.()
  dispose = undefined
  vi.restoreAllMocks()
})
const fixture = async (runtime: 'sqlite' | 'd1', legacy = false) => {
  let upgrade!: () => Promise<void>
  let db: ReturnType<typeof createContainerDatabase> | ReturnType<typeof createD1Database>
  let sessions:
    ReturnType<typeof createContainerSessionStore> | ReturnType<typeof createD1SessionStore>
  let now = initial
  if (runtime === 'sqlite') {
    const native = new BetterSqlite3(':memory:')
    if (legacy) migrateContainerThrough(native, '0156_wise_signed_deliveries')
    else migrateContainer(native)
    upgrade = async () => {
      migrateContainer(native)
    }
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
    if (legacy) await migrateD1Through(binding, '0156_wise_signed_deliveries')
    else await migrateD1(binding)
    upgrade = () => migrateD1(binding)
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
  const admin = await sessions.issue(2),
    member = await sessions.issue(3)
  const store = createManagedQuickBooksGrantStore(db)
  const lifecycle = createManagedQuickBooksLifecycleStore(db)
  const errors: Error[] = []
  const commands = createManagedQuickBooksGrantCommands({
    store,
    reportError: (error) => {
      errors.push(error)
    },
    authentication: { sessions: createApiSessionService(sessions) },
    now: () => now,
  })
  const request = (
    token = admin.token,
    origin = 'https://owned.example',
    extra: Record<string, string> = {},
  ) =>
    new Request('https://owned.example/_hosted/quickbooks/redeem', {
      method: 'POST',
      headers: { cookie: `__Host-ezacto_session=${token}`, origin, ...extra },
    })
  const command: ManagedQuickBooksGrantCommand = {
    grantId: 'a'.repeat(64),
    browserHash: 'b'.repeat(64),
    credentialHash: 'c'.repeat(64),
    expectedActorUserId: 2,
    expectedConnectionGeneration: 0,
    expiresAt: Date.parse(now) + 600_000,
    tokens: {
      realmId: 'owned-realm',
      companyName: 'Owned fixture',
      accessToken: 'PRIVATE_ACCESS_SENTINEL',
      refreshToken: 'PRIVATE_REFRESH_SENTINEL',
      accessTokenExpiresAt: '2026-10-24T19:00:00.000Z',
      refreshTokenExpiresAt: '2027-10-24T18:00:00.000Z',
      scope: 'com.intuit.quickbooks.accounting',
    },
  }
  const rows = (table: string) => db.all<Record<string, unknown>>(sql.raw(`SELECT * FROM ${table}`))
  return {
    db,
    upgrade,
    store,
    lifecycle,
    commands,
    errors,
    sessions,
    admin,
    member,
    request,
    command,
    execute,
    rows,
    canonical: createQuickBooksStore(db),
    now: () => now,
    tick: (ms: number) => {
      now = new Date(Date.parse(now) + ms).toISOString()
    },
  }
}
const data = <T>(value: T | Response): T => {
  if (value instanceof Response) throw new Error(`Unexpected managed command status${value.status}`)
  return value
}

// Managed connections are fenced through lifecycle custody, not native disconnect.
const fenceManaged = (f: Awaited<ReturnType<typeof fixture>>, generation: number) =>
  f.lifecycle.fence(
    {
      revocationId: String(generation).repeat(64),
      grantId: f.command.grantId,
      expectedActorUserId: 2,
      expectedConnectionGeneration: generation,
      environment: 'sandbox',
      reason: 'disconnect',
    },
    { kind: 'guarded-session', userId: 2 },
    f.now(),
  )

// Delegate every statement to the real backend; hold or fault only AFTER a
// genuine atomic read/commit so races and unknown replies are deterministic.
const interceptedStore = (
  database: Awaited<ReturnType<typeof fixture>>['db'],
  after: (rows: Record<string, unknown>[][]) => void | Promise<void>,
  wrapFailure: (error: unknown) => unknown = (error) => error,
) => {
  const client = database.$client as BetterSqlite3.Database | D1Database
  const wrapped =
    'batch' in client
      ? {
          prepare: client.prepare.bind(client),
          batch: async (statements: D1PreparedStatement[]) => {
            try {
              const results = await client.batch(statements)
              await after(results.map((result) => result.results as Record<string, unknown>[]))
              return results
            } catch (error) {
              throw wrapFailure(error)
            }
          },
        }
      : {
          prepare: client.prepare.bind(client),
          transaction: (work: () => Record<string, unknown>[][]) => ({
            immediate: async () => {
              try {
                const results = client.transaction(work).immediate()
                await after(results)
                return results
              } catch (error) {
                throw wrapFailure(error)
              }
            },
          }),
        }
  return createManagedQuickBooksGrantStore(
    new Proxy(database, {
      get: (target, key) => (key === '$client' ? wrapped : Reflect.get(target, key)),
    }),
  )
}
const commandsFor = (
  f: Awaited<ReturnType<typeof fixture>>,
  store: ReturnType<typeof createManagedQuickBooksGrantStore>,
) =>
  createManagedQuickBooksGrantCommands({
    store,
    authentication: { sessions: createApiSessionService(f.sessions) },
    now: f.now,
  })

const closeActor = async (f: Awaited<ReturnType<typeof fixture>>) => {
  const policy = {
    frameworks: [],
    retained_records: ['audit_and_security', 'billing_and_payments'].map((category) => ({
      category,
      reason: 'Owned fixture reviewed retention.',
      period: 'One year then review.',
      review_after_days: 30,
    })),
    response_target_days: 14,
    operator_contact: 'privacy@example.test',
    user_notice: 'Operator-reviewed closure.',
    backup_handling: 'Replay closure before restored access.',
    acknowledged: true,
  }
  await createAccountRetentionRepository(f.db).publish({
    actorUserId: 1,
    expectedVersion: 0,
    policy,
    now: f.now(),
  })
  await createAccountDeletionRequestRepository(f.db).request({
    userId: 2,
    id: 'owned-grant-closure',
    now: f.now(),
    expectedPolicyVersion: 1,
  })
  const closure = createAccountClosureRepository(f.db)
  const preview = await closure.preview(1, 'owned-grant-closure')
  expect(preview.uncovered_categories).toEqual([])
  await closure.close({
    actorUserId: 1,
    id: 'owned-grant-closure',
    reviewToken: preview.review_token,
    expectedVersion: 1,
    expectedPolicyVersion: 1,
    now: f.now(),
    acknowledged: true,
  })
}

describe.each(['sqlite', 'd1'] as const)('managed QuickBooks native %s', (runtime) => {
  it('uses fresh native session policy and atomically records one private grant/connection', async () => {
    const f = await fixture(runtime)
    expect(data(await f.commands.prepare(f.request()))).toMatchObject({
      actorUserId: 2,
      connectionGeneration: 0,
      connected: false,
    })
    expect(data(await f.commands.inspect(f.request(), f.command))).toMatchObject({
      replayed: false,
      connectionGeneration: 0,
    })
    const result = data(await f.commands.accept(f.request(), f.command))
    expect(result).toMatchObject({
      actorUserId: 2,
      outcome: 'accepted',
      connectionGeneration: 1,
      connected: true,
    })
    expect(await f.canonical.readConnection()).toMatchObject({
      realmId: 'owned-realm',
      connectedByUserId: 2,
    })
    const receipt = await f.rows('quickbooks_managed_grants')
    expect(receipt).toHaveLength(1)
    expect(JSON.stringify([result, receipt])).not.toMatch(
      /PRIVATE_ACCESS_SENTINEL|PRIVATE_REFRESH_SENTINEL/,
    )
    expect(data(await f.commands.accept(f.request(), f.command))).toMatchObject({
      outcome: 'replayed',
      connectionGeneration: 1,
    })
    expect(data(await f.commands.inspect(f.request(), f.command))).toMatchObject({
      replayed: true,
      connectionGeneration: 1,
      connected: true,
    })
    // A new native OAuth connection can have exactly the same millisecond,
    // realm and actor. It must still invalidate this older handoff.
    await f.canonical.saveConnection({
      ...f.command.tokens,
      accessToken: 'NATIVE_RECONNECT_ACCESS',
      connectedByUserId: 2,
      now: f.now(),
    })
    expect(data(await f.commands.prepare(f.request()))).toMatchObject({
      connectionGeneration: 2,
      connected: true,
    })
    expect(((await f.commands.inspect(f.request(), f.command)) as Response).status).toBe(409)
  })
  it('rejects member, foreign-origin and bearer credentials without touching a grant', async () => {
    const f = await fixture(runtime)
    for (const [request, status] of [
      [f.request(f.member.token), 403],
      [f.request(f.admin.token, 'https://foreign.example'), 403],
      [f.request(f.admin.token, 'https://owned.example', { authorization: 'Bearer invalid' }), 401],
    ] as const) {
      const result = await f.commands.accept(request, f.command)
      expect(result).toBeInstanceOf(Response)
      expect((result as Response).status).toBe(status)
    }
    expect(await f.rows('quickbooks_managed_grants')).toHaveLength(0)
    expect(await f.canonical.readConnection()).toBeNull()
    expect(f.errors).toHaveLength(0)
  })
  it('resolves guarded identity through canonical current role and rechecks demotion at SQL acceptance', async () => {
    const f = await fixture(runtime)
    const identity = vi.fn(async () => 2 as number | null)
    const guarded = createManagedQuickBooksGrantCommands({
      store: f.store,
      guardedUserId: identity,
      now: f.now,
    })
    expect(data(await guarded.prepare(f.request()))).toMatchObject({ actorUserId: 2 })
    await f.execute(
      "UPDATE users SET profile='member',updated_at='2026-10-24T18:00:01.000Z' WHERE id=2",
    )
    const refused = await guarded.accept(f.request(), f.command)
    expect((refused as Response).status).toBe(403)
    expect(identity).toHaveBeenCalledTimes(2)
    expect(await f.rows('quickbooks_managed_grants')).toHaveLength(0)
  })
  it('fences pending grants on disconnect even with no connection, and never replays after disconnect/reconnect', async () => {
    const f = await fixture(runtime)
    await f.canonical.disconnect({ now: f.now() })
    expect(data(await f.commands.prepare(f.request()))).toMatchObject({
      connectionGeneration: 1,
      connected: false,
    })
    expect(((await f.commands.accept(f.request(), f.command)) as Response).status).toBe(409)
    const fresh = { ...f.command, expectedConnectionGeneration: 1 }
    expect(data(await f.commands.accept(f.request(), fresh))).toMatchObject({
      outcome: 'accepted',
      connectionGeneration: 2,
    })
    await fenceManaged(f, 2)
    await f.canonical.disconnect({ now: f.now() })
    expect(data(await f.commands.prepare(f.request()))).toMatchObject({
      connectionGeneration: 4,
      connected: false,
    })
    expect(((await f.commands.inspect(f.request(), fresh)) as Response).status).toBe(409)
    expect(((await f.commands.accept(f.request(), fresh)) as Response).status).toBe(409)
    expect(await f.canonical.readConnection()).toBeNull()
  })
  it('does not confuse a token refresh with a new accepted connection incarnation', async () => {
    const f = await fixture(runtime)
    await f.commands.accept(f.request(), f.command)
    await f.canonical.saveTokens({
      realmId: 'owned-realm',
      accessToken: 'NEW_ACCESS',
      refreshToken: 'NEW_REFRESH',
      accessTokenExpiresAt: '2026-10-24T20:00:00.000Z',
      refreshTokenExpiresAt: '2027-10-25T18:00:00.000Z',
      now: f.now(),
    })
    expect(data(await f.commands.inspect(f.request(), f.command))).toMatchObject({
      replayed: true,
      connectionGeneration: 1,
    })
    expect(data(await f.commands.accept(f.request(), f.command))).toMatchObject({
      outcome: 'replayed',
      connectionGeneration: 1,
    })
    expect((await f.canonical.readConnection())?.accessToken).toBe('NEW_ACCESS')
    await f.execute('DELETE FROM quickbooks_managed_grants')
    expect(((await f.commands.accept(f.request(), f.command)) as Response).status).toBe(409)
    expect((await f.canonical.readConnection())?.accessToken).toBe('NEW_ACCESS')
  })
  it('rejects changed tokens, browser proof, actor and expired confirmation without leaking credentials', async () => {
    const f = await fixture(runtime)
    await f.commands.accept(f.request(), f.command)
    for (const command of [
      { ...f.command, tokens: { ...f.command.tokens, accessToken: 'CHANGED_PRIVATE' } },
      { ...f.command, browserHash: 'd'.repeat(64) },
      { ...f.command, expectedActorUserId: 1 },
    ]) {
      const result = await f.commands.accept(f.request(), command)
      expect(result).toBeInstanceOf(Response)
      expect(await (result as Response).text()).not.toMatch(
        /PRIVATE|CHANGED|refreshToken|accessToken/,
      )
    }
    f.tick(600_000)
    expect(((await f.commands.inspect(f.request(), f.command)) as Response).status).toBe(409)
    expect(await f.rows('quickbooks_managed_grants')).toHaveLength(1)
    expect(f.errors).toHaveLength(0)
  })
  it('rolls back a receipt and generation if the connection write fails; logs stay static and reporter retains the cause', async () => {
    const f = await fixture(runtime)
    await f.execute(
      "CREATE TRIGGER owned_connection_fault BEFORE INSERT ON quickbooks_connections BEGIN SELECT RAISE(ABORT,'PRIVATE_ACCESS_SENTINEL'); END",
    )
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined),
      reporter = vi.fn((error: Error) => {
        void error
        throw new Error('ignored reporter failure')
      })
    const deceptive = {
      ...f.command,
      tokens: {
        ...f.command.tokens,
        accessToken: 'managed_quickbooks_allowed_token',
        companyName: 'CHECK constraint',
      },
    }
    // The actual backend still performs and rolls back the failed command;
    // model a diagnostic driver envelope that includes untrusted bound params.
    const wrappedStore = interceptedStore(
      f.db,
      () => undefined,
      (cause) =>
        new Error(`Owned driver envelope params=${JSON.stringify(deceptive.tokens)}`, { cause }),
    )
    const commands = createManagedQuickBooksGrantCommands({
      store: wrappedStore,
      authentication: { sessions: createApiSessionService(f.sessions) },
      now: f.now,
      reportError: reporter,
    })
    const response = await commands.accept(f.request(), deceptive)
    expect((response as Response).status).toBe(503)
    expect(await (response as Response).text()).not.toMatch(
      /PRIVATE_ACCESS_SENTINEL|PRIVATE_REFRESH_SENTINEL|managed_quickbooks_allowed_token|CHECK constraint/,
    )
    expect(
      log.mock.calls
        .flat()
        .map((value) =>
          value instanceof Error ? `${value.name}:${value.message}:${value.stack}` : String(value),
        )
        .join(''),
    ).not.toMatch(
      /PRIVATE_ACCESS_SENTINEL|PRIVATE_REFRESH_SENTINEL|managed_quickbooks_allowed_token|CHECK constraint/,
    )
    expect(reporter).toHaveBeenCalledOnce()
    expect(String(reporter.mock.calls[0]![0].cause)).toContain('PRIVATE_ACCESS_SENTINEL')
    expect(reporter.mock.calls[0]![0].message).toContain('managed_quickbooks_allowed_token')
    const rejectedObserver = createManagedQuickBooksGrantCommands({
      store: wrappedStore,
      authentication: { sessions: createApiSessionService(f.sessions) },
      now: f.now,
      reportError: async () => {
        throw new Error('ignored async observer failure')
      },
    })
    expect(((await rejectedObserver.accept(f.request(), deceptive)) as Response).status).toBe(503)
    await Promise.resolve()
    expect(await f.rows('quickbooks_managed_grants')).toHaveLength(0)
    expect(await f.canonical.readConnection()).toBeNull()
    expect(data(await f.commands.prepare(f.request()))).toMatchObject({ connectionGeneration: 0 })
  })
  it('replays concurrent identical grants once and rejects a genuinely different concurrent grant', async () => {
    const f = await fixture(runtime)
    const race = async (commands: ManagedQuickBooksGrantCommand[], generation: number) => {
      let reads = 0,
        release!: () => void
      const barrier = new Promise<void>((resolve) => {
          release = resolve
        }),
        timer = setTimeout(release, 5000)
      const raced = commandsFor(
        f,
        interceptedStore(f.db, async (rows) => {
          if (rows.length === 2 && rows[0]?.[0]?.generation === generation && reads < 2) {
            reads++
            if (reads === 2) release()
            await barrier
          }
        }),
      )
      try {
        const results = await Promise.all(
          commands.map((command) => raced.accept(f.request(), command)),
        )
        expect(reads).toBe(2)
        return results
      } finally {
        clearTimeout(timer)
        release()
      }
    }
    const duplicates = await race([f.command, f.command], 0)
    expect(duplicates.map((value) => data(value).outcome).sort()).toEqual(['accepted', 'replayed'])
    expect(await f.rows('quickbooks_managed_grants')).toHaveLength(1)
    await fenceManaged(f, 1)
    const one = { ...f.command, grantId: 'd'.repeat(64), expectedConnectionGeneration: 2 }
    const two = {
      ...one,
      grantId: 'e'.repeat(64),
      tokens: { ...one.tokens, realmId: 'different-company' },
    }
    const competing = await race([one, two], 2)
    expect(
      competing.filter((value) => value instanceof Response && value.status === 409),
    ).toHaveLength(1)
    const winner = competing.findIndex((value) => !(value instanceof Response))
    expect(data(competing[winner]!)).toMatchObject({ outcome: 'accepted', connectionGeneration: 3 })
    expect((await f.canonical.readConnection())?.realmId).toBe([one, two][winner]!.tokens.realmId)
    expect(await f.rows('quickbooks_managed_grants')).toHaveLength(2)
    expect(((await f.commands.inspect(f.request(), f.command)) as Response).status).toBe(409)
  })
  it('rechecks native session revocation, role demotion, disconnect and account closure after a stale authorized read', async () => {
    const f = await fixture(runtime)
    for (const change of ['revoke', 'demote', 'disconnect', 'close'] as const) {
      await f.execute(
        "UPDATE users SET profile='administrator',updated_at='2026-10-24T18:00:00.000Z' WHERE id=2",
      )
      const session = await f.sessions.issue(2)
      let armed = true,
        authorizedRead = false
      const raced = commandsFor(
        f,
        interceptedStore(f.db, async (rows) => {
          if (armed && rows.length === 2 && rows[0]?.[0]?.authorized === 1) {
            armed = false
            authorizedRead = true
            if (change === 'revoke') await f.sessions.revoke(2, session.session.id)
            else if (change === 'demote')
              await f.execute(
                "UPDATE users SET profile='member',updated_at='2026-10-24T18:00:00.000Z' WHERE id=2",
              )
            else if (change === 'close') await closeActor(f)
            else await f.canonical.disconnect({ now: f.now() })
          }
        }),
      )
      const result = await raced.accept(f.request(session.token), f.command)
      expect(authorizedRead).toBe(true)
      expect((result as Response).status).toBe(change === 'disconnect' ? 409 : 403)
      expect(await f.rows('quickbooks_managed_grants')).toHaveLength(0)
      expect(await f.canonical.readConnection()).toBeNull()
    }
  })
  it('recovers an actually committed response loss without replacing tokens or creating another receipt', async () => {
    const f = await fixture(runtime)
    let lose = true
    const raced = commandsFor(
      f,
      interceptedStore(f.db, (rows) => {
        if (lose && rows[0]?.[0]?.grant_id === f.command.grantId) {
          lose = false
          throw new Error('Owned response lost after commit')
        }
      }),
    )
    expect(data(await raced.accept(f.request(), f.command))).toMatchObject({
      outcome: 'replayed',
      connectionGeneration: 1,
    })
    expect(await f.rows('quickbooks_managed_grants')).toHaveLength(1)
    expect((await f.canonical.readConnection())?.accessToken).toBe('PRIVATE_ACCESS_SENTINEL')
    expect(data(await f.commands.inspect(f.request(), f.command))).toMatchObject({
      replayed: true,
      connectionGeneration: 1,
    })
  })
  it('does not accept an external guarded identity after revocation or local account closure', async () => {
    const f = await fixture(runtime)
    let identity: number | null | Response = null
    const guarded = createManagedQuickBooksGrantCommands({
      store: f.store,
      reportError: (error) => {
        f.errors.push(error)
      },
      guardedUserId: async () => identity,
      now: f.now,
    })
    expect(((await guarded.accept(f.request(), f.command)) as Response).status).toBe(401)
    for (const status of [401, 403, 503]) {
      identity = new Response('Owned known host refusal', {
        status,
        headers: { 'x-owned-refusal': 'preserved' },
      })
      const refusal = await guarded.accept(f.request(), f.command)
      expect(refusal).toBe(identity)
      expect((refusal as Response).status).toBe(status)
      expect((refusal as Response).headers.get('x-owned-refusal')).toBe('preserved')
      expect(await (refusal as Response).text()).toBe('Owned known host refusal')
    }
    expect(f.errors).toEqual([])
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    identity = new Response('Invalid success must not authorize', { status: 200 })
    expect(((await guarded.accept(f.request(), f.command)) as Response).status).toBe(503)
    expect(f.errors).toHaveLength(1)
    expect(f.errors[0]?.message).toBe('Managed QuickBooks identity returned a non-failure response')

    identity = 2
    await f.execute("UPDATE users SET is_active=0,updated_at='2026-10-24T18:00:00.000Z' WHERE id=2")
    expect(((await guarded.accept(f.request(), f.command)) as Response).status).toBe(403)
    expect(await f.rows('quickbooks_managed_grants')).toHaveLength(0)
    expect(await f.canonical.readConnection()).toBeNull()
  })
  it('removes transient receipts on real account closure without resetting the connection generation', async () => {
    const f = await fixture(runtime)
    await f.commands.accept(f.request(), f.command)
    await closeActor(f)
    expect(await f.rows('quickbooks_managed_grants')).toEqual([])
    expect(await f.rows('quickbooks_connection_generation')).toEqual([
      { singleton: 1, generation: 1 },
    ])
    expect(((await f.commands.accept(f.request(), f.command)) as Response).status).toBe(401)
    expect(await f.rows('quickbooks_managed_grants')).toEqual([])
  })
  it('upgrades existing connections without rewriting their credentials or treating them as new grants', async () => {
    const f = await fixture(runtime, true)
    // Seed a real pre0157 row, without calling the newer generation-aware writer.
    await f.execute(`INSERT INTO quickbooks_connections(id,realm_id,access_token,refresh_token,access_token_expires_at,
      refresh_token_expires_at,scope,connected_by_user_id,connected_at,created_at,updated_at)
      VALUES(1,'owned-realm','LEGACY_ACCESS','LEGACY_REFRESH','2026-10-24T19:00:00.000Z','2027-10-24T18:00:00.000Z',
      'com.intuit.quickbooks.accounting',2,'${initial}','${initial}','${initial}')`)
    const before = await f.rows('quickbooks_connections')
    await f.upgrade()
    expect(await f.rows('quickbooks_connections')).toEqual(before)
    expect(data(await f.commands.prepare(f.request()))).toMatchObject({
      connected: true,
      connectionGeneration: 0,
    })
    await f.canonical.disconnect({ now: f.now() })
    expect(data(await f.commands.prepare(f.request()))).toMatchObject({
      connected: false,
      connectionGeneration: 1,
    })
    expect(((await f.commands.accept(f.request(), f.command)) as Response).status).toBe(409)
    expect(await f.rows('quickbooks_managed_grants')).toHaveLength(0)
  })
})
