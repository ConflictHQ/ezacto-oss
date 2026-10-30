import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import {
  StaffPaymentError,
  paymentMonthEnd,
  reconcileEarnings,
  validPaymentMonth,
  type PaymentActualEntry,
  type PaymentReconciliation,
  type ReconciliationPerson,
} from '@ezacto/core'
type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>

/** Issue 902 slice 1: read-only. Proposes earnings; writes nothing. */
export const createPaymentReconciliationStore = (database: Database) => ({
  reconciliation: async (month: string, today: string): Promise<PaymentReconciliation> => {
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
      database.all<{ user_id: number; name: string; amount_cents: number; entries_json: string }>(
        sql`SELECT a.user_id,u.first_name||' '||u.last_name AS name,a.amount_cents,a.entries_json
        FROM staff_payment_actuals a JOIN users u ON u.id=a.user_id
        WHERE a.month=${month} AND a.expected_version=(SELECT MAX(b.expected_version) FROM staff_payment_actuals b WHERE b.user_id=a.user_id AND b.month=a.month)
        ORDER BY u.first_name,u.id`,
      ),
    ])
    if (!organization[0]) throw new Error('Organization is missing.')
    const people = new Map<number, ReconciliationPerson>()
    for (const r of reviews)
      people.set(r.user_id, {
        user_id: r.user_id,
        name: r.name,
        entries: [],
        confirmed: {
          amount_cents: r.amount_cents,
          entries: JSON.parse(r.entries_json) as PaymentActualEntry[],
        },
      })
    for (const { user_id, name, ...entry } of entries) {
      const person = people.get(user_id) ?? { user_id, name, entries: [], confirmed: null }
      person.entries.push(entry)
      people.set(user_id, person)
    }
    const date = today.includes('T')
      ? new Intl.DateTimeFormat('en-CA', {
          timeZone: organization[0].timezone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(new Date(today))
      : today
    return reconcileEarnings(
      month,
      organization[0].currency,
      paymentMonthEnd(month) < date,
      [...people.values()],
    )
  },
})
