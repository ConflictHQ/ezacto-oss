import type BetterSqlite3 from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'

type ContainerDatabase = BetterSQLite3Database<typeof schema> & {
  $client: BetterSqlite3.Database
}

type WorkerDatabase = DrizzleD1Database<typeof schema> & {
  $client: D1Database
}

export type RetainerDatabase = ContainerDatabase | WorkerDatabase

export type RetainerLedgerKind = 'deposit' | 'drawdown' | 'expiry' | 'reset' | 'adjustment'

type CentsAmount = { amountCents: number; seconds?: never }
type SecondsAmount = { amountCents?: never; seconds: number }

export type AppendRetainerLedgerEntryInput = {
  id: string
  retainerId: number
  kind: RetainerLedgerKind
  invoiceId?: number | null
  occurredOn: string
  notes?: string | null
  createdAt: string
} & (CentsAmount | SecondsAmount)

export interface RetainerLedgerEntry {
  id: string
  retainerId: number
  kind: RetainerLedgerKind
  unit: 'cents' | 'seconds'
  amount: number
  invoiceId: number | null
  occurredOn: string
  notes: string | null
  createdAt: string
}

export interface RetainerBalance {
  retainerId: number
  denomination: 'money' | 'hours'
  balance: number
}

interface SqlStatement {
  text: string
  params: readonly unknown[]
}

const centsLimit = 9_000_000_000_000
const safeIntegerLimit = Number.MAX_SAFE_INTEGER
const entryIdPattern = /^[A-Za-z0-9._:-]{1,128}$/
const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/
const timestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/

const assertPositiveSafeInteger = (value: number, field: string): void => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${field} must be a positive safe integer`)
  }
}

const assertCanonicalDate = (value: string, field: string): void => {
  const match = datePattern.exec(value)
  if (!match) throw new RangeError(`${field} must be a canonical YYYY-MM-DD date`)
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  if (
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() !== Number(match[2]) - 1 ||
    date.getUTCDate() !== Number(match[3])
  ) {
    throw new RangeError(`${field} must be a real calendar date`)
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

const run = async (database: RetainerDatabase, statement: SqlStatement): Promise<void> => {
  const client = database.$client
  if (isD1Client(client)) {
    await client
      .prepare(statement.text)
      .bind(...statement.params)
      .run()
    return
  }
  client.prepare(statement.text).run(...statement.params)
}

const ledgerEntryStatement = (entryId: string): SqlStatement => ({
  text: `SELECT id, retainer_id AS "retainerId", kind, unit, amount,
      invoice_id AS "invoiceId", occurred_on AS "occurredOn", notes,
      created_at AS "createdAt"
    FROM retainer_ledger WHERE id = ?`,
  params: [entryId],
})

const sameEntry = (
  stored: RetainerLedgerEntry,
  input: AppendRetainerLedgerEntryInput,
  unit: 'cents' | 'seconds',
  amount: number,
): boolean =>
  stored.retainerId === input.retainerId &&
  stored.kind === input.kind &&
  stored.unit === unit &&
  stored.amount === amount &&
  stored.invoiceId === (input.invoiceId ?? null) &&
  stored.occurredOn === input.occurredOn &&
  stored.notes === (input.notes ?? null) &&
  stored.createdAt === input.createdAt

/**
 * Append one stable ledger movement. Parent-unit and overdraw checks execute in
 * the INSERT trigger, so concurrent Worker and container writers cannot both
 * spend the same balance.
 */
export const appendRetainerLedgerEntry = async (
  database: RetainerDatabase,
  input: AppendRetainerLedgerEntryInput,
): Promise<RetainerLedgerEntry> => {
  if (!entryIdPattern.test(input.id)) {
    throw new RangeError('retainer ledger id must use 1-128 safe identifier characters')
  }
  assertPositiveSafeInteger(input.retainerId, 'retainerId')
  if (input.invoiceId !== undefined && input.invoiceId !== null) {
    assertPositiveSafeInteger(input.invoiceId, 'invoiceId')
  }
  assertCanonicalDate(input.occurredOn, 'occurredOn')
  assertCanonicalTimestamp(input.createdAt, 'createdAt')

  const hasCents = typeof input.amountCents === 'number'
  const hasSeconds = typeof input.seconds === 'number'
  if (hasCents === hasSeconds) {
    throw new RangeError('retainer ledger entry must contain cents or seconds, never both')
  }
  const unit = hasCents ? 'cents' : 'seconds'
  const amount = hasCents ? input.amountCents : input.seconds
  const limit = unit === 'cents' ? centsLimit : safeIntegerLimit
  if (!Number.isSafeInteger(amount) || amount === 0 || Math.abs(amount) > limit) {
    throw new RangeError(`retainer ledger ${unit} must be a non-zero bounded safe integer`)
  }
  if (input.kind === 'deposit' && amount < 1) {
    throw new RangeError('retainer deposit must be positive')
  }
  if ((input.kind === 'drawdown' || input.kind === 'expiry') && amount > -1) {
    throw new RangeError(`retainer ${input.kind} must be negative`)
  }
  if (input.kind === 'adjustment' && (input.notes ?? '').trim().length === 0) {
    throw new RangeError('retainer adjustment requires a reason')
  }
  if (
    (input.kind === 'deposit' || input.kind === 'drawdown') &&
    (input.invoiceId === undefined || input.invoiceId === null)
  ) {
    throw new RangeError(`retainer ${input.kind} requires a linked invoice`)
  }

  const existing = await first<RetainerLedgerEntry>(database, ledgerEntryStatement(input.id))
  if (existing !== null) {
    if (!sameEntry(existing, input, unit, amount)) {
      throw new Error(`retainer ledger id ${input.id} was already used for another movement`)
    }
    return existing
  }

  try {
    await run(database, {
      text: `INSERT INTO retainer_ledger (
          id, retainer_id, kind, unit, amount, invoice_id, occurred_on, notes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        input.id,
        input.retainerId,
        input.kind,
        unit,
        amount,
        input.invoiceId ?? null,
        input.occurredOn,
        input.notes ?? null,
        input.createdAt,
      ],
    })
  } catch (error) {
    const raced = await first<RetainerLedgerEntry>(database, ledgerEntryStatement(input.id))
    if (raced === null) throw error
    if (!sameEntry(raced, input, unit, amount)) {
      throw new Error(`retainer ledger id ${input.id} was already used for another movement`, {
        cause: error,
      })
    }
    return raced
  }

  const stored = await first<RetainerLedgerEntry>(database, ledgerEntryStatement(input.id))
  if (stored === null) throw new Error(`retainer ledger entry ${input.id} did not persist`)
  if (!sameEntry(stored, input, unit, amount)) {
    throw new Error(`retainer ledger id ${input.id} was already used for another movement`)
  }
  return stored
}

export const getRetainerBalance = async (
  database: RetainerDatabase,
  retainerId: number,
): Promise<RetainerBalance> => {
  assertPositiveSafeInteger(retainerId, 'retainerId')
  const balance = await first<RetainerBalance>(database, {
    text: `SELECT retainer_id AS "retainerId", denomination, balance
      FROM retainer_balances WHERE retainer_id = ?`,
    params: [retainerId],
  })
  if (balance === null) throw new Error(`retainer ${retainerId} does not exist`)
  if (!Number.isSafeInteger(balance.balance)) {
    throw new Error(`retainer ${retainerId} balance exceeds the safe integer range`)
  }
  return balance
}
