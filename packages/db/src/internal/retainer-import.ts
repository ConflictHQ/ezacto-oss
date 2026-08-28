import type BetterSqlite3 from 'better-sqlite3'
import type { RetainerDatabase } from '../retainers.js'

export interface EnsureHarvestRetainerStubInput {
  invoiceId: number
  harvestInvoiceId: number
  harvestRetainerId: number
  createdAt: string
  updatedAt: string
}

export interface HarvestRetainerStub {
  id: number
  harvestId: number
  clientId: number | null
  denomination: 'money'
  amountCents: number
  seconds: null
}

interface SqlStatement {
  text: string
  params: readonly unknown[]
}

const timestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/

const assertPositiveSafeInteger = (value: number, field: string): void => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${field} must be a positive safe integer`)
  }
}

const assertCanonicalTimestamp = (value: string, field: string): void => {
  const match = timestampPattern.exec(value)
  if (!match) throw new RangeError(`${field} must be a canonical UTC timestamp`)
  const milliseconds = Date.parse(value)
  const date = new Date(milliseconds)
  if (
    !Number.isFinite(milliseconds) ||
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() !== Number(match[2]) - 1 ||
    date.getUTCDate() !== Number(match[3]) ||
    date.getUTCHours() !== Number(match[4]) ||
    date.getUTCMinutes() !== Number(match[5]) ||
    date.getUTCSeconds() !== Number(match[6]) ||
    date.getUTCMilliseconds() !== Number((match[7] ?? '').padEnd(3, '0') || 0)
  ) {
    throw new RangeError(`${field} must be a real canonical UTC timestamp`)
  }
}

const isD1Client = (client: BetterSqlite3.Database | D1Database): client is D1Database =>
  'batch' in client

const first = async <T>(database: RetainerDatabase, statement: SqlStatement): Promise<T | null> => {
  const client = database.$client
  if (isD1Client(client)) {
    return (
      (await client
        .prepare(statement.text)
        .bind(...statement.params)
        .first<T>()) ?? null
    )
  }
  return (client.prepare(statement.text).get(...statement.params) as T | undefined) ?? null
}

const runAtomic = async (
  database: RetainerDatabase,
  statements: readonly SqlStatement[],
): Promise<void> => {
  const client = database.$client
  if (isD1Client(client)) {
    await client.batch(
      statements.map((statement) => client.prepare(statement.text).bind(...statement.params)),
    )
    return
  }
  client.transaction(() => {
    for (const statement of statements) client.prepare(statement.text).run(...statement.params)
  })()
}

/**
 * Initial-load authority only. Materialize the source identity Harvest leaves
 * dangling and link one already-imported invoice to it. Repeated source ids
 * converge on one money stub; the opening balance remains an explicit worksheet
 * adjustment through the normal ledger operation.
 */
export const ensureHarvestRetainerStub = async (
  database: RetainerDatabase,
  input: EnsureHarvestRetainerStubInput,
): Promise<HarvestRetainerStub> => {
  assertPositiveSafeInteger(input.invoiceId, 'invoiceId')
  assertPositiveSafeInteger(input.harvestInvoiceId, 'harvestInvoiceId')
  assertPositiveSafeInteger(input.harvestRetainerId, 'harvestRetainerId')
  assertCanonicalTimestamp(input.createdAt, 'createdAt')
  assertCanonicalTimestamp(input.updatedAt, 'updatedAt')

  const retainerIdLookup = `(SELECT id FROM retainers
    WHERE harvest_id = ? AND denomination = 'money'
      AND amount_cents IS NOT NULL AND seconds IS NULL)`
  await runAtomic(database, [
    {
      text: `INSERT INTO retainers (
          harvest_id, client_id, state, denomination, amount_cents, seconds,
          on_exhaustion, created_at, updated_at
        )
        SELECT ?, invoice.client_id, 'ongoing', 'money', 0, NULL,
          'block', ?, ?
        FROM invoices invoice
        WHERE invoice.id = ? AND invoice.harvest_id = ?
          AND invoice.version = 0
          AND NOT EXISTS (
            SELECT 1 FROM invoice_command_ledger command WHERE command.invoice_id = invoice.id
          )
          AND NOT EXISTS (SELECT 1 FROM retainers WHERE harvest_id = ?)`,
      params: [
        input.harvestRetainerId,
        input.createdAt,
        input.updatedAt,
        input.invoiceId,
        input.harvestInvoiceId,
        input.harvestRetainerId,
      ],
    },
    {
      text: `UPDATE invoices
        SET retainer_id = CASE
          WHEN retainer_id IS NULL OR retainer_id = ${retainerIdLookup}
            THEN ${retainerIdLookup}
          ELSE -1
        END
        WHERE id = ? AND harvest_id = ? AND version = 0
          AND NOT EXISTS (
            SELECT 1 FROM invoice_command_ledger command WHERE command.invoice_id = invoices.id
          )`,
      params: [
        input.harvestRetainerId,
        input.harvestRetainerId,
        input.invoiceId,
        input.harvestInvoiceId,
      ],
    },
  ])

  const stub = await first<HarvestRetainerStub>(database, {
    text: `SELECT retainer.id, retainer.harvest_id AS "harvestId",
        retainer.client_id AS "clientId", retainer.denomination,
        retainer.amount_cents AS "amountCents", retainer.seconds
      FROM invoices invoice
      JOIN retainers retainer ON retainer.id = invoice.retainer_id
      WHERE invoice.id = ? AND invoice.harvest_id = ? AND retainer.harvest_id = ?`,
    params: [input.invoiceId, input.harvestInvoiceId, input.harvestRetainerId],
  })
  if (stub === null) {
    throw new Error(
      `imported invoice ${input.invoiceId} could not link Harvest retainer ${input.harvestRetainerId}`,
    )
  }
  return stub
}
