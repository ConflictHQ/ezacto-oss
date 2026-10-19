import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import {
  allowBackupDownloadRequest,
  BACKUP_DOWNLOAD_REQUESTS_PER_MINUTE,
  BACKUP_LINK_LIFETIME_MS,
  BACKUP_LINK_MINTS_PER_MINUTE,
  consumeBackupDownloadLink,
  latestCompletedBackupRunId,
  mintBackupDownloadLink,
} from '../src/backup-download-links.js'
import type { InvoiceStateDatabase } from '../src/invoice-state.js'
import { hashViewLinkToken } from '../src/invoice-view-links.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'

interface Harness {
  orm: InvoiceStateDatabase
  run(sql: string, ...bindings: unknown[]): Promise<void>
  rows<T>(sql: string, ...bindings: unknown[]): Promise<T[]>
  close(): Promise<void>
}

const at = '2026-10-19T12:00:00.000Z'
const soon = '2026-10-19T12:05:00.000Z'
const lapsed = '2026-10-19T12:10:00.000Z'

const container = async (): Promise<Harness> => {
  const sqlite = new BetterSqlite3(':memory:')
  migrateContainer(sqlite)
  return {
    orm: createContainerDatabase(sqlite),
    run: async (sql, ...bindings) => void sqlite.prepare(sql).run(...bindings),
    rows: async <T>(sql: string, ...bindings: unknown[]) =>
      sqlite.prepare(sql).all(...bindings) as T[],
    close: async () => void sqlite.close(),
  }
}

const d1 = async (): Promise<Harness> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const database = await miniflare.getD1Database('DB')
  await migrateD1(database)
  return {
    orm: createD1Database(database),
    run: async (sql, ...bindings) => void (await database.prepare(sql).bind(...bindings).run()),
    rows: async <T>(sql: string, ...bindings: unknown[]) =>
      (await database.prepare(sql).bind(...bindings).all<T>()).results,
    close: async () => miniflare.dispose(),
  }
}

const seed = async (database: Harness): Promise<void> => {
  await database.run(
    `INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
     VALUES (1, 'Avery', 'Ng', 'administrator', '[]', ?, ?)`,
    at,
    at,
  )
  await database.run(
    `INSERT INTO backup_runs (id, status, trigger, started_at, completed_at, r2_prefix,
       manifest_json, table_count, total_rows, created_at, updated_at)
     VALUES (1, 'completed', 'nightly', '2026-10-18T03:00:00.000Z', '2026-10-18T03:01:00.000Z',
       'backups/2026-10-18/', '{}', 0, 0, ?, ?)`,
    at,
    at,
  )
  await database.run(
    `INSERT INTO backup_runs (id, status, trigger, started_at, error_message, completed_at,
       created_at, updated_at)
     VALUES (2, 'failed', 'nightly', '2026-10-19T03:00:00.000Z', 'boom',
       '2026-10-19T03:01:00.000Z', ?, ?)`,
    at,
    at,
  )
  await database.run(
    `INSERT INTO backup_runs (id, status, trigger, started_at, created_at, updated_at)
     VALUES (3, 'running', 'manual', '2026-10-19T11:00:00.000Z', ?, ?)`,
    at,
    at,
  )
}

for (const [name, open] of [
  ['the container (SQLite)', container],
  ['the Worker (D1)', d1],
] as const) {
  describe(`backup download links on ${name}`, () => {
    let database: Harness | undefined
    afterEach(async () => {
      await database?.close()
      database = undefined
    })
    const ready = async (): Promise<Harness> => {
      database = await open()
      await seed(database)
      return database
    }

    it('[db] offers the newest completed run, ignoring failed and running ones', async () => {
      const db = await ready()
      expect(await latestCompletedBackupRunId(db.orm)).toBe(1)
    })

    it('[db] mints for a completed run only, and stores the hash and never the token', async () => {
      const db = await ready()
      const link = await mintBackupDownloadLink(db.orm, { backupRunId: 1, userId: 1, now: at })
      expect(link).not.toBeNull()
      expect(link!.token).toMatch(/^[A-Za-z0-9_-]{43}$/u)
      expect(Date.parse(link!.expiresAt) - Date.parse(at)).toBe(BACKUP_LINK_LIFETIME_MS)
      const stored = await db.rows<Record<string, unknown>>('SELECT * FROM backup_download_links')
      expect(stored).toHaveLength(1)
      expect(stored[0]!.token_hash).toBe(await hashViewLinkToken(link!.token))
      expect(JSON.stringify(stored)).not.toContain(link!.token)
      for (const refused of [2, 3, 99]) {
        expect(
          await mintBackupDownloadLink(db.orm, { backupRunId: refused, userId: 1, now: at }),
        ).toBeNull()
      }
      expect(await db.rows('SELECT id FROM backup_download_links')).toHaveLength(1)
    })

    it('[db] two mints never share a token', async () => {
      const db = await ready()
      const first = await mintBackupDownloadLink(db.orm, { backupRunId: 1, userId: 1, now: at })
      const second = await mintBackupDownloadLink(db.orm, { backupRunId: 1, userId: 1, now: at })
      expect(first!.token).not.toBe(second!.token)
    })

    it('[db] spends a live link once and says what it was for', async () => {
      const db = await ready()
      const link = (await mintBackupDownloadLink(db.orm, {
        backupRunId: 1,
        userId: 1,
        now: at,
      }))!
      expect(await consumeBackupDownloadLink(db.orm, link.token, soon)).toEqual({
        id: link.id,
        backupRunId: 1,
        createdByUserId: 1,
      })
      expect(await consumeBackupDownloadLink(db.orm, link.token, soon)).toBeNull()
      const [row] = await db.rows<{ consumed_at: string }>(
        'SELECT consumed_at FROM backup_download_links WHERE id = ?',
        link.id,
      )
      expect(row!.consumed_at).toBe(soon)
    })

    it('[db] refuses an expired link, and the refusal does not spend it', async () => {
      const db = await ready()
      const link = (await mintBackupDownloadLink(db.orm, {
        backupRunId: 1,
        userId: 1,
        now: at,
      }))!
      expect(await consumeBackupDownloadLink(db.orm, link.token, lapsed)).toBeNull()
      expect(await consumeBackupDownloadLink(db.orm, link.token, link.expiresAt)).toBeNull()
      const [row] = await db.rows<{ consumed_at: string | null }>(
        'SELECT consumed_at FROM backup_download_links WHERE id = ?',
        link.id,
      )
      expect(row!.consumed_at).toBeNull()
    })

    it('[db] refuses a token that was never minted or is the wrong shape', async () => {
      const db = await ready()
      await mintBackupDownloadLink(db.orm, { backupRunId: 1, userId: 1, now: at })
      for (const token of ['', 'short', 'A'.repeat(43), 'A'.repeat(44), `${'A'.repeat(42)}!`, '%00']) {
        expect(await consumeBackupDownloadLink(db.orm, token, soon)).toBeNull()
      }
      const [row] = await db.rows<{ spent: number }>(
        'SELECT count(consumed_at) AS spent FROM backup_download_links',
      )
      expect(row!.spent).toBe(0)
    })

    it('[db] hands exactly one of several concurrent redemptions the link', async () => {
      const db = await ready()
      const link = (await mintBackupDownloadLink(db.orm, {
        backupRunId: 1,
        userId: 1,
        now: at,
      }))!
      const results = await Promise.all(
        Array.from({ length: 6 }, () => consumeBackupDownloadLink(db.orm, link.token, soon)),
      )
      expect(results.filter((result) => result !== null)).toHaveLength(1)
    })

    it('[db] never lets a link be edited, unspent or deleted', async () => {
      const db = await ready()
      const link = (await mintBackupDownloadLink(db.orm, {
        backupRunId: 1,
        userId: 1,
        now: at,
      }))!
      await consumeBackupDownloadLink(db.orm, link.token, soon)
      await expect(
        db.run('UPDATE backup_download_links SET consumed_at = NULL WHERE id = ?', link.id),
      ).rejects.toThrow(/single-use/u)
      await expect(
        db.run('UPDATE backup_download_links SET expires_at = ? WHERE id = ?', lapsed, link.id),
      ).rejects.toThrow(/immutable/u)
      await expect(
        db.run('UPDATE backup_download_links SET backup_run_id = 3 WHERE id = ?', link.id),
      ).rejects.toThrow(/immutable/u)
      await expect(db.run('DELETE FROM backup_download_links')).rejects.toThrow(/immutable/u)
    })

    it('[db] rejects a stored hash that is not a SHA-256', async () => {
      const db = await ready()
      await expect(
        db.run(
          `INSERT INTO backup_download_links
             (backup_run_id, created_by_user_id, token_hash, expires_at, created_at)
           VALUES (1, 1, 'plain-token', ?, ?)`,
          soon,
          at,
        ),
      ).rejects.toThrow()
    })

    it('[db] counts requests per scope and caller per minute, and keeps no address', async () => {
      const db = await ready()
      for (let attempt = 0; attempt < BACKUP_LINK_MINTS_PER_MINUTE; attempt += 1) {
        expect(await allowBackupDownloadRequest(db.orm, 'mint', '1', at)).toBe(true)
      }
      expect(await allowBackupDownloadRequest(db.orm, 'mint', '1', at)).toBe(false)
      expect(await allowBackupDownloadRequest(db.orm, 'mint', '2', at)).toBe(true)
      // A different scope has its own budget, and the minute turns over.
      expect(await allowBackupDownloadRequest(db.orm, 'redeem', '1', at)).toBe(true)
      expect(await allowBackupDownloadRequest(db.orm, 'mint', '1', '2026-10-19T12:01:00.000Z')).toBe(
        true,
      )
      for (let attempt = 0; attempt < BACKUP_DOWNLOAD_REQUESTS_PER_MINUTE; attempt += 1) {
        expect(await allowBackupDownloadRequest(db.orm, 'redeem', '203.0.113.9', at)).toBe(true)
      }
      expect(await allowBackupDownloadRequest(db.orm, 'redeem', '203.0.113.9', at)).toBe(false)
      expect(JSON.stringify(await db.rows('SELECT * FROM backup_download_limits'))).not.toContain(
        '203.0.113.9',
      )
    })
  })
}
