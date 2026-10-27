import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { atomicStatements } from '../src/atomic-statements.js'
import { NativeGithubPublicationJournal } from '../src/github-publication-journal.js'
import type { InvoiceStateDatabase } from '../src/invoice-state.js'
import { reconcilePublication, type PublishContext } from '@ezacto/integrations'
import { FakeCommentSurface } from '../../integrations/test/fixtures/fake-comment-surface.js'

for (const runtime of ['SQLite', 'D1'] as const)
  describe(`GitHub publication journal ${runtime}`, () => {
    let db: InvoiceStateDatabase,
      dispose: () => Promise<void>,
      sequence = 0
    beforeAll(async () => {
      if (runtime === 'SQLite') {
        const sqlite = new BetterSqlite3(':memory:')
        migrateContainer(sqlite)
        db = createContainerDatabase(sqlite) as InvoiceStateDatabase
        dispose = async () => {
          sqlite.close()
        }
      } else {
        const mf = new Miniflare({
          modules: true,
          script: 'export default {fetch(){return new Response("ok")}}',
          d1Databases: ['DB'],
        })
        const d1 = await mf.getD1Database('DB')
        await migrateD1(d1)
        db = createD1Database(d1) as InvoiceStateDatabase
        dispose = () => mf.dispose()
      }
      await query(
        "INSERT INTO users(id,first_name,last_name,profile,manager_grants,timezone,created_at,updated_at) VALUES(1,'Owned','Administrator','administrator','[]','UTC','2026-10-26T00:00:00.000Z','2026-10-26T00:00:00.000Z'),(2,'Owned','Member','member','[]','UTC','2026-10-26T00:00:00.000Z','2026-10-26T00:00:00.000Z')",
      )
      await query(
        "INSERT INTO clients(id,name,currency,created_at,updated_at) VALUES(1,'Owned','USD','2026-10-26T00:00:00.000Z','2026-10-26T00:00:00.000Z')",
      )
      await query(
        "INSERT INTO projects(id,client_id,name,bill_by,created_at,updated_at) VALUES(1,1,'Owned','tasks','2026-10-26T00:00:00.000Z','2026-10-26T00:00:00.000Z')",
      )
      await query(
        "INSERT INTO tasks(id,name,created_at,updated_at) VALUES(1,'Owned','2026-10-26T00:00:00.000Z','2026-10-26T00:00:00.000Z')",
      )
      await query(
        "INSERT INTO task_assignments(id,project_id,task_id,billable,created_at,updated_at) VALUES(1,1,1,0,'2026-10-26T00:00:00.000Z','2026-10-26T00:00:00.000Z')",
      )
      await query(
        "INSERT INTO user_assignments(id,project_id,user_id,created_at,updated_at) VALUES(1,1,2,'2026-10-26T00:00:00.000Z','2026-10-26T00:00:00.000Z')",
      )
    }, 60000)
    afterAll(async () => dispose?.())
    const query = async (text: string, ...params: unknown[]) =>
      (
        await atomicStatements(db, [
          {
            text:
              /^(INSERT|UPDATE|DELETE)\b/.test(text) && !/\bRETURNING\b/i.test(text)
                ? `${text} RETURNING *`
                : text,
            params,
          },
        ])
      )[0]!
    const setup = async () => {
      const id = ++sequence,
        connection = `11:${id}:33`,
        key = { connectionId: connection, entryId: String(id), itemId: '5' }
      let clock = 100000
      await query(
        "INSERT INTO time_entries(id,user_id,project_id,task_id,user_assignment_id,task_assignment_id,spent_date,seconds,seconds_without_timer,rounded_seconds,billable,created_at,updated_at) VALUES(?,2,1,1,1,1,'2026-10-01',3600,3600,3600,0,'2026-10-26T00:00:00.000Z','2026-10-26T00:00:00.000Z')",
        id,
      )
      await query(
        'INSERT INTO github_read_connections(id,installation_id,account_id) VALUES(?,?,?)',
        connection,
        String(id),
        '33',
      )
      await query(
        "INSERT INTO github_read_resources(connection_id,repository_id,full_name) VALUES(?,'77','owned/disposable')",
        connection,
      )
      await query(
        "INSERT INTO github_publication_policy(connection_id,enabled,marker,verified_app_id,verified_at,instance_nonce) VALUES(?,1,?,'11','2026-10-26T00:00:00.000Z',(SELECT nonce FROM github_publication_instance WHERE singleton=1))",
        connection,
        'a'.repeat(64),
      )
      await query(
        "INSERT INTO github_publications(id,connection_id,entry_id,repository_id,issue_id,issue_number,destination,desired_date,desired_seconds) VALUES(?,?,?,'77','900','5','https://github.com/owned/disposable/issues/5','2026-10-01',3600)",
        id,
        connection,
        id,
      )
      const journal = new NativeGithubPublicationJournal(db, id, () => clock),
        surface = new FakeCommentSurface()
      const ctx: PublishContext = {
        journal,
        surface,
        marker: 'a'.repeat(64),
        now: () => clock,
        settleMs: 60000,
      }
      return { id, key, ctx, journal, surface, advance: (ms: number) => (clock += ms) }
    }
    const values = { spentDate: '2026-10-01', seconds: 3600 }
    it('[native] persists unknown POST and reconciles after rebuilding the journal without duplication', async () => {
      const { id, key, ctx, surface } = await setup()
      surface.timeoutAfterWrite = true
      expect((await reconcilePublication(ctx, key, 1, values)).outcome).toBe('ambiguous')
      const fresh = { ...ctx, journal: new NativeGithubPublicationJournal(db, id, ctx.now) }
      expect((await reconcilePublication(fresh, key, 1, values)).outcome).toBe('adopted')
      expect(surface.creates).toBe(1)
      expect(
        (await query('SELECT remote_id,last_seconds FROM github_publications WHERE id=?', id))[0],
      ).toMatchObject({ remote_id: 'c1', last_seconds: 3600 })
    })
    it('[native] two distinct resolvers have one lease and reject stale source/fence writes', async () => {
      const { id, key, journal, ctx } = await setup()
      const other = new NativeGithubPublicationJournal(db, id, ctx.now)
      const [a, b] = await Promise.all([journal.claim(key, 1), other.claim(key, 1)])
      expect([a, b].filter(Boolean)).toHaveLength(1)
      const held = (a ?? b)!
      expect(await journal.save({ ...held, fence: held.fence - 1 })).toBe(false)
      await journal.release(key, held.fence)
      await query('UPDATE github_publications SET source_version=2 WHERE id=?', id)
      expect(await journal.claim(key, 1)).toBeNull()
    })
    it('[native] disconnect blocks new writes while late acknowledgements remain durable', async () => {
      const { id, key, journal } = await setup()
      const held = (await journal.claim(key, 1))!
      expect(await journal.permit(held.fence, 1, 1, 1)).toBe(true)
      await query(
        "UPDATE github_read_connections SET state='revoked',generation=generation+1 WHERE id=?",
        key.connectionId,
      )
      expect(await journal.permit(held.fence, 1, 1, 1)).toBe(false)
      expect(await journal.save({ ...held, status: 'published', remoteId: '900' })).toBe(true)
      await journal.release(key, held.fence)
      expect(await journal.claim(key, 1)).toBeNull()
      expect(
        (await query('SELECT remote_id FROM github_publications WHERE id=?', id))[0]!.remote_id,
      ).toBe('900')
    })
    it('[native] fences in-flight completion and fresh claims after restore incarnation rotation', async () => {
      const { id, key, journal } = await setup(),
        held = (await journal.claim(key, 1))!
      await query(
        'UPDATE github_publication_instance SET nonce=lower(hex(randomblob(32))) WHERE singleton=1',
      )
      expect(await journal.permit(held.fence, 1, 1, 1)).toBe(false)
      expect(await journal.save({ ...held, status: 'published', remoteId: '999' })).toBe(false)
      await journal.release(key, held.fence)
      expect(await journal.claim(key, 1)).toBeNull()
      expect(
        (await query('SELECT remote_id FROM github_publications WHERE id=?', id))[0]!.remote_id,
      ).toBeNull()
    })

    it('[native] bounded create retries survive process replacement and stop after second unknown attempt', async () => {
      const { id, key, ctx, surface, advance } = await setup()
      surface.timeoutBeforeWrite = true
      await reconcilePublication(ctx, key, 1, values)
      advance(60000)
      surface.timeoutBeforeWrite = true
      await reconcilePublication(
        { ...ctx, journal: new NativeGithubPublicationJournal(db, id, ctx.now) },
        key,
        1,
        values,
      )
      advance(60000)
      expect((await reconcilePublication(ctx, key, 1, values)).outcome).toBe('failed')
      expect(
        (await query('SELECT create_attempts,status FROM github_publications WHERE id=?', id))[0],
      ).toMatchObject({ create_attempts: 2, status: 'failed' })
    })
    it('[native] isolates a human edit and holds it without overwriting', async () => {
      const { key, ctx, surface } = await setup()
      await reconcilePublication(ctx, key, 1, values)
      const comment = surface.comments.get('c1')!
      surface.comments.set('c1', { ...comment, body: comment.body + '\nHuman correction' })
      expect((await reconcilePublication(ctx, key, 1, values)).outcome).toBe('conflicted')
      expect(surface.comments.get('c1')!.body).toContain('Human correction')
    })
  })
