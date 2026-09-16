import { sql } from 'drizzle-orm'
import type { InvoiceStateDatabase } from './invoice-state.js'

/**
 * The organisation's default reminder policy (issue 801).
 *
 * `organizations.reminder_policy` has existed since the first migration and
 * nothing read or wrote it: every invoice carried its own policy or none, and
 * "none" was every invoice raised through the screen. The default is what makes
 * reminders a thing an operator switches on once rather than per invoice, and
 * the invoice's own policy still wins where it has one.
 *
 * The shape is the one the scheduler already parses: the first reminder goes
 * `first_after_days` after the due date, then one every `every_days` until the
 * invoice is paid, written off or cancelled.
 */
export interface ReminderPolicy {
  readonly first_after_days: number
  readonly every_days: number
}

export const parseReminderPolicy = (json: string | null): ReminderPolicy | null => {
  if (json === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  return reminderPolicyFrom(parsed)
}

/** A policy from any value, or null where the value is not one. */
export const reminderPolicyFrom = (value: unknown): ReminderPolicy | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const policy = value as Record<string, unknown>
  const first = policy.first_after_days
  const every = policy.every_days
  if (
    typeof first !== 'number' ||
    !Number.isSafeInteger(first) ||
    first < 0 ||
    first > 3650 ||
    typeof every !== 'number' ||
    !Number.isSafeInteger(every) ||
    every < 1 ||
    every > 365
  ) {
    return null
  }
  return { first_after_days: first, every_days: every }
}

export const readOrganizationReminderPolicy = async (
  database: InvoiceStateDatabase,
): Promise<ReminderPolicy | null> => {
  const rows = await database.all<{ policy: string | null }>(
    sql`SELECT reminder_policy AS policy FROM organizations ORDER BY id LIMIT 1`,
  )
  return parseReminderPolicy(rows[0]?.policy ?? null)
}

/** `null` switches the default off; invoices with their own policy keep it. */
export const setOrganizationReminderPolicy = async (
  database: InvoiceStateDatabase,
  policy: ReminderPolicy | null,
  now: string,
): Promise<void> => {
  const stored =
    policy === null
      ? null
      : JSON.stringify({ first_after_days: policy.first_after_days, every_days: policy.every_days })
  await database.run(
    sql`UPDATE organizations SET reminder_policy = ${stored}, updated_at = ${now}
        WHERE id = (SELECT id FROM organizations ORDER BY id LIMIT 1)`,
  )
}
