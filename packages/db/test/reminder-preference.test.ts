import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { executeInvoiceLifecycleCommand } from '../src/invoice-state.js'
import { migrateContainer } from '../src/migrate.js'
import { createContainerOutboxService } from '../src/outbox.js'
import { createReminderSettings } from '../src/reminder-preference.js'
import { createContainerReminderScheduler } from '../src/reminders.js'

const t = (minute: number): string => `2026-09-02T10:${String(minute).padStart(2, '0')}:00.000Z`

let sqlite: BetterSqlite3.Database | null = null
afterEach(() => {
  sqlite?.close()
  sqlite = null
})

/** Two invoices sent, no policy anywhere: the state production was in on 2026-09-17. */
const fixture = async () => {
  const database = new BetterSqlite3(':memory:')
  sqlite = database
  await migrateContainer(database)
  database.exec(`
    INSERT INTO organizations (name, modules, created_at, updated_at) VALUES ('Fixture', '{}', '${t(0)}', '${t(0)}');
    INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
      VALUES (1, 'Casey', 'Ng', 'administrator', '[]', '${t(0)}', '${t(0)}');
    INSERT INTO clients (id, name, currency, created_at, updated_at) VALUES (1, 'Kestrel Environmental', 'USD', '${t(0)}', '${t(0)}');
    INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date, state, created_at, updated_at)
      VALUES (1, 1, '1299', 'USD', '2026-08-01', '2026-08-31', 'draft', '${t(0)}', '${t(0)}'),
             (2, 1, '1302', 'USD', '2026-08-01', '2026-08-31', 'draft', '${t(0)}', '${t(0)}');
  `)
  const orm = createContainerDatabase(database)
  for (const invoiceId of [1, 2]) {
    await executeInvoiceLifecycleCommand(orm, {
      invoiceId,
      commandId: `send-${invoiceId}`,
      command: 'send',
      actor: { type: 'user', id: 1 },
      authorize: async () => true,
      expectedVersion: 0,
      occurredAt: t(1),
      messageId: 200 + invoiceId,
      eventId: `sent-${invoiceId}`,
    })
  }
  const scheduler = createContainerReminderScheduler(database)
  await createContainerOutboxService(database, {
    subscribers: [scheduler.subscriber],
    now: () => t(2),
    createAttemptId: () => 'drain',
  }).drain()
  return { database, scheduler, settings: createReminderSettings(orm, scheduler, () => t(3)) }
}

describe('reminder settings, composed (issue 850)', () => {
  it('[money] setting the organisation policy books the invoices already sent, and says how many', async () => {
    const { scheduler, settings } = await fixture()
    expect(await scheduler.listPending()).toHaveLength(0)
    expect(await settings.setOrganizationReminderPolicy({ first_after_days: 3, every_days: 7 })).toBe(2)
    expect((await scheduler.listPending()).map((row) => row.scheduledAt)).toEqual([
      '2026-09-03T00:00:00.000Z',
      '2026-09-03T00:00:00.000Z',
    ])
    expect(await settings.readInvoiceReminders(1)).toEqual({
      invoice: null,
      organizationPolicy: { first_after_days: 3, every_days: 7 },
      effective: true,
      nextReminderAt: '2026-09-03T00:00:00.000Z',
    })
  })

  it('[money] one invoice switched off stays off through a new policy, and comes back when handed back', async () => {
    // The client said they will pay. The operator switches reminders off for
    // that invoice; the organisation default is not their concern.
    const { scheduler, settings } = await fixture()
    await settings.setOrganizationReminderPolicy({ first_after_days: 3, every_days: 7 })
    expect(await settings.setInvoiceReminders(1, false)).toBe(true)
    expect(await settings.readInvoiceReminders(1)).toMatchObject({ invoice: false, effective: false, nextReminderAt: null })
    expect((await scheduler.listPending()).map((row) => row.invoiceId)).toEqual([2])

    // A new default reaches the other invoice only.
    await scheduler.cancelPending(2, t(3))
    expect(await settings.setOrganizationReminderPolicy({ first_after_days: 1, every_days: 5 })).toBe(1)
    expect((await scheduler.listPending()).map((row) => row.invoiceId)).toEqual([2])

    // Handed back, it is booked under the policy in force now.
    expect(await settings.setInvoiceReminders(1, null)).toBe(true)
    expect(await settings.readInvoiceReminders(1)).toMatchObject({
      invoice: null,
      effective: true,
      nextReminderAt: '2026-09-01T00:00:00.000Z',
    })
  })

  it('[unit] switching the default off cancels nothing already booked', async () => {
    const { scheduler, settings } = await fixture()
    await settings.setOrganizationReminderPolicy({ first_after_days: 3, every_days: 7 })
    expect(await settings.setOrganizationReminderPolicy(null)).toBe(0)
    expect(await scheduler.listPending()).toHaveLength(2)
    expect(await settings.readInvoiceReminders(1)).toMatchObject({ organizationPolicy: null, effective: false })
  })

  it('[unit] an invoice that is not there is null, and cannot be set', async () => {
    const { settings } = await fixture()
    expect(await settings.readInvoiceReminders(99)).toBeNull()
    expect(await settings.setInvoiceReminders(99, false)).toBe(false)
  })
})
