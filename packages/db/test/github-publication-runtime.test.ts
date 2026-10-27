import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { NativeGithubReaderAdmin } from '../src/github-reader-admin.js'
import { atomicStatements } from '../src/atomic-statements.js'
import { NativeGithubPublicationJournal } from '../src/github-publication-journal.js'
import { createGithubPublicationService } from '../src/github-publication-service.js'
import type { InvoiceStateDatabase } from '../src/invoice-state.js'
const now = '2026-10-25T12:00:00.000Z'
const authority = { userId: 2, sessionId: 102 }
for (const runtime of ['SQLite', 'D1'] as const)
  describe(`GitHub publication runtime ${runtime}`, () => {
    let database: InvoiceStateDatabase,
      run: (sql: string) => Promise<void>,
      close: () => Promise<void>,
      admin: NativeGithubReaderAdmin
    beforeAll(async () => {
      if (runtime === 'SQLite') {
        const sqlite = new BetterSqlite3(':memory:')
        migrateContainer(sqlite)
        database = createContainerDatabase(sqlite) as InvoiceStateDatabase
        run = async (sql) => {
          sqlite.exec(sql)
        }
        close = async () => {
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
        database = createD1Database(d1) as InvoiceStateDatabase
        run = async (sql) => {
          await d1.prepare(sql).run()
        }
        close = () => mf.dispose()
      }
      await run(
        `INSERT INTO organizations(name,modules,time_entry_mode,created_at,updated_at) VALUES('Owned native fixture','{}','duration','${now}','${now}')`,
      )
      await run(
        `INSERT INTO users(id,first_name,last_name,profile,manager_grants,timezone,created_at,updated_at) VALUES(1,'Owned','Owner','administrator','[]','UTC','${now}','${now}'),(2,'Other','Administrator','administrator','[]','UTC','${now}','${now}'),(3,'Scoped','Member','member','[]','UTC','${now}','${now}')`,
      )
      await run(
        `INSERT INTO organization_owner(id,user_id,updated_at) VALUES(1,1,'${now}') ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id`,
      )
      await run(
        `INSERT INTO sessions(id,user_id,selector,secret_hash,profile_snapshot,manager_grants_snapshot,created_at,last_seen_at,idle_expires_at,absolute_expires_at,updated_at) VALUES(102,2,'AAAAAAAAAAAAAAAB','${'a'.repeat(64)}','administrator','[]','${now}','${now}','2099-10-25T13:00:00.000Z','2099-10-26T12:00:00.000Z','${now}'),(103,3,'AAAAAAAAAAAAAAAC','${'b'.repeat(64)}','member','[]','${now}','${now}','2099-10-25T13:00:00.000Z','2099-10-26T12:00:00.000Z','${now}')`,
      )
      await run(
        `INSERT INTO clients(id,name,currency,created_at,updated_at) VALUES(1,'Owned client','EUR','${now}','${now}')`,
      )
      await run(
        `INSERT INTO projects(id,client_id,name,bill_by,created_at,updated_at) VALUES(1,1,'Existing project','tasks','${now}','${now}')`,
      )
      await run(
        `INSERT INTO tasks(id,name,created_at,updated_at) VALUES(1,'Existing task','${now}','${now}')`,
      )
      await run(
        `INSERT INTO task_assignments(project_id,task_id,billable,created_at,updated_at) VALUES(1,1,0,'${now}','${now}')`,
      )
      admin = new NativeGithubReaderAdmin(database)
      await run(
        `INSERT INTO user_assignments(id,project_id,user_id,created_at,updated_at) VALUES(1,1,3,'${now}','${now}')`,
      )
      await run(
        `INSERT INTO time_entries(id,user_id,project_id,task_id,user_assignment_id,task_assignment_id,spent_date,seconds,seconds_without_timer,rounded_seconds,billable,created_at,updated_at) VALUES(1,3,1,1,1,1,'2026-10-01',3600,3600,3600,0,'${now}','${now}')`,
      )
      await admin.map(
        authority,
        {
          commandId: crypto.randomUUID(),
          expectedGeneration: 0,
          verified: {
            appId: '11',
            installationId: '22',
            accountId: '33',
            repositoryId: '77',
            fullName: 'owned/disposable',
            projectId: 1,
            taskId: 1,
          },
        },
        now,
      )
      await run(
        `INSERT INTO github_read_items(connection_id,issue_id,repository_id,metadata,outcome) VALUES('11:22:33','900','77','{"connectionId":"11:22:33","issueId":"900","repositoryId":"77","number":5,"canonicalUrl":"https://github.com/owned/disposable/issues/5","title":"Owned issue","state":"open","remoteUpdatedAt":"2026-10-25T12:00:00.000Z","aliases":[],"status":"visible"}','inserted')`,
      )
      await run(
        `INSERT INTO github_read_aliases(connection_id,issue_id,alias) VALUES('11:22:33','900','owned/disposable#5')`,
      )
      await run(
        `INSERT INTO work_item_links(id,connection_id,time_entry_id,provider_item_id,created_by,created_at,updated_at) SELECT 1,work_item_connection_id,1,'owned/disposable#5',2,'${now}','${now}' FROM github_read_connections WHERE id='11:22:33'`,
      )
      await run(
        `INSERT INTO github_publication_policy(connection_id,enabled,marker,verified_app_id,verified_at,instance_nonce) VALUES('11:22:33',1,'${'a'.repeat(64)}','11','${now}',(SELECT nonce FROM github_publication_instance WHERE singleton=1))`,
      )
    }, 60000)
    afterAll(async () => close?.())
    it('[native] stages only explicit consent, reconciles lost response, edits, operator decisions and retirement', async () => {
      const keypair = await crypto.subtle.generateKey(
        {
          name: 'RSASSA-PKCS1-v1_5',
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: 'SHA-256',
        },
        true,
        ['sign', 'verify'],
      )
      const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', keypair.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----`
      let clock = Date.parse(now),
        creates = 0,
        updates = 0,
        deletes = 0,
        loseResponse = true
      const comments = new Map<
        string,
        {
          id: number
          body: string
          user: { id: number; type: string }
          performed_via_github_app: { id: number }
        }
      >()
      const service = createGithubPublicationService(database, {
        credentials: async () => ({ appId: '11', privateKey: pem, webhookSecret: 'owned' }),
        now: () => new Date(clock),
        fetch: async (request) => {
          const url = new URL(request.url)
          expect(url.origin).toBe('https://api.github.com')
          expect(request.redirect).toBe('manual')
          if (url.pathname === '/app/installations/22')
            return Response.json({
              id: 22,
              account: { id: 33 },
              suspended_at: null,
              permissions: { issues: 'write' },
            })
          if (url.pathname === '/app/installations/22/access_tokens') {
            expect(await request.json()).toEqual({
              repository_ids: [77],
              permissions: { issues: 'write', metadata: 'read' },
            })
            return Response.json({
              token: 'owned-private-token',
              expires_at: new Date(clock + 3600000).toISOString(),
              permissions: { issues: 'write', metadata: 'read' },
              repositories: [{ id: 77, full_name: 'owned/disposable' }],
            })
          }
          if (url.pathname === '/repos/owned/disposable')
            return Response.json({ id: 77, full_name: 'owned/disposable', owner: { id: 33 } })
          if (url.pathname === '/repos/owned/disposable/issues/5/comments') {
            if (request.method === 'GET') return Response.json([...comments.values()])
            expect(request.method).toBe('POST')
            const { body } = (await request.json()) as { body: string }
            creates++
            const comment = {
              id: creates,
              body,
              user: { id: 100, type: 'Bot' },
              performed_via_github_app: { id: 11 },
            }
            comments.set(String(comment.id), comment)
            if (loseResponse) {
              loseResponse = false
              throw new Error('owned lost accepted response')
            }
            return Response.json(comment, { status: 201 })
          }
          if (url.pathname === '/repos/owned/disposable/issues/5') return Response.json({ id: 900 })
          const id = /^\/repos\/owned\/disposable\/issues\/comments\/(\d+)$/.exec(url.pathname)?.[1]
          if (id) {
            const comment = comments.get(id)
            if (request.method === 'GET')
              return comment
                ? Response.json({
                    ...comment,
                    issue_url: 'https://api.github.com/repos/owned/disposable/issues/5',
                  })
                : new Response(null, { status: 404 })
            if (request.method === 'DELETE') {
              deletes++
              comments.delete(id)
              return new Response(null, { status: 204 })
            }
            if (request.method === 'PATCH' && comment) {
              updates++
              const { body } = (await request.json()) as { body: string }
              comment.body = body
              return Response.json(comment)
            }
          }
          throw new Error('Unexpected owned fixture path')
        },
      })
      await service.tick()
      expect(creates).toBe(0)
      const preview = await service.preview(authority, 1)
      await service.consent(authority, {
        link_id: 1,
        source_version: preview.source_version,
        command_id: crypto.randomUUID(),
      })
      await service.tick()
      expect(creates).toBe(1)
      clock += 60000
      await service.tick()
      expect(creates).toBe(1)
      expect((await service.list(authority)).publications[0]!.status).toBe('published')
      expect(comments.get('1')!.body).toMatch(
        /^<!-- ezacto-time:[a-f0-9]{64}:1 -->\nTime logged: 1h on 2026-10-01$/,
      )
      await run(
        `UPDATE time_entries SET seconds=7200,seconds_without_timer=7200,rounded_seconds=7200 WHERE id=1`,
      )
      await service.tick()
      expect(updates).toBe(1)
      expect(comments.get('1')!.body).toContain('2h')
      comments.get('1')!.body += '\nHuman correction'
      clock += 60000
      await service.tick()
      let row = (await service.list(authority)).publications[0]!
      expect(row.status).toBe('conflicted')
      await service.act(authority, {
        id: row.id,
        expected_version: row.version,
        action: 'adopt',
        confirm: true,
        command_id: crypto.randomUUID(),
      })
      clock += 60000
      await service.tick()
      expect(updates).toBe(1)
      await run(
        `UPDATE time_entries SET seconds=10800,seconds_without_timer=10800,rounded_seconds=10800 WHERE id=1`,
      )
      await service.tick()
      expect(updates).toBe(2)
      expect(comments.get('1')!.body).toContain('3h')
      comments.delete('1')
      clock += 60000
      await service.tick()
      row = (await service.list(authority)).publications[0]!
      expect(row.status).toBe('conflicted')
      await service.act(authority, {
        id: row.id,
        expected_version: row.version,
        action: 'restore',
        confirm: true,
        command_id: crypto.randomUUID(),
      })
      await service.tick()
      expect(creates).toBe(2)
      await run('DELETE FROM work_item_links WHERE id=1')
      await service.tick()
      expect(deletes).toBe(1)
      expect(comments.size).toBe(0)
      expect((await service.list(authority)).publications[0]!.status).toBe('retired')
      const [actual] = await atomicStatements(database, [
        { text: 'SELECT seconds FROM time_entries WHERE id=1', params: [] },
      ])
      expect(actual![0]!.seconds).toBe(10800)
    })
    it('[native] a comment 429 delays every publication until the shared provider deadline', async () => {
      for (const id of [2, 3])
        await run(
          `INSERT INTO github_publications(id,connection_id,entry_id,repository_id,issue_id,issue_number,destination,desired_date,desired_seconds) VALUES(${id},'11:22:33',1,'77','${900 + id}','5','https://github.com/owned/disposable/issues/5','2026-10-01',10800)`,
        )
      const keys = await crypto.subtle.generateKey(
        {
          name: 'RSASSA-PKCS1-v1_5',
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: 'SHA-256',
        },
        true,
        ['sign', 'verify'],
      )
      const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----`
      let calls = 0,
        posts = 0,
        clock = Date.parse(now)
      const service = createGithubPublicationService(database, {
        credentials: async () => ({ appId: '11', privateKey: pem, webhookSecret: 'owned' }),
        now: () => new Date(clock),
        fetch: async (request) => {
          calls++
          const path = new URL(request.url).pathname
          if (path === '/app/installations/22')
            return Response.json({
              id: 22,
              account: { id: 33 },
              suspended_at: null,
              permissions: { issues: 'write' },
            })
          if (path === '/app/installations/22/access_tokens')
            return Response.json({
              token: 'owned',
              expires_at: new Date(clock + 3600000).toISOString(),
              permissions: { issues: 'write', metadata: 'read' },
              repositories: [{ id: 77, full_name: 'owned/disposable' }],
            })
          if (path === '/repos/owned/disposable')
            return Response.json({ id: 77, full_name: 'owned/disposable', owner: { id: 33 } })
          if (path === '/repos/owned/disposable/issues/5') return Response.json({ id: 902 })
          if (path === '/repos/owned/disposable/issues/5/comments') {
            posts++
            return new Response(null, { status: 429, headers: { 'retry-after': '120' } })
          }
          throw new Error('Unexpected fixture path')
        },
      })
      await service.tick()
      expect(posts).toBe(1)
      const after = calls
      await service.tick()
      expect(calls).toBe(after)
      clock += 119000
      await service.tick()
      expect(calls).toBe(after)
      const [rows] = await atomicStatements(database, [
        { text: 'SELECT cooldown_until FROM github_publication_dispatch', params: [] },
      ])
      expect(Number(rows![0]!.cooldown_until)).toBe(Date.parse(now) + 120000)
    })
    it('[native] retained subject closure fences publication even while the installer stays active', async () => {
      await run(
        `INSERT INTO account_retention_policies(version,policy_json,published_by_user_id,published_at) VALUES(1,'{"acknowledged":true}',2,'${now}')`,
      )
      await run(
        `INSERT INTO account_deletion_requests(id,user_id,requested_at,notification_updated_at,updated_at) VALUES('owned-close',3,'${now}','${now}','${now}')`,
      )
      await run(
        `INSERT INTO account_closures(request_id,user_id,actor_user_id,closed_at,policy_version,policy_snapshot,inventory_json,replay_keys,retained_identity,apple_cleanup) SELECT 'owned-close',3,2,'${now}',version,policy_json,'{}','[]',1,'not_linked' FROM account_retention_policies ORDER BY version DESC LIMIT 1`,
      )
      const [actors] = await atomicStatements(database, [
        { text: 'SELECT id,is_active FROM users WHERE id IN (2,3) ORDER BY id', params: [] },
      ])
      expect(actors).toEqual([
        { id: 2, is_active: 1 },
        { id: 3, is_active: 0 },
      ])
      const journal = new NativeGithubPublicationJournal(database, 2, () => Date.parse(now))
      const held = await journal.claim({ connectionId: '11:22:33', entryId: '1', itemId: '5' }, 2)
      // Closure bumps source version and marks visible source_unavailable failure.
      const [rows] = await atomicStatements(database, [
        { text: 'SELECT status,failure_code FROM github_publications WHERE id=2', params: [] },
      ])
      expect(rows![0]).toEqual({ status: 'failed', failure_code: 'source_unavailable' })
      if (held) expect(await journal.permit(held.fence, held.sourceVersion, 1, 1)).toBe(false)
      expect(await journal.permit(1, 2, 1, 1)).toBe(false)
    })
  })
