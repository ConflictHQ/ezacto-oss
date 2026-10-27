import { writeFile } from 'node:fs/promises'
import { Miniflare } from 'miniflare'
import { describe, it, expect } from 'vitest'
import { workerBackupCaptureMigration } from '../src/migrations/0176_worker_backup_capture.js'
import { exportBundle, completeBackupRun, recordBackupStart, failBackupRun } from '../src/backup.js'
const setup = async () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    d1Databases: ['DB'],
  })
  const db = await mf.getD1Database('DB')
  await db.exec(
    'CREATE TABLE account_closures(id INTEGER); CREATE TABLE account_retention_review_events(decision TEXT); CREATE TABLE organizations(id INTEGER); CREATE TABLE users(id INTEGER); CREATE TABLE sample(id INTEGER PRIMARY KEY,payload TEXT); CREATE TABLE backup_runs(id INTEGER PRIMARY KEY,status TEXT,trigger TEXT,started_at TEXT,completed_at TEXT,r2_prefix TEXT,manifest_json TEXT,table_count INTEGER,total_rows INTEGER,error_message TEXT,created_at TEXT,updated_at TEXT);',
  )
  await db.batch(workerBackupCaptureMigration.map((sql) => db.prepare(sql)))
  return { mf, db: db as unknown as D1Database }
}
describe('Worker snapshot bounded pages and privacy custody', () => {
  it('streams production-sized row counts without materializing the whole snapshot', async () => {
    const { mf, db } = await setup()
    try {
      const cols = Array.from({ length: 28 }, (_, i) => `c${i} TEXT`)
      await db.prepare(`CREATE TABLE time_entries(id INTEGER PRIMARY KEY,${cols.join(',')})`).run()
      await db
        .prepare(
          `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<31370) INSERT INTO time_entries SELECT x,${cols.map((_, i) => (i === 0 ? "printf('%0140d',x)" : "'fixture'")).join(',')} FROM n`,
        )
        .run()
      const extra = Array.from({ length: 9 }, (_, i) => `c${i} TEXT`)
      await db.prepare(`CREATE TABLE history(id INTEGER PRIMARY KEY,${extra.join(',')})`).run()
      await db
        .prepare(
          `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<53200) INSERT INTO history SELECT x,${extra.map(() => "'synthetic long value 12345'").join(',')} FROM n`,
        )
        .run()
      await db.batch(
        Array.from({ length: 232 }, (_, i) =>
          db.prepare(`CREATE TABLE empty_${i}(id INTEGER PRIMARY KEY)`),
        ),
      )
      let calls = 0,
        puts = 0,
        maxPage = 0,
        maxRows = 0,
        encodedRows = 0
      const wrapped = new Proxy(db, {
        get(target, key) {
          if (key === 'batch')
            return async (statements: D1PreparedStatement[]) => {
              calls++
              const result = await target.batch(statements)
              for (const item of result) {
                const rows = item.results as Array<{ encoded?: string }>
                const encoded = rows.filter((r) => typeof r.encoded === 'string')
                maxRows = Math.max(maxRows, encoded.length)
                maxPage = Math.max(
                  maxPage,
                  encoded.reduce((n, r) => n + new TextEncoder().encode(r.encoded!).length, 0),
                )
                encodedRows += encoded.length
              }
              return result
            }
          const value = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        },
      }) as D1Database
      const started = Date.now()
      const manifest = await exportBundle(
        wrapped,
        {
          async put() {
            puts++
          },
        },
        'scale/',
      )
      const proof = {
        proof: 'synthetic-production-shape',
        tables: manifest.table_count,
        rows: manifest.total_rows,
        d1_batch_calls: calls,
        d1_direct_calls: 1,
        r2_puts: puts,
        elapsed_ms: Date.now() - started,
        max_page_bytes: maxPage,
      }
      if (process.env.EZACTO_BACKUP_EVIDENCE_PATH)
        await writeFile(process.env.EZACTO_BACKUP_EVIDENCE_PATH, JSON.stringify(proof, null, 2))
      expect(calls + 2).toBeLessThan(1000)
      expect(manifest.table_count).toBe(243)
      expect(manifest.tables.time_entries?.row_count).toBe(31370)
      expect(encodedRows).toBe(84570)
      expect(maxRows).toBeLessThanOrEqual(500)
      expect(maxPage).toBeLessThanOrEqual(1024 * 1024)
      expect(manifest.tables.worker_backup_rows?.row_count).toBe(0)
    } finally {
      await mf.dispose()
    }
  }, 120000)
  it('preserves a frozen value across ordinary edits but purges privacy-invalidated captures', async () => {
    const { mf, db } = await setup()
    try {
      await db.prepare("INSERT INTO sample VALUES(1,'before')").run()
      let changed = false,
        rows = ''
      const manifest = await exportBundle(
        db,
        {
          async put(key, value) {
            if (key.includes('rows/sample/')) {
              rows += value
              if (!changed) {
                changed = true
                await db.prepare("UPDATE sample SET payload='after' WHERE id=1").run()
              }
            }
          },
        },
        'ordinary/',
      )
      expect(rows).toContain('6265666F7265')
      expect(
        (await db.prepare('SELECT payload FROM sample').first<{ payload: string }>())!.payload,
      ).toBe('after')
      expect(
        await db
          .prepare('SELECT 1 FROM worker_backup_snapshots WHERE id=?')
          .bind(manifest.capture_id)
          .first(),
      ).not.toBeNull()
      await db.prepare('INSERT INTO account_closures VALUES(1)').run()
      expect(await db.prepare('SELECT count(*) AS n FROM worker_backup_rows').first()).toEqual({
        n: 0,
      })
      expect(await db.prepare('SELECT count(*) AS n FROM worker_backup_snapshots').first()).toEqual(
        { n: 0 },
      )
      expect(await db.prepare('SELECT count(*) AS n FROM worker_backup_cleanup').first()).toEqual({
        n: 1,
      })
      let erased = false
      await expect(
        exportBundle(
          db,
          {
            async put(key) {
              if (!erased && key.includes('rows/sample/')) {
                erased = true
                await db
                  .prepare("INSERT INTO account_retention_review_events VALUES('removed')")
                  .run()
              }
            },
          },
          'erased/',
        ),
      ).rejects.toThrow(/invalidated/)
      expect(await db.prepare('SELECT count(*) AS n FROM worker_backup_rows').first()).toEqual({
        n: 0,
      })
    } finally {
      await mf.dispose()
    }
  }, 60000)
  it('fences completion if erasure occurs after final R2 publication', async () => {
    const { mf, db } = await setup()
    try {
      const now = new Date().toISOString(),
        runId = await recordBackupStart(db, 'manual', now)
      const manifest = await exportBundle(db, { async put() {} }, 'late/')
      await db.prepare('INSERT INTO account_closures VALUES(2)').run()
      await expect(completeBackupRun(db, runId, manifest, 'late/', now)).rejects.toThrow(
        /invalidated/,
      )
      expect(
        await db.prepare('SELECT status FROM backup_runs WHERE id=?').bind(runId).first(),
      ).toEqual({ status: 'running' })
      const successful = await recordBackupStart(db, 'manual', now)
      const good = await exportBundle(db, { async put() {} }, 'good/')
      await completeBackupRun(db, successful, good, 'good/', now)
      await completeBackupRun(db, successful, good, 'good/', new Date(Date.parse(now)+60000).toISOString())
      expect(await db.prepare('SELECT completed_at,updated_at FROM backup_runs WHERE id=?').bind(successful).first()).toEqual({completed_at:now,updated_at:now})
      await failBackupRun(db, successful, 'lost acknowledgement', now)
      expect(
        await db.prepare('SELECT status FROM backup_runs WHERE id=?').bind(successful).first(),
      ).toEqual({ status: 'completed' })
      expect(
        await db
          .prepare('SELECT count(*) AS n FROM worker_backup_snapshots WHERE id=?')
          .bind(good.capture_id)
          .first(),
      ).toEqual({ n: 0 })
    } finally {
      await mf.dispose()
    }
  }, 60000)
})
