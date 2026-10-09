import BetterSqlite3 from 'better-sqlite3'
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
      return { store, rows, exec, review }
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
