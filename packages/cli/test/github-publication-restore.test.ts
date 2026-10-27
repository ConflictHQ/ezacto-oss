import BetterSqlite3 from 'better-sqlite3'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createBackup, restoreBackup } from '../src/backup.js'
import { migrateContainer } from '../../db/src/migrate.js'
import { createContainerDatabase } from '../../db/src/adapters.js'
import { NativeGithubPublicationJournal } from '../../db/src/github-publication-journal.js'
import type { InvoiceStateDatabase } from '../../db/src/invoice-state.js'

it('[native] real bundle restore preserves remote receipts but fences old outbound publication consent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ezacto-github-restore-'))
  let source: BetterSqlite3.Database | undefined, restored: BetterSqlite3.Database | undefined
  try {
    const sourcePath = join(dir, 'source.sqlite'),
      attachmentDirectory = join(dir, 'attachments')
    await mkdir(attachmentDirectory)
    source = new BetterSqlite3(sourcePath)
    migrateContainer(source)
    const original = (
      source.prepare('SELECT nonce FROM github_publication_instance').get() as { nonce: string }
    ).nonce
    source.exec(`INSERT INTO github_read_connections(id,installation_id,account_id) VALUES('11:22:33','22','33');
      INSERT INTO github_read_resources(connection_id,repository_id,full_name) VALUES('11:22:33','77','owned/disposable');
      INSERT INTO github_publication_policy(connection_id,enabled,marker,verified_app_id,verified_at,instance_nonce) VALUES('11:22:33',1,'${'a'.repeat(64)}','11','2026-10-26T00:00:00.000Z','${original}');
      INSERT INTO github_publications(id,connection_id,entry_id,subject_user_id,subject_created_at,consent_nonce,marker,repository_id,issue_id,issue_number,destination,desired_date,desired_seconds,remote_id,last_body,status) VALUES(1,'11:22:33',1,1,'2026-10-26T00:00:00.000Z',(SELECT nonce FROM github_publication_instance WHERE singleton=1),'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','77','900','5','https://github.com/owned/disposable/issues/5','2026-10-01',3600,'4321','Owned previous body','published');`)
    const bundle = await createBackup({
      databasePath: sourcePath,
      attachmentDirectory,
      outputDirectory: join(dir, 'backups'),
    })
    const target = join(dir, 'restored.sqlite')
    await restoreBackup({
      bundleDirectory: bundle.bundleDirectory,
      targetDatabasePath: target,
      restoredAt: '2026-10-26T00:01:00.000Z',
    })
    restored = new BetterSqlite3(target)
    const next = (
      restored.prepare('SELECT nonce FROM github_publication_instance').get() as { nonce: string }
    ).nonce
    expect(next).not.toBe(original)
    expect(restored.prepare('SELECT remote_id,last_body FROM github_publications').get()).toEqual({
      remote_id: '4321',
      last_body: 'Owned previous body',
    })
    const journal = new NativeGithubPublicationJournal(
      createContainerDatabase(restored) as InvoiceStateDatabase,
      1,
      () => Date.parse('2026-10-26T00:02:00Z'),
    )
    expect(
      await journal.claim({ connectionId: '11:22:33', entryId: '1', itemId: '5' }, 1),
    ).toBeNull()
    expect(
      restored.prepare('SELECT token,expires_at FROM github_publication_dispatch').get(),
    ).toEqual({ token: null, expires_at: 0 })
  } finally {
    source?.close()
    restored?.close()
    await rm(dir, { recursive: true, force: true })
  }
})

it.each(['known', 'unknown', 'snapshot_before_attempt'] as const)(
  '[native] restored %s receipt and fresh consent reuse verified identity without a duplicate POST',
  async (mode) => {
    const { calendarOperatorFixture } =
      await import('../../db/test/support/calendar-operator-fixture.js')
    const { NativeGithubReaderAdmin } = await import('../../db/src/github-reader-admin.js')
    const { createGithubPublicationService } =
      await import('../../db/src/github-publication-service.js')
    const { createContainerSessionStore } = await import('../../db/src/sessions.js')
    const { quarantineRestoredDatabase, replayClosureHistory, releasePrivacyQuarantine } =
      await import('../../../entries/container/src/privacy-restore.js')
    const { renderTimeComment } = await import('../../integrations/src/work-items/publication.js')
    const f = await calendarOperatorFixture('sqlite')
    const directory = await mkdtemp(join(tmpdir(), 'ezacto-github-consent-restore-'))
    let restored: BetterSqlite3.Database | undefined, current: BetterSqlite3.Database | undefined
    try {
      await f.run(
        "INSERT INTO clients(id,name,currency,created_at,updated_at) VALUES(1,'Owned','USD',?,?)",
        f.now,
        f.now,
      )
      await f.run(
        "INSERT INTO projects(id,client_id,name,bill_by,created_at,updated_at) VALUES(1,1,'Owned','tasks',?,?)",
        f.now,
        f.now,
      )
      await f.run(
        "INSERT INTO tasks(id,name,created_at,updated_at) VALUES(1,'Owned',?,?)",
        f.now,
        f.now,
      )
      await f.run(
        'INSERT INTO task_assignments(id,project_id,task_id,billable,created_at,updated_at) VALUES(1,1,1,0,?,?)',
        f.now,
        f.now,
      )
      await f.run(
        'INSERT INTO user_assignments(id,project_id,user_id,created_at,updated_at) VALUES(1,1,3,?,?)',
        f.now,
        f.now,
      )
      await f.run(
        "INSERT INTO time_entries(id,user_id,project_id,task_id,user_assignment_id,task_assignment_id,spent_date,seconds,seconds_without_timer,rounded_seconds,billable,created_at,updated_at) VALUES(1,3,1,1,1,1,'2026-10-01',3600,3600,3600,0,?,?)",
        f.now,
        f.now,
      )
      await new NativeGithubReaderAdmin(f.db).map(
        f.actor,
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
        f.now,
      )
      await f.run(
        `INSERT INTO github_read_items(connection_id,issue_id,repository_id,metadata,outcome) VALUES('11:22:33','900','77',?,'inserted')`,
        JSON.stringify({
          connectionId: '11:22:33',
          issueId: '900',
          repositoryId: '77',
          number: 5,
          canonicalUrl: 'https://github.com/owned/disposable/issues/5',
          title: 'Owned',
          state: 'open',
          remoteUpdatedAt: f.now,
          aliases: [],
          status: 'visible',
        }),
      )
      await f.run(
        "INSERT INTO github_read_aliases(connection_id,issue_id,alias) VALUES('11:22:33','900','owned/disposable#5')",
      )
      await f.run(
        "INSERT INTO work_item_links(id,connection_id,time_entry_id,provider_item_id,created_by,created_at,updated_at) SELECT 1,work_item_connection_id,1,'owned/disposable#5',1,?,? FROM github_read_connections WHERE id='11:22:33'",
        f.now,
        f.now,
      )
      const marker = 'a'.repeat(64),
        body = renderTimeComment(marker, '1', { spentDate: '2026-10-01', seconds: 3600 })
      await f.run(
        "INSERT INTO github_publication_policy(connection_id,enabled,marker,verified_app_id,verified_at,instance_nonce) VALUES('11:22:33',1,?,'11',?,(SELECT nonce FROM github_publication_instance))",
        marker,
        f.now,
      )
      await f.run(
        "INSERT INTO github_publications(id,connection_id,entry_id,subject_user_id,subject_created_at,consent_nonce,marker,link_id,repository_id,issue_id,issue_number,destination,desired_date,desired_seconds,remote_id,last_body,last_date,last_seconds,status,attempted_at) VALUES(1,'11:22:33',1,3,(SELECT created_at FROM users WHERE id=3),(SELECT nonce FROM github_publication_instance),?,1,'77','900','5','https://github.com/owned/disposable/issues/5','2026-10-01',3600,?,?,'2026-10-01',3600,?,?)",
        marker,
        mode === 'known' ? '4321' : null,
        mode === 'snapshot_before_attempt' ? null : body,
        mode === 'known' ? 'published' : mode === 'unknown' ? 'attempted' : 'pending',
        mode === 'unknown' ? Date.now() - 60000 : null,
      )
      const sourcePath = join(directory, 'current.sqlite')
      await f.sqlite!.backup(sourcePath)
      const backup = await createBackup({
        databasePath: sourcePath,
        outputDirectory: join(directory, 'backup'),
      })
      const target = join(directory, 'restored.sqlite')
      await restoreBackup({ bundleDirectory: backup.bundleDirectory, targetDatabasePath: target })
      restored = new BetterSqlite3(target)
      current = new BetterSqlite3(sourcePath, { readonly: true })
      quarantineRestoredDatabase(restored)
      replayClosureHistory(restored, current)
      releasePrivacyQuarantine(
        restored,
        current,
        'Owned fixture: current privacy history reviewed before release.',
      )
      const actor = {
        userId: 1,
        sessionId: (await createContainerSessionStore(restored).issue(1)).session.id,
      }
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
      let writes = 0
      const service = createGithubPublicationService(createContainerDatabase(restored), {
        publicationEnabled: true,
        now: () => new Date(),
        credentials: async () => ({ appId: '11', privateKey: pem, webhookSecret: 'owned' }),
        fetch: async (request) => {
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
              expires_at: new Date(Date.now() + 3600000).toISOString(),
              permissions: { issues: 'write', metadata: 'read' },
              repositories: [{ id: 77, full_name: 'owned/disposable' }],
            })
          if (path === '/repos/owned/disposable')
            return Response.json({ id: 77, full_name: 'owned/disposable', owner: { id: 33 } })
          if (path === '/repos/owned/disposable/issues/5/comments')
            return Response.json([
              {
                id: 4321,
                body,
                user: { id: 100, type: 'Bot' },
                performed_via_github_app: { id: 11 },
              },
            ])
          if (path === '/repos/owned/disposable/issues/comments/4321')
            return Response.json({
              id: 4321,
              body,
              user: { id: 100, type: 'Bot' },
              performed_via_github_app: { id: 11 },
              issue_url: 'https://api.github.com/repos/owned/disposable/issues/5',
            })
          writes++
          throw new Error('No comment mutation expected')
        },
      })
      await service.policy(actor, {
        connection_id: '11:22:33',
        expected_generation: 1,
        enabled: true,
        confirm_permission: true,
        command_id: crypto.randomUUID(),
      })
      await service.tick()
      expect(writes).toBe(0)
      expect((await service.list(actor)).publications[0]!.status).toBe('prior_instance')
      const preview = await service.preview(actor, 1)
      await service.consent(actor, {
        link_id: 1,
        source_version: preview.source_version,
        command_id: crypto.randomUUID(),
      })
      await service.tick()
      expect(writes).toBe(0)
      const rows = (await service.list(actor)).publications
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject({ status: 'published', remote_id: '4321' })
      expect(rows[1]).toMatchObject({
        status: 'prior_instance',
        remote_id: mode === 'known' ? '4321' : null,
      })
    } finally {
      current?.close()
      restored?.close()
      await f.close()
      await rm(directory, { recursive: true, force: true })
    }
  },
  30000,
)
