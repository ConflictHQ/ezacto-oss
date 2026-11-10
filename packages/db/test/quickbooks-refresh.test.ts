import BetterSqlite3 from 'better-sqlite3'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Miniflare } from 'miniflare'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createManagedQuickBooksRefresh, type QuickBooksTokens, type ManagedQuickBooksRefreshStore } from '@ezacto/integrations'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { atomicStatements } from '../src/atomic-statements.js'
import type { InvoiceStateDatabase } from '../src/invoice-state.js'
import { createManagedQuickBooksGrantStore } from '../src/managed-quickbooks.js'
import { createManagedQuickBooksLifecycleStore } from '../src/managed-quickbooks-lifecycle.js'
import { createQuickBooksStore } from '../src/quickbooks.js'
import { createManagedQuickBooksRefreshStore } from '../src/quickbooks-refresh.js'
import { createAccountRetentionRepository } from '../src/account-retention.js'
import { createAccountDeletionRequestRepository } from '../src/account-deletion-requests.js'
import { createAccountClosureRepository } from '../src/account-closure.js'

const worker = { modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['DB'] } as const
const authority = { kind: 'guarded-session', userId: 2 } as const
const grantId = 'a'.repeat(64)
const attemptId = '11111111-1111-4111-8111-111111111111'
const at = '2026-11-10T03:00:00.000Z'
const replacement: QuickBooksTokens = { accessToken: 'PRIVATE_NEW_ACCESS', refreshToken: 'PRIVATE_NEW_REFRESH',
  accessTokenExpiresAt: '2026-11-10T04:00:00.000Z', refreshTokenExpiresAt: '2027-01-01T00:00:00.000Z' }

describe.each(['sqlite', 'd1'] as const)('managed QuickBooks refresh ownership %s', backend => {
  let root: string, snapshot: Buffer
  let template: Miniflare | undefined
  const closers: (() => Promise<void>)[] = []
  let closed = false
  const closeAll = async () => {
    const results = await Promise.allSettled(closers.splice(0).map(close => close()))
    for (const result of results) if (result.status === 'rejected') throw result.reason
  }
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'qb-refresh-'))
    if (backend === 'sqlite') {
      const native = new BetterSqlite3(':memory:')
      try { migrateContainer(native); snapshot = native.serialize() } finally { native.close() }
    } else {
      template = new Miniflare({ ...worker, d1Persist: join(root, 'template') })
      let closing: Promise<void> | undefined
      const dispose = () => closing ??= template!.dispose()
      closers.push(dispose)
      try { await migrateD1(await template.getD1Database('DB')) } finally { await dispose() }
      if (closed) throw new Error('Owned refresh fixture setup was closed')
    }
  })
  afterEach(closeAll)
  afterAll(async () => { closed = true; try { await closeAll() } finally { if (root) await rm(root, { recursive: true, force: true }) } })

  const fixture = async (blockedImport = false) => {
    let db: InvoiceStateDatabase
    if (backend === 'sqlite') {
      const native = new BetterSqlite3(Buffer.from(snapshot)); native.pragma('foreign_keys=ON')
      closers.push(async () => { native.close() })
      db = createContainerDatabase(native)
    } else {
      const path = join(root, crypto.randomUUID())
      await cp(join(root, 'template'), path, { recursive: true })
      const mf = new Miniflare({ ...worker, d1Persist: path })
      let closing: Promise<void> | undefined
      closers.push(() => closing ??= mf.dispose())
      db = createD1Database(await mf.getD1Database('DB'))
    }
    const execute = (text: string, params: readonly unknown[] = []) => atomicStatements(db, [{ text, params }])
    const seed = [
      { text: `INSERT INTO organizations(name,modules,created_at,updated_at) VALUES('Owned','{}',?,?) RETURNING id`, params: [at,at] },
      { text: `INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at)
        VALUES(1,'Owner','Fixture','administrator','[]',?,?),(2,'Admin','Fixture','administrator','[]',?,?) RETURNING id`, params: [at,at,at,at] },
    ]
    if (blockedImport) {
      const runId = crypto.randomUUID(), epoch = Date.parse(at)
      await execute(`INSERT INTO migration_loads(id,catalog_json,options_json,snapshot_sha256,source_rows,status,created_at,updated_at)
        VALUES(?,'{}','{}',?,0,'ready',?,?) RETURNING id`, [runId,'e'.repeat(64),at,at])
      await execute(`UPDATE migration_loads SET status='running',started_at=? RETURNING id`, [at])
      await execute(`INSERT INTO _ezacto_load_lease(singleton,holder,fence,claimed_at,expires_at,snapshot_sha256,manifest_sha256,source_fingerprint)
        VALUES(1,'owned-refresh-import',1,?,?,?,'fixture','fixture') RETURNING singleton`, [epoch,epoch+60_000,'e'.repeat(64)])
      // Native import authority permits these owned partial rows; ordinary
      // writes are barred again before the started job is cancelled.
      await atomicStatements(db, [
        { text: `INSERT INTO _ezacto_migration_write_context(singleton,run_id,holder,fence,at_ms,allowed)
          VALUES(1,?,'owned-refresh-import',1,?,1) RETURNING singleton`, params: [runId,epoch] },
        ...seed,
        { text: 'DELETE FROM _ezacto_migration_write_context RETURNING singleton', params: [] },
      ])
      await execute(`UPDATE migration_loads SET status='cancelled' RETURNING id`)
      await execute(`UPDATE _ezacto_load_lease SET released_at=? RETURNING singleton`, [epoch])
    } else { await atomicStatements(db, seed) }
    const grants = createManagedQuickBooksGrantStore(db)
    if (!blockedImport) await grants.accept({ grantId, browserHash: 'b'.repeat(64), credentialHash: 'c'.repeat(64), expectedActorUserId: 2,
      expectedConnectionGeneration: 0, expiresAt: Date.parse(at) + 600_000,
      tokens: { realmId: '111', companyName: 'Owned', accessToken: 'PRIVATE_OLD_ACCESS', refreshToken: 'PRIVATE_OLD_REFRESH',
        accessTokenExpiresAt: '2026-11-10T03:01:00.000Z', refreshTokenExpiresAt: '2027-01-01T00:00:00.000Z',
        scope: 'com.intuit.quickbooks.accounting' } }, authority, at)
    const canonical = createQuickBooksStore(db)
    const connection = (await canonical.readConnection())!
    const store = createManagedQuickBooksRefreshStore(db)
    const compose = (override: ManagedQuickBooksRefreshStore = store, admitted = () => true) => createManagedQuickBooksRefresh({
      store: override, admitted, now: () => new Date(at), newAttemptId: () => attemptId,
    })
    return { db, execute, store, compose, canonical, connection, grants, lifecycle: createManagedQuickBooksLifecycleStore(db) }
  }

  it('commits one owner before the exchange; competing runtimes cannot rotate twice', async () => {
    const f = await fixture()
    let entered!: () => void, release!: (tokens: QuickBooksTokens) => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const response = new Promise<QuickBooksTokens>(resolve => { release = resolve })
    let calls = 0
    const exchange = async () => { calls += 1; entered(); return response }
    const first = f.compose().refresh(f.connection, exchange)
    await started
    expect(await f.compose().status()).toBe('pending')
    await expect(f.compose().refresh(f.connection, exchange)).rejects.toMatchObject({ code: 'provider_unavailable' })
    expect(calls).toBe(1)
    release(replacement)
    await expect(first).resolves.toEqual(replacement)
    expect(await f.store.status()).toBe('ready')
    expect(await f.canonical.readConnection()).toMatchObject(replacement)
    expect((await f.execute('SELECT status,expected_refresh_token,retained_refresh_token FROM quickbooks_refresh_attempts'))[0]).toEqual([
      { status: 'completed', expected_refresh_token: null, retained_refresh_token: null },
    ])
  })

  it('retains unknown outcomes across restart and blocks a new grant without repeating provider work', async () => {
    const f = await fixture(); let calls = 0
    const exchange = async (): Promise<QuickBooksTokens> => { calls += 1; throw new Error('PRIVATE_LOST_PROVIDER_REPLY') }
    await expect(f.compose().refresh(f.connection, exchange)).rejects.toMatchObject({ message: 'QuickBooks authorization requires recovery' })
    expect(await f.compose().status()).toBe('unavailable')
    const restarted = createManagedQuickBooksRefresh({ store: createManagedQuickBooksRefreshStore(f.db), admitted: () => true,
      now: () => new Date('2026-11-11T03:00:00.000Z') })
    await expect(restarted.refresh(f.connection, exchange)).rejects.toMatchObject({ code: 'provider_unavailable' })
    expect(calls).toBe(1)
    await expect(f.grants.prepare(authority, at)).rejects.toMatchObject({ kind: 'conflict' })
    await expect(f.execute('DELETE FROM quickbooks_refresh_attempts RETURNING attempt_id')).rejects.toThrow('managed_quickbooks_refresh_unresolved')
    expect(await f.canonical.readConnection()).toMatchObject({ refreshToken: 'PRIVATE_OLD_REFRESH' })
    await createAccountRetentionRepository(f.db).publish({ actorUserId: 1, expectedVersion: 0, now: at,
      policy: { frameworks: [], retained_records: (['audit_and_security', 'billing_and_payments'] as const).map(category => ({
        category, reason: 'Owned fixture review.', period: 'One year then review.', review_after_days: 30,
      })), response_target_days: 14, operator_contact: 'privacy@example.test', user_notice: 'Reviewed closure.',
      backup_handling: 'Replay closure.', acknowledged: true } })
    await createAccountDeletionRequestRepository(f.db).request({ userId: 2, id: 'owned-refresh-closure', now: at, expectedPolicyVersion: 1 })
    const preview = await createAccountClosureRepository(f.db).preview(1, 'owned-refresh-closure')
    expect(preview.inventory).toContainEqual({ location: 'quickbooks_refresh_attempts.actor_id', count: 1, category: 'billing_and_payments' })
    expect(JSON.stringify(preview)).not.toContain('PRIVATE_')
  })

  it('retains a late replacement for cleanup after a native lifecycle fence, preserving old revocation custody', async () => {
    const f = await fixture()
    await expect(f.compose().refresh(f.connection, async () => {
      await f.lifecycle.fence({ revocationId: 'd'.repeat(64), grantId, expectedActorUserId: 2,
        expectedConnectionGeneration: 1, environment: 'sandbox', reason: 'disconnect' }, authority, at)
      return replacement
    })).rejects.toMatchObject({ code: 'provider_unavailable' })
    expect(await f.canonical.readConnection()).toBeNull()
    expect(await f.store.status()).toBe('unavailable')
    expect((await f.execute('SELECT status,retained_refresh_token FROM quickbooks_refresh_attempts'))[0]).toEqual([
      { status: 'orphaned', retained_refresh_token: replacement.refreshToken },
    ])
    expect((await f.execute('SELECT status,refresh_token FROM quickbooks_revocations'))[0]).toEqual([
      { status: 'pending', refresh_token: 'PRIVATE_OLD_REFRESH' },
    ])
  })

  it('recovers a lost completion acknowledgement without replaying refresh and rejects a changed result', async () => {
    const f = await fixture(); let calls = 0
    const faulted: ManagedQuickBooksRefreshStore = { ...f.store, finish: async input => {
      await f.store.finish(input); throw new Error('Owned lost commit acknowledgement')
    } }
    await expect(f.compose(faulted).refresh(f.connection, async () => { calls += 1; return replacement })).rejects.toMatchObject({ code: 'provider_unavailable' })
    expect(await f.store.status()).toBe('ready')
    expect(await f.canonical.readConnection()).toMatchObject(replacement)
    expect(await f.store.finish({ attemptId, tokens: replacement, now: at })).toBe('completed')
    expect(await f.store.finish({ attemptId, tokens: { ...replacement, refreshToken: 'PRIVATE_WRONG_RESULT' }, now: at })).toBe('unavailable')
    expect(calls).toBe(1)
  })

  it('denies missing admission and a foreign connection snapshot before provider transport', async () => {
    const f = await fixture(); let calls = 0
    const exchange = async () => { calls += 1; return replacement }
    await expect(f.compose(f.store, () => false).refresh(f.connection, exchange)).rejects.toMatchObject({ code: 'provider_unavailable' })
    await expect(f.compose().refresh({ ...f.connection, realmId: '222' }, exchange)).rejects.toMatchObject({ code: 'provider_unavailable' })
    expect(calls).toBe(0)
    expect((await f.execute('SELECT count(*) AS n FROM quickbooks_refresh_attempts'))[0]).toEqual([{ n: 0 }])
  })

  it('refuses an unowned token write and permits a subsequent owned refresh when the provider retains its refresh token', async () => {
    const f = await fixture()
    await expect(f.canonical.saveTokens({ realmId: f.connection.realmId, ...replacement, now: at })).rejects.toMatchObject({
      name: 'ManagedQuickBooksRefreshUnavailableError', code: 'provider_unavailable', message: 'QuickBooks authorization requires recovery',
    })
    expect(await f.canonical.readConnection()).toMatchObject({ accessToken: 'PRIVATE_OLD_ACCESS', refreshToken: 'PRIVATE_OLD_REFRESH' })
    const first = { ...replacement, refreshToken: f.connection.refreshToken }
    await expect(f.compose().refresh(f.connection, async () => first)).resolves.toEqual(first)
    const current = (await f.canonical.readConnection())!
    const next = createManagedQuickBooksRefresh({ store: f.store, admitted: () => true, now: () => new Date(at) })
    await expect(next.refresh(current, async () => replacement)).resolves.toEqual(replacement)
    expect(await f.canonical.readConnection()).toMatchObject(replacement)
  })

  it('releases only its own proven unsent intent when admission changes before transport', async () => {
    const f = await fixture(); let checks = 0, calls = 0
    const exchange = async () => { calls += 1; return replacement }
    await expect(f.compose(f.store, () => ++checks === 1).refresh(f.connection, exchange)).rejects.toMatchObject({ code: 'provider_unavailable' })
    expect(calls).toBe(0)
    expect(await f.store.status()).toBe('ready')
    expect((await f.execute('SELECT status,expected_refresh_token FROM quickbooks_refresh_attempts'))[0]).toEqual([
      { status: 'cancelled', expected_refresh_token: null },
    ])
    const resumed = createManagedQuickBooksRefresh({ store: f.store, admitted: () => true, now: () => new Date(at) })
    await expect(resumed.refresh(f.connection, exchange)).resolves.toEqual(replacement)
    expect(calls).toBe(1)
  })

  it('cancels an ambiguously committed claim only before any provider exchange', async () => {
    const f = await fixture(); let calls = 0
    const exchange = async () => { calls += 1; return replacement }
    const lostClaim: ManagedQuickBooksRefreshStore = { ...f.store, claim: async input => {
      await f.store.claim(input); throw new Error('Owned lost claim acknowledgement')
    } }
    await expect(f.compose(lostClaim).refresh(f.connection, exchange)).rejects.toMatchObject({ code: 'provider_unavailable' })
    expect(calls).toBe(0)
    expect(await f.store.status()).toBe('ready')
    const resumed = createManagedQuickBooksRefresh({ store: f.store, admitted: () => true, now: () => new Date(at) })
    await expect(resumed.refresh(f.connection, exchange)).resolves.toEqual(replacement)
    expect(calls).toBe(1)
  })
  it('retains the cancelled started-import guard for authorization and reconnect', async () => {
    const f = await fixture(true)
    expect((await f.execute('SELECT status,started_at FROM migration_loads'))[0]).toEqual([{ status: 'cancelled', started_at: at }])
    expect(await f.compose().status()).toBe('unavailable')
    await expect(f.grants.prepare(authority, at)).rejects.toMatchObject({ kind: 'conflict' })
    expect((await f.execute('SELECT count(*) AS n FROM quickbooks_refresh_attempts'))[0]).toEqual([{ n: 0 }])
  })

  it('retains the latest rotated credential and blocks reconnect availability while native revocation is pending', async () => {
    const f = await fixture()
    await f.compose().refresh(f.connection, async () => replacement)
    await f.lifecycle.fence({ revocationId: 'd'.repeat(64), grantId, expectedActorUserId: 2,
      expectedConnectionGeneration: 1, environment: 'sandbox', reason: 'disconnect' }, authority, at)
    expect(await f.canonical.readConnection()).toBeNull()
    expect(await f.compose().status()).toBe('unavailable')
    expect((await f.execute('SELECT status,refresh_token FROM quickbooks_revocations'))[0]).toEqual([
      { status: 'pending', refresh_token: replacement.refreshToken },
    ])
    expect((await f.execute('SELECT status,expected_refresh_token,retained_refresh_token FROM quickbooks_refresh_attempts'))[0]).toEqual([
      { status: 'completed', expected_refresh_token: null, retained_refresh_token: null },
    ])
  })

  it('refuses a different grant generation even when the realm, timestamps and credentials match', async () => {
    const f = await fixture(); let calls = 0
    expect(f.connection.connectionGeneration).toBe(1)
    const exchange = async () => { calls += 1; return replacement }
    await expect(f.compose().refresh({ ...f.connection, connectionGeneration: 0 }, exchange)).rejects.toMatchObject({ code: 'provider_unavailable' })
    const { connectionGeneration, ...missingGeneration } = f.connection
    expect(connectionGeneration).toBe(1)
    await expect(f.compose().refresh(missingGeneration, exchange)).rejects.toMatchObject({ code: 'provider_unavailable' })
    expect(calls).toBe(0)
    expect((await f.execute('SELECT count(*) AS n FROM quickbooks_refresh_attempts'))[0]).toEqual([{ n: 0 }])
  })

})
