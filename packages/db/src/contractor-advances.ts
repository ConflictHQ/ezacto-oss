import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import {
  StaffPaymentError,
  validPaymentMonth,
  type AdvanceCredit,
  type AdvanceCreditApplication,
  type AdvanceCreditReturn,
  type AdvanceCreditsStore,
  type ApplyAdvanceCredit,
  type ReturnAdvanceCredit,
  type ReverseAdvanceCredit,
} from '@ezacto/core'

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>
const id = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9._-]{1,100}$/u.test(value)
const cents = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value > 0 &&
  value <= 9_000_000_000_000
const bad = (message: string): never => {
  throw new StaffPaymentError('invalid', message)
}
const date = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value

export const createAdvanceCreditsStore = (database: Database): AdvanceCreditsStore => {
  const insert = async (
    table: 'staff_advance_applications' | 'staff_advance_reversals' | 'staff_advance_returns',
    command: ApplyAdvanceCredit | ReverseAdvanceCredit | ReturnAdvanceCredit,
    actorId: number,
    statement: ReturnType<typeof sql>,
  ): Promise<void> => {
    if (
      !id(command.id) ||
      typeof command.reason !== 'string' ||
      !command.reason.trim() ||
      command.reason.length > 2000
    )
      bad('Provide a command identifier and an explanation of up to 2,000 characters.')
    const encoded = JSON.stringify(command)
    const existing = async () =>
      (
        await database.all<{ command_json: string; actor_id: number }>(
          sql`SELECT command_json,actor_id FROM ${sql.identifier(table)} WHERE id=${command.id}`,
        )
      )[0]
    const replay = await existing()
    if (replay) {
      if (replay.command_json === encoded && replay.actor_id === actorId) return
      throw new StaffPaymentError('conflict', 'This advance command identifier was already used.')
    }
    try {
      await database.run(statement)
    } catch (error) {
      const raced = await existing()
      if (raced?.command_json === encoded && raced.actor_id === actorId) return
      let cause: unknown = error
      for (let depth = 0; depth < 6 && cause; depth++) {
        if (
          /advance|allocation|reserved|UNIQUE constraint|CHECK constraint|FOREIGN KEY constraint/u.test(
            String(cause),
          )
        )
          throw new StaffPaymentError(
            'conflict',
            'The advance credit, earning or reference changed. Reload and review before continuing.',
          )
        cause = cause instanceof Error ? cause.cause : null
      }
      throw error
    }
  }
  return {
    apply: async (command, actorId, requestId, now) => {
      if (
        !id(command.advance_item_id) ||
        !Number.isSafeInteger(command.user_id) ||
        command.user_id <= 0 ||
        !/^[A-Z]{3}$/u.test(command.currency) ||
        !validPaymentMonth(command.month) ||
        !cents(command.amount_cents) ||
        !['month', 'project', 'entry'].includes(command.scope)
      )
        bad('Choose settled credit, a person, currency, reviewed work month and amount.')
      if (
        (command.scope === 'month' && (command.project_id !== null || command.entry_id !== null)) ||
        (command.scope !== 'month' &&
          (!Number.isSafeInteger(command.project_id) || command.project_id! <= 0)) ||
        (command.scope === 'project' && command.entry_id !== null) ||
        (command.scope === 'entry' &&
          (!Number.isSafeInteger(command.entry_id) || command.entry_id! <= 0))
      )
        bad('Choose a whole month, a project, or a time entry.')
      await insert(
        'staff_advance_applications',
        command,
        actorId,
        sql`
        INSERT INTO staff_advance_applications(id,advance_item_id,user_id,currency,month,amount_cents,scope,project_id,entry_id,reason,command_json,actor_id,recorded_at,request_id)
        VALUES(${command.id},${command.advance_item_id},${command.user_id},${command.currency},${command.month},${command.amount_cents},${command.scope},${command.project_id},${command.entry_id},${command.reason},${JSON.stringify(command)},${actorId},${now},${requestId})`,
      )
    },
    reverse: async (command, actorId, requestId, now) => {
      if (!id(command.application_id)) bad('Choose an advance application to reverse.')
      await insert(
        'staff_advance_reversals',
        command,
        actorId,
        sql`
        INSERT INTO staff_advance_reversals(id,application_id,reason,command_json,actor_id,recorded_at,request_id)
        VALUES(${command.id},${command.application_id},${command.reason},${JSON.stringify(command)},${actorId},${now},${requestId})`,
      )
    },
    recordReturn: async (command, actorId, requestId, now) => {
      if (
        !id(command.advance_item_id) ||
        !cents(command.amount_cents) ||
        typeof command.reference !== 'string' ||
        !command.reference.trim() ||
        command.reference.length > 255
      )
        bad('Choose an advance, amount and confirmed return reference.')
      await insert(
        'staff_advance_returns',
        command,
        actorId,
        sql`
        INSERT INTO staff_advance_returns(id,advance_item_id,amount_cents,reference,reason,command_json,actor_id,recorded_at,request_id)
        VALUES(${command.id},${command.advance_item_id},${command.amount_cents},${command.reference.trim()},${command.reason},${JSON.stringify(command)},${actorId},${now},${requestId})`,
      )
    },
    report: async (from, to) => {
      if (!date(from) || !date(to) || from > to) bad('Choose an inclusive date range (YYYY-MM-DD).')
      const rows = await database.all<
        Omit<
          AdvanceCredit,
          | 'reserved_cents'
          | 'available_cents'
          | 'opening_cents'
          | 'period_settled_cents'
          | 'period_applied_cents'
          | 'period_returned_cents'
          | 'closing_cents'
          | 'applications'
          | 'returns'
        >
      >(sql`
        SELECT b.*,u.first_name||' '||u.last_name AS name FROM staff_advance_balances b JOIN users u ON u.id=b.user_id ORDER BY b.user_id,b.currency,b.advance_item_id`)
      const applications = await database.all<AdvanceCreditApplication>(sql`
        SELECT a.id,a.advance_item_id,a.user_id,a.currency,a.month,a.amount_cents,a.scope,a.project_id,a.entry_id,a.reason,a.actor_id,a.recorded_at,
          r.recorded_at AS reversed_at,r.reason AS reversal_reason FROM staff_advance_applications a LEFT JOIN staff_advance_reversals r ON r.application_id=a.id ORDER BY a.recorded_at,a.id`)
      const returns = await database.all<AdvanceCreditReturn>(sql`
        SELECT id,advance_item_id,amount_cents,reference,reason,actor_id,recorded_at FROM staff_advance_returns ORDER BY recorded_at,id`)
      return {
        from,
        to,
        advances: rows.map((row) => {
          const own = applications.filter((a) => a.advance_item_id === row.advance_item_id)
          const returned = returns.filter((r) => r.advance_item_id === row.advance_item_id)
          const before = (stamp: string | null, boundary: string) =>
            stamp !== null && stamp.slice(0, 10) < boundary
          const through = (stamp: string | null) => stamp !== null && stamp.slice(0, 10) <= to
          const applied = (matches: (stamp: string | null) => boolean) =>
            own.reduce(
              (n, a) =>
                n +
                (matches(a.recorded_at) ? a.amount_cents : 0) -
                (matches(a.reversed_at) ? a.amount_cents : 0),
              0,
            )
          const returnSum = (matches: (stamp: string) => boolean) =>
            returned.reduce((n, r) => n + (matches(r.recorded_at) ? r.amount_cents : 0), 0)
          const opening =
            (before(row.settled_at, from) ? row.settled_cents : 0) -
            applied((s) => before(s, from)) -
            returnSum((s) => before(s, from))
          const closing =
            (through(row.settled_at) ? row.settled_cents : 0) -
            applied(through) -
            returnSum(through)
          return {
            ...row,
            reserved_cents: ['queued', 'creating', 'funding', 'processing', 'attention'].includes(
              row.state,
            )
              ? row.amount_cents
              : 0,
            available_cents:
              row.state === 'paid' ? row.settled_cents - row.applied_cents - row.returned_cents : 0,
            opening_cents: opening,
            period_settled_cents:
              !before(row.settled_at, from) && through(row.settled_at) ? row.settled_cents : 0,
            period_applied_cents: applied(through) - applied((s) => before(s, from)),
            period_returned_cents: returnSum(through) - returnSum((s) => before(s, from)),
            closing_cents: closing,
            applications: own,
            returns: returned,
          }
        }),
      }
    },
  }
}
