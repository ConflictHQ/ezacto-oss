import { sql } from 'drizzle-orm'
import type { InvoiceStateDatabase } from './invoice-state.js'
import { readInvoiceExtras, setInvoiceExtra } from './invoice-extras.js'
import {
  parseReminderPolicy,
  readOrganizationReminderPolicy,
  setOrganizationReminderPolicy,
  type ReminderPolicy,
} from './reminder-settings.js'
import type { ReminderScheduler } from './reminders.js'

/**
 * The reminder settings the API routes need, composed once for both entries
 * (issue 850): the organisation default, which now reaches the open invoices
 * already out when it is set, and one invoice's own answer, which can switch
 * reminders off for that invoice alone.
 */
export interface InvoiceReminderAnswer {
  readonly invoice: boolean | null
  readonly organizationPolicy: ReminderPolicy | null
  readonly effective: boolean
  readonly nextReminderAt: string | null
}

export interface ReminderSettings {
  readOrganizationReminderPolicy(): Promise<ReminderPolicy | null>
  setOrganizationReminderPolicy(policy: ReminderPolicy | null): Promise<number>
  readInvoiceReminders(invoiceId: number): Promise<InvoiceReminderAnswer | null>
  setInvoiceReminders(invoiceId: number, value: boolean | null): Promise<boolean>
}

export const createReminderSettings = (
  database: InvoiceStateDatabase,
  scheduler: Pick<ReminderScheduler, 'applyPolicy' | 'cancelPending' | 'listPending'>,
  now: () => string,
): ReminderSettings => ({
  readOrganizationReminderPolicy: () => readOrganizationReminderPolicy(database),

  setOrganizationReminderPolicy: async (policy) => {
    const at = now()
    await setOrganizationReminderPolicy(database, policy, at)
    // Switching the default off cancels nothing: an invoice already booked
    // was booked under a policy somebody chose, and a mistaken default is
    // undone by the per-invoice answer, not by forgetting every booking.
    if (policy === null) return 0
    return scheduler.applyPolicy({ now: at, causation: `reminder-policy:${at}` })
  },

  readInvoiceReminders: async (invoiceId) => {
    const extras = await readInvoiceExtras(database, invoiceId)
    if (extras === null) return null
    const rows = await database.all<{ policy: string | null }>(
      sql`SELECT reminder_policy AS policy FROM invoices WHERE id = ${invoiceId}`,
    )
    const own = parseReminderPolicy(rows[0]?.policy ?? null)
    const organizationPolicy = await readOrganizationReminderPolicy(database)
    const invoice = extras.invoice.reminders === false ? false : null
    const pending = await scheduler.listPending(invoiceId)
    return {
      invoice,
      organizationPolicy,
      effective: invoice !== false && (own ?? organizationPolicy) !== null,
      nextReminderAt: pending[0]?.scheduledAt ?? null,
    }
  },

  setInvoiceReminders: async (invoiceId, value) => {
    // `true` and `null` mean the same thing here -- follow the policy -- and
    // are stored as "not answered", so a later organisation change governs.
    const stored = value === false ? false : null
    if (!(await setInvoiceExtra(database, invoiceId, 'reminders', stored))) return false
    const at = now()
    if (stored === false) {
      await scheduler.cancelPending(invoiceId, at)
    } else {
      await scheduler.applyPolicy({ now: at, invoiceId, causation: `reminder-preference:${invoiceId}:${at}` })
    }
    return true
  },
})
