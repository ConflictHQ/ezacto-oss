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
import type { ManagedQuickBooksFenceCommand, ManagedQuickBooksGrantCommand } from '@ezacto/core'
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
const fence = (f: Fixture, over: Partial<ManagedQuickBooksFenceCommand> = {}): ManagedQuickBooksFenceCommand => ({
  revocationId: 'd'.repeat(64),
  grantId: f.command.grantId,
  expectedActorUserId: 2,
  expectedConnectionGeneration: 1,
  environment: 'sandbox',
  reason: 'disconnect',
  ...over,
})
const connect = async (f: Fixture) => {
  expect(data(await f.commands.accept(f.request(), f.command))).toMatchObject({ connectionGeneration: 1 })
}
const status = (value: unknown) => (value instanceof Response ? value.status : 0)
const everything = async (f: Fixture) => {
  const tables = await f.db.all<{ name: string }>(
    sql.raw("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'"),
  )
  const dump: unknown[] = []
  for (const { name } of tables) dump.push(await f.rows(`"${name}"`))
  return JSON.stringify(dump)
}

describe.each(['sqlite', 'd1'] as const)('managed QuickBooks lifecycle fence %s', (runtime) => {
  it('fences, retains only the refresh token, and refuses stale grant/refresh/native writes', async () => {
    const f = await fixture(runtime)
    await connect(f)
    const result = data(await f.commands.fence(f.request(), fence(f)))
    expect(result).toMatchObject({
      actorUserId: 2,
      outcome: 'fenced',
      connectionGeneration: 2,
      revocation: { status: 'pending', complete: false, realmId: 'owned-realm', environment: 'sandbox', fencedGeneration: 2 },
    })
    expect(JSON.stringify(result)).not.toContain('SENTINEL')
    expect(await f.canonical.readConnection()).toBeNull()
    const [connection] = await f.rows('quickbooks_connections')
    expect(connection).toMatchObject({ access_token: '-', refresh_token: '-' })
    expect((await f.rows('quickbooks_revocations'))[0]).toMatchObject({ refresh_token: 'PRIVATE_REFRESH_SENTINEL' })
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

  it('replays exactly, and refuses a changed binding for the same intent', async () => {
    const f = await fixture(runtime)
    await connect(f)
    data(await f.commands.fence(f.request(), fence(f)))
    expect(data(await f.commands.fence(f.request(), fence(f)))).toMatchObject({
      outcome: 'replayed',
      connectionGeneration: 2,
      revocation: { status: 'pending' },
    })
    for (const changed of [{ environment: 'production' }, { reason: 'erasure' }, { grantId: 'e'.repeat(64) }] as const)
      expect(status(await f.commands.fence(f.request(), fence(f, changed)))).toBe(409)
    expect(await f.rows('quickbooks_revocations')).toHaveLength(1)
  })

  it('requires fresh administrator authority and an exact grant, generation and actor', async () => {
    const f = await fixture(runtime)
    await connect(f)
    expect(status(await f.commands.fence(f.request(f.member.token), fence(f, { expectedActorUserId: 3 })))).toBe(403)
    expect(status(await f.commands.fence(f.request(f.admin.token, 'https://evil.example'), fence(f)))).toBe(403)
    expect(status(await f.commands.fence(f.request(), fence(f, { expectedActorUserId: 1 })))).toBe(403)
    expect(status(await f.commands.fence(f.request(), fence(f, { revocationId: 'bad' })))).toBe(422)
    expect(status(await f.commands.fence(f.request(), fence(f, { grantId: 'e'.repeat(64) })))).toBe(409)
    expect(status(await f.commands.fence(f.request(), fence(f, { expectedConnectionGeneration: 0 })))).toBe(409)
    expect(status(await f.commands.fence(f.request(), fence(f, { expectedConnectionGeneration: 2 })))).toBe(409)
    await f.sessions.revoke?.(f.admin.token)
    expect(await f.rows('quickbooks_revocations')).toHaveLength(0)
    expect(await f.canonical.readConnection()).toMatchObject({ realmId: 'owned-realm' })
  })

  it('refuses a fence with no live connection or after an unfenced native disconnect', async () => {
    const f = await fixture(runtime)
    expect(status(await f.commands.fence(f.request(), fence(f, { expectedConnectionGeneration: 0 })))).toBe(409)
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
    expect(status(await f.commands.fence(f.request(), fence(f, { revocationId: 'f'.repeat(64), expectedConnectionGeneration: 2 })))).toBe(409)
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
    expect(await restarted.settleRevocation(id, 'not_revoked', f.now())).toMatchObject({ status: 'pending', complete: false })
    expect(await f.lifecycle.listUnresolved()).toHaveLength(1)
    const second = await f.lifecycle.beginRevocation(id, f.now())
    expect(second.custody?.refreshToken).toBe('PRIVATE_REFRESH_SENTINEL')
    expect(second.revocation.attempts).toBe(2)
    expect(await f.lifecycle.settleRevocation(id, 'revoked', f.now())).toMatchObject({ status: 'revoked', complete: true })
    expect(await f.lifecycle.settleRevocation(id, 'revoked', f.now())).toMatchObject({ complete: true })
    await expect(f.lifecycle.settleRevocation(id, 'not_revoked', f.now())).rejects.toThrow()
    expect(await f.lifecycle.beginRevocation(id, f.now())).toMatchObject({ custody: null, revocation: { complete: true } })
    expect(await f.lifecycle.listUnresolved()).toHaveLength(0)
    expect((await f.rows('quickbooks_revocations'))[0]).toMatchObject({ refresh_token: null, status: 'revoked' })
    const dump = await everything(f)
    expect(dump).not.toContain('PRIVATE_REFRESH_SENTINEL')
    expect(dump).not.toContain('PRIVATE_ACCESS_SENTINEL')
    await expect(Promise.resolve().then(() => f.execute(`DELETE FROM quickbooks_revocations`))).rejects.toThrow()
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
    const preview = await createAccountClosureRepository(f.db).preview(1, 'owned-revocation-closure')
    expect(preview.inventory).toContainEqual({
      location: 'quickbooks_revocations.actor_id',
      count: 1,
      category: 'billing_and_payments',
    })
  })
})
