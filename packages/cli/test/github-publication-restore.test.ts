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
      INSERT INTO github_publications(id,connection_id,entry_id,repository_id,issue_id,issue_number,destination,desired_date,desired_seconds,remote_id,last_body,status) VALUES(1,'11:22:33',1,'77','900','5','https://github.com/owned/disposable/issues/5','2026-10-01',3600,'4321','Owned previous body','published');`)
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
