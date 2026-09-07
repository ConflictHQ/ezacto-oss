import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1, migrationIds } from '../src/migrate.js'
import { orgPeopleMigration } from '../src/migrations/0000_org_people.js'
import {
  createClient,
  createContact,
  listClientDescendants,
  reassignContact,
  rotateClientStatementKey,
  updateClient,
  type ClientChanges,
  type NewClient,
  type NewContact,
  type ClientHierarchyNode,
} from '../src/operations.js'
import { clientHierarchy, organizations } from '../src/schema.js'

interface TestDatabase {
  run(sql: string, ...params: unknown[]): Promise<void>
  rows<T>(sql: string, ...params: unknown[]): Promise<T[]>
  migrateAgain(): Promise<void>
  createClient(input: NewClient): ReturnType<typeof createClient>
  updateClient(clientId: number, input: ClientChanges): ReturnType<typeof updateClient>
  rotateClientStatementKey(
    clientId: number,
    updatedAt: string,
  ): ReturnType<typeof rotateClientStatementKey>
  createContact(input: NewContact): ReturnType<typeof createContact>
  listClientDescendants(clientId: number): Promise<ClientHierarchyNode[]>
  reassignContact(
    contactId: number,
    clientId: number,
    updatedAt: string,
  ): ReturnType<typeof reassignContact>
  close(): Promise<void>
}

const now = '2026-08-27T00:00:00.000Z'
const modules = JSON.stringify({ expenses: true, invoices: true })

const collectDiagnostics = (value: unknown): string => {
  const seen = new WeakSet<object>()
  const diagnostics: string[] = []
  const visit = (item: unknown): void => {
    if (typeof item === 'string') {
      diagnostics.push(item)
      return
    }
    if (typeof item !== 'object' || item === null) return
    if (seen.has(item)) return
    seen.add(item)
    if (item instanceof Error) diagnostics.push(item.name, item.message, item.stack ?? '')
    for (const key of Reflect.ownKeys(item)) {
      if (typeof key === 'string') diagnostics.push(key)
      const descriptor = Object.getOwnPropertyDescriptor(item, key)
      if (descriptor && 'value' in descriptor) {
        visit(descriptor.value)
      }
    }
  }
  visit(value)
  return diagnostics.join('\n')
}

const containerDatabase = (migrate = true): TestDatabase => {
  const sqlite = new BetterSqlite3(':memory:')
  if (migrate) migrateContainer(sqlite)
  const drizzle = createContainerDatabase(sqlite)
  return {
    run: async (sql, ...params) => {
      sqlite.prepare(sql).run(...params)
    },
    rows: async <T>(sql: string, ...params: unknown[]) => sqlite.prepare(sql).all(...params) as T[],
    migrateAgain: async () => migrateContainer(sqlite),
    createClient: async (input) => createClient(drizzle, input),
    updateClient: async (clientId, input) => updateClient(drizzle, clientId, input),
    rotateClientStatementKey: async (clientId, updatedAt) =>
      rotateClientStatementKey(drizzle, clientId, updatedAt),
    createContact: async (input) => createContact(drizzle, input),
    listClientDescendants: async (clientId) => listClientDescendants(drizzle, clientId),
    reassignContact: async (contactId, clientId, updatedAt) =>
      reassignContact(drizzle, contactId, clientId, updatedAt),
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
  const drizzle = createD1Database(d1)
  return {
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
    createClient: async (input) => createClient(drizzle, input),
    updateClient: async (clientId, input) => updateClient(drizzle, clientId, input),
    rotateClientStatementKey: async (clientId, updatedAt) =>
      rotateClientStatementKey(drizzle, clientId, updatedAt),
    createContact: async (input) => createContact(drizzle, input),
    listClientDescendants: async (clientId) => listClientDescendants(drizzle, clientId),
    reassignContact: async (contactId, clientId, updatedAt) =>
      reassignContact(drizzle, contactId, clientId, updatedAt),
    close: async () => miniflare.dispose(),
  }
}

const factories = [
  ['container', async (migrate = true) => containerDatabase(migrate)],
  ['D1', d1Database],
] as const

for (const [runtime, factory] of factories) {
  describe(`organization and people schema (${runtime})`, () => {
    let database: TestDatabase | undefined

    afterEach(async () => database?.close())

    const setup = async (): Promise<TestDatabase> => {
      database = await factory()
      await database.run(
        `INSERT INTO organizations (name, modules, created_at, updated_at) VALUES (?, ?, ?, ?)`,
        'Halcyon Studio',
        modules,
        now,
        now,
      )
      return database
    }

    const insertUser = async (db: TestDatabase, id: number): Promise<void> => {
      await db.run(
        `INSERT INTO users
          (id, first_name, last_name, profile, manager_grants, is_owner, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        `User${id}`,
        'Example',
        'member',
        '[]',
        0,
        now,
        now,
      )
    }

    const insertClient = async (
      db: TestDatabase,
      id: number,
      name: string,
      parentClientId: number | null = null,
      billToClientId: number | null = null,
      currency = 'USD',
    ): Promise<void> => {
      await db.run(
        `INSERT INTO clients
          (id, name, currency, parent_client_id, bill_to_client_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id,
        name,
        currency,
        parentClientId,
        billToClientId,
        now,
        now,
      )
    }

    const installLegacyFixture = async (db: TestDatabase): Promise<void> => {
      await db.run(
        `CREATE TABLE _ezacto_migrations (
          id TEXT PRIMARY KEY, applied_at TEXT NOT NULL
        ) STRICT`,
      )
      for (const statement of orgPeopleMigration) await db.run(statement)
      await db.run(
        `INSERT INTO _ezacto_migrations (id, applied_at) VALUES ('0000_org_people', ?)`,
        now,
      )
      await db.run(
        `INSERT INTO organizations (name, modules, created_at, updated_at) VALUES (?, ?, ?, ?)`,
        'Existing Halcyon Studio',
        modules,
        now,
        now,
      )
      await insertUser(db, 42)
    }

    it('[unit] rejects direct and indirect parent cycles without changing the tree', async () => {
      const db = await setup()
      await expect(insertClient(db, 1, 'Self', 1)).rejects.toThrow(/parent cycle/)

      await insertClient(db, 1, 'Ridgeline IT')
      await insertClient(db, 2, 'Kestrel Environmental', 1)
      await insertClient(db, 3, 'Kestrel North Build', 2)

      await expect(db.run(`UPDATE clients SET parent_client_id = id WHERE id = 2`)).rejects.toThrow(
        /parent cycle/,
      )
      await expect(db.run(`UPDATE clients SET parent_client_id = 3 WHERE id = 1`)).rejects.toThrow(
        /parent cycle/,
      )

      expect(
        await db.rows<{ id: number; parent_client_id: number | null }>(
          `SELECT id, parent_client_id FROM clients ORDER BY id`,
        ),
      ).toEqual([
        { id: 1, parent_client_id: null },
        { id: 2, parent_client_id: 1 },
        { id: 3, parent_client_id: 2 },
      ])
    })

    it('[unit] rolls back every row when a multi-row reparent would create a cycle', async () => {
      const db = await setup()
      await insertClient(db, 1, 'Northpeak')
      await insertClient(db, 2, 'Ridgeline IT')
      await insertClient(db, 3, 'Kestrel Environmental', 2)

      await expect(
        db.run(
          `UPDATE clients
           SET parent_client_id = CASE id WHEN 1 THEN 2 WHEN 2 THEN 3 END
           WHERE id IN (1, 2)`,
        ),
      ).rejects.toThrow(/parent cycle/)
      expect(
        await db.rows<{ id: number; parent_client_id: number | null }>(
          `SELECT id, parent_client_id FROM clients ORDER BY id`,
        ),
      ).toEqual([
        { id: 1, parent_client_id: null },
        { id: 2, parent_client_id: null },
        { id: 3, parent_client_id: 2 },
      ])
    })

    it('[unit] accepts legal forward references and rejects cyclic multi-row inserts', async () => {
      const db = await setup()
      await db.run(
        `INSERT INTO clients
          (id, name, currency, parent_client_id, created_at, updated_at)
         VALUES
          (1, 'Forward child', 'USD', 2, ?, ?),
          (2, 'Forward parent', 'USD', NULL, ?, ?)`,
        now,
        now,
        now,
        now,
      )
      expect(await db.listClientDescendants(2)).toEqual([
        { ancestorId: 2, descendantId: 2, depth: 0 },
        { ancestorId: 2, descendantId: 1, depth: 1 },
      ])

      await expect(
        db.run(
          `INSERT INTO clients
            (id, name, currency, parent_client_id, created_at, updated_at)
           VALUES
            (3, 'Cycle one', 'USD', 4, ?, ?),
            (4, 'Cycle two', 'USD', 3, ?, ?)`,
          now,
          now,
          now,
          now,
        ),
      ).rejects.toThrow(/parent cycle/)
      expect(
        await db.rows<{ count: number }>(
          `SELECT count(*) AS count FROM clients WHERE id IN (3, 4)`,
        ),
      ).toEqual([{ count: 0 }])
    })

    it('[unit] reverses a parent edge through a detached intermediate state', async () => {
      const db = await setup()
      await insertClient(db, 1, 'Ridgeline IT')
      await insertClient(db, 2, 'Kestrel Environmental', 1)

      await db.updateClient(2, { parentClientId: null, updatedAt: now })
      await db.updateClient(1, { parentClientId: 2, updatedAt: now })
      expect(await db.listClientDescendants(2)).toEqual([
        { ancestorId: 2, descendantId: 2, depth: 0 },
        { ancestorId: 2, descendantId: 1, depth: 1 },
      ])
    })

    it('[unit] derives a finite hierarchy even if legacy data contains a cycle', async () => {
      const db = await setup()
      await insertClient(db, 1, 'Ridgeline IT')
      await insertClient(db, 2, 'Kestrel Environmental', 1)
      await insertClient(db, 3, 'Kestrel North Build', 2)
      await db.run(`DROP TRIGGER clients_parent_cycle_update`)
      await db.run(`UPDATE clients SET parent_client_id = 3 WHERE id = 1`)

      const hierarchy = await db.rows<{
        ancestor_id: number
        descendant_id: number
        depth: number
      }>(
        `SELECT ancestor_id, descendant_id, depth
         FROM client_hierarchy ORDER BY ancestor_id, depth`,
      )
      expect(hierarchy).toHaveLength(9)
      expect(hierarchy.filter(({ ancestor_id }) => ancestor_id === 1)).toEqual([
        { ancestor_id: 1, descendant_id: 1, depth: 0 },
        { ancestor_id: 1, descendant_id: 2, depth: 1 },
        { ancestor_id: 1, descendant_id: 3, depth: 2 },
      ])
      expect(await db.listClientDescendants(1)).toEqual([
        { ancestorId: 1, descendantId: 1, depth: 0 },
        { ancestorId: 1, descendantId: 2, depth: 1 },
        { ancestorId: 1, descendantId: 3, depth: 2 },
      ])
    })

    it('[unit] rolls up a root plus 3 levels by currency using the derived hierarchy', async () => {
      const db = await setup()
      await insertClient(db, 1, 'Ridgeline IT')
      await insertClient(db, 2, 'Kestrel Environmental', 1)
      await insertClient(db, 3, 'Kestrel North Build', 2, null, 'EUR')
      await insertClient(db, 4, 'Kestrel North Phase Two', 3, null, 'EUR')
      await insertClient(db, 5, 'Kestrel South Build', 1)
      await insertClient(db, 6, 'Northpeak')

      expect(await db.listClientDescendants(2)).toEqual([
        { ancestorId: 2, descendantId: 2, depth: 0 },
        { ancestorId: 2, descendantId: 3, depth: 1 },
        { ancestorId: 2, descendantId: 4, depth: 2 },
      ])

      const rollup = async (ancestorId: number) =>
        db.rows<{ currency: string; amount_cents: number }>(
          `WITH RECURSIVE hierarchy(descendant_id, visited) AS (
             SELECT id, printf(',%d,', id) FROM clients WHERE id = ?
             UNION ALL
             SELECT child.id, hierarchy.visited || child.id || ','
             FROM hierarchy JOIN clients child
               ON child.parent_client_id = hierarchy.descendant_id
             WHERE instr(hierarchy.visited, printf(',%d,', child.id)) = 0
           ),
           direct_spend(client_id, currency, amount_cents) AS (
             VALUES (1, 'USD', 10000), (2, 'USD', 20000), (3, 'EUR', 30000),
                    (4, 'EUR', 40000), (5, 'USD', 50000), (6, 'USD', 60000)
           )
           SELECT spend.currency, sum(spend.amount_cents) AS amount_cents
           FROM hierarchy
           JOIN direct_spend spend ON spend.client_id = hierarchy.descendant_id
           GROUP BY spend.currency ORDER BY spend.currency`,
          ancestorId,
        )

      expect(await rollup(1)).toEqual([
        { currency: 'EUR', amount_cents: 70_000 },
        { currency: 'USD', amount_cents: 80_000 },
      ])
      expect(await rollup(2)).toEqual([
        { currency: 'EUR', amount_cents: 70_000 },
        { currency: 'USD', amount_cents: 20_000 },
      ])
      expect(await rollup(4)).toEqual([{ currency: 'EUR', amount_cents: 40_000 }])
    })

    it('[unit] keeps bill-to independent and reflects legal reparenting immediately', async () => {
      const db = await setup()
      await insertClient(db, 1, 'Ridgeline IT')
      await insertClient(db, 2, 'Kestrel Environmental', 1)
      await insertClient(db, 3, 'Northpeak')

      await db.updateClient(2, { billToClientId: 3, updatedAt: now })
      expect(
        await db.rows<{ ancestor_id: number; descendant_id: number }>(
          `SELECT ancestor_id, descendant_id FROM client_hierarchy
           WHERE descendant_id = 2 ORDER BY ancestor_id`,
        ),
      ).toEqual([
        { ancestor_id: 1, descendant_id: 2 },
        { ancestor_id: 2, descendant_id: 2 },
      ])

      await db.updateClient(2, { parentClientId: 3, updatedAt: now })
      expect(
        await db.rows<{ ancestor_id: number; descendant_id: number }>(
          `SELECT ancestor_id, descendant_id FROM client_hierarchy
           WHERE descendant_id = 2 ORDER BY ancestor_id`,
        ),
      ).toEqual([
        { ancestor_id: 2, descendant_id: 2 },
        { ancestor_id: 3, descendant_id: 2 },
      ])
      expect(
        await db.rows<{ parent_client_id: number; bill_to_client_id: number }>(
          `SELECT parent_client_id, bill_to_client_id FROM clients WHERE id = 2`,
        ),
      ).toEqual([{ parent_client_id: 3, bill_to_client_id: 3 }])
    })

    it('[unit] rejects hostile statement keys at the client operation boundary', async () => {
      const db = await setup()
      await db.run(`UPDATE organizations SET currency = 'CRC' WHERE id = 1`)
      const secret = 'harvest-client-key-must-not-survive'
      const createSnakeError = await db
        .createClient({
          name: 'Attacker supplied key',
          createdAt: now,
          updatedAt: now,
          statement_key: secret,
        } as NewClient)
        .catch((error: unknown) => error)
      expect(String(createSnakeError)).toMatch(/server-generated/)
      expect(String(createSnakeError)).not.toContain(secret)
      await expect(
        db.createClient({
          name: 'Undefined is still supplied',
          createdAt: now,
          updatedAt: now,
          statementKey: undefined,
        } as unknown as NewClient),
      ).rejects.toThrow(/server-generated/)
      expect(await db.rows<{ count: number }>(`SELECT count(*) AS count FROM clients`)).toEqual([
        { count: 0 },
      ])

      const client = await db.createClient({
        name: 'Ridgeline IT',
        createdAt: now,
        updatedAt: now,
      })
      expect(client.currency).toBe('CRC')
      expect(Object.hasOwn(client, 'statementKey')).toBe(false)
      expect(JSON.stringify(client)).not.toContain('statementKey')
      const initialKey = (
        await db.rows<{ statement_key: string }>(
          `SELECT statement_key FROM clients WHERE id = ?`,
          client.id,
        )
      )[0]!.statement_key
      expect(initialKey).toMatch(/^[0-9a-f]{64}$/)
      expect(initialKey).not.toBe(secret)
      const safeUpdate = await db.updateClient(client.id, { updatedAt: now })
      expect(Object.hasOwn(safeUpdate, 'statementKey')).toBe(false)
      expect(JSON.stringify(safeUpdate)).not.toContain('statementKey')

      const updateCamelError = await db
        .updateClient(client.id, {
          name: 'Must not be applied',
          updatedAt: now,
          statementKey: secret,
        } as ClientChanges)
        .catch((error: unknown) => error)
      expect(String(updateCamelError)).toMatch(/server-generated/)
      expect(String(updateCamelError)).not.toContain(secret)
      await expect(
        db.updateClient(client.id, {
          name: 'Also must not be applied',
          updatedAt: now,
          statement_key: undefined,
        } as unknown as ClientChanges),
      ).rejects.toThrow(/server-generated/)
      expect(
        await db.rows<{ name: string; statement_key: string }>(
          `SELECT name, statement_key FROM clients WHERE id = ?`,
          client.id,
        ),
      ).toEqual([{ name: 'Ridgeline IT', statement_key: initialKey }])

      const child = await db.createClient({
        name: 'Kestrel Environmental',
        parentClientId: client.id,
        createdAt: now,
        updatedAt: now,
      })
      expect(Object.hasOwn(child, 'statementKey')).toBe(false)
      const childKey = (
        await db.rows<{ statement_key: string }>(
          `SELECT statement_key FROM clients WHERE id = ?`,
          child.id,
        )
      )[0]!.statement_key
      const cycleError = await db
        .updateClient(client.id, {
          parentClientId: child.id,
          updatedAt: now,
        })
        .catch((error: unknown) => error)
      expect(cycleError).toBeInstanceOf(Error)
      expect(String(cycleError)).not.toContain(secret)
      expect(
        await db.rows<{ statement_key: string }>(
          `SELECT statement_key FROM clients WHERE id = ?`,
          client.id,
        ),
      ).toEqual([{ statement_key: initialKey }])

      const rotated = await db.rotateClientStatementKey(client.id, now)
      expect(rotated).toMatch(/^[0-9a-f]{64}$/)
      expect(rotated).not.toBe(initialKey)
      expect(rotated).not.toBe(childKey)

      const failedCreate = await db
        .createClient({
          name: 'Missing parent',
          parentClientId: 999,
          createdAt: now,
          updatedAt: now,
        })
        .catch((error: unknown) => error)
      expect(collectDiagnostics(failedCreate)).not.toMatch(/[0-9a-f]{64}/i)

      await db.run(
        `CREATE TRIGGER clients_insert_failure BEFORE INSERT ON clients
         BEGIN SELECT RAISE(ABORT, 'forced client insert failure'); END`,
      )
      const failedInsert = await db
        .createClient({ name: 'Must roll back', createdAt: now, updatedAt: now })
        .catch((error: unknown) => error)
      const insertDiagnostics = collectDiagnostics(failedInsert)
      expect(insertDiagnostics).not.toMatch(/[0-9a-f]{64}/i)
      expect(insertDiagnostics).not.toContain(rotated)
      expect(
        await db.rows<{ count: number }>(
          `SELECT count(*) AS count FROM clients WHERE name = 'Must roll back'`,
        ),
      ).toEqual([{ count: 0 }])

      await db.run(
        `CREATE TRIGGER clients_statement_key_failure BEFORE UPDATE OF statement_key ON clients
         BEGIN SELECT RAISE(ABORT, 'forced statement key failure'); END`,
      )
      const failedRotate = await db
        .rotateClientStatementKey(client.id, now)
        .catch((error: unknown) => error)
      const rotateDiagnostics = collectDiagnostics(failedRotate)
      expect(rotateDiagnostics).not.toMatch(/[0-9a-f]{64}/i)
      expect(rotateDiagnostics).not.toContain(rotated)
      expect(
        await db.rows<{ statement_key: string }>(
          `SELECT statement_key FROM clients WHERE id = ?`,
          client.id,
        ),
      ).toEqual([{ statement_key: rotated }])
    })

    it('[unit] enforces contact routing roles and supports client reassignment', async () => {
      const db = await setup()
      await insertClient(db, 1, 'Ridgeline IT')
      await insertClient(db, 2, 'Northpeak')

      const contact = await db.createContact({
        clientId: 1,
        firstName: 'Cleo',
        email: 'cleo@example.test',
        invoiceRecipientStatus: 'recipient',
        createdAt: now,
        updatedAt: now,
      })
      expect(contact.invoiceRecipientStatus).toBe('recipient')
      expect((await db.reassignContact(contact.id, 2, now)).clientId).toBe(2)

      const defaulted = await db.createContact({
        clientId: 2,
        firstName: 'Morgan',
        createdAt: now,
        updatedAt: now,
      })
      expect(defaulted.invoiceRecipientStatus).toBe('none')
      await expect(
        db.run(
          `INSERT INTO contacts
            (client_id, first_name, invoice_recipient_status, created_at, updated_at)
            VALUES (2, 'Invalid', 'to', ?, ?)`,
          now,
          now,
        ),
      ).rejects.toThrow(/CHECK constraint/)
      await expect(
        db.run(
          `INSERT INTO contacts (client_id, first_name, created_at, updated_at)
           VALUES (999, 'Missing client', ?, ?)`,
          now,
          now,
        ),
      ).rejects.toThrow(/FOREIGN KEY/)
      await expect(
        db.run(
          `INSERT INTO contacts (client_id, first_name, created_at, updated_at)
           VALUES (2, NULL, ?, ?)`,
          now,
          now,
        ),
      ).rejects.toThrow(/NOT NULL/)
    })

    it('[unit] [inv-08] rate insert closes the previous row and history is append-only', async () => {
      const db = await setup()
      await insertUser(db, 1)
      await db.run(
        `INSERT INTO user_billable_rates (user_id, amount_cents, start_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        1,
        10_000,
        '2026-01-01',
        now,
        now,
      )
      await db.run(
        `INSERT INTO user_billable_rates (user_id, amount_cents, start_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        1,
        12_500,
        '2026-02-01',
        now,
        now,
      )
      expect(
        await db.rows<{ amount_cents: number; start_date: string; end_date: string | null }>(
          `SELECT amount_cents, start_date, end_date FROM user_billable_rates ORDER BY start_date`,
        ),
      ).toEqual([
        { amount_cents: 10_000, start_date: '2026-01-01', end_date: '2026-01-31' },
        { amount_cents: 12_500, start_date: '2026-02-01', end_date: null },
      ])
      await expect(
        db.run(`UPDATE user_billable_rates SET amount_cents = 1 WHERE amount_cents = 12500`),
      ).rejects.toThrow(/append-only/)
      await expect(
        db.run(`DELETE FROM user_billable_rates WHERE amount_cents = 12500`),
      ).rejects.toThrow(/append-only/)
      await expect(
        db.run(
          `INSERT INTO user_billable_rates (user_id, amount_cents, start_date, end_date, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          1,
          14_000,
          '2026-03-01',
          '2030-01-01',
          now,
          now,
        ),
      ).rejects.toThrow(/derived/)
      await expect(
        db.run(`UPDATE user_billable_rates SET end_date = '2030-01-01' WHERE amount_cents = 12500`),
      ).rejects.toThrow(/append-only/)
      await db.run(
        `INSERT INTO user_cost_rates (user_id, amount_cents, start_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
        1,
        5_000,
        '2026-01-01',
        now,
        now,
      )
      await expect(
        db.run(`UPDATE user_cost_rates SET end_date = '2030-01-01' WHERE user_id = 1`),
      ).rejects.toThrow(/append-only/)
      await expect(
        db.run(
          `INSERT INTO user_cost_rates (user_id, amount_cents, start_date, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
          1,
          6_000,
          '2099-01-01',
          now,
          now,
        ),
      ).rejects.toThrow(/future/)
    })

    it('[unit] first verified address wins and invalidates pending duplicates (D19)', async () => {
      const db = await setup()
      await insertUser(db, 1)
      await insertUser(db, 2)
      for (const [id, userId, address] of [
        [1, 1, 'Ana@Example.com'],
        [2, 2, 'ana@example.com'],
      ] as const) {
        await db.run(
          `INSERT INTO user_emails (id, user_id, address, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
          id,
          userId,
          address,
          now,
          now,
        )
      }
      await db.run(`UPDATE user_emails SET verified_at = ?, updated_at = ? WHERE id = 1`, now, now)
      await db.run(`UPDATE user_emails SET verified_at = ?, updated_at = ? WHERE id = 2`, now, now)
      expect(
        await db.rows<{ id: number; verified_at: string | null; invalidated_at: string | null }>(
          `SELECT id, verified_at, invalidated_at FROM user_emails ORDER BY id`,
        ),
      ).toEqual([
        { id: 1, verified_at: now, invalidated_at: null },
        { id: 2, verified_at: null, invalidated_at: now },
      ])
      await expect(
        db.run(`UPDATE user_emails SET address = 'attacker@example.test' WHERE id = 1`),
      ).rejects.toThrow(/immutable/)
    })

    it('[unit] inserting a verified address invalidates an existing pending duplicate (D19)', async () => {
      const db = await setup()
      await insertUser(db, 1)
      await insertUser(db, 2)
      await db.run(
        `INSERT INTO user_emails (id, user_id, address, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
        1,
        1,
        'shared@example.test',
        now,
        now,
      )
      await db.run(
        `INSERT INTO user_emails
          (id, user_id, address, verified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
        2,
        2,
        'SHARED@example.test',
        now,
        now,
        now,
      )
      expect(
        await db.rows<{ id: number; invalidated_at: string | null }>(
          `SELECT id, invalidated_at FROM user_emails ORDER BY id`,
        ),
      ).toEqual([
        { id: 1, invalidated_at: now },
        { id: 2, invalidated_at: null },
      ])
    })

    it('[unit] [inv-12] exactly one owner remains enforced', async () => {
      const db = await setup()
      await insertUser(db, 1)
      await insertUser(db, 2)
      expect(
        await db.rows<{ id: number; profile: string; is_owner: number }>(
          `SELECT id, profile, is_owner FROM users ORDER BY id`,
        ),
      ).toEqual([
        { id: 1, profile: 'administrator', is_owner: 1 },
        { id: 2, profile: 'member', is_owner: 0 },
      ])
      await expect(db.run(`UPDATE users SET profile = 'member' WHERE id = 1`)).rejects.toThrow(
        /check constraint|retain an active administrator/i,
      )
      await expect(db.run(`UPDATE users SET is_owner = 1 WHERE id = 2`)).rejects.toThrow(/derived/)
      await db.run(`UPDATE organization_owner SET user_id = 2, updated_at = ? WHERE id = 1`, now)
      await db.run(`UPDATE organization_owner SET user_id = 2, updated_at = ? WHERE id = 1`, now)
      expect(
        await db.rows<{ owners: number }>(
          `SELECT count(*) AS owners FROM users WHERE is_owner = 1`,
        ),
      ).toEqual([{ owners: 1 }])
      expect(await db.rows<{ id: number }>(`SELECT id FROM users WHERE is_owner = 1`)).toEqual([
        { id: 2 },
      ])
      expect(await db.rows<{ profile: string }>(`SELECT profile FROM users WHERE id = 2`)).toEqual([
        { profile: 'administrator' },
      ])
      await expect(db.run(`UPDATE users SET profile = 'accounting' WHERE id = 2`)).rejects.toThrow(
        /check constraint/i,
      )
      await expect(db.run(`DELETE FROM users WHERE id = 2`)).rejects.toThrow(/foreign key/i)
      await expect(db.run(`DELETE FROM organization_owner WHERE id = 1`)).rejects.toThrow(
        /exactly one owner/,
      )
    })

    it('[unit] the migration exposes the complete first schema slice', async () => {
      const db = await setup()
      const tables = await db.rows<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%' ORDER BY name`,
      )
      expect(tables.map(({ name }) => name)).toEqual(
        expect.arrayContaining([
          'organizations',
          'users',
          'user_emails',
          'user_identities',
          'roles',
          'departments',
          'user_roles',
          'user_departments',
          'teammate_assignments',
          'user_billable_rates',
          'user_cost_rates',
          'clients',
          'contacts',
        ]),
      )
      expect(
        await db.rows<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'client_hierarchy'`,
        ),
      ).toEqual([{ name: 'client_hierarchy' }])
    })

    it('[unit] rejects an unknown time-rounding policy', async () => {
      const db = await setup()
      await expect(
        db.run(`UPDATE organizations SET time_rounding = 'garbage' WHERE id = 1`),
      ).rejects.toThrow(/CHECK constraint/)
      await db.run(`UPDATE organizations SET time_rounding = 'nearest_15' WHERE id = 1`)
      expect(
        await db.rows<{ time_rounding: string }>(
          `SELECT time_rounding FROM organizations WHERE id = 1`,
        ),
      ).toEqual([{ time_rounding: 'nearest_15' }])
    })

    it('[unit] upgrades a populated 0000 database and preserves data across reruns', async () => {
      database = await factory(false)
      const db = database
      await installLegacyFixture(db)

      await db.migrateAgain()
      expect(
        await db.rows<{ id: string }>(`SELECT id FROM _ezacto_migrations ORDER BY id`),
      ).toEqual(migrationIds.map((id) => ({ id })))
      expect(
        await db.rows<{ applied_at: string }>(
          `SELECT applied_at FROM _ezacto_migrations WHERE id = '0000_org_people'`,
        ),
      ).toEqual([{ applied_at: now }])
      expect(await db.rows<{ name: string }>(`SELECT name FROM organizations`)).toEqual([
        { name: 'Existing Halcyon Studio' },
      ])
      expect(
        await db.rows<{ team_enabled: number }>(
          `SELECT json_extract(modules, '$.team') AS team_enabled FROM organizations`,
        ),
      ).toEqual([{ team_enabled: 1 }])
      expect(
        await db.rows<{ id: number; first_name: string }>(
          `SELECT id, first_name FROM users WHERE id = 42`,
        ),
      ).toEqual([{ id: 42, first_name: 'User42' }])
      await insertClient(db, 1, 'Post-upgrade client')

      await db.migrateAgain()
      expect(
        await db.rows<{ id: string }>(`SELECT id FROM _ezacto_migrations ORDER BY id`),
      ).toEqual(migrationIds.map((id) => ({ id })))
      expect(
        await db.rows<{ applied_at: string }>(
          `SELECT applied_at FROM _ezacto_migrations WHERE id = '0000_org_people'`,
        ),
      ).toEqual([{ applied_at: now }])
      expect(await db.rows<{ name: string }>(`SELECT name FROM clients`)).toEqual([
        { name: 'Post-upgrade client' },
      ])
    })

    it('[unit] rolls back a failed 0001 migration and can retry cleanly', async () => {
      database = await factory(false)
      const db = database
      await installLegacyFixture(db)
      await db.run(`CREATE TABLE contacts (id INTEGER PRIMARY KEY) STRICT`)

      await expect(db.migrateAgain()).rejects.toThrow()
      expect(
        await db.rows<{ id: string }>(`SELECT id FROM _ezacto_migrations ORDER BY id`),
      ).toEqual([{ id: '0000_org_people' }])
      expect(
        await db.rows<{ name: string }>(
          `SELECT name FROM sqlite_master
           WHERE name IN ('clients', 'client_hierarchy') ORDER BY name`,
        ),
      ).toEqual([])
      expect(
        await db.rows<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'contacts'`,
        ),
      ).toEqual([{ name: 'contacts' }])

      await db.run(`DROP TABLE contacts`)
      await db.migrateAgain()
      expect(
        await db.rows<{ id: string }>(`SELECT id FROM _ezacto_migrations ORDER BY id`),
      ).toEqual(migrationIds.map((id) => ({ id })))
      expect(
        await db.rows<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('clients', 'contacts') ORDER BY name`,
        ),
      ).toEqual([{ name: 'clients' }, { name: 'contacts' }])
    })

    it('[unit] fresh migrations are ordered and idempotent', async () => {
      const db = await setup()
      await db.migrateAgain()
      expect(
        await db.rows<{ id: string }>(`SELECT id FROM _ezacto_migrations ORDER BY id`),
      ).toEqual(migrationIds.map((id) => ({ id })))
    })
  })
}

/**
 * The ids that have shipped. Every database that has ever run applies these by
 * name and records the name, so renaming one is not a rename: it is a
 * thirty-ninth migration that silently re-runs a table creation. Appending here
 * is routine; changing or reordering an existing line is the bug this guards.
 *
 * This is the one place a ledger is written out by hand. The nineteen other
 * copies this replaces were incidental — each fixture happened to need the list
 * and each went stale on its own schedule.
 */
const shippedMigrationIds = [
  '0000_org_people',
  '0001_clients',
  '0002_projects_time',
  '0003_rate_resolver',
  '0004_invoice_foundation',
  '0005_invoice_payments_totals',
  '0006_invoice_state_events',
  '0007_expenses',
  '0008_retainer_ledger',
  '0009_three_axis_state',
  '0010_recurring_invoices',
  '0011_api_tokens',
  '0012_instance_bootstrap',
  '0013_password_auth',
  '0014_sessions',
  '0015_oidc_transactions',
  '0016_email_log',
  '0017_email_delivery_details',
  '0018_estimates',
  '0019_attachments',
  '0020_argon2_passwords',
  '0021_estimate_commands',
  '0022_resource_create_commands',
  '0023_migration_import_authority',
  '0024_migration_worksheet_completions',
  '0025_time_entry_note_requirements',
  '0026_invoice_generation',
  '0027_timesheet_approvals',
  '0028_timesheet_lock_policy',
  '0029_outbox_delivery',
  '0030_email_templates',
  '0031_team_people',
  '0032_invoice_email_delivery',
  '0033_contact_portal',
  '0034_scheduled_reminders',
  '0035_backup_runs',
  '0036_client_budgets',
  '0037_recurring_generate_command',
] as const

describe('migration ledger', () => {
  // Two branches that each append a migration merge without conflict, and the
  // duplicated number is the only trace either of them left.
  it('[unit] numbers every migration exactly once and without gaps', () => {
    expect(migrationIds.map((id) => id.slice(0, 4))).toEqual(
      migrationIds.map((_, index) => String(index).padStart(4, '0')),
    )
  })

  it('[unit] never renames or reorders a migration that has already shipped', () => {
    expect(migrationIds.slice(0, shippedMigrationIds.length)).toEqual([...shippedMigrationIds])
  })
})

describe('client operation trust boundary', () => {
  it('[unit] traverses nested diagnostic parameters without looping', () => {
    const token = 'a'.repeat(64)
    const diagnostic: { cause: { params: string[] }; cycle?: unknown } = {
      cause: { params: [token] },
    }
    diagnostic.cycle = diagnostic
    expect(collectDiagnostics(diagnostic)).toContain(token)
  })

  it('[unit] rejects every statement-key spelling before touching the database', async () => {
    const untouchedDatabase = new Proxy(
      {},
      {
        get: () => {
          throw new Error('database was touched')
        },
      },
    )
    const createBase = { name: 'Blocked', createdAt: now, updatedAt: now }
    const updateBase = { updatedAt: now }

    await expect(
      createClient(
        untouchedDatabase as never,
        {
          ...createBase,
          statementKey: undefined,
        } as unknown as NewClient,
      ),
    ).rejects.toThrow(/server-generated/)
    await expect(
      createClient(
        untouchedDatabase as never,
        {
          ...createBase,
          statement_key: 'secret',
        } as NewClient,
      ),
    ).rejects.toThrow(/server-generated/)
    await expect(
      updateClient(untouchedDatabase as never, 1, {
        ...updateBase,
        statementKey: 'secret',
      } as ClientChanges),
    ).rejects.toThrow(/server-generated/)
    await expect(
      updateClient(untouchedDatabase as never, 1, {
        ...updateBase,
        statement_key: undefined,
      } as unknown as ClientChanges),
    ).rejects.toThrow(/server-generated/)
  })
})

describe('package contents', () => {
  it('[unit] packs every exported runtime and the clients migration', () => {
    const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--silent'], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
    })
    const packed = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>
    expect(packed[0]?.files.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        'dist/index.js',
        'dist/index.d.ts',
        'dist/schema.js',
        'dist/migrations/0001_clients.js',
        'dist/migrations/0002_projects_time.js',
        'dist/migrations/0003_rate_resolver.js',
        'dist/migrations/0004_invoice_foundation.js',
        'dist/migrations/0004_invoice_foundation.d.ts',
        'dist/migrations/0005_invoice_payments_totals.js',
        'dist/migrations/0005_invoice_payments_totals.d.ts',
        'dist/migrations/0009_three_axis_state.js',
        'dist/migrations/0009_three_axis_state.d.ts',
        'dist/migrations/0010_recurring_invoices.js',
        'dist/migrations/0010_recurring_invoices.d.ts',
        'dist/migrations/0011_api_tokens.js',
        'dist/migrations/0011_api_tokens.d.ts',
        'dist/migrations/0012_instance_bootstrap.js',
        'dist/migrations/0012_instance_bootstrap.d.ts',
        'dist/migrations/0013_password_auth.js',
        'dist/migrations/0013_password_auth.d.ts',
        'dist/migrations/0014_sessions.js',
        'dist/migrations/0014_sessions.d.ts',
        'dist/migrations/0015_oidc_transactions.js',
        'dist/migrations/0015_oidc_transactions.d.ts',
        'dist/migrations/0016_email_log.js',
        'dist/migrations/0016_email_log.d.ts',
        'dist/migrations/0017_email_delivery_details.js',
        'dist/migrations/0017_email_delivery_details.d.ts',
        'dist/migrations/0018_estimates.js',
        'dist/migrations/0018_estimates.d.ts',
        'dist/migrations/0019_attachments.js',
        'dist/migrations/0019_attachments.d.ts',
        'dist/migrations/0020_argon2_passwords.js',
        'dist/migrations/0020_argon2_passwords.d.ts',
        'dist/migrations/0021_estimate_commands.js',
        'dist/migrations/0021_estimate_commands.d.ts',
        'dist/migrations/0022_resource_create_commands.js',
        'dist/migrations/0022_resource_create_commands.d.ts',
        'dist/migrations/0023_migration_import_authority.js',
        'dist/migrations/0023_migration_import_authority.d.ts',
        'dist/migrations/0024_migration_worksheet_completions.js',
        'dist/migrations/0024_migration_worksheet_completions.d.ts',
        'dist/migrations/0025_time_entry_note_requirements.js',
        'dist/migrations/0025_time_entry_note_requirements.d.ts',
        'dist/migrations/0026_invoice_generation.js',
        'dist/migrations/0026_invoice_generation.d.ts',
        'dist/migrations/0027_timesheet_approvals.js',
        'dist/migrations/0027_timesheet_approvals.d.ts',
        'dist/migrations/0028_timesheet_lock_policy.js',
        'dist/migrations/0028_timesheet_lock_policy.d.ts',
        'dist/migrations/0030_email_templates.js',
        'dist/migrations/0030_email_templates.d.ts',
        'dist/migrations/0032_invoice_email_delivery.js',
        'dist/migrations/0033_contact_portal.js',
        'dist/migrations/0032_invoice_email_delivery.d.ts',
        'dist/migrations/0033_contact_portal.d.ts',
        'dist/migrations/0032_invoice_email_delivery.d.ts',
        'dist/migrations/0034_scheduled_reminders.js',
        'dist/migrations/0034_scheduled_reminders.d.ts',
        'dist/migrations/0035_backup_runs.js',
        'dist/migrations/0035_backup_runs.d.ts',
        'dist/migrations/0036_client_budgets.js',
        'dist/migrations/0036_client_budgets.d.ts',
        'dist/migrations/0037_recurring_generate_command.js',
        'dist/migrations/0037_recurring_generate_command.d.ts',
        'dist/email-configuration.js',
        'dist/email-configuration.d.ts',
        'dist/migrations/0029_outbox_delivery.js',
        'dist/migrations/0029_outbox_delivery.d.ts',
        'dist/migrations/0031_team_people.js',
        'dist/migrations/0031_team_people.d.ts',
        'dist/outbox.js',
        'dist/outbox.d.ts',
        'dist/team.js',
        'dist/team.d.ts',
        'dist/timesheet-approvals.js',
        'dist/timesheet-approvals.d.ts',
        'dist/timesheet-lock-policy.js',
        'dist/timesheet-lock-policy.d.ts',
        'dist/invoice-generation.js',
        'dist/invoice-generation.d.ts',
        'dist/attachments.js',
        'dist/attachments.d.ts',
        'dist/estimates.js',
        'dist/estimates.d.ts',
        'dist/instance-bootstrap.js',
        'dist/instance-bootstrap.d.ts',
        'dist/oidc-transactions.js',
        'dist/oidc-transactions.d.ts',
        'dist/invoice-payments.js',
        'dist/invoice-payments.d.ts',
        'dist/rate-resolver.js',
        'dist/recurring-invoices.js',
        'dist/recurring-invoices.d.ts',
        'dist/tracked-state.js',
        'dist/tracked-state.d.ts',
      ]),
    )
  }, 30_000)
})

describe('Drizzle adapters', () => {
  it('[unit] query the shared schema through the container adapter', async () => {
    const sqlite = new BetterSqlite3(':memory:')
    try {
      migrateContainer(sqlite)
      const database = createContainerDatabase(sqlite)
      await database.insert(organizations).values({
        name: 'Halcyon Studio',
        modules: { expenses: true },
        createdAt: now,
        updatedAt: now,
      })
      expect((await database.select().from(organizations))[0]?.name).toBe('Halcyon Studio')
      const client = await createClient(database, {
        name: 'Ridgeline IT',
        createdAt: now,
        updatedAt: now,
      })
      expect(await database.select().from(clientHierarchy)).toEqual([
        { ancestorId: client.id, descendantId: client.id, depth: 0 },
      ])
    } finally {
      sqlite.close()
    }
  })

  it('[unit] query the shared schema through the D1 adapter', async () => {
    const miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: ['DB'],
    })
    try {
      const d1 = await miniflare.getD1Database('DB')
      await migrateD1(d1)
      const database = createD1Database(d1)
      await database.insert(organizations).values({
        name: 'Halcyon Studio',
        modules: { expenses: true },
        createdAt: now,
        updatedAt: now,
      })
      expect((await database.select().from(organizations))[0]?.name).toBe('Halcyon Studio')
      const client = await createClient(database, {
        name: 'Ridgeline IT',
        createdAt: now,
        updatedAt: now,
      })
      expect(await database.select().from(clientHierarchy)).toEqual([
        { ancestorId: client.id, descendantId: client.id, depth: 0 },
      ])
    } finally {
      await miniflare.dispose()
    }
  })

  it('[unit] enables foreign keys whenever a container connection is adapted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezacto-db-'))
    const path = join(directory, 'org.sqlite')
    const first = new BetterSqlite3(path)
    migrateContainer(first)
    first.close()
    const reopened = new BetterSqlite3(path)
    try {
      createContainerDatabase(reopened)
      expect(reopened.pragma('foreign_keys', { simple: true })).toBe(1)
      expect(() =>
        reopened
          .prepare(
            `INSERT INTO user_emails (user_id, address, created_at, updated_at) VALUES (999, ?, ?, ?)`,
          )
          .run('nobody@example.test', now, now),
      ).toThrow(/FOREIGN KEY/)
    } finally {
      reopened.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

