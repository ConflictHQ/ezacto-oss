/**
 * Scrub the demo and build it again.
 *
 * ezacto.io is public and signed into with credentials printed on its own
 * front page, so whatever a visitor does to it has to stop mattering by the
 * next morning. That is what this is: empty every table, and lay down a fresh
 * three years of invented work anchored to today.
 *
 * Three things are deliberate.
 *
 * The wipe lifts the triggers and puts them back. Every table here is defended
 * by triggers that refuse a write without its command row -- exactly what you
 * want of a book of account, and exactly wrong for a wipe. So the wipe reads
 * their definitions out of `sqlite_master`, drops them, empties the tables,
 * and recreates them from the SQL it read. Nothing is hand-listed, so a
 * migration that adds a trigger is covered by the wipe the day it lands.
 *
 * It empties rather than drops. Dropping is the obvious move and it does not
 * work: this schema has reference cycles, and SQLite refuses to drop a table
 * whose foreign-key parent has already gone, so no drop order exists. Deleting
 * inside one transaction with `defer_foreign_keys` has no such problem -- every
 * table still exists while the deletes run, and by the commit they are all
 * empty. It also leaves the migration ledger applied, which is the point:
 * the demo is rebuilt, not reinstalled.
 *
 * It rebuilds through the real services. The invoices are produced by
 * `createInvoiceGenerationService`, sent by `executeInvoiceLifecycleCommand`
 * and paid by `recordInvoicePayment` -- the same three paths a person clicking
 * the demo uses. A seed that reached past them could show a book of account
 * that the product itself could never have produced.
 *
 * Nothing here decides whether it is allowed to run. The caller does, and the
 * only caller that should is one that has checked it is not in production.
 */

import type BetterSqlite3 from 'better-sqlite3'
import * as schema from './schema.js'
import { hashPassword } from '@ezacto/core'
import { drizzle } from 'drizzle-orm/d1'
import {
  demoAccounts,
  demoClientProjects,
  demoSeedStatements,
  type DemoSeedStatement,
} from './demo-seed.js'
import {
  bootstrapInstanceContainer,
  bootstrapInstanceD1,
  enrollInstanceOwnerPasswordContainer,
  enrollInstanceOwnerPasswordD1,
  type InstanceBootstrapInput,
  type InstanceOwnerPasswordInput,
} from './instance-bootstrap.js'
import {
  createInvoiceGenerationService,
  InvoiceGenerationError,
  type InvoiceGenerationDatabase,
} from './invoice-generation.js'
import { executeInvoiceLifecycleCommand, recordInvoicePayment } from './invoice-state.js'
import { migrateD1 } from './migrate.js'

/** The demo organisation. Fake, and named so a reader can tell at a glance. */
export const DEMO_ORGANIZATION_NAME = 'Folding Forks (Fake)'

export interface DemoResetOptions {
  /** ISO instant the rebuilt demo is anchored to. */
  readonly now: string
  /** Years of history. Three unless a caller has a reason. */
  readonly years?: number
  /**
   * Spelled out at every call site, because the first thing this does is drop
   * every table. A boolean would read as a flag; this reads as a decision.
   */
  readonly confirm: 'wipe-and-reload'
}

export interface DemoWipeSummary {
  readonly clearedTables: number
  readonly restoredTriggers: number
  readonly seedStatements: number
}

export interface DemoBillingSummary {
  readonly billed: number
  readonly paid: number
  /** Client-months still to bill. Zero means the demo is complete. */
  readonly remaining: number
}

export type DemoResetSummary = DemoWipeSummary & DemoBillingSummary

export interface DemoSchemaObjects {
  /** Name and defining SQL, because the wipe puts each one back verbatim. */
  readonly triggers: readonly { name: string; sql: string }[]
  readonly tables: readonly string[]
}

/**
 * What a reset needs of a database, and nothing more. The two drivers below
 * are the whole of the runtime-specific part.
 */
export interface DemoResetDriver {
  readonly orm: InvoiceGenerationDatabase
  schemaObjects(): Promise<DemoSchemaObjects>
  readRows<T>(sql: string): Promise<readonly T[]>
  execute(statements: readonly DemoSeedStatement[]): Promise<void>
  /** One transaction, which is what makes `defer_foreign_keys` mean anything. */
  executeAtomic(statements: readonly DemoSeedStatement[]): Promise<void>
  bootstrap(input: InstanceBootstrapInput, now: string): Promise<unknown>
  enrollOwnerPassword(input: InstanceOwnerPasswordInput, now: string): Promise<unknown>
  migrate(): Promise<void>
}

const quoted = (name: string): string => `"${name.replace(/"/g, '""')}"`

/**
 * `PRAGMA` is not a prepared statement in better-sqlite3, and `CREATE TRIGGER`
 * carries its own `BEGIN ... END`, which `prepare` will not take either.
 */
const runAll = (
  database: BetterSqlite3.Database,
  statements: readonly DemoSeedStatement[],
): void => {
  for (const statement of statements) {
    if (statement.text.startsWith('PRAGMA ')) {
      database.pragma(statement.text.slice('PRAGMA '.length))
      continue
    }
    if (statement.bindings.length === 0) {
      database.exec(statement.text)
      continue
    }
    database.prepare(statement.text).run(...statement.bindings)
  }
}

/**
 * Tables the migration ledger fills, which a wipe must leave alone. They hold
 * schema, not books: the applied-migration list, the invoice number counter,
 * and the built-in email templates. Emptying them does not reset the demo, it
 * breaks the install -- an empty `_ezacto_migrations` makes the next request
 * re-apply every migration over tables that already exist, and an empty
 * `invoice_number_sequence` leaves invoice generation with no number to take.
 *
 * `demo-reset.test.ts` asserts this set is exactly the set of tables a fresh
 * migration run leaves non-empty, so a migration that seeds a new one fails the
 * test rather than quietly breaking the demo.
 */
export const PRESERVED_TABLES: ReadonlySet<string> = new Set([
  '_ezacto_migrations',
  'invoice_number_sequence',
  'email_template_versions',
  'email_template_heads',
])

const wipeStatements = (
  objects: DemoSchemaObjects,
): {
  readonly liftTriggers: readonly DemoSeedStatement[]
  readonly empty: readonly DemoSeedStatement[]
  readonly restoreTriggers: readonly DemoSeedStatement[]
} => ({
  liftTriggers: objects.triggers.map((trigger) => ({
    text: `DROP TRIGGER IF EXISTS ${quoted(trigger.name)}`,
    bindings: [],
  })),
  empty: [
    { text: 'PRAGMA defer_foreign_keys = true', bindings: [] },
    ...objects.tables
      .filter((table) => !PRESERVED_TABLES.has(table))
      .map((table) => ({ text: `DELETE FROM ${quoted(table)}`, bindings: [] })),
    // Preserved, but not carried over: the counter is kept because generation
    // needs a row to read, and reset because yesterday's demo took every number
    // below it and none of those invoices exist any more.
    { text: 'UPDATE invoice_number_sequence SET next_number = 1', bindings: [] },
  ],
  restoreTriggers: objects.triggers.map((trigger) => ({ text: trigger.sql, bindings: [] })),
})

const base64Url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/** `ezacto_<16>_<43>`, which is the only shape `prepareApiTokenForStorage` takes. */
const generateBootstrapToken = (): string =>
  `ezacto_${base64Url(crypto.getRandomValues(new Uint8Array(12)))}_${base64Url(
    crypto.getRandomValues(new Uint8Array(32)),
  )}`

/** Deterministic, and inside the `[A-Za-z0-9._:-]{1,128}` a command id must match. */
const commandId = (kind: string, ...parts: (string | number)[]): string =>
  `demo.${kind}.${parts.join('.')}`

const monthEnd = (month: string): string => {
  const next = new Date(`${month}-01T00:00:00Z`)
  next.setUTCMonth(next.getUTCMonth() + 1)
  next.setUTCDate(0)
  return next.toISOString().slice(0, 10)
}

const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)

/** Two accounts sign in, and only the owner's password comes from bootstrap. */
const teammatePasswordStatements = async (
  now: string,
): Promise<readonly DemoSeedStatement[]> => {
  const rows: DemoSeedStatement[] = []
  for (const account of demoAccounts) {
    if (account.userId === 1) continue
    const stored = await hashPassword(account.password)
    rows.push({
      text: `INSERT INTO user_passwords
        (user_id, credential_version, algorithm, version, iterations, memory_kib,
         time_cost, parallelism, salt, password_hash, created_at, updated_at)
        VALUES (?, 1, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      bindings: [
        account.userId,
        stored.algorithm,
        stored.version,
        stored.memoryKiB,
        stored.timeCost,
        stored.parallelism,
        stored.salt,
        stored.passwordHash,
        now,
        now,
      ],
    })
  }
  return rows
}

/**
 * A month of one client's work, generated, sent, and -- if it is old enough
 * that a client on net-30 would have paid it -- paid.
 *
 * Recent months are left open on purpose. An accounts-receivable screen where
 * every invoice is settled shows nothing, and the aging buckets are among the
 * things a person opening the demo has come to look at.
 */
const billMonth = async (
  driver: DemoResetDriver,
  input: {
    clientId: number
    projectIds: readonly number[]
    month: string
    now: string
    messageId: number
    paymentId: number
  },
): Promise<'billed' | 'nothing' | 'open'> => {
  const service = createInvoiceGenerationService(driver.orm, {
    clock: () => `${monthEnd(input.month)}T12:00:00.000Z`,
  })
  const issuedAt = `${monthEnd(input.month)}T12:00:00.000Z`
  let invoice
  try {
    invoice = await service.generate({
      commandId: commandId('generate', input.clientId, input.month),
      principal: { userId: 1, profile: 'administrator' },
      request: {
        clientId: input.clientId,
        from: `${input.month}-01`,
        to: monthEnd(input.month),
        projectIds: input.projectIds,
        timeSummaryType: 'project',
        expenseSummaryType: 'category',
      },
    })
  } catch (error) {
    // A client with no billable rows that month. Not every client bills every
    // month, and a demo where they all do is a demo of nothing.
    if (error instanceof InvoiceGenerationError && error.code === 'invalid_command_input') {
      return 'nothing'
    }
    throw error
  }

  await executeInvoiceLifecycleCommand(driver.orm, {
    invoiceId: invoice.id,
    commandId: commandId('send', invoice.id),
    command: 'send',
    actor: { type: 'user', id: 1 },
    authorize: async () => true,
    expectedVersion: 0,
    occurredAt: issuedAt,
    messageId: input.messageId,
    eventId: commandId('sent', invoice.id),
  })

  // Net-30 with a fortnight of slack. Anything more recent is still out.
  const settledAfterDays = 44
  const paidOn = new Date(Date.parse(issuedAt) + settledAfterDays * 86_400_000)
    .toISOString()
    .slice(0, 10)
  if (daysBetween(paidOn, input.now.slice(0, 10)) < 0) return 'open'

  await recordInvoicePayment(driver.orm, {
    invoiceId: invoice.id,
    commandId: commandId('pay', invoice.id),
    actor: { type: 'user', id: 1 },
    authorize: async () => true,
    expectedVersion: 1,
    occurredAt: `${paidOn}T12:00:00.000Z`,
    eventIds: [commandId('payment', invoice.id), commandId('paid', invoice.id)],
    payment: {
      type: 'manual',
      id: input.paymentId,
      currency: invoice.currency,
      amountCents: invoice.amount_cents,
      // Exactly one of the two, and a demo payment is a date on a remittance
      // rather than an instant the system observed.
      paidAt: null,
      paidDate: paidOn,
      recordedByUserId: 1,
    },
  })
  return 'billed'
}

/**
 * D1 caps a batch, and the seed is tens of thousands of rows. Small enough to
 * stay inside the limit, large enough that the round trips are not the cost.
 */
const BATCH = 200

/**
 * Empty the demo and lay down a fresh three years of people, projects and
 * hours. What it does not do is bill any of it -- see `billDemoBacklog`.
 */
export const wipeAndSeedDemo = async (
  driver: DemoResetDriver,
  options: DemoResetOptions,
): Promise<DemoWipeSummary> => {
  if (options.confirm !== 'wipe-and-reload') {
    throw new TypeError('a demo reset must be confirmed with "wipe-and-reload"')
  }
  const now = options.now
  const years = options.years ?? 3

  // A demo that has never been built has no schema to empty.
  await driver.migrate()
  const objects = await driver.schemaObjects()
  const wipe = wipeStatements(objects)
  await driver.execute(wipe.liftTriggers)
  await driver.executeAtomic(wipe.empty)
  await driver.execute(wipe.restoreTriggers)

  const owner = demoAccounts.find((account) => account.userId === 1)
  if (owner === undefined) throw new TypeError('the demo has no owner account')
  // Bootstrap takes an API token; the demo has no use for one. It is generated
  // rather than written down so that the value never exists outside this call,
  // and thrown away as soon as the owner's password is enrolled.
  const bootstrapToken = generateBootstrapToken()
  await driver.bootstrap(
    {
      organizationName: DEMO_ORGANIZATION_NAME,
      ownerFirstName: 'Demo',
      ownerLastName: 'Administrator',
      ownerEmail: owner.email,
      token: bootstrapToken,
    },
    now,
  )
  await driver.enrollOwnerPassword({ token: bootstrapToken, password: owner.password }, now)

  const seed = [
    ...demoSeedStatements({ now, years }),
    ...(await teammatePasswordStatements(now)),
  ]
  for (let index = 0; index < seed.length; index += BATCH) {
    await driver.executeAtomic(seed.slice(index, index + BATCH))
  }

  return {
    // The counter reset is in `empty` and is not a table being cleared.
    clearedTables: wipe.empty.length - 2,
    restoredTriggers: objects.triggers.length,
    seedStatements: seed.length,
  }
}

/**
 * Bill what the seed has left unbilled, up to `limit` client-months.
 *
 * Bounded and resumable because the caller is a cron tick with a CPU budget,
 * and three years of eight clients is a few hundred generate/send/pay chains
 * that will not fit in one.
 *
 * The backlog is the uninvoiced work itself, not a list of months that ought to
 * have been billed. Generation claims the rows it bills, so a month drops out
 * of this query the moment it is invoiced, and a month with nothing billable in
 * it never appears -- which is what lets the count reach zero. A progress table
 * would have had to be kept, wiped, and preserved through the wipe; the rows
 * already know.
 */
export const billDemoBacklog = async (
  driver: DemoResetDriver,
  options: DemoResetOptions & { readonly limit?: number },
): Promise<DemoBillingSummary> => {
  const now = options.now
  // The month `now` falls in is left alone: work in progress is what the
  // uninvoiced report is for, and an empty one is a screen with nothing to say.
  const currentMonth = now.slice(0, 7)
  const projectsOf = new Map(
    demoClientProjects.map(({ clientId, projectIds }) => [clientId, projectIds]),
  )
  const outstanding = (
    await driver.readRows<{ clientId: number; month: string }>(
      `SELECT project.client_id AS clientId, substr(source.spent_date, 1, 7) AS month
       FROM (
         SELECT project_id, spent_date FROM time_entries
           WHERE billable = 1 AND invoice_id IS NULL
         UNION ALL
         SELECT project_id, spent_date FROM expenses
           WHERE billable = 1 AND invoice_id IS NULL
       ) source
       JOIN projects project ON project.id = source.project_id
       WHERE project.is_active = 1
       GROUP BY 1, 2
       ORDER BY 2, 1`,
    )
  ).filter((entry) => entry.month < currentMonth && projectsOf.has(entry.clientId))
  const limit = options.limit ?? outstanding.length

  // Ids only have to be unique, and nothing carries across a tick boundary.
  const nextId = (table: string, column: string) =>
    driver
      .readRows<{ next: number }>(
        `SELECT coalesce(max(${column}), 9000) + 1 AS next FROM ${table}`,
      )
      .then((rows) => rows[0]?.next ?? 9001)
  let messageId = await nextId('invoice_messages', 'id')
  let paymentId = await nextId('invoice_payments', 'id')

  let billed = 0
  let paid = 0
  let attempted = 0
  for (const entry of outstanding) {
    if (attempted >= limit) break
    attempted += 1
    const outcome = await billMonth(driver, {
      clientId: entry.clientId,
      projectIds: projectsOf.get(entry.clientId)!,
      month: entry.month,
      now,
      messageId,
      paymentId,
    })
    if (outcome === 'nothing') continue
    billed += 1
    messageId += 1
    if (outcome === 'billed') {
      paid += 1
      paymentId += 1
    }
  }
  return { billed, paid, remaining: Math.max(0, outstanding.length - attempted) }
}

/**
 * The whole thing, start to finish. This is what a person rehearsing the reset
 * runs; the nightly cron uses the two halves so it can stop for breath.
 */
export const runDemoReset = async (
  driver: DemoResetDriver,
  options: DemoResetOptions,
): Promise<DemoResetSummary> => {
  const wiped = await wipeAndSeedDemo(driver, options)
  const billing = await billDemoBacklog(driver, options)
  return { ...wiped, ...billing }
}

export const createD1DemoResetDriver = (database: D1Database): DemoResetDriver => ({
  orm: drizzle(database, { schema }) as unknown as InvoiceGenerationDatabase,
  async schemaObjects() {
    const triggers = await database
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL`)
      .all<{ name: string; sql: string }>()
    const tables = await database
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      .all<{ name: string }>()
    return {
      triggers: triggers.results,
      tables: tables.results.map((row) => row.name),
    }
  },
  async execute(statements) {
    if (statements.length === 0) return
    await database.batch(
      statements.map((statement) =>
        database.prepare(statement.text).bind(...statement.bindings),
      ),
    )
  },
  // D1 runs a batch as one transaction, which is exactly the guarantee the
  // deferred foreign keys need.
  executeAtomic(statements) {
    return this.execute(statements)
  },
  async readRows<T>(sql: string) {
    const { results } = await database.prepare(sql).all<T>()
    return results
  },
  bootstrap: (input, now) => bootstrapInstanceD1(database, input, { now: () => now }),
  enrollOwnerPassword: (input, now) =>
    enrollInstanceOwnerPasswordD1(database, input, { now: () => now }),
  migrate: () => migrateD1(database),
})

/**
 * The same reset against a local file, which is how it is tested and how an
 * operator rehearses it before trusting a nightly cron with it.
 *
 * `migrate` is taken as an argument rather than imported: `migrateContainer`
 * pulls the native driver, and this module is also on the Worker's import path.
 */
export const createContainerDemoResetDriver = (
  database: BetterSqlite3.Database,
  orm: InvoiceGenerationDatabase,
  migrate: (database: BetterSqlite3.Database) => void,
): DemoResetDriver => ({
  orm,
  async schemaObjects() {
    return {
      triggers: database
        .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL`)
        .all() as { name: string; sql: string }[],
      tables: (
        database
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
          )
          .all() as { name: string }[]
      ).map((row) => row.name),
    }
  },
  async execute(statements) {
    runAll(database, statements)
  },
  async executeAtomic(statements) {
    database.transaction(() => runAll(database, statements))()
  },
  async readRows<T>(sql: string) {
    return database.prepare(sql).all() as T[]
  },
  bootstrap: (input, now) => bootstrapInstanceContainer(database, input, { now: () => now }),
  enrollOwnerPassword: (input, now) =>
    enrollInstanceOwnerPasswordContainer(database, input, { now: () => now }),
  async migrate() {
    migrate(database)
  },
})
