import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertStaticRecurringAttachmentPolicy,
  createAttachmentStore,
  sha256ContentHash,
  type AttachmentDatabase,
  type AttachmentMetadataInput,
} from '../src/attachments.js'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import {
  invoiceLifecycleMigration,
  migrateContainer,
  migrateD1,
  migrationIds,
} from '../src/migrate.js'
import { orgPeopleMigration } from '../src/migrations/0000_org_people.js'
import { clientsMigration } from '../src/migrations/0001_clients.js'
import { projectsTimeMigration } from '../src/migrations/0002_projects_time.js'
import { rateResolverMigration } from '../src/migrations/0003_rate_resolver.js'
import { invoiceFoundationMigration } from '../src/migrations/0004_invoice_foundation.js'
import { invoicePaymentsTotalsMigration } from '../src/migrations/0005_invoice_payments_totals.js'
import { expensesMigration } from '../src/migrations/0007_expenses.js'
import { retainerLedgerMigration } from '../src/migrations/0008_retainer_ledger.js'
import { threeAxisStateMigration } from '../src/migrations/0009_three_axis_state.js'
import { recurringInvoicesMigration } from '../src/migrations/0010_recurring_invoices.js'
import { apiTokensMigration } from '../src/migrations/0011_api_tokens.js'
import { instanceBootstrapMigration } from '../src/migrations/0012_instance_bootstrap.js'
import { passwordAuthMigration } from '../src/migrations/0013_password_auth.js'
import { sessionsMigration } from '../src/migrations/0014_sessions.js'
import { oidcTransactionsMigration } from '../src/migrations/0015_oidc_transactions.js'
import { emailLogMigration } from '../src/migrations/0016_email_log.js'
import { emailDeliveryDetailsMigration } from '../src/migrations/0017_email_delivery_details.js'
import { estimatesMigration } from '../src/migrations/0018_estimates.js'

interface TestDatabase {
  orm: AttachmentDatabase
  run(sql: string, ...params: unknown[]): Promise<void>
  rows<T>(sql: string, ...params: unknown[]): Promise<T[]>
  migrateAgain(): Promise<void>
  close(): Promise<void>
}

interface HarvestExpenseFixture {
  id: number
  receipt: {
    file_name: string
    file_size: number
    content_type: string
  }
}

const timestamp = '2026-08-28T12:00:00.000Z'
const laterTimestamp = '2026-08-28T12:01:00.000Z'
const migrationsThrough0018 = [
  ['0000_org_people', orgPeopleMigration],
  ['0001_clients', clientsMigration],
  ['0002_projects_time', projectsTimeMigration],
  ['0003_rate_resolver', rateResolverMigration],
  ['0004_invoice_foundation', invoiceFoundationMigration],
  ['0005_invoice_payments_totals', invoicePaymentsTotalsMigration],
  ['0006_invoice_state_events', invoiceLifecycleMigration],
  ['0007_expenses', expensesMigration],
  ['0008_retainer_ledger', retainerLedgerMigration],
  ['0009_three_axis_state', threeAxisStateMigration],
  ['0010_recurring_invoices', recurringInvoicesMigration],
  ['0011_api_tokens', apiTokensMigration],
  ['0012_instance_bootstrap', instanceBootstrapMigration],
  ['0013_password_auth', passwordAuthMigration],
  ['0014_sessions', sessionsMigration],
  ['0015_oidc_transactions', oidcTransactionsMigration],
  ['0016_email_log', emailLogMigration],
  ['0017_email_delivery_details', emailDeliveryDetailsMigration],
  ['0018_estimates', estimatesMigration],
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

const installThrough0018 = async (database: TestDatabase): Promise<void> => {
  await database.run(
    `CREATE TABLE _ezacto_migrations (
      id TEXT PRIMARY KEY, applied_at TEXT NOT NULL
    ) STRICT`,
  )
  for (const [id, statements] of migrationsThrough0018) {
    for (const statement of statements) await database.run(statement)
    await database.run(
      `INSERT INTO _ezacto_migrations (id, applied_at) VALUES (?, ?)`,
      id,
      timestamp,
    )
  }
}

const fixedAmountConfig = JSON.stringify({
  schema_version: 1,
  type: 'fixed_lines',
  line_items: [
    {
      kind: 'Service',
      description: 'Sanitized monthly service',
      quantity: 1,
      unit_price_cents: 125_000,
      taxed: false,
      taxed2: false,
      project_id: null,
    },
  ],
})

const seedParents = async (database: TestDatabase): Promise<void> => {
  await database.run(
    `INSERT INTO organizations (name, modules, created_at, updated_at)
     VALUES ('Sanitized Organization', '{"invoices":true,"expenses":true}', ?, ?)`,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO users (id, harvest_id, first_name, last_name, manager_grants, created_at, updated_at)
     VALUES (1, 1782959, 'Expense', 'Owner', '[]', ?, ?),
            (2, NULL, 'Attachment', 'Uploader', '[]', ?, ?)`,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO clients (id, harvest_id, name, currency, created_at, updated_at)
     VALUES (1, 5735776, 'Sanitized Client', 'USD', ?, ?)`,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO projects (id, harvest_id, client_id, name, code, created_at, updated_at)
     VALUES (1, 14308069, 1, 'Migration', 'MIG', ?, ?)`,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO invoices
      (id, harvest_id, client_id, number, currency, issue_date, due_date, created_at, updated_at)
     VALUES (1, 12000001, 1, 'INV-ATTACHMENT', 'USD', '2026-08-28', '2026-09-28', ?, ?)`,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO recurring_invoices (
      id, client_id, subject_template, notes_template, every_n_months,
      day_of_month, next_issue_on, amount_config, created_at, updated_at
    ) VALUES (1, 1, 'Sanitized recurring services', '', 1, 28, '2026-09-28', ?, ?, ?)`,
    fixedAmountConfig,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO estimates (id, client_id, number, currency, issue_date, created_at, updated_at)
     VALUES (1, 1, 'EST-ATTACHMENT', 'USD', '2026-08-28', ?, ?)`,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO expense_categories (id, name, created_at, updated_at)
     VALUES (1, 'Sanitized Mileage', ?, ?)`,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO expenses (
      id, user_id, project_id, expense_category_id, spent_date,
      total_cost_cents, created_at, updated_at
    ) VALUES (152975211, 1, 1, 1, '2026-08-15', 8125, ?, ?)`,
    timestamp,
    timestamp,
  )
}

const metadata = (
  digit: string,
  overrides: Partial<AttachmentMetadataInput> = {},
): AttachmentMetadataInput => ({
  contentHash: digit.repeat(64),
  fileKey: `attachments/${digit.repeat(64)}`,
  byteSize: 51,
  contentType: 'application/pdf',
  name: `sanitized-${digit}.pdf`,
  uploadedByUserId: 2,
  createdAt: timestamp,
  updatedAt: timestamp,
  ...overrides,
})

for (const [runtime, factory] of factories) {
  describe(`attachment schema (${runtime})`, () => {
    let database: TestDatabase | undefined

    afterEach(async () => database?.close())

    it('[unit] installs the complete 0019 schema and remains idempotent', async () => {
      database = await factory()
      const db = database
      const before = await db.rows<{ id: string }>(`SELECT id FROM _ezacto_migrations ORDER BY id`)
      expect(before.at(-1)).toEqual({ id: migrationIds.at(-1) })
      await db.migrateAgain()
      expect(await db.rows(`SELECT id FROM _ezacto_migrations ORDER BY id`)).toEqual(before)

      const tables = await db.rows<{ name: string }>(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN (
           'file_objects','attachments','invoice_attachments',
           'recurring_invoice_attachments','estimate_attachments',
           'expense_attachments','project_attachments'
         ) ORDER BY name`,
      )
      expect(tables.map(({ name }) => name)).toEqual([
        'attachments',
        'estimate_attachments',
        'expense_attachments',
        'file_objects',
        'invoice_attachments',
        'project_attachments',
        'recurring_invoice_attachments',
      ])
      expect(
        (await db.rows<{ name: string }>(`PRAGMA table_info(recurring_invoices)`)).map(
          ({ name }) => name,
        ),
      ).toContain('attachment_policy')
      for (const [table, parent] of [
        ['invoice_attachments', 'invoices'],
        ['recurring_invoice_attachments', 'recurring_invoices'],
        ['estimate_attachments', 'estimates'],
        ['expense_attachments', 'expenses'],
        ['project_attachments', 'projects'],
      ]) {
        const references = await db.rows<{ table: string }>(`PRAGMA foreign_key_list(${table})`)
        expect(references.map(({ table: referenced }) => referenced)).toEqual(
          expect.arrayContaining(['attachments', parent]),
        )
      }
      expect(await db.rows(`PRAGMA foreign_key_check`)).toEqual([])
    })

    it('[security] commits one real owner, deduplicates bytes, and scopes every read', async () => {
      database = await factory()
      const db = database
      await seedParents(db)
      const store = createAttachmentStore(db.orm)
      const invoice = await store.createInvoiceAttachment({ invoiceId: 1, ...metadata('a') })
      const recurring = await store.createRecurringInvoiceAttachment({
        recurringInvoiceId: 1,
        ...metadata('b'),
      })
      const estimate = await store.createEstimateAttachment({ estimateId: 1, ...metadata('c') })
      const expense = await store.createExpenseAttachment({
        expenseId: 152975211,
        ...metadata('a', { name: 'same-content-expense.pdf' }),
      })
      const project = await store.createProjectAttachment({ projectId: 1, ...metadata('d') })
      const [racedFirst, racedSecond] = await Promise.all([
        store.createProjectAttachment({
          projectId: 1,
          ...metadata('8', { name: 'concurrent-first.pdf' }),
        }),
        store.createProjectAttachment({
          projectId: 1,
          ...metadata('8', { name: 'concurrent-second.pdf' }),
        }),
      ])

      expect(invoice.fileObjectId).toBe(expense.fileObjectId)
      expect(invoice.id).not.toBe(expense.id)
      expect(racedFirst.fileObjectId).toBe(racedSecond.fileObjectId)
      expect(racedFirst.id).not.toBe(racedSecond.id)
      expect(await db.rows(`SELECT count(*) AS count FROM file_objects`)).toEqual([{ count: 5 }])
      expect(await db.rows(`SELECT count(*) AS count FROM attachments`)).toEqual([{ count: 7 }])
      expect(await store.listInvoiceAttachments(1)).toEqual([invoice])
      expect(await store.listRecurringInvoiceAttachments(1)).toEqual([recurring])
      expect(await store.listEstimateAttachments(1)).toEqual([estimate])
      expect(await store.listExpenseAttachments(152975211)).toEqual([expense])
      expect(await store.listProjectAttachments(1)).toEqual([project, racedFirst, racedSecond])
      expect(await store.getExpenseAttachment(152975211, invoice.id)).toBeNull()
      expect(await store.getInvoiceAttachment(1, expense.id)).toBeNull()

      const ownerCounts = await db.rows<{ id: number; owner_count: number }>(
        `SELECT attachment.id,
          (invoice.attachment_id IS NOT NULL)
          + (recurring.attachment_id IS NOT NULL)
          + (estimate.attachment_id IS NOT NULL)
          + (expense.attachment_id IS NOT NULL)
          + (project.attachment_id IS NOT NULL) AS owner_count
         FROM attachments attachment
         LEFT JOIN invoice_attachments invoice ON invoice.attachment_id = attachment.id
         LEFT JOIN recurring_invoice_attachments recurring ON recurring.attachment_id = attachment.id
         LEFT JOIN estimate_attachments estimate ON estimate.attachment_id = attachment.id
         LEFT JOIN expense_attachments expense ON expense.attachment_id = attachment.id
         LEFT JOIN project_attachments project ON project.attachment_id = attachment.id
         ORDER BY attachment.id`,
      )
      expect(ownerCounts).toEqual(
        [invoice, recurring, estimate, expense, project, racedFirst, racedSecond]
          .map(({ id }) => ({ id, owner_count: 1 }))
          .sort((left, right) => left.id - right.id),
      )

      await expect(
        store.createProjectAttachment({ projectId: 999, ...metadata('e') }),
      ).rejects.toThrow()
      expect(
        await db.rows(
          `SELECT count(*) AS count FROM file_objects WHERE content_hash = ?`,
          'e'.repeat(64),
        ),
      ).toEqual([{ count: 0 }])
      expect(
        await db.rows(`SELECT count(*) AS count FROM attachments WHERE name = 'sanitized-e.pdf'`),
      ).toEqual([{ count: 0 }])
      await expect(
        store.createProjectAttachment({
          projectId: 1,
          ...metadata('a', { fileKey: 'attachments/conflicting-key' }),
        }),
      ).rejects.toThrow()

      await expect(
        db.run(
          `INSERT INTO attachments (
            id, file_object_id, name, created_at, updated_at
           ) VALUES (100, ?, 'ownerless.pdf', ?, ?)`,
          invoice.fileObjectId,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow()
      await expect(
        db.run(
          `INSERT INTO attachments (
            id, file_object_id, name, invoice_attachment_link_id,
            project_attachment_link_id, created_at, updated_at
           ) VALUES (101, ?, 'multiple.pdf', 101, 101, ?, ?)`,
          invoice.fileObjectId,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow()
      await expect(
        db.run(
          `INSERT INTO project_attachments (attachment_id, project_id) VALUES (?, 1)`,
          invoice.id,
        ),
      ).rejects.toThrow()

      await db.run(
        `INSERT INTO file_objects (
          id, content_hash, file_key, byte_size, content_type, created_at, updated_at
        ) VALUES (900, ?, 'attachments/unreferenced-original', 9, 'text/plain', ?, ?)`,
        '9'.repeat(64),
        timestamp,
        timestamp,
      )
      for (const [id, hash, key] of [
        [901, '9'.repeat(64), 'attachments/replaced-by-hash'],
        [900, '6'.repeat(64), 'attachments/replaced-by-id'],
        [902, '5'.repeat(64), 'attachments/unreferenced-original'],
      ] as const) {
        await expect(
          db.run(
            `INSERT OR REPLACE INTO file_objects (
              id, content_hash, file_key, byte_size, content_type, created_at, updated_at
            ) VALUES (?, ?, ?, 999, 'application/octet-stream', ?, ?)`,
            id,
            hash,
            key,
            laterTimestamp,
            laterTimestamp,
          ),
        ).rejects.toThrow(/identity already exists|constraint/i)
      }
      await expect(
        db.run(
          `INSERT OR REPLACE INTO file_objects (
            id, content_hash, file_key, byte_size, content_type, created_at, updated_at
          ) VALUES (?, ?, 'attachments/referenced-replacement', 999,
            'application/octet-stream', ?, ?)`,
          invoice.fileObjectId,
          '4'.repeat(64),
          laterTimestamp,
          laterTimestamp,
        ),
      ).rejects.toThrow(/identity already exists|constraint/i)
      expect(
        await db.rows(
          `SELECT id, content_hash, file_key, byte_size, content_type, created_at, updated_at
           FROM file_objects WHERE id = 900`,
        ),
      ).toEqual([
        {
          id: 900,
          content_hash: '9'.repeat(64),
          file_key: 'attachments/unreferenced-original',
          byte_size: 9,
          content_type: 'text/plain',
          created_at: timestamp,
          updated_at: timestamp,
        },
      ])
      expect(await store.getInvoiceAttachment(1, invoice.id)).toEqual(invoice)

      await db.run(`DELETE FROM users WHERE id = 2`)
      expect(await store.getInvoiceAttachment(1, invoice.id)).toMatchObject({
        uploadedByUserId: null,
      })
      expect(await db.rows(`PRAGMA foreign_key_check`)).toEqual([])
    })

    it('[security] durably replays attachment creates and rejects changed command input', async () => {
      database = await factory()
      const db = database
      await seedParents(db)
      const store = createAttachmentStore(db.orm)
      const input = {
        projectId: 1,
        attachmentId: 400_001,
        commandId: 'project-attachment-stable',
        actorUserId: 2,
        ...metadata('4'),
      }
      const [first, raced] = await Promise.all([
        store.createProjectAttachment(input),
        store.createProjectAttachment(input),
      ])
      expect(raced).toEqual(first)
      const replay = await store.createProjectAttachment({
        ...input,
        createdAt: laterTimestamp,
        updatedAt: laterTimestamp,
      })
      expect(replay).toEqual(first)
      await expect(
        store.createProjectAttachment({ ...input, name: 'changed-name.pdf' }),
      ).rejects.toThrow(/command id was reused/i)
      expect(await db.rows(`SELECT count(*) AS count FROM attachments`)).toEqual([{ count: 1 }])
      expect(await db.rows(`SELECT count(*) AS count FROM resource_create_commands`)).toEqual([
        { count: 1 },
      ])
      const [receipt] = await db.rows<{
        command_kind: string
        command_id: string
        input_fingerprint: string
        actor_user_id: number
        resource_id: number
        result_json: string
        occurred_at: string
      }>(`SELECT * FROM resource_create_commands`)
      if (receipt === undefined) throw new Error('attachment receipt fixture is missing')
      await expect(
        db.run(
          `INSERT OR REPLACE INTO resource_create_commands (
            command_kind, command_id, input_fingerprint, actor_user_id,
            resource_id, result_json, occurred_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          receipt.command_kind,
          receipt.command_id,
          `sha256:${'f'.repeat(64)}`,
          receipt.actor_user_id,
          receipt.resource_id,
          receipt.result_json,
          receipt.occurred_at,
        ),
      ).rejects.toThrow(/identity already exists/)
      await expect(
        db.run(
          `UPDATE resource_create_commands SET result_json = result_json
           WHERE command_kind = 'project_attachment.create' AND command_id = ?`,
          input.commandId,
        ),
      ).rejects.toThrow(/immutable/)
      await expect(
        db.run(
          `DELETE FROM resource_create_commands
           WHERE command_kind = 'project_attachment.create' AND command_id = ?`,
          input.commandId,
        ),
      ).rejects.toThrow(/append-only/)

      await db.run(
        `CREATE TRIGGER force_attachment_receipt_failure
         BEFORE INSERT ON resource_create_commands
         WHEN NEW.command_id = 'forced-attachment-receipt-failure'
         BEGIN SELECT RAISE(ABORT, 'forced attachment receipt failure'); END`,
      )
      await expect(
        store.createProjectAttachment({
          projectId: 1,
          attachmentId: 400_002,
          commandId: 'forced-attachment-receipt-failure',
          actorUserId: 2,
          ...metadata('3'),
        }),
      ).rejects.toThrow(/forced attachment receipt failure/)
      expect(
        await db.rows(
          `SELECT count(*) AS count FROM file_objects WHERE content_hash = ?`,
          '3'.repeat(64),
        ),
      ).toEqual([{ count: 0 }])
      expect(await db.rows(`SELECT count(*) AS count FROM attachments WHERE id = 400002`)).toEqual([
        { count: 0 },
      ])
    })

    it('[unit] accepts only closed v1 static recurring policies owned by the definition', async () => {
      database = await factory()
      const db = database
      await seedParents(db)
      const store = createAttachmentStore(db.orm)
      const owned = await store.createRecurringInvoiceAttachment({
        recurringInvoiceId: 1,
        ...metadata('f', { uploadedByUserId: null }),
      })
      const invoice = await store.createInvoiceAttachment({ invoiceId: 1, ...metadata('7') })

      const policy = {
        schema_version: 1 as const,
        type: 'static' as const,
        attachment_ids: [owned.id],
      }
      assertStaticRecurringAttachmentPolicy(policy)
      await store.setRecurringInvoiceAttachmentPolicy(1, policy, laterTimestamp)
      expect(
        await db.rows(`SELECT attachment_policy FROM recurring_invoices WHERE id = 1`),
      ).toEqual([{ attachment_policy: JSON.stringify(policy) }])

      for (const invalid of [
        { schema_version: 2, type: 'static', attachment_ids: [owned.id] },
        { schema_version: 1, type: 'generated_report', attachment_ids: [owned.id] },
        { schema_version: 1, type: 'static', attachment_ids: [] },
        { schema_version: 1, type: 'static', attachment_ids: [owned.id, owned.id] },
        { schema_version: 1, type: 'static', attachment_ids: [owned.id], future: true },
      ]) {
        await expect(
          store.setRecurringInvoiceAttachmentPolicy(1, invalid as never, laterTimestamp),
        ).rejects.toThrow()
      }
      await expect(
        db.run(
          `UPDATE recurring_invoices SET attachment_policy = ? WHERE id = 1`,
          JSON.stringify({ schema_version: 1, type: 'static', attachment_ids: [invoice.id] }),
        ),
      ).rejects.toThrow()
      await expect(db.run(`DELETE FROM attachments WHERE id = ?`, owned.id)).rejects.toThrow(
        /static policy|constraint/i,
      )
      await store.setRecurringInvoiceAttachmentPolicy(1, null, laterTimestamp)
      await db.run(`DELETE FROM attachments WHERE id = ?`, owned.id)
      expect(await store.getRecurringInvoiceAttachment(1, owned.id)).toBeNull()
      expect(await db.rows(`PRAGMA foreign_key_check`)).toEqual([])
    })

    it('[unit] upgrades populated 0018 data and rolls back a failed 0019 atomically', async () => {
      database = await factory(false)
      const db = database
      await installThrough0018(db)
      await seedParents(db)
      const before = await db.rows(`SELECT id, number FROM invoices`)

      await db.run(`CREATE TABLE file_objects (id INTEGER PRIMARY KEY) STRICT`)
      await expect(db.migrateAgain()).rejects.toThrow()
      expect(
        await db.rows<{ id: string }>(`SELECT id FROM _ezacto_migrations ORDER BY id DESC LIMIT 1`),
      ).toEqual([{ id: '0018_estimates' }])
      expect(
        await db.rows<{ name: string }>(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name IN ('attachments','file_objects') ORDER BY name`,
        ),
      ).toEqual([{ name: 'file_objects' }])
      expect(
        (await db.rows<{ name: string }>(`PRAGMA table_info(recurring_invoices)`)).map(
          ({ name }) => name,
        ),
      ).not.toContain('attachment_policy')

      await db.run(`DROP TABLE file_objects`)
      await db.migrateAgain()
      expect(await db.rows(`SELECT id, number FROM invoices`)).toEqual(before)
      expect(
        await db.rows<{ id: string }>(`SELECT id FROM _ezacto_migrations ORDER BY id DESC LIMIT 1`),
      ).toEqual([{ id: migrationIds.at(-1) }])
      await db.migrateAgain()
      expect(await db.rows(`SELECT id, number FROM invoices`)).toEqual(before)
      expect(await db.rows(`PRAGMA foreign_key_check`)).toEqual([])
    })

    it('[unit] imports a Harvest receipt as an expense-owned shared attachment', async () => {
      database = await factory()
      const db = database
      await seedParents(db)
      const fixture = JSON.parse(
        await readFile(new URL('fixtures/harvest-expense.json', import.meta.url), 'utf8'),
      ) as HarvestExpenseFixture
      const bytes = await readFile(new URL('fixtures/harvest-receipt.pdf', import.meta.url))
      const hash = await sha256ContentHash(bytes)
      expect(bytes.byteLength).toBe(fixture.receipt.file_size)
      expect(hash).toBe('eadef7418e14af08d4dab416d408d94121199f49e60eed1caa7a6bec3b16ebe0')

      const stored = await createAttachmentStore(db.orm).createExpenseAttachment({
        expenseId: fixture.id,
        contentHash: hash,
        fileKey: `receipts/${hash}.pdf`,
        byteSize: bytes.byteLength,
        contentType: fixture.receipt.content_type,
        name: fixture.receipt.file_name,
        uploadedByUserId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      expect(stored).toMatchObject({
        contentHash: hash,
        byteSize: fixture.receipt.file_size,
        contentType: fixture.receipt.content_type,
        name: fixture.receipt.file_name,
        uploadedByUserId: null,
      })
      expect(
        (await db.rows<{ name: string }>(`PRAGMA table_info(expenses)`)).map(({ name }) => name),
      ).not.toContain('receipt_id')
      expect(
        await db.rows(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'receipts'`),
      ).toEqual([])
      expect(await db.rows(`PRAGMA foreign_key_check`)).toEqual([])
    })
  })
}
