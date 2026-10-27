import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { NativeGithubReaderAdmin } from '../src/github-reader-admin.js'
import { atomicStatements } from '../src/atomic-statements.js'
import { createGithubPublicationService } from '../src/github-publication-service.js'
import type { InvoiceStateDatabase } from '../src/invoice-state.js'
const now = '2026-10-25T12:00:00.000Z'
const authority = { userId: 2, sessionId: 102 }
for (const runtime of ['SQLite', 'D1'] as const)
  describe(`GitHub publication commands ${runtime}`, () => {
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
    const service = () =>
      createGithubPublicationService(database, {
        credentials: async () => null,
        fetch: async () => {
          throw new Error('No provider expected')
        },
        now: () => new Date(now),
      })
    it('[native] defaults each link off, previews only destination/date/duration and rejects members', async () => {
      expect((await service().list(authority)).publications).toHaveLength(0)
      const preview = await service().preview(authority, 1)
      expect(preview).toMatchObject({
        link_id: 1,
        destination: 'https://github.com/owned/disposable/issues/5',
        spent_date: '2026-10-01',
        seconds: 3600,
        policy_enabled: true,
      })
      expect(Object.keys(preview).sort()).toEqual([
        'connection_id',
        'destination',
        'link_id',
        'policy_enabled',
        'seconds',
        'source_version',
        'spent_date',
      ])
      await expect(service().preview({ userId: 3, sessionId: 103 }, 1)).rejects.toThrow()
    })
    it('[native] explicit consent is replay-safe, validates source revision and journals edits/deletion without changing actuals', async () => {
      const preview = await service().preview(authority, 1),
        command_id = crypto.randomUUID()
      await expect(
        service().consent(authority, { link_id: 1, source_version: 'b'.repeat(64), command_id }),
      ).rejects.toThrow('conflict')
      await run(
        `UPDATE github_read_items SET metadata=json_set(metadata,'$.canonicalUrl','https://github.com/owned/disposable/issues/6') WHERE issue_id='900'`,
      )
      await expect(
        service().consent(authority, {
          link_id: 1,
          source_version: preview.source_version,
          command_id,
        }),
      ).rejects.toThrow('conflict')
      await run(
        `UPDATE github_read_items SET metadata=json_set(metadata,'$.canonicalUrl','https://github.com/owned/disposable/issues/5') WHERE issue_id='900'`,
      )
      const input = { link_id: 1, source_version: preview.source_version, command_id }
      await service().consent(authority, input)
      await service().consent(authority, input)
      let rows = (await service().list(authority)).publications
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ seconds: 3600, status: 'pending', version: 1 })
      await run(
        `UPDATE time_entries SET seconds=7200,seconds_without_timer=7200,rounded_seconds=7200,updated_at='2026-10-25T12:01:00.000Z' WHERE id=1`,
      )
      rows = (await service().list(authority)).publications
      expect(rows[0]).toMatchObject({ seconds: 7200, version: 2 })
      await run('DELETE FROM work_item_links WHERE id=1')
      rows = (await service().list(authority)).publications
      expect(rows[0]).toMatchObject({ seconds: null, spent_date: null, version: 3 })
      const [actual] = await atomicStatements(database, [
        { text: 'SELECT seconds FROM time_entries WHERE id=1', params: [] },
      ])
      expect(actual![0]!.seconds).toBe(7200)
      await expect(
        service().act(authority, {
          id: rows[0]!.id,
          expected_version: 2,
          action: 'unlink',
          confirm: true,
          command_id: crypto.randomUUID(),
        }),
      ).rejects.toThrow('conflict')
      const action = {
        id: rows[0]!.id,
        expected_version: 3,
        action: 'unlink' as const,
        confirm: true,
        command_id: crypto.randomUUID(),
      }
      await service().act(authority, action)
      await service().act(authority, action)
      expect((await service().list(authority)).publications[0]!.status).toBe('unlinked')
    })
    it('[native] refuses prior-instance comment adoption when the reused subject identity differs', async () => {
      await run(
        `INSERT INTO work_item_links(id,connection_id,time_entry_id,provider_item_id,created_by,created_at,updated_at) SELECT 2,work_item_connection_id,1,'owned/disposable#5',2,'${now}','${now}' FROM github_read_connections WHERE id='11:22:33'`,
      )
      await run(
        `INSERT INTO github_publications(connection_id,entry_id,subject_user_id,subject_created_at,consent_nonce,marker,repository_id,issue_id,issue_number,destination,remote_id,last_body) VALUES('11:22:33',1,3,'2000-01-01T00:00:00.000Z','${'d'.repeat(64)}','${'a'.repeat(64)}','77','900','5','https://github.com/owned/disposable/issues/5','123','Old identity body')`,
      )
      const preview = await service().preview(authority, 2)
      await expect(
        service().consent(authority, {
          link_id: 2,
          source_version: preview.source_version,
          command_id: crypto.randomUUID(),
        }),
      ).rejects.toThrow('conflict')
    })
    it('[native] rejects an expired session using database time even when a caller clock is old', async () => {
      await run(
        "INSERT INTO sessions(id,user_id,selector,secret_hash,profile_snapshot,manager_grants_snapshot,created_at,last_seen_at,idle_expires_at,absolute_expires_at,updated_at) SELECT 104,user_id,'AAAAAAAAAAAAAAAE',secret_hash,profile_snapshot,manager_grants_snapshot,created_at,last_seen_at,'2026-10-26T00:00:00.000Z','2026-10-26T01:00:00.000Z',updated_at FROM sessions WHERE id=102",
      )
      await expect(service().list({ ...authority, sessionId: 104 })).rejects.toThrow('forbidden')
    })
  })
