import { createHash } from 'node:crypto'
import { createManagedQuickBooksRevocationCoordinator } from '@ezacto/integrations'
import { atomicStatements } from '../src/atomic-statements.js'
import { quickBooksConnectionStatements } from '../src/quickbooks-connection-command.js'
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
import {
  createManagedQuickBooksGrantStore,
  createManagedQuickBooksLifecycleStore,
} from '../src/index.js'
import { createApiSessionService } from '../../api/src/sessions.js'
import { createManagedQuickBooksGrantCommands } from '../../api/src/index.js'
import type { ManagedQuickBooksFenceCommand, ManagedQuickBooksGrantCommand } from '@ezacto/core'
import { createAccountRetentionRepository } from '../src/account-retention.js'
import { createAccountDeletionRequestRepository } from '../src/account-deletion-requests.js'
import { createAccountClosureRepository } from '../src/account-closure.js'

const initial = '2026-10-24T18:00:00.000Z'
const disposers: (() => Promise<void>)[] = []
afterEach(async () => {
  const results = await Promise.allSettled(disposers.splice(0).map(dispose => dispose()))
  vi.restoreAllMocks()
  const failed = results.filter(result => result.status === 'rejected')
  if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'QuickBooks fixture cleanup failed')
})
const fixture = async (
  runtime: 'sqlite' | 'd1',
  legacy: boolean | '0181_reminder_reconciliation' | '0186_quickbooks_outbox_grants' = false,
) => {
  let upgrade!: () => Promise<void>
  let db: ReturnType<typeof createContainerDatabase> | ReturnType<typeof createD1Database>
  let sessions:
    ReturnType<typeof createContainerSessionStore> | ReturnType<typeof createD1SessionStore>
  let now = initial
  if (runtime === 'sqlite') {
    const native = new BetterSqlite3(':memory:')
    disposers.push(async () => { native.close() })
    if (legacy)
      migrateContainerThrough(native, legacy === true ? '0156_wise_signed_deliveries' : legacy)
    else migrateContainer(native)
    upgrade = async () => {
      migrateContainer(native)
    }
    db = createContainerDatabase(native)
    sessions = createContainerSessionStore(native, { now: () => now })
  } else {
    const mf = new Miniflare({
      modules: true,
      script: 'export default {fetch(){return new Response("ok")}}',
      d1Databases: ['DB'],
    })
    // Own the worker before any await: a timed-out startup/migration must not
    // leak a writer into subsequent cases or overwrite their disposer.
    disposers.push(() => mf.dispose())
    const binding = await mf.getD1Database('DB')
    if (legacy)
      await migrateD1Through(binding, legacy === true ? '0156_wise_signed_deliveries' : legacy)
    else await migrateD1(binding)
    upgrade = () => migrateD1(binding)
    db = createD1Database(binding)
    sessions = createD1SessionStore(binding, { now: () => now })
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
    lifecycle,
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
    legacy,
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
type Fixture = Awaited<ReturnType<typeof fixture>>
const fence = (
  f: Fixture,
  over: Partial<ManagedQuickBooksFenceCommand> = {},
): ManagedQuickBooksFenceCommand => ({
  revocationId: 'd'.repeat(64),
  grantId: f.command.grantId,
  expectedActorUserId: 2,
  expectedConnectionGeneration: 1,
  environment: 'sandbox',
  reason: 'disconnect',
  ...over,
})
const connect = async (f: Fixture) => {
  if (f.legacy === '0181_reminder_reconciliation') {
    // Seed the actual pre0182 receipt/connection, not the current command whose
    // refresh guard requires0184. No old-schema guards are disabled or mocked.
    const c = f.command, t = c.tokens
    const fingerprint = createHash('sha256').update(JSON.stringify([c.grantId,c.browserHash,c.credentialHash,
      c.expectedActorUserId,c.expectedConnectionGeneration,c.expiresAt,t.realmId,t.companyName,t.scope,
      t.accessToken,t.refreshToken,t.accessTokenExpiresAt,t.refreshTokenExpiresAt])).digest('hex')
    await atomicStatements(f.db, [{ text: `INSERT INTO quickbooks_managed_grants
      (grant_id,actor_id,authority_kind,session_id,browser_hash,credential_hash,command_fingerprint,
       expected_generation,accepted_generation,realm_id,expires_at,recorded_at)
      VALUES(?,2,'guarded-session',NULL,?,?,?,0,1,?,?,?) RETURNING grant_id`,
      params: [c.grantId,c.browserHash,c.credentialHash,fingerprint,t.realmId,c.expiresAt,f.now()] },
      ...quickBooksConnectionStatements({ ...t, connectedByUserId: 2, now: f.now() })])
    expect(await f.rows('quickbooks_connection_generation')).toMatchObject([{ generation: 1 }])
  } else {
    expect(data(await f.commands.accept(f.request(), f.command))).toMatchObject({ connectionGeneration: 1 })
  }
}
const status = (value: unknown) => (value instanceof Response ? value.status : 0)
const everything = async (f: Fixture, excludeLedger = false, existingTables?: readonly string[]) => {
  const tables = await f.db.all<{ name: string }>(
    sql.raw(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'" +
        (excludeLedger ? " AND name<>'_ezacto_migrations'" : ''),
    ),
  )
  const dump: unknown[] = []
  for (const { name } of tables) if (existingTables === undefined || existingTables.includes(name)) dump.push(await f.rows(`"${name}"`))
  return JSON.stringify(dump)
}

describe.each(['sqlite', 'd1'] as const)('managed QuickBooks lifecycle fence %s', (runtime) => {
  it('returns only the current grant identity to an authenticated administrator', async () => {
    const f = await fixture(runtime)
    expect(data(await f.commands.currentGrant(f.request())).grant).toBeNull()
    expect(status(await f.commands.currentGrant(f.request(f.member.token)))).toBe(403)
    expect(status(await f.commands.currentGrant(f.request(f.admin.token, 'https://evil.example')))).toBe(403)
    data(await f.commands.accept(f.request(), f.command))
    const result = data(await f.commands.currentGrant(f.request()))
    expect(result.grant).toEqual({ grantId: f.command.grantId, connectionGeneration: 1 })
    expect(JSON.stringify(result)).not.toContain('PRIVATE_')
    data(await f.commands.fence(f.request(), fence(f)))
    expect(data(await f.commands.currentGrant(f.request())).grant).toBeNull()
  })

  it('refuses an unbound live connection and a revoked administrator session', async () => {
    const f = await fixture(runtime)
    await f.canonical.saveConnection({ ...f.command.tokens, connectedByUserId: 2, now: f.now() })
    expect(status(await f.commands.currentGrant(f.request()))).toBe(409)
    await f.sessions.revoke(2, f.admin.session.id)
    expect(status(await f.commands.currentGrant(f.request()))).toBe(401)
  })

  it('retains an ambiguous provider revocation and refuses a second transport', async () => {
    const f = await fixture(runtime)
    data(await f.commands.accept(f.request(), f.command))
    data(await f.commands.fence(f.request(), fence(f)))
    const provider = vi.fn(async () => { throw new Error('PRIVATE_PROVIDER_RESPONSE') })
    const coordinator = createManagedQuickBooksRevocationCoordinator({ store: f.lifecycle, admitted: () => true,
      revoke: provider, now: () => new Date(f.now()) })
    expect(await coordinator.run(fence(f).revocationId)).toBe('uncertain')
    expect(await coordinator.run(fence(f).revocationId)).toBe('uncertain')
    expect(provider).toHaveBeenCalledOnce()
    expect(await f.lifecycle.readRevocation(fence(f).revocationId)).toMatchObject({ status: 'attempting', attempts: 1 })
    expect(status(await f.commands.prepare(f.request()))).toBe(409)
  })

  it('adds the recovery index without changing existing revocation custody', async () => {
    const f = await fixture(runtime, '0186_quickbooks_outbox_grants')
    data(await f.commands.accept(f.request(), f.command))
    data(await f.commands.fence(f.request(), fence(f)))
    const before = await f.rows('quickbooks_revocations')
    await f.upgrade()
    expect(await f.rows('quickbooks_revocations')).toEqual(before)
    expect(await f.lifecycle.nextUnresolved()).toMatchObject({ revocationId: fence(f).revocationId, status: 'pending' })
  })

  it('fences the current grant with fresh authority and replays the same intent', async () => {
    const f = await fixture(runtime)
    const intent = { revocationId: 'd'.repeat(64), environment: 'sandbox' as const }
    expect(data(await f.commands.fenceCurrent(f.request(), intent)).fence).toBeNull()
    expect(status(await f.commands.fenceCurrent(f.request(f.member.token), intent))).toBe(403)
    data(await f.commands.accept(f.request(), f.command))
    const result = data(await f.commands.fenceCurrent(f.request(), intent))
    expect(result.fence).toMatchObject({ outcome: 'fenced', revocation: { status: 'pending', grantId: f.command.grantId } })
    expect(JSON.stringify(result)).not.toContain('PRIVATE_')
    expect(data(await f.commands.fenceCurrent(f.request(), intent)).fence).toMatchObject({ outcome: 'replayed' })
    expect(status(await f.commands.fenceCurrent(f.request(), { ...intent, environment: 'production' }))).toBe(409)
    expect(await f.rows('quickbooks_revocations')).toHaveLength(1)
    const guarded = createManagedQuickBooksGrantCommands({ store: f.store, lifecycle: f.lifecycle,
      guardedUserId: async () => 2, now: f.now })
    expect(data(await guarded.fenceCurrent(f.request(), intent)).fence).toMatchObject({ outcome: 'replayed' })
    const denied = createManagedQuickBooksGrantCommands({ store: f.store, lifecycle: f.lifecycle,
      guardedUserId: async () => 3, now: f.now })
    expect(status(await denied.fenceCurrent(f.request(), intent))).toBe(403)
  })

  it('discovers bounded pending and uncertain revocation work', async () => {
    const f = await fixture(runtime)
    const plan = await f.db.all<{ detail: string }>(sql.raw("EXPLAIN QUERY PLAN SELECT revocation_id FROM quickbooks_revocations WHERE status='pending' ORDER BY fenced_at,revocation_id LIMIT 1"))
    expect(plan.some(row => row.detail.includes('quickbooks_revocations_recovery'))).toBe(true)
    expect(await f.lifecycle.nextUnresolved()).toBeNull()
    data(await f.commands.accept(f.request(), f.command))
    data(await f.commands.fence(f.request(), fence(f)))
    expect(await f.lifecycle.nextUnresolved()).toMatchObject({ revocationId: fence(f).revocationId, status: 'pending' })
    await f.lifecycle.beginRevocation(fence(f).revocationId, f.now())
    expect(await f.lifecycle.nextUnresolved()).toMatchObject({ revocationId: fence(f).revocationId, status: 'attempting' })
    await f.lifecycle.settleRevocation(fence(f).revocationId, 'revoked', f.now())
    expect(await f.lifecycle.nextUnresolved()).toBeNull()
  })

  it('fences, retains only the refresh token, and refuses stale grant/refresh/native writes', async () => {
    const f = await fixture(runtime)
    await connect(f)
    const result = data(await f.commands.fence(f.request(), fence(f)))
    expect(result).toMatchObject({
      actorUserId: 2,
      outcome: 'fenced',
      connectionGeneration: 2,
      revocation: {
        status: 'pending',
        complete: false,
        realmId: 'owned-realm',
        environment: 'sandbox',
        fencedGeneration: 2,
      },
    })
    expect(JSON.stringify(result)).not.toContain('SENTINEL')
    expect(await f.canonical.readConnection()).toBeNull()
    const [connection] = await f.rows('quickbooks_connections')
    expect(connection).toMatchObject({ access_token: '-', refresh_token: '-' })
    expect((await f.rows('quickbooks_revocations'))[0]).toMatchObject({
      refresh_token: 'PRIVATE_REFRESH_SENTINEL',
    })
    expect(await everything(f)).not.toContain('PRIVATE_ACCESS_SENTINEL')
    // A stale refresh worker cannot write back, and a stale callback cannot recreate it.
    await f.canonical.saveTokens({
      realmId: 'owned-realm',
      accessToken: 'LATE_ACCESS',
      refreshToken: 'LATE_REFRESH',
      accessTokenExpiresAt: '2026-10-24T20:00:00.000Z',
      refreshTokenExpiresAt: '2027-10-24T18:00:00.000Z',
      now: f.now(),
    })
    expect(await f.canonical.readConnection()).toBeNull()
    expect(await everything(f)).not.toContain('LATE_')
    for (const generation of [0, 1])
      expect(
        status(
          await f.commands.accept(f.request(), {
            ...f.command,
            grantId: String(generation).repeat(64),
            expectedConnectionGeneration: generation,
          }),
        ),
      ).toBe(409)
    expect(await f.canonical.readConnection()).toBeNull()
  })

  it('[race #1236] blocks fresh reconnect until the prior provider revocation is resolved', async () => {
    const f = await fixture(runtime)
    await connect(f)
    data(await f.commands.fence(f.request(), fence(f)))
    const fresh = {
      ...f.command,
      grantId: 'f'.repeat(64),
      expectedConnectionGeneration: 2,
      tokens: {
        ...f.command.tokens,
        accessToken: 'NEW_RECONNECT_ACCESS',
        refreshToken: 'NEW_RECONNECT_REFRESH',
      },
    }
    expect(status(await f.commands.prepare(f.request()))).toBe(409)
    expect(status(await f.commands.accept(f.request(), fresh))).toBe(409)
    await expect(
      f.canonical.saveConnection({ ...fresh.tokens, connectedByUserId: 2, now: f.now() }),
    ).rejects.toThrow()
    expect(await f.canonical.readConnection()).toBeNull()
    expect(await everything(f)).not.toContain('NEW_RECONNECT_')
    const id = fence(f).revocationId
    await f.lifecycle.beginRevocation(id, f.now())
    expect(status(await f.commands.prepare(f.request()))).toBe(409)
    await f.lifecycle.settleRevocation(id, 'not_revoked', f.now())
    expect(status(await f.commands.accept(f.request(), fresh))).toBe(409)
    await f.lifecycle.beginRevocation(id, f.now())
    await f.lifecycle.settleRevocation(id, 'revoked', f.now())
    expect(data(await f.commands.prepare(f.request()))).toMatchObject({
      connectionGeneration: 2,
      connected: false,
    })
    expect(data(await f.commands.accept(f.request(), fresh))).toMatchObject({
      outcome: 'accepted',
      connectionGeneration: 3,
    })
    expect(await f.canonical.readConnection()).toMatchObject({
      accessToken: 'NEW_RECONNECT_ACCESS',
    })
    expect(await f.lifecycle.beginRevocation(id, f.now())).toMatchObject({
      custody: null,
      revocation: { complete: true },
    })
  })

  it('[migration #1236] retains all data while fencing an unresolved prior connection on upgrade', async () => {
    const f = await fixture(runtime, '0181_reminder_reconciliation')
    await connect(f)
    data(await f.commands.fence(f.request(), fence(f)))
    const existing = (await f.db.all<{ name: string }>(sql.raw("SELECT name FROM sqlite_schema WHERE type='table'"))).map(row => row.name)
    const before = await everything(f, true)
    await f.upgrade()
    expect(await everything(f, true, existing)).toBe(before)
    const added = (await f.db.all<{ name: string }>(sql.raw("SELECT name FROM sqlite_schema WHERE type='table'")))
      .map(row => row.name).filter(name => !existing.includes(name)).sort()
    expect(added).toEqual(['bill_effect_fences','quickbooks_outbox_grants','quickbooks_refresh_attempts','quickbooks_write_attempts','quickbooks_write_effects','quickbooks_write_request_chunks','quickbooks_write_response_chunks','wise_managed_commands','wise_managed_connection'])
    expect(await f.rows('quickbooks_refresh_attempts')).toEqual([])
    expect(await f.rows('wise_managed_commands')).toEqual([])
    expect(await f.rows('wise_managed_connection')).toMatchObject([{ singleton: 1, generation: 0, status: 'disconnected' }])
    expect(status(await f.commands.prepare(f.request()))).toBe(409)
    await expect(
      f.canonical.saveConnection({ ...f.command.tokens, connectedByUserId: 2, now: f.now() }),
    ).rejects.toThrow()
    expect(await everything(f, true, existing)).toBe(before)
  })

  it('[migration #1236] refuses a pre-existing live/revoking overlap without changing its custody or ledger', async () => {
    const f = await fixture(runtime, '0181_reminder_reconciliation')
    await connect(f)
    data(await f.commands.fence(f.request(), fence(f)))
    // This is the actual write accepted by the old schema; no guards are dropped.
    await f.canonical.saveConnection({
      ...f.command.tokens,
      accessToken: 'UNRESOLVED_RECONNECT_ACCESS',
      refreshToken: 'UNRESOLVED_RECONNECT_REFRESH',
      connectedByUserId: 2,
      now: f.now(),
    })
    expect((await f.rows('quickbooks_connections'))[0]?.disconnected_at).toBeNull()
    const before = await everything(f)
    await expect(f.upgrade()).rejects.toThrow(/ok=1/)
    expect(await everything(f)).toBe(before)
    expect(
      await f.db.all(
        sql.raw("SELECT name FROM sqlite_schema WHERE name='quickbooks_reconnect_upgrade_guard'"),
      ),
    ).toEqual([])
  })

  it('replays exactly, and refuses a changed binding for the same intent', async () => {
    const f = await fixture(runtime)
    await connect(f)
    data(await f.commands.fence(f.request(), fence(f)))
    expect(data(await f.commands.fence(f.request(), fence(f)))).toMatchObject({
      outcome: 'replayed',
      connectionGeneration: 2,
      revocation: { status: 'pending' },
    })
    for (const changed of [
      { environment: 'production' },
      { reason: 'erasure' },
      { grantId: 'e'.repeat(64) },
    ] as const)
      expect(status(await f.commands.fence(f.request(), fence(f, changed)))).toBe(409)
    expect(await f.rows('quickbooks_revocations')).toHaveLength(1)
  })

  it('requires fresh administrator authority and an exact grant, generation and actor', async () => {
    const f = await fixture(runtime)
    await connect(f)
    expect(
      status(
        await f.commands.fence(f.request(f.member.token), fence(f, { expectedActorUserId: 3 })),
      ),
    ).toBe(403)
    expect(
      status(await f.commands.fence(f.request(f.admin.token, 'https://evil.example'), fence(f))),
    ).toBe(403)
    expect(status(await f.commands.fence(f.request(), fence(f, { expectedActorUserId: 1 })))).toBe(
      403,
    )
    expect(status(await f.commands.fence(f.request(), fence(f, { revocationId: 'bad' })))).toBe(422)
    expect(status(await f.commands.fence(f.request(), fence(f, { grantId: 'e'.repeat(64) })))).toBe(
      409,
    )
    expect(
      status(await f.commands.fence(f.request(), fence(f, { expectedConnectionGeneration: 0 }))),
    ).toBe(409)
    expect(
      status(await f.commands.fence(f.request(), fence(f, { expectedConnectionGeneration: 2 }))),
    ).toBe(409)
    await f.sessions.revoke(2, f.admin.session.id)
    expect(await f.rows('quickbooks_revocations')).toHaveLength(0)
    expect(await f.canonical.readConnection()).toMatchObject({ realmId: 'owned-realm' })
  })

  it('refuses a fence with no live connection or after an unfenced native disconnect', async () => {
    const f = await fixture(runtime)
    expect(
      status(await f.commands.fence(f.request(), fence(f, { expectedConnectionGeneration: 0 }))),
    ).toBe(409)
    await connect(f)
    await expect(f.canonical.disconnect({ now: f.now() })).rejects.toThrow()
    expect(await f.canonical.readConnection()).toMatchObject({ realmId: 'owned-realm' })
    await expect(
      f.canonical.saveConnection({
        realmId: 'other-realm',
        accessToken: 'A',
        refreshToken: 'R',
        accessTokenExpiresAt: '2026-10-24T19:00:00.000Z',
        refreshTokenExpiresAt: '2027-10-24T18:00:00.000Z',
        scope: 'com.intuit.quickbooks.accounting',
        connectedByUserId: 2,
        companyName: null,
        now: f.now(),
      }),
    ).rejects.toThrow()
    expect(await f.canonical.readConnection()).toMatchObject({ realmId: 'owned-realm' })
    data(await f.commands.fence(f.request(), fence(f)))
    expect(
      status(
        await f.commands.fence(
          f.request(),
          fence(f, { revocationId: 'f'.repeat(64), expectedConnectionGeneration: 2 }),
        ),
      ),
    ).toBe(409)
  })

  it('lets exactly one of concurrent fences win', async () => {
    const f = await fixture(runtime)
    await connect(f)
    const results = await Promise.all(
      ['1', '2', '3'].map((digit) =>
        f.commands.fence(f.request(), fence(f, { revocationId: digit.repeat(64) })),
      ),
    )
    expect(results.filter((value) => !(value instanceof Response))).toHaveLength(1)
    expect(results.filter((value) => status(value) === 409)).toHaveLength(2)
    expect(await f.rows('quickbooks_revocations')).toHaveLength(1)
    expect((await f.rows('quickbooks_connection_generation'))[0]).toMatchObject({ generation: 2 })
  })

  it('keeps provider failure pending, withholds the credential after a lost reply, and retires it on success', async () => {
    const f = await fixture(runtime)
    await connect(f)
    const id = 'd'.repeat(64)
    data(await f.commands.fence(f.request(), fence(f)))
    expect(await f.lifecycle.listUnresolved()).toHaveLength(1)
    const first = await f.lifecycle.beginRevocation(id, f.now())
    expect(first.custody).toEqual({
      revocationId: id,
      realmId: 'owned-realm',
      environment: 'sandbox',
      refreshToken: 'PRIVATE_REFRESH_SENTINEL',
    })
    expect(JSON.stringify(first.revocation)).not.toContain('SENTINEL')
    // Lost reply or restart: a new store instance cannot retry the credential blindly.
    const restarted = createManagedQuickBooksLifecycleStore(f.db)
    expect(await restarted.beginRevocation(id, f.now())).toMatchObject({
      custody: null,
      revocation: { status: 'attempting', attempts: 1, complete: false },
    })
    expect(await restarted.settleRevocation(id, 'not_revoked', f.now())).toMatchObject({
      status: 'pending',
      complete: false,
    })
    expect(await f.lifecycle.listUnresolved()).toHaveLength(1)
    const second = await f.lifecycle.beginRevocation(id, f.now())
    expect(second.custody?.refreshToken).toBe('PRIVATE_REFRESH_SENTINEL')
    expect(second.revocation.attempts).toBe(2)
    expect(await f.lifecycle.settleRevocation(id, 'revoked', f.now())).toMatchObject({
      status: 'revoked',
      complete: true,
    })
    expect(await f.lifecycle.settleRevocation(id, 'revoked', f.now())).toMatchObject({
      complete: true,
    })
    await expect(f.lifecycle.settleRevocation(id, 'not_revoked', f.now())).rejects.toThrow()
    expect(await f.lifecycle.beginRevocation(id, f.now())).toMatchObject({
      custody: null,
      revocation: { complete: true },
    })
    expect(await f.lifecycle.listUnresolved()).toHaveLength(0)
    expect((await f.rows('quickbooks_revocations'))[0]).toMatchObject({
      refresh_token: null,
      status: 'revoked',
    })
    const dump = await everything(f)
    expect(dump).not.toContain('PRIVATE_REFRESH_SENTINEL')
    expect(dump).not.toContain('PRIVATE_ACCESS_SENTINEL')
    await expect((async () => f.execute(`DELETE FROM quickbooks_revocations`))()).rejects.toThrow()
  })

  it('claims the credential once under concurrent begin calls', async () => {
    const f = await fixture(runtime)
    await connect(f)
    data(await f.commands.fence(f.request(), fence(f)))
    const claims = await Promise.all(
      [1, 2, 3].map(() => f.lifecycle.beginRevocation('d'.repeat(64), f.now())),
    )
    expect(claims.filter((claim) => claim.custody !== null)).toHaveLength(1)
    expect((await f.rows('quickbooks_revocations'))[0]).toMatchObject({ attempts: 1 })
  })

  it('rejects unknown or malformed revocations and inventories the record for account closure', async () => {
    const f = await fixture(runtime)
    await connect(f)
    data(await f.commands.fence(f.request(), fence(f)))
    await expect(f.lifecycle.beginRevocation('9'.repeat(64), f.now())).rejects.toThrow()
    await expect(f.lifecycle.settleRevocation('bad', 'revoked', f.now())).rejects.toThrow()
    await expect(f.lifecycle.settleRevocation('d'.repeat(64), 'revoked', f.now())).rejects.toThrow()
    await createAccountRetentionRepository(f.db).publish({
      actorUserId: 1,
      expectedVersion: 0,
      policy: {
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
      },
      now: f.now(),
    })
    await createAccountDeletionRequestRepository(f.db).request({
      userId: 2,
      id: 'owned-revocation-closure',
      now: f.now(),
      expectedPolicyVersion: 1,
    })
    const preview = await createAccountClosureRepository(f.db).preview(
      1,
      'owned-revocation-closure',
    )
    expect(preview.inventory).toContainEqual({
      location: 'quickbooks_revocations.actor_id',
      count: 1,
      category: 'billing_and_payments',
    })
  })
})
