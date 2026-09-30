import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import {
  StaffPaymentError,
  paymentMonthEnd,
  validPaymentMonth,
  validateActualsMonth,
  paymentActualsTotal,
  type PaymentActuals,
  type PaymentActualEntry,
  type ConfirmPaymentActuals,
  type StaffPaymentStore,
} from '@ezacto/core'
type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>

export const createPaymentActualsStore = (
  database: Database,
  ledger: Pick<StaffPaymentStore, 'report'>,
) => ({
  actuals: async (month: string, today: string): Promise<PaymentActuals> => {
    if (!validPaymentMonth(month))
      throw new StaffPaymentError('invalid', 'Choose a valid work month.')
    const [entries, organization, reviews] = await Promise.all([
      database.all<PaymentActualEntry & { user_id: number; name: string }>(sql`
        SELECT t.id AS entry_id,t.project_id,p.name AS project_name,t.spent_date,t.rounded_seconds,t.cost_rate_cents,
          t.rounded_seconds AS selected_seconds,u.id AS user_id,u.first_name||' '||u.last_name AS name
        FROM time_entries t JOIN users u ON u.id=t.user_id JOIN projects p ON p.id=t.project_id
        WHERE u.is_contractor=1 AND t.spent_date BETWEEN ${month + '-01'} AND ${paymentMonthEnd(month)}
        ORDER BY u.first_name,u.id,p.name,t.spent_date,t.id`),
      database.all<{ currency: string; timezone: string }>(
        sql`SELECT upper(currency) AS currency,timezone FROM organizations WHERE id=1`,
      ),
      database.all<{
        user_id: number
        entries_json: string
      }>(sql`SELECT a.user_id,a.entries_json FROM staff_payment_actuals a
        WHERE a.month=${month} AND a.expected_version=(SELECT MAX(b.expected_version) FROM staff_payment_actuals b WHERE b.user_id=a.user_id AND b.month=a.month)`),
    ])
    const people = new Map<number, PaymentActuals['people'][number]>()
    const previous = new Map(
      reviews.map((r) => [
        r.user_id,
        new Map(
          (JSON.parse(r.entries_json) as PaymentActualEntry[]).map((e) => [
            e.entry_id,
            e.selected_seconds,
          ]),
        ),
      ]),
    )
    for (const { user_id, name, ...entry } of entries) {
      const person = people.get(user_id) ?? { user_id, name, entries: [] }
      // Preserve the previous review selection, including exclusions. Newly
      // tracked entries remain unselected on a revision until explicitly reviewed.
      const selected = previous.get(user_id)
      if (selected)
        entry.selected_seconds = Math.max(
          Math.min(0, entry.rounded_seconds),
          Math.min(Math.max(0, entry.rounded_seconds), selected.get(entry.entry_id) ?? 0),
        )
      person.entries.push(entry)
      people.set(user_id, person)
    }
    if (!organization[0]) throw new Error('Organization is missing.')
    const date = today.includes('T')
      ? new Intl.DateTimeFormat('en-CA', {
          timeZone: organization[0].timezone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(new Date(today))
      : today
    return {
      month,
      currency: organization[0].currency,
      completed: paymentMonthEnd(month) < date,
      people: [...people.values()],
    }
  },
  confirmActuals: async (
    command: ConfirmPaymentActuals,
    actor: number,
    request: string,
    now: string,
  ): Promise<void> => {
    const replay = (
      await database.all<{ command_json: string; actor_id: number }>(
        sql`SELECT command_json,actor_id FROM staff_payment_actuals WHERE id=${command.id}`,
      )
    )[0]
    const encoded = JSON.stringify(command)
    if (replay) {
      if (replay.command_json === encoded && replay.actor_id === actor) return
      throw new StaffPaymentError(
        'conflict',
        'This review identifier was already used. Reload actuals.',
      )
    }
    const organization = (
      await database.all<{ timezone: string }>(
        sql`SELECT timezone FROM organizations WHERE id=1`,
      )
    )[0]
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: organization?.timezone ?? 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(now))
    validateActualsMonth(command.month, today)
    if (
      !/^[a-zA-Z0-9._-]{1,100}$/u.test(command.id) ||
      !Number.isSafeInteger(command.expected_version) ||
      command.expected_version < 0 ||
      !Number.isSafeInteger(command.user_id) ||
      command.user_id <= 0 ||
      command.note.trim().length === 0 ||
      command.note.length > 2000 ||
      !/^[A-Z]{3}$/u.test(command.currency) ||
      command.entries.length === 0 ||
      command.entries.length > 10000
    )
      throw new StaffPaymentError(
        'invalid',
        'Provide a person, review identifier, version, currency, hours and explanation.',
      )
    for (const e of command.entries)
      if (
        !e.spent_date.startsWith(command.month + '-') ||
        !Number.isSafeInteger(e.project_id) ||
        e.project_id <= 0 ||
        typeof e.project_name !== 'string'
      )
        throw new StaffPaymentError(
          'invalid',
          'Every selected time entry must belong to the work month.',
        )
    const amount = paymentActualsTotal(command.entries)
    const row = (await ledger.report(command.month, now.slice(0, 10))).rows.find(
      (r) => r.user_id === command.user_id,
    )
    if (!row || !row.active)
      throw new StaffPaymentError('invalid', 'Choose an active contractor.')
    if (row.status === 'settled')
      throw new StaffPaymentError(
        'conflict',
        'This work month is already settled. Reopen it before reviewing additional earnings.',
      )
    if (row.version !== command.expected_version)
      throw new StaffPaymentError(
        'conflict',
        'The balance changed. Reload actuals before confirming.',
      )
    if (row.paid_cents > 0 && row.currency !== command.currency)
      throw new StaffPaymentError('conflict', 'The currency cannot change after a payment.')
    try {
      const inserted = await database.all<{
        id: string
      }>(sql`INSERT INTO staff_payment_actuals(id,user_id,month,command_json,entries_json,amount_cents,currency,expected_version,actor_id,recorded_at,request_id,note)
        SELECT ${command.id},${command.user_id},${command.month},${encoded},${JSON.stringify(command.entries)},${amount},${command.currency},${command.expected_version},${actor},${now},${request},${command.note}
        WHERE EXISTS(SELECT 1 FROM users WHERE id=${command.user_id} AND is_contractor=1 AND is_active=1)
        RETURNING id`)
      if (inserted.length === 0)
        throw new StaffPaymentError('invalid', 'Choose an active contractor.')
    } catch (error) {
      let current: unknown = error
      for (let depth = 0; depth < 5 && current; depth++) {
        if (/actuals|reserved|UNIQUE constraint/u.test(String(current)))
          throw new StaffPaymentError(
            'conflict',
            'The hours, balance or reservation changed. Reload actuals and review again.',
          )
        current = current instanceof Error ? current.cause : undefined
      }
      throw error
    }
  },
})
