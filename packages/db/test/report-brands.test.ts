import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { migrateContainer } from '../src/migrate.js'
import { resolveReportBrand } from '../src/report-brands.js'

const now = '2026-09-14T12:00:00.000Z'
let sqlite: BetterSqlite3.Database | null = null

afterEach(() => {
  sqlite?.close()
  sqlite = null
})

describe('report brand inheritance (#55)', () => {
  it('selects the nearest brand at any depth and never falls back to deployment assets', async () => {
    sqlite = new BetterSqlite3(':memory:')
    await migrateContainer(sqlite)
    sqlite.exec(`
      INSERT INTO organizations (name, modules, created_at, updated_at)
        VALUES ('Deployment name', '{}', '${now}', '${now}');
      INSERT INTO report_brands (id, name, primary_color, created_at, updated_at)
        VALUES (1, 'Root reports', '#112233', '${now}', '${now}'),
               (2, 'Branch reports', '#445566', '${now}', '${now}');
      INSERT INTO clients (id, name, currency, parent_client_id, report_brand_id, created_at, updated_at)
        VALUES (1, 'Root', 'USD', NULL, 1, '${now}', '${now}'),
               (2, 'Branch', 'USD', 1, 2, '${now}', '${now}'),
               (3, 'Leaf', 'USD', 2, NULL, '${now}', '${now}'),
               (4, 'Grandchild', 'USD', 3, NULL, '${now}', '${now}'),
               (5, 'Unbranded', 'USD', NULL, NULL, '${now}', '${now}');
      INSERT INTO brand_assets
        (slot, content_hash, file_key, content_type, byte_size, created_at, updated_at)
        VALUES ('wordmark_light', '${'0'.repeat(64)}', 'deployment/logo.png',
          'image/png', 1, '${now}', '${now}');
    `)
    const database = createContainerDatabase(sqlite)
    await expect(resolveReportBrand(database, 4)).resolves.toMatchObject({
      id: 2,
      name: 'Branch reports',
      sourceClientId: 2,
      inheritedDepth: 2,
    })
    await expect(resolveReportBrand(database, 1)).resolves.toMatchObject({ inheritedDepth: 0 })
    await expect(resolveReportBrand(database, 5)).resolves.toBeNull()
  })
})
