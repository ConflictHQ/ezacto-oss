import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import {
  migrateContainer,
  migrateD1,
  migrateContainerThrough,
  migrateD1Through,
} from '../src/migrate.js'
import { accountClosureDigest, closedAccountProviderKey } from '../src/account-closure-sign-in.js'
import { createAppleLifecycleRepository } from '../src/apple-lifecycle.js'
import { createAccountClosureRepository } from '../src/account-closure.js'
import { createAccountDeletionRequestRepository } from '../src/account-deletion-requests.js'
import { createAccountRetentionRepository } from '../src/account-retention.js'

const at = '2026-10-09T00:00:00.000Z'
const origin = 'https://time.example.test'
const binding = {
  subject: 'apple-pat',
  origin,
  grantId: 'grant-one',
  generation: 100,
  eventId: 'binding-one',
}
const revoked = {
  ...binding,
  type: 'apple_revocation' as const,
  eventId: 'revoked-one',
  requestId: 'request-one',
  revokedAt: at,
  now: at,
}
for (const runtime of ['SQLite', 'D1'])
  describe(`Apple lifecycle (${runtime})`, () => {
    let dispose: (() => Promise<void>) | undefined
    afterEach(async () => dispose?.())
    async function setup(legacy = false) {
      let upgrade: () => Promise<void>
      let database: Parameters<typeof createAppleLifecycleRepository>[0]
      let exec: (query: string) => Promise<unknown>
      let rows: (query: string) => Promise<Record<string, unknown>[]>
      if (runtime === 'SQLite') {
        const sqlite = new BetterSqlite3(':memory:')
        if (legacy) migrateContainerThrough(sqlite, '0103_account_closure')
        else migrateContainer(sqlite)
        upgrade = async () => migrateContainer(sqlite)
        database = createContainerDatabase(sqlite)
        exec = async (query) => sqlite.exec(query)
        rows = async (query) => sqlite.prepare(query).all() as Record<string, unknown>[]
        dispose = async () => {
          sqlite.close()
        }
      } else {
        const mf = new Miniflare({
          modules: true,
          script: 'export default {fetch(){return new Response("ok")}}',
          d1Databases: ['DB'],
        })
        dispose = async () => mf.dispose()
        const db = await mf.getD1Database('DB')
        if (legacy) await migrateD1Through(db, '0103_account_closure')
        else await migrateD1(db)
        upgrade = async () => migrateD1(db)
        database = createD1Database(db)
        exec = async (query) => db.prepare(query).run()
        rows = async (query) => (await db.prepare(query).all<Record<string, unknown>>()).results
      }
      await exec(
        `INSERT INTO users(id,first_name,last_name,profile,is_active,manager_grants,created_at,updated_at) VALUES(1,'Ada','Owner','administrator',1,'[]','${at}','${at}'),(2,'Pat','Person','member',1,'[]','${at}','${at}')`,
      )
      await exec(
        `INSERT INTO user_identities(user_id,provider,provider_subject,created_at,updated_at) VALUES(2,'apple','apple-pat','${at}','${at}')`,
      )
      await createAccountRetentionRepository(database).publish({
        actorUserId: 1,
        expectedVersion: 0,
        now: at,
        policy: {
          frameworks: [],
          retained_records: [
            {
              category: 'audit_and_security',
              reason: 'Minimal security and request evidence.',
              period: 'Review within one year after closure.',
              review_after_days: 30,
            },
          ],
          response_target_days: 14,
          operator_contact: 'privacy@example.test',
          user_notice: 'Close local access; review actual retained records.',
          backup_handling: 'Replay closure evidence before restored access.',
          acknowledged: true,
        },
      })
      const requests = createAccountDeletionRequestRepository(database)
      const closure = createAccountClosureRepository(database)
      const request = () =>
        requests.request({ userId: 2, id: 'request-one', expectedPolicyVersion: 1, now: at })
      const close = async () => {
        const preview = await closure.preview(1, 'request-one')
        return closure.close({
          actorUserId: 1,
          id: 'request-one',
          expectedVersion: preview.request_version,
          expectedPolicyVersion: 1,
          reviewToken: preview.review_token,
          now: at,
          acknowledged: true,
        })
      }
      return {
        upgrade,
        store: createAppleLifecycleRepository(database),
        rows,
        exec,
        request,
        close,
      }
    }
    it('separates proven web-only custody from native and unknown historical obligations', async () => {
      const { store, rows, exec, request, close } = await setup()
      const secret = (await rows('SELECT secret FROM account_closure_security'))[0]!
        .secret as string
      const digest = accountClosureDigest(
        secret,
        'provider',
        closedAccountProviderKey('apple', 'apple-pat'),
      )
      await exec(`INSERT INTO apple_identity_channels VALUES('${digest}',2,'web',0)`)
      await request()
      expect(await store.status('request-one')).toBe('manual_required')
      // This fixture now represents proof that the identity's first linkage was web.
      await exec('UPDATE apple_identity_channels SET known_from_first_link=1')
      expect(await store.status('request-one')).toBe('not_linked')
      await store.begin(2, 'request-one')
      expect(await rows('SELECT * FROM apple_deletion_subjects')).toHaveLength(0)
      await close()
      expect(await store.status('request-one')).toBe('not_linked')
    })
    it('keeps a native obligation when a subject has both verified channels', async () => {
      const { store, rows, exec, request, close } = await setup()
      await store.recordSignIn({ ...binding, userId: 2, now: at })
      const digest = (await rows('SELECT subject_hash FROM apple_native_grants'))[0]!.subject_hash
      await exec(`INSERT INTO apple_identity_channels VALUES('${digest}',2,'web',1)`)
      await request()
      await close()
      expect(await store.status('request-one')).toBe('pending')
      expect(await store.acceptRevocation(revoked)).toBe(true)
      expect(await store.status('request-one')).toBe('revoked')
      // Web status is independently aggregated; native evidence never updates it.
      expect(await rows("SELECT * FROM apple_identity_channels WHERE channel='web'")).toHaveLength(
        1,
      )
    })
    it('keeps unmapped historical closure conservative after a receipt for one recovered identity', async () => {
      const { store, request, close, upgrade, rows } = await setup(true)
      await request()
      await close()
      await upgrade()
      expect(await rows('SELECT * FROM apple_deletion_unknown')).toHaveLength(1)
      expect(await store.status('request-one')).toBe('manual_required')
      expect(await store.rebind({ ...binding, requestId: 'request-one', now: at })).toBe(true)
      expect(await store.acceptRevocation(revoked)).toBe(true)
      expect(await store.status('request-one')).toBe('manual_required')
    })
    it('records a native grant once, accepts only exact durable evidence, and keeps confirmed history after closure', async () => {
      const { store, request, close, rows } = await setup()
      expect(await store.recordSignIn({ ...binding, userId: 2, now: at })).toBe(true)
      expect(await store.recordSignIn({ ...binding, userId: 2, now: at })).toBe(false)
      expect(
        await store.recordSignIn({
          ...binding,
          userId: 1,
          generation: 101,
          eventId: 'not-linked',
          now: at,
        }),
      ).toBe(false)
      await request()
      expect(await store.status('request-one')).toBe('pending')
      for (const changes of [
        { requestId: 'unknown' },
        { subject: 'another-apple' },
        { origin: 'https://other.example' },
        { grantId: 'wrong' },
        { generation: 99 },
      ])
        expect(await store.acceptRevocation({ ...revoked, ...changes })).toBe(false)
      expect(await store.acceptRevocation(revoked)).toBe(true)
      expect(await store.acceptRevocation({ ...revoked, now: '2026-10-09T00:01:00.000Z' })).toBe(
        true,
      )
      expect(await store.acceptRevocation({ ...revoked, eventId: 'different-event' })).toBe(false)
      expect(
        await store.acceptRevocation({ ...revoked, revokedAt: '2026-10-08T00:00:00.000Z' }),
      ).toBe(false)
      expect(await store.status('request-one')).toBe('revoked')
      await close()
      expect(await rows('SELECT * FROM user_identities')).toEqual([])
      expect(
        await store.recordSignIn({
          ...binding,
          userId: 2,
          generation: 102,
          eventId: 'too-late',
          now: at,
        }),
      ).toBe(false)
      expect(await store.status('request-one')).toBe('revoked')
      const serialized = JSON.stringify(await rows('SELECT * FROM apple_native_grants'))
      expect(serialized).not.toContain('apple-pat')
      expect(await rows('SELECT * FROM apple_revocation_events')).toHaveLength(1)
      await expect(
        Promise.resolve().then(() =>
          rows(
            "UPDATE apple_revocation_events SET revoked_at='2026-10-08T00:00:00.000Z' RETURNING *",
          ),
        ),
      ).rejects.toThrow(/immutable/)
    })
    it('permits fresh request-specific recovery after closure but requires every Apple identity to be resolved', async () => {
      const { store, exec, request, close, rows } = await setup()
      await exec(
        `INSERT INTO user_identities(user_id,provider,provider_subject,created_at,updated_at) VALUES(2,'apple','second-apple','${at}','${at}')`,
      )
      await request()
      await close()
      expect(await store.status('request-one')).toBe('manual_required')
      expect(await store.rebind({ ...binding, requestId: 'unknown', now: at })).toBe(false)
      expect(await store.rebind({ ...binding, requestId: 'request-one', now: at })).toBe(true)
      expect(await store.rebind({ ...binding, requestId: 'request-one', now: at })).toBe(true)
      expect(await store.acceptRevocation(revoked)).toBe(true)
      expect(await store.status('request-one')).toBe('manual_required')
      const second = {
        ...binding,
        subject: 'second-apple',
        grantId: 'second-grant',
        eventId: 'second-binding',
      }
      expect(await store.rebind({ ...second, requestId: 'request-one', now: at })).toBe(true)
      expect(
        await store.acceptRevocation({ ...revoked, ...second, eventId: 'second-revocation' }),
      ).toBe(true)
      expect(await store.status('request-one')).toBe('revoked')
      expect(await rows('SELECT is_active FROM users WHERE id=2')).toEqual([{ is_active: 0 }])
    })
    it('rejects stale proof after newer authorization and never reopens completed historical cleanup', async () => {
      const { store, request, exec } = await setup()
      await store.recordSignIn({ ...binding, userId: 2, now: at })
      await request()
      expect(
        await store.rebind({
          ...binding,
          requestId: 'request-one',
          generation: 101,
          grantId: 'cleanup-grant',
          eventId: 'cleanup-binding',
          now: at,
        }),
      ).toBe(true)
      const newer = { ...binding, generation: 102, grantId: 'new-grant', eventId: 'new-binding' }
      expect(await store.recordSignIn({ ...newer, userId: 2, now: at })).toBe(true)
      expect(await store.acceptRevocation(revoked)).toBe(false)
      const event = { ...revoked, ...newer, eventId: 'new-revocation' }
      expect(await store.acceptRevocation(event)).toBe(true)
      await exec(
        `UPDATE account_deletion_requests SET status='completed',completed_at='${at}',completion_confirmation='Confirmed test fixture result' WHERE id='request-one'`,
      )
      expect(
        await store.rebind({ ...newer, generation: 103, requestId: 'request-one', now: at }),
      ).toBe(false)
      expect(
        await store.recordSignIn({
          ...newer,
          generation: 103,
          eventId: 'later-auth',
          userId: 2,
          now: at,
        }),
      ).toBe(true)
      expect(await store.acceptRevocation(event)).toBe(true)
      expect(await store.status('request-one')).toBe('revoked')
      expect(await store.allowProof(at)).toBe(true)
      await exec('UPDATE apple_lifecycle_limits SET attempts=120')
      expect(await store.allowProof(at)).toBe(false)
      expect(await store.allowProof('2026-10-09T00:01:00.000Z')).toBe(true)
    })
  })

describe('Apple persistence error disclosure', () => {
  it('discards driver causes and bound provider identifiers before error reporting', async () => {
    const sensitive = new Error('SQL bind apple-private-subject capability-private-value')
    const database = {
      all: vi.fn(async () => {
        throw sensitive
      }),
      run: vi.fn(async () => {
        throw sensitive
      }),
    }
    const store = createAppleLifecycleRepository(
      database as unknown as Parameters<typeof createAppleLifecycleRepository>[0],
    )
    for (const action of [
      () => store.recordSignIn({ ...binding, userId: 2, now: at }),
      () => store.begin(2, 'request-one'),
      () => store.status('request-one'),
      () => store.rebind({ ...binding, requestId: 'request-one', now: at }),
      () => store.acceptRevocation(revoked),
      () => store.allowProof(at),
    ]) {
      const error = await action().catch((failure: unknown) => failure)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe(
        'Apple lifecycle persistence is temporarily unavailable',
      )
      expect((error as Error).cause).toBeUndefined()
      expect(String(error)).not.toContain('private')
    }
  })
})
