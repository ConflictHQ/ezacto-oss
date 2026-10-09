import BetterSqlite3 from 'better-sqlite3'
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { createAccountClosureRepository } from '../src/account-closure.js'
import { createAccountDeletionRequestRepository } from '../src/account-deletion-requests.js'
import { createAccountRetentionRepository } from '../src/account-retention.js'
import { createAccountRetentionReviewRepository } from '../src/account-retention-review.js'
import type { RetentionObligation, RetentionReviewChange } from '@ezacto/core'
const at = '2026-10-09T00:00:00.000Z',
  later = '2026-11-09T00:00:00.000Z'
for (const runtime of ['SQLite', 'D1'])
  describe(`retention follow-through (${runtime})`, () => {
    let dispose: (() => Promise<void>) | undefined
    afterEach(async () => dispose?.())
    async function setup() {
      let database: Parameters<typeof createAccountRetentionReviewRepository>[0]
      let exec: (query: string) => Promise<unknown>
      let rows: (query: string) => Promise<Record<string, unknown>[]>
      if (runtime === 'SQLite') {
        const db = new BetterSqlite3(':memory:')
        migrateContainer(db)
        database = createContainerDatabase(db)
        exec = async (query) => db.exec(query)
        rows = async (query) => db.prepare(query).all() as Record<string, unknown>[]
        dispose = async () => {
          db.close()
        }
      } else {
        const mf = new Miniflare({
          modules: true,
          script: 'export default {fetch(){return new Response("ok")}}',
          d1Databases: ['DB'],
        })
        dispose = async () => mf.dispose()
        const db = await mf.getD1Database('DB')
        await migrateD1(db)
        database = createD1Database(db)
        exec = async (query) => db.prepare(query).run()
        rows = async (query) => (await db.prepare(query).all<Record<string, unknown>>()).results
      }
      await exec(
        `INSERT INTO users(id,first_name,last_name,profile,is_active,manager_grants,created_at,updated_at) VALUES(1,'Ada','Owner','administrator',1,'[]','${at}','${at}'),(2,'Pat','Person','member',1,'[]','${at}','${at}')`,
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
              reason: 'Minimal request evidence under operator review.',
              period: 'Until the documented security purpose ends.',
              review_after_days: 30,
            },
            {
              category: 'legal_hold',
              reason: 'Active documented hold for the fixture case.',
              period: 'Until authorized release of the fixture hold.',
              review_after_days: 14,
            },
          ],
          response_target_days: 14,
          operator_contact: 'privacy@example.test',
          user_notice: 'Local closure leaves reviewed retention.',
          backup_handling: 'Replay closure before service restoration.',
          acknowledged: true,
        },
      })
      await createAccountDeletionRequestRepository(database).request({
        userId: 2,
        id: 'request-one',
        expectedPolicyVersion: 1,
        now: at,
      })
      const closure = createAccountClosureRepository(database),
        preview = await closure.preview(1, 'request-one')
      await closure.close({
        actorUserId: 1,
        id: 'request-one',
        expectedVersion: preview.request_version,
        expectedPolicyVersion: 1,
        reviewToken: preview.review_token,
        acknowledged: true,
        now: at,
      })
      const store = createAccountRetentionReviewRepository(database)
      const review = (row: RetentionObligation, change: Partial<RetentionReviewChange> = {}) =>
        store.review({
          actorUserId: 1,
          requestId: 'request-one',
          area: row.area,
          expectedVersion: row.version,
          decision: 'not_applicable',
          basis: '',
          releaseCondition: '',
          evidence: 'Inspected the specific system and confirmed no applicable copy.',
          nextReviewAt: null,
          acknowledged: true,
          now: at,
          ...change,
        })
      return { store, rows, exec, review, database }
    }
    it('creates durable category and downstream obligations and rejects stale or unauthorized review', async () => {
      const { store, review, rows } = await setup()
      const obligations = await store.read(1, 'request-one')
      expect(obligations).toHaveLength(9)
      expect((await store.list(1, at)).map((row) => row.area)).toContain('backups')
      await expect(store.read(2, 'request-one')).rejects.toMatchObject({
        code: 'administrator_required',
      })
      const backup = obligations.find((row) => row.area === 'backups')!
      const outcomes = await Promise.allSettled([review(backup), review(backup)])
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
      expect(await rows('SELECT * FROM account_retention_review_events')).toHaveLength(1)
      expect(await rows('SELECT is_active FROM users WHERE id=2')).toEqual([{ is_active: 0 }])
    })
    it('requires explicit hold release and records fresh retained justification without deleting work', async () => {
      const { store, review, rows } = await setup()
      let held = (await store.read(1, 'request-one')).find((row) => row.area === 'legal_hold')!
      await expect(review(held, { decision: 'removed' })).rejects.toMatchObject({
        code: 'hold_release_required',
      })
      held = await review(held, {
        decision: 'retain',
        basis: 'Current case remains unresolved under documented hold.',
        releaseCondition: 'Authorized closure of the named case.',
        nextReviewAt: later,
      })
      expect(held.hold_active).toBe(true)
      expect(await store.list(1, later)).toContainEqual(held)
      held = await review(held, {
        decision: 'release_hold',
        evidence:
          'Operator verified the authorized release reference in the protected case record.',
      })
      expect(held.hold_active).toBe(false)
      expect(held.decision).toBe('release_hold')
      held = await review(held, {
        decision: 'removed',
        evidence:
          'The operator verified eligible held copies were removed through the documented process.',
      })
      expect(held.decision).toBe('removed')
      expect(await rows('SELECT * FROM account_retention_review_events')).toHaveLength(3)
    })
    it('keeps historical manual verification distinct and rejects native or web custody appearing during completion', async () => {
      const { store, review, rows, exec, database } = await setup()
      await exec("INSERT INTO apple_deletion_unknown(request_id) VALUES('request-one')")
      for (let row of await store.read(1, 'request-one')) {
        if (row.hold_active) row = await review(row, { decision: 'release_hold' })
        await review(
          row,
          row.area === 'apple_authorization'
            ? {
                decision: 'removed',
                evidence:
                  'Protected ticket records the requester verified historical Apple disconnect.',
              }
            : {},
        )
      }
      const obligations = await store.read(1, 'request-one')
      const input = {
        actorUserId: 1,
        requestId: 'request-one',
        expectedRequestVersion: Number(
          (await rows("SELECT version FROM account_deletion_requests WHERE id='request-one'"))[0]!
            .version,
        ),
        expectedReviews: Object.fromEntries(obligations.map((row) => [row.area, row.version])),
        now: at,
        acknowledged: true as const,
        appleResolved: false,
        appleHistoricalManualVerified: true,
      }
      await expect(
        store.complete({ ...input, appleHistoricalManualVerified: false }),
      ).rejects.toMatchObject({ code: 'review_incomplete' })
      const dialect = new SQLiteSyncDialect()
      const racing = (mutation: string) => {
        let changed = false
        const proxy = new Proxy(database, {
          get(target, key) {
            if (key === 'all')
              return async (query: Parameters<typeof database.all>[0]) => {
                if (
                  !changed &&
                  (typeof query === 'string'
                    ? query
                    : dialect.sqlToQuery(query.getSQL()).sql
                  ).startsWith('UPDATE account_deletion_requests')
                ) {
                  changed = true
                  await exec(mutation)
                }
                return target.all(query)
              }
            const value = Reflect.get(target, key)
            return typeof value === 'function' ? value.bind(target) : value
          },
        })
        return createAccountRetentionReviewRepository(proxy)
      }
      await expect(
        racing(
          `INSERT INTO apple_deletion_subjects(request_id,subject_hash,origin,grant_id,generation,updated_at) VALUES('request-one','${'a'.repeat(64)}','https://example.test','current-native-grant',1,'${at}')`,
        ).complete(input),
      ).rejects.toMatchObject({ code: 'review_changed' })
      await exec(
        `INSERT INTO apple_revocation_events(request_id,subject_hash,origin,grant_id,generation,event_id,revoked_at,accepted_at) VALUES('request-one','${'a'.repeat(64)}','https://example.test','current-native-grant',1,'verified-native-event','${at}','${at}')`,
      )
      await expect(
        racing(
          `INSERT INTO apple_web_connections(id,subject_digest,browser_hash,user_id,service_issuer,instance_origin,client_id,grant_id,generation,status,created_at,updated_at) VALUES('${'b'.repeat(43)}','${'c'.repeat(64)}','${'d'.repeat(64)}',2,'https://apple-auth.ezacto.com','https://app.example.com','com.ezacto.web','current-web-grant',1,'pending','${at}','${at}')`,
        ).complete(input),
      ).rejects.toMatchObject({ code: 'review_changed' })
      expect(
        await rows("SELECT status FROM account_deletion_requests WHERE id='request-one'"),
      ).toEqual([{ status: 'action_required' }])
      await exec(
        `INSERT INTO apple_web_cleanup_requests(request_id,user_id,captured_at) VALUES('request-one',2,'${at}')`,
      )
      await exec(
        `INSERT INTO apple_web_cleanup_obligations(request_id,connection_id,grant_id,generation,status,updated_at) VALUES('request-one','${'b'.repeat(43)}','current-web-grant',1,'pending','${at}')`,
      )
      await exec(`UPDATE apple_web_connections SET status='revoked' WHERE id='${'b'.repeat(43)}'`)
      await expect(store.complete(input)).rejects.toMatchObject({ code: 'review_changed' })
      await exec(
        "UPDATE apple_web_cleanup_obligations SET status='revoked',sealed_receipt='{}' WHERE request_id='request-one'",
      )
      const result = await store.complete(input)
      expect(result.confirmation).toContain('Historical Apple disconnect was manually verified')
      expect(result.confirmation).toContain('not a signed provider revocation receipt')
      expect(
        await rows(
          'SELECT actor_user_id,apple_historical_manual_verified,apple_evidence FROM account_deletion_completion_audit',
        ),
      ).toEqual([
        {
          actor_user_id: 1,
          apple_historical_manual_verified: 1,
          apple_evidence:
            'Protected ticket records the requester verified historical Apple disconnect.',
        },
      ])
      expect(await rows('SELECT * FROM apple_deletion_unknown')).toHaveLength(1)
      await expect(
        exec("UPDATE account_deletion_completion_audit SET apple_evidence='rewritten'"),
      ).rejects.toThrow('immutable')
    })
    it('confirms only an exactly reviewed outcome, keeps retention due later and never infers provider revocation', async () => {
      const { store, review, rows } = await setup()
      const finish = async (appleResolved = true) => {
        const obligations = await store.read(1, 'request-one')
        return store.complete({
          actorUserId: 1,
          requestId: 'request-one',
          expectedRequestVersion: Number(
            (await rows("SELECT version FROM account_deletion_requests WHERE id='request-one'"))[0]!
              .version,
          ),
          expectedReviews: Object.fromEntries(obligations.map((row) => [row.area, row.version])),
          now: at,
          acknowledged: true,
          appleResolved,
        })
      }
      await expect(finish()).rejects.toMatchObject({ code: 'review_incomplete' })
      for (let row of await store.read(1, 'request-one')) {
        if (row.hold_active) row = await review(row, { decision: 'release_hold' })
        if (row.area === 'audit_and_security')
          await review(row, {
            decision: 'retain',
            basis: 'Current security evidence remains necessary for the documented review.',
            releaseCondition: 'Close the active security investigation and confirm disposal.',
            nextReviewAt: later,
          })
        else await review(row)
      }
      await expect(finish(false)).rejects.toMatchObject({ code: 'review_incomplete' })
      const stale = await store.read(1, 'request-one'),
        backup = stale.find((row) => row.area === 'backups')!
      await review(backup)
      await expect(
        store.complete({
          actorUserId: 1,
          requestId: 'request-one',
          expectedRequestVersion: 2,
          expectedReviews: Object.fromEntries(stale.map((row) => [row.area, row.version])),
          now: at,
          acknowledged: true,
          appleResolved: true,
        }),
      ).rejects.toMatchObject({ code: 'review_changed' })
      const completed = await finish()
      expect(completed.confirmation).toContain(
        'Records remain under documented retention: audit and security',
      )
      expect(completed.confirmation).not.toContain('all data deleted')
      expect((await store.list(1, later)).map((row) => row.area)).toContain('audit_and_security')
    })
  })
