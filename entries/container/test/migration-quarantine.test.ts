import BetterSqlite3 from 'better-sqlite3'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { prepareContainerDatabase } from '../src/runtime.js'

it('[restore #409] refuses a restored partial Worker import and releases only a never-started cancellation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ezacto-container-migration-'))
  const db = new BetterSqlite3(join(directory, 'db.sqlite'))
  try {
    prepareContainerDatabase(db)
    const now = new Date().toISOString(),
      id = crypto.randomUUID()
    db.prepare(
      `INSERT INTO migration_loads(id,catalog_json,options_json,snapshot_sha256,source_rows,status,created_at,updated_at)
      VALUES(?,'{}','{}',?,0,'ready',?,?)`,
    ).run(id, '1'.repeat(64), now, now)
    expect(() => prepareContainerDatabase(db)).toThrow('Queued migration target is quarantined')
    db.prepare("UPDATE migration_loads SET status='cancelled' WHERE id=?").run(id)
    expect(() => prepareContainerDatabase(db)).not.toThrow()
    const partial = crypto.randomUUID()
    db.prepare(
      `INSERT INTO migration_loads(id,catalog_json,options_json,snapshot_sha256,source_rows,status,created_at,updated_at)
      VALUES(?,'{}','{}',?,1,'ready',?,?)`,
    ).run(partial, '2'.repeat(64), now, now)
    db.prepare("UPDATE migration_loads SET status='running',started_at=? WHERE id=?").run(
      now,
      partial,
    )
    db.prepare("UPDATE migration_loads SET status='cancelled' WHERE id=?").run(partial)
    expect(() => prepareContainerDatabase(db)).toThrow('Queued migration target is quarantined')
  } finally {
    db.close()
    await rm(directory, { recursive: true, force: true })
  }
})
