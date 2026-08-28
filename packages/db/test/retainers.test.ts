import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import * as publicDatabase from '../src/index.js'
import { ensureHarvestRetainerStub } from '../src/internal/retainer-import.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { orgPeopleMigration } from '../src/migrations/0000_org_people.js'
import { clientsMigration } from '../src/migrations/0001_clients.js'
import { projectsTimeMigration } from '../src/migrations/0002_projects_time.js'
import { rateResolverMigration } from '../src/migrations/0003_rate_resolver.js'
import { invoiceFoundationMigration } from '../src/migrations/0004_invoice_foundation.js'
import { invoicePaymentsTotalsMigration } from '../src/migrations/0005_invoice_payments_totals.js'
import {
  appendRetainerLedgerEntry,
  getRetainerBalance,
  type RetainerDatabase,
} from '../src/retainers.js'

interface TestDatabase {
  orm: RetainerDatabase
  run(sql: string, ...params: unknown[]): Promise<void>
  rows<T>(sql: string, ...params: unknown[]): Promise<T[]>
  migrateAgain(): Promise<void>
  close(): Promise<void>
}

interface DanglingRetainerInvoice {
  id: number
  client: { id: number; name: string }
  retainer: { id: number }
}

const timestamp = '2026-08-28T08:00:00.000Z'
const date = '2026-08-28'
const migrationsThrough0005 = [
  ['0000_org_people', orgPeopleMigration],
  ['0001_clients', clientsMigration],
  ['0002_projects_time', projectsTimeMigration],
  ['0003_rate_resolver', rateResolverMigration],
  ['0004_invoice_foundation', invoiceFoundationMigration],
  ['0005_invoice_payments_totals', invoicePaymentsTotalsMigration],
] as const

const containerDatabase = (migrate = true): TestDatabase => {
  const sqlite = new BetterSqlite3(':memory:')
  if (migrate) migrateContainer(sqlite)
  return {
    orm: createContainerDatabase(sqlite),
    run: async (sql, ...params) => {
      sqlite.prepare(sql).run(...params)
    },
    rows: async <T>(sql: string, ...params: unknown[]) => sqlite.prepare(sql).all(...params) as T[],
    migrateAgain: async () => migrateContainer(sqlite),
    close: async () => {
      sqlite.close()
    },
  }
}

const d1Database = async (migrate = true): Promise<TestDatabase> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const d1 = await miniflare.getD1Database('DB')
  if (migrate) await migrateD1(d1)
  return {
    orm: createD1Database(d1),
    run: async (sql, ...params) => {
      await d1
        .prepare(sql)
        .bind(...params)
        .run()
    },
    rows: async <T>(sql: string, ...params: unknown[]) =>
      (
        await d1
          .prepare(sql)
          .bind(...params)
          .all<T>()
      ).results,
    migrateAgain: async () => migrateD1(d1),
    close: async () => miniflare.dispose(),
  }
}

const factories = [
  ['container', async (migrate = true) => containerDatabase(migrate)],
  ['D1', d1Database],
] as const

const installThrough0005 = async (database: TestDatabase): Promise<void> => {
  await database.run(
    `CREATE TABLE _ezacto_migrations (
      id TEXT PRIMARY KEY, applied_at TEXT NOT NULL
    ) STRICT`,
  )
  for (const [id, statements] of migrationsThrough0005) {
    for (const statement of statements) await database.run(statement)
    await database.run(
      `INSERT INTO _ezacto_migrations (id, applied_at) VALUES (?, ?)`,
      id,
      timestamp,
    )
  }
}

const installOrganizationAndClients = async (database: TestDatabase): Promise<void> => {
  await database.run(
    `INSERT INTO organizations (name, modules, created_at, updated_at)
     VALUES ('Sanitized Organization', '{"invoices":true}', ?, ?)`,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO clients (id, harvest_id, name, currency, created_at, updated_at)
     VALUES (1, 41001, 'Sanitized Client', 'USD', ?, ?),
            (2, 41002, 'Other Sanitized Client', 'USD', ?, ?)`,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
  )
}

const insertInvoice = async (
  database: TestDatabase,
  id: number,
  clientId = 1,
  harvestId: number | null = null,
): Promise<void> => {
  await database.run(
    `INSERT INTO invoices (
      id, harvest_id, client_id, number, currency, issue_date, due_date, state,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'USD', ?, '2026-09-28', 'draft', ?, ?)`,
    id,
    harvestId,
    clientId,
    `INV-${id}`,
    date,
    timestamp,
    timestamp,
  )
}

const insertLinkedInvoice = async (
  database: TestDatabase,
  id: number,
  retainerId: number,
  clientId = 1,
): Promise<void> => {
  await insertInvoice(database, id, clientId)
  await database.run(`UPDATE invoices SET retainer_id = ? WHERE id = ?`, retainerId, id)
}

const insertMoneyRetainer = async (
  database: TestDatabase,
  id: number,
  onExhaustion: 'block' | 'warn' | 'overflow' = 'block',
  clientId: number | null = 1,
): Promise<void> => {
  await database.run(
    `INSERT INTO retainers (
      id, client_id, state, denomination, amount_cents, seconds,
      on_exhaustion, created_at, updated_at
    ) VALUES (?, ?, 'ongoing', 'money', 100000, NULL, ?, ?, ?)`,
    id,
    clientId,
    onExhaustion,
    timestamp,
    timestamp,
  )
}

const append = (database: TestDatabase, input: Parameters<typeof appendRetainerLedgerEntry>[1]) =>
  appendRetainerLedgerEntry(database.orm, input)

for (const [runtime, factory] of factories) {
  describe(`retainer storage (${runtime})`, () => {
    let database: TestDatabase | undefined

    afterEach(async () => database?.close())

    it('[unit] upgrades fresh and populated invoice databases with real foreign keys', async () => {
      database = await factory()
      expect(
        await database.rows<{ name: string }>(
          `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name IN ('retainers','retainer_ledger')
             ORDER BY name`,
        ),
      ).toEqual([{ name: 'retainer_ledger' }, { name: 'retainers' }])
      expect(
        (await database.rows<{ name: string }>(`PRAGMA table_info(invoices)`)).map(
          ({ name }) => name,
        ),
      ).toContain('retainer_id')
      expect(
        (
          await database.rows<{
            from: string
            table: string
            to: string
            on_delete: string
          }>(`PRAGMA foreign_key_list(invoices)`)
        ).map(({ from, table, to, on_delete }) => ({ from, table, to, on_delete })),
      ).toEqual(
        expect.arrayContaining([
          {
            from: 'retainer_id',
            table: 'retainers',
            to: 'id',
            on_delete: 'RESTRICT',
          },
        ]),
      )
      expect(
        await database.rows<{ id: string }>(
          `SELECT id FROM _ezacto_migrations ORDER BY id DESC LIMIT 1`,
        ),
      ).toEqual([{ id: '0013_password_auth' }])
      await database.close()
      database = await factory(false)
      await installThrough0005(database)
      await installOrganizationAndClients(database)
      await insertInvoice(database, 1)

      await database.migrateAgain()
      expect(
        await database.rows<{ id: number; retainer_id: number | null }>(
          `SELECT id, retainer_id FROM invoices`,
        ),
      ).toEqual([{ id: 1, retainer_id: null }])
      await insertMoneyRetainer(database, 1)
      await database.run(
        `INSERT INTO projects (id, client_id, name, code, created_at, updated_at)
         VALUES (1, 1, 'Retainer project', 'RET', ?, ?)`,
        timestamp,
        timestamp,
      )
      await database.run(`UPDATE retainers SET project_id = 1 WHERE id = 1`)
      await expect(database.run(`UPDATE projects SET client_id = 2 WHERE id = 1`)).rejects.toThrow(
        /project client must match every linked retainer/,
      )
      expect(
        await database.rows<{ retainer_client: number; project_client: number }>(
          `SELECT retainer.client_id AS retainer_client, project.client_id AS project_client
           FROM retainers retainer
           JOIN projects project ON project.id = retainer.project_id
           WHERE retainer.id = 1`,
        ),
      ).toEqual([{ retainer_client: 1, project_client: 1 }])
      await database.run(`UPDATE invoices SET retainer_id = 1 WHERE id = 1`)
      await expect(
        database.run(`UPDATE invoices SET retainer_id = 999 WHERE id = 1`),
      ).rejects.toThrow()
      expect(await database.rows(`PRAGMA foreign_key_check`)).toEqual([])
      await database.migrateAgain()
      expect(await database.rows(`PRAGMA foreign_key_check`)).toEqual([])
    }, 20_000)

    it('[unit] enforces one cap and the hours-only locked-rate pair', async () => {
      database = await factory()
      await installOrganizationAndClients(database)
      await insertMoneyRetainer(database, 1)
      await database.run(
        `INSERT INTO retainers (
          id, client_id, denomination, amount_cents, seconds,
          locked_rate_cents, rate_locked_at, created_at, updated_at
        ) VALUES (2, 1, 'hours', NULL, 360000, 25000, ?, ?, ?)`,
        timestamp,
        timestamp,
        timestamp,
      )
      for (const sql of [
        `INSERT INTO retainers
          (id, denomination, amount_cents, seconds, created_at, updated_at)
         VALUES (10, 'money', 100, 3600, '${timestamp}', '${timestamp}')`,
        `INSERT INTO retainers
          (id, denomination, amount_cents, seconds, created_at, updated_at)
         VALUES (11, 'money', NULL, 3600, '${timestamp}', '${timestamp}')`,
        `INSERT INTO retainers
          (id, denomination, amount_cents, seconds, locked_rate_cents,
            rate_locked_at, created_at, updated_at)
         VALUES (12, 'money', 100, NULL, 50, '${timestamp}', '${timestamp}', '${timestamp}')`,
        `INSERT INTO retainers
          (id, denomination, amount_cents, seconds, locked_rate_cents,
            created_at, updated_at)
         VALUES (13, 'hours', NULL, 3600, 50, '${timestamp}', '${timestamp}')`,
      ]) {
        await expect(database.run(sql)).rejects.toThrow(/CHECK constraint/)
      }
      expect(
        await database.rows<{
          id: number
          denomination: string
          amount_cents: number | null
          seconds: number | null
        }>(`SELECT id, denomination, amount_cents, seconds FROM retainers ORDER BY id`),
      ).toEqual([
        { id: 1, denomination: 'money', amount_cents: 100000, seconds: null },
        { id: 2, denomination: 'hours', amount_cents: null, seconds: 360000 },
      ])
    })

    it('[unit] accepts only the five append-only movement kinds in the parent unit', async () => {
      database = await factory()
      await installOrganizationAndClients(database)
      await insertMoneyRetainer(database, 1, 'overflow')
      await database.run(
        `INSERT INTO retainers (
          id, client_id, denomination, amount_cents, seconds, on_exhaustion,
          created_at, updated_at
        ) VALUES (2, 1, 'hours', NULL, 36000, 'overflow', ?, ?)`,
        timestamp,
        timestamp,
      )
      await insertMoneyRetainer(database, 3, 'overflow')
      await insertLinkedInvoice(database, 100, 1)
      await insertLinkedInvoice(database, 101, 2)
      const movements = [
        ['deposit', 1000],
        ['drawdown', -100],
        ['expiry', -100],
        ['reset', 50],
        ['adjustment', -25],
      ] as const
      for (const [index, [kind, amountCents]] of movements.entries()) {
        await append(database, {
          id: `movement-${index}`,
          retainerId: 1,
          kind,
          amountCents,
          invoiceId: kind === 'deposit' || kind === 'drawdown' ? 100 : null,
          occurredOn: date,
          notes: kind === 'adjustment' ? 'Sanitized reconciliation' : null,
          createdAt: timestamp,
        })
      }
      await append(database, {
        id: 'hours-deposit',
        retainerId: 2,
        kind: 'deposit',
        seconds: 3600,
        invoiceId: 101,
        occurredOn: date,
        createdAt: timestamp,
      })
      await expect(
        append(database, {
          id: 'wrong-retainer-invoice',
          retainerId: 3,
          kind: 'drawdown',
          amountCents: -10,
          invoiceId: 100,
          occurredOn: date,
          createdAt: timestamp,
        }),
      ).rejects.toThrow(/same retainer and client/)
      await expect(
        database.run(`UPDATE invoices SET retainer_id = 3 WHERE id = 100`),
      ).rejects.toThrow(/immutable after a linked ledger entry/)
      await expect(
        append(database, {
          id: 'wrong-unit',
          retainerId: 1,
          kind: 'deposit',
          seconds: 60,
          invoiceId: 100,
          occurredOn: date,
          createdAt: timestamp,
        }),
      ).rejects.toThrow(/unit must match/)
      await expect(
        database.run(
          `INSERT INTO retainer_ledger
            (id, retainer_id, kind, unit, amount, occurred_on, created_at)
           VALUES ('bad-kind', 1, 'refund', 'cents', 1, ?, ?)`,
          date,
          timestamp,
        ),
      ).rejects.toThrow(/CHECK constraint/)

      const retry = await append(database, {
        id: 'movement-0',
        retainerId: 1,
        kind: 'deposit',
        amountCents: 1000,
        invoiceId: 100,
        occurredOn: date,
        notes: null,
        createdAt: timestamp,
      })
      expect(retry.amount).toBe(1000)
      await expect(
        append(database, {
          id: 'movement-0',
          retainerId: 1,
          kind: 'deposit',
          amountCents: 1001,
          invoiceId: 100,
          occurredOn: date,
          createdAt: timestamp,
        }),
      ).rejects.toThrow(/already used/)
      await expect(
        database.run(`UPDATE retainer_ledger SET notes = 'changed' WHERE id = 'movement-0'`),
      ).rejects.toThrow(/append-only/)
      await expect(
        database.run(`DELETE FROM retainer_ledger WHERE id = 'movement-0'`),
      ).rejects.toThrow(/append-only/)
      await expect(
        database.run(
          `INSERT OR REPLACE INTO retainer_ledger
            (id, retainer_id, kind, unit, amount, invoice_id, occurred_on, created_at)
           VALUES ('movement-0', 1, 'deposit', 'cents', 2000, 100, ?, ?)`,
          date,
          timestamp,
        ),
      ).rejects.toThrow(/identity already exists/)
      expect(
        await database.rows<{ amount: number }>(
          `SELECT amount FROM retainer_ledger WHERE id = 'movement-0'`,
        ),
      ).toEqual([{ amount: 1000 }])
      await expect(
        database.run(
          `INSERT INTO retainer_ledger
            (id, retainer_id, kind, unit, amount, occurred_on, created_at)
           VALUES ('missing-adjustment-reason', 1, 'adjustment', 'cents', 1, ?, ?)`,
          date,
          timestamp,
        ),
      ).rejects.toThrow(/CHECK constraint/)
      await expect(
        database.run(
          `INSERT INTO retainer_ledger
            (id, retainer_id, kind, unit, amount, occurred_on, created_at)
           VALUES ('missing-drawdown-invoice', 1, 'drawdown', 'cents', -1, ?, ?)`,
          date,
          timestamp,
        ),
      ).rejects.toThrow(/CHECK constraint/)
    })

    it('[unit] derives balance and atomically blocks all non-overflow overdrafts', async () => {
      database = await factory()
      await installOrganizationAndClients(database)
      await insertMoneyRetainer(database, 1, 'block')
      await insertMoneyRetainer(database, 2, 'warn')
      await insertMoneyRetainer(database, 3, 'overflow')

      for (const [invoiceId, retainerId] of [
        [201, 1],
        [202, 1],
        [203, 1],
        [204, 2],
        [205, 2],
        [206, 3],
        [207, 3],
      ] as const) {
        await insertLinkedInvoice(database, invoiceId, retainerId)
      }

      for (const retainerId of [1, 2, 3]) {
        await append(database, {
          id: `seed-${retainerId}`,
          retainerId,
          kind: 'deposit',
          amountCents: 1000,
          invoiceId: retainerId === 1 ? 201 : retainerId === 2 ? 204 : 206,
          occurredOn: date,
          createdAt: timestamp,
        })
      }
      const competing = await Promise.allSettled([
        append(database, {
          id: 'competing-a',
          retainerId: 1,
          kind: 'drawdown',
          amountCents: -700,
          invoiceId: 202,
          occurredOn: date,
          createdAt: timestamp,
        }),
        append(database, {
          id: 'competing-b',
          retainerId: 1,
          kind: 'drawdown',
          amountCents: -700,
          invoiceId: 203,
          occurredOn: date,
          createdAt: timestamp,
        }),
      ])
      expect(competing.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
      expect(competing.filter(({ status }) => status === 'rejected')).toHaveLength(1)
      expect(await getRetainerBalance(database.orm, 1)).toEqual({
        retainerId: 1,
        denomination: 'money',
        balance: 300,
      })
      await expect(
        append(database, {
          id: 'warn-overdraw',
          retainerId: 2,
          kind: 'drawdown',
          amountCents: -1001,
          invoiceId: 205,
          occurredOn: date,
          createdAt: timestamp,
        }),
      ).rejects.toThrow(/cannot overdraw/)
      await append(database, {
        id: 'overflow-overdraw',
        retainerId: 3,
        kind: 'drawdown',
        amountCents: -1500,
        invoiceId: 207,
        occurredOn: date,
        createdAt: timestamp,
      })
      expect((await getRetainerBalance(database.orm, 3)).balance).toBe(-500)
      await expect(
        database.run(`UPDATE retainers SET on_exhaustion = 'block' WHERE id = 3`),
      ).rejects.toThrow(/negative retainer balance requires overflow/)
    })

    it('[unit] deduplicates dangling Harvest stubs and opens a cents adjustment without hours', async () => {
      database = await factory()
      expect('ensureHarvestRetainerStub' in publicDatabase).toBe(false)
      await installOrganizationAndClients(database)
      const fixtures = JSON.parse(
        await readFile(
          new URL('fixtures/harvest-invoices-dangling-retainer.json', import.meta.url),
          'utf8',
        ),
      ) as DanglingRetainerInvoice[]
      for (const fixture of fixtures) {
        await insertInvoice(database, fixture.id, 1, fixture.id)
      }
      const ensured = await Promise.all(
        fixtures.map((fixture) =>
          ensureHarvestRetainerStub(database!.orm, {
            invoiceId: fixture.id,
            harvestInvoiceId: fixture.id,
            harvestRetainerId: fixture.retainer.id,
            createdAt: timestamp,
            updatedAt: timestamp,
          }),
        ),
      )
      expect(new Set(ensured.map(({ id }) => id)).size).toBe(1)

      const [stub] = await database.rows<{
        id: number
        harvest_id: number
        denomination: string
        amount_cents: number | null
        seconds: number | null
      }>(
        `SELECT id, harvest_id, denomination, amount_cents, seconds
           FROM retainers WHERE harvest_id = ?`,
        fixtures[0]!.retainer.id,
      )
      expect(stub).toMatchObject({
        harvest_id: fixtures[0]!.retainer.id,
        denomination: 'money',
        amount_cents: 0,
        seconds: null,
      })
      expect(
        await database.rows<{ count: number }>(
          `SELECT count(*) AS count FROM retainers WHERE harvest_id = ?`,
          fixtures[0]!.retainer.id,
        ),
      ).toEqual([{ count: 1 }])
      expect(
        await database.rows<{ retainer_id: number }>(
          `SELECT retainer_id FROM invoices WHERE id IN (?, ?) ORDER BY id`,
          fixtures[0]!.id,
          fixtures[1]!.id,
        ),
      ).toEqual([{ retainer_id: stub!.id }, { retainer_id: stub!.id }])
      await expect(
        database.run(`UPDATE retainers SET client_id = 2 WHERE id = ?`, stub!.id),
      ).rejects.toThrow(/match every linked invoice/)

      await append(database, {
        id: `harvest-retainer:${fixtures[0]!.retainer.id}:opening`,
        retainerId: stub!.id,
        kind: 'adjustment',
        amountCents: 125_000,
        occurredOn: date,
        notes: 'Manual opening balance from sanitized worksheet',
        createdAt: timestamp,
      })
      expect(await getRetainerBalance(database.orm, stub!.id)).toEqual({
        retainerId: stub!.id,
        denomination: 'money',
        balance: 125_000,
      })
      expect(
        await database.rows<{ unit: string; amount: number }>(
          `SELECT unit, amount FROM retainer_ledger WHERE retainer_id = ?`,
          stub!.id,
        ),
      ).toEqual([{ unit: 'cents', amount: 125_000 }])
      await expect(
        database.run(`UPDATE retainers SET harvest_id = 91002 WHERE id = ?`, stub!.id),
      ).rejects.toThrow(/immutable/)

      await insertInvoice(database, 72_000)
      await expect(
        ensureHarvestRetainerStub(database.orm, {
          invoiceId: 72_000,
          harvestInvoiceId: 72_000,
          harvestRetainerId: 92_000,
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      ).rejects.toThrow(/imported invoice/)
      expect(
        await database.rows<{ count: number }>(
          `SELECT count(*) AS count FROM retainers WHERE harvest_id = 92000`,
        ),
      ).toEqual([{ count: 0 }])
    }, 20_000)

    it('[unit] rolls back a conflicting Harvest stub link without partial rows', async () => {
      database = await factory()
      await installOrganizationAndClients(database)
      await insertInvoice(database, 73_000, 1, 73_000)

      // Prove the importer cannot rely on a numeric sentinel missing from the
      // identity domain: SQLite permits this schema-valid negative local id.
      await insertMoneyRetainer(database, -1)
      await insertMoneyRetainer(database, 70_001)
      await database.run(
        `INSERT INTO retainers (
          id, harvest_id, client_id, state, denomination, amount_cents, seconds,
          on_exhaustion, created_at, updated_at
        ) VALUES (70002, 93000, 1, 'ongoing', 'money', 100000, NULL, 'block', ?, ?)`,
        timestamp,
        timestamp,
      )
      await database.run(`UPDATE invoices SET retainer_id = 70001 WHERE id = 73000`)

      await expect(
        ensureHarvestRetainerStub(database.orm, {
          invoiceId: 73_000,
          harvestInvoiceId: 73_000,
          harvestRetainerId: 93_000,
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      ).rejects.toThrow()
      expect(
        await database.rows<{ retainer_id: number }>(
          `SELECT retainer_id FROM invoices WHERE id = 73000`,
        ),
      ).toEqual([{ retainer_id: 70_001 }])
      expect(
        await database.rows<{ id: number }>(`SELECT id FROM retainers WHERE harvest_id = 93000`),
      ).toEqual([{ id: 70_002 }])
      expect(await database.rows(`PRAGMA foreign_key_check`)).toEqual([])
    }, 20_000)
  })
}
