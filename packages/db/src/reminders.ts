import type BetterSqlite3 from 'better-sqlite3'
import type {
  OutboxEventRecord,
  OutboxSubscriber,
  OutboxSubscriberContext,
} from './outbox.js'

export const REMINDER_SUBSCRIBER_ID = 'reminder_scheduler'

const cancellingEventTypes = new Set([
  'invoice.paid',
  'invoice.cancelled',
  'invoice.written_off',
  'invoice.closed',
])

export interface ScheduledReminderRecord {
  id: number
  invoiceId: number
  scheduledAt: string
  intervalDays: number
  status: 'pending' | 'sent' | 'cancelled'
  template: string
  causationEventId: string
  createdAt: string
  updatedAt: string
}

export interface ReminderProcessSummary {
  examined: number
  sent: number
  scheduled: number
}

interface ReminderDatabase {
  first<T>(query: string, bindings: readonly unknown[]): Promise<T | null>
  all<T>(query: string, bindings: readonly unknown[]): Promise<T[]>
  run(query: string, bindings: readonly unknown[]): Promise<void>
}

interface InvoiceReminderContext {
  dueDate: string
  reminderPolicy: string | null
}

const canonicalTimestamp =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/

const assertCanonicalTimestamp = (value: string, field: string): void => {
  if (!canonicalTimestamp.test(value)) {
    throw new RangeError(`${field} must be a canonical UTC timestamp`)
  }
  const epoch = Date.parse(value)
  if (!Number.isFinite(epoch) || !Number.isSafeInteger(epoch)) {
    throw new RangeError(`${field} must be a real canonical UTC instant`)
  }
}

const addDays = (date: string, days: number): string => {
  const epoch = Date.parse(`${date}T00:00:00.000Z`)
  if (!Number.isSafeInteger(epoch)) {
    throw new RangeError('reminder base date is out of range')
  }
  const result = new Date(epoch + days * 86_400_000)
  return result.toISOString()
}

const parseReminderPolicy = (
  json: string | null,
): { first_after_days: number; every_days: number } | null => {
  if (json === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null
  }
  const policy = parsed as Record<string, unknown>
  if (
    typeof policy.first_after_days !== 'number' ||
    !Number.isSafeInteger(policy.first_after_days) ||
    policy.first_after_days < 0 ||
    typeof policy.every_days !== 'number' ||
    !Number.isSafeInteger(policy.every_days) ||
    policy.every_days < 1
  ) {
    return null
  }
  return {
    first_after_days: policy.first_after_days,
    every_days: policy.every_days,
  }
}

const scheduleReminder = async (
  database: ReminderDatabase,
  event: Readonly<OutboxEventRecord>,
  context: Readonly<OutboxSubscriberContext>,
): Promise<void> => {
  const invoice = await database.first<InvoiceReminderContext>(
    `SELECT due_date AS "dueDate", reminder_policy AS "reminderPolicy"
     FROM invoices WHERE id = ?`,
    [event.aggregateId],
  )
  if (invoice === null) return
  const policy = parseReminderPolicy(invoice.reminderPolicy)
  if (policy === null) return
  const scheduledAt = addDays(invoice.dueDate, policy.first_after_days)
  await database.run(
    `INSERT INTO scheduled_reminders (
      invoice_id, scheduled_at, interval_days, status, template,
      causation_event_id, created_at, updated_at
    )
    SELECT ?, ?, ?, 'pending', 'reminder', ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM scheduled_reminders
      WHERE invoice_id = ? AND status = 'pending'
    )`,
    [
      event.aggregateId,
      scheduledAt,
      policy.every_days,
      event.id,
      context.recordedAt,
      context.recordedAt,
      event.aggregateId,
    ],
  )
}

const cancelReminders = async (
  database: ReminderDatabase,
  event: Readonly<OutboxEventRecord>,
  context: Readonly<OutboxSubscriberContext>,
): Promise<void> => {
  await database.run(
    `UPDATE scheduled_reminders
     SET status = 'cancelled', updated_at = ?
     WHERE invoice_id = ? AND status = 'pending'`,
    [context.recordedAt, event.aggregateId],
  )
}

const createSubscriber = (database: ReminderDatabase): OutboxSubscriber => ({
  id: REMINDER_SUBSCRIBER_ID,
  async deliver(event, context) {
    if (context.signal.aborted) {
      throw new DOMException('reminder subscriber aborted', 'AbortError')
    }
    if (event.aggregateType !== 'invoice') return
    if (event.eventType === 'invoice.sent') {
      await scheduleReminder(database, event, context)
      return
    }
    if (cancellingEventTypes.has(event.eventType)) {
      await cancelReminders(database, event, context)
    }
  },
})

export interface ReminderScheduler {
  readonly subscriber: OutboxSubscriber
  processReminders(options: {
    now: string
    limit?: number
    send: (reminder: ScheduledReminderRecord) => Promise<void>
  }): Promise<ReminderProcessSummary>
  listPending(invoiceId?: number): Promise<ScheduledReminderRecord[]>
}

const createScheduler = (database: ReminderDatabase): ReminderScheduler => {
  const subscriber = createSubscriber(database)

  return {
    subscriber,

    async processReminders(options) {
      assertCanonicalTimestamp(options.now, 'reminder process clock')
      const limit = options.limit ?? 25
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new RangeError('reminder process limit must be between 1 and 100')
      }
      const summary: ReminderProcessSummary = {
        examined: 0,
        sent: 0,
        scheduled: 0,
      }
      const rows = await database.all<{
        id: number
        invoiceId: number
        scheduledAt: string
        intervalDays: number
        status: string
        template: string
        causationEventId: string
        createdAt: string
        updatedAt: string
      }>(
        `SELECT id, invoice_id AS "invoiceId", scheduled_at AS "scheduledAt",
          interval_days AS "intervalDays", status, template,
          causation_event_id AS "causationEventId",
          created_at AS "createdAt", updated_at AS "updatedAt"
        FROM scheduled_reminders
        WHERE status = 'pending' AND julianday(scheduled_at) <= julianday(?)
        ORDER BY scheduled_at, id
        LIMIT ?`,
        [options.now, limit],
      )
      for (const row of rows) {
        summary.examined += 1
        const reminder: ScheduledReminderRecord = {
          ...row,
          status: row.status as 'pending' | 'sent' | 'cancelled',
        }
        // Check the invoice is still in a state that warrants reminders
        const invoice = await database.first<{ state: string }>(
          `SELECT state FROM invoices WHERE id = ?`,
          [reminder.invoiceId],
        )
        if (invoice === null || invoice.state !== 'open') {
          await database.run(
            `UPDATE scheduled_reminders
             SET status = 'cancelled', updated_at = ?
             WHERE id = ? AND status = 'pending'`,
            [options.now, reminder.id],
          )
          continue
        }
        try {
          await options.send(reminder)
        } catch {
          continue
        }
        // Mark as sent
        await database.run(
          `UPDATE scheduled_reminders
           SET status = 'sent', updated_at = ?
           WHERE id = ? AND status = 'pending'`,
          [options.now, reminder.id],
        )
        summary.sent += 1
        // Schedule the next reminder
        const nextScheduledAt = addDays(
          reminder.scheduledAt.slice(0, 10),
          reminder.intervalDays,
        )
        await database.run(
          `INSERT INTO scheduled_reminders (
            invoice_id, scheduled_at, interval_days, status, template,
            causation_event_id, created_at, updated_at
          )
          SELECT ?, ?, ?, 'pending', ?, ?, ?, ?
          WHERE NOT EXISTS (
            SELECT 1 FROM scheduled_reminders
            WHERE invoice_id = ? AND status = 'pending'
          )
          AND EXISTS (
            SELECT 1 FROM invoices WHERE id = ? AND state = 'open'
          )`,
          [
            reminder.invoiceId,
            nextScheduledAt,
            reminder.intervalDays,
            reminder.template,
            `next:${reminder.id}`,
            options.now,
            options.now,
            reminder.invoiceId,
            reminder.invoiceId,
          ],
        )
        const next = await database.first<{ id: number }>(
          `SELECT id FROM scheduled_reminders
           WHERE invoice_id = ? AND status = 'pending'`,
          [reminder.invoiceId],
        )
        if (next !== null) summary.scheduled += 1
      }
      return summary
    },

    async listPending(invoiceId) {
      const query =
        invoiceId === undefined
          ? `SELECT id, invoice_id AS "invoiceId", scheduled_at AS "scheduledAt",
              interval_days AS "intervalDays", status, template,
              causation_event_id AS "causationEventId",
              created_at AS "createdAt", updated_at AS "updatedAt"
            FROM scheduled_reminders WHERE status = 'pending'
            ORDER BY scheduled_at, id LIMIT 100`
          : `SELECT id, invoice_id AS "invoiceId", scheduled_at AS "scheduledAt",
              interval_days AS "intervalDays", status, template,
              causation_event_id AS "causationEventId",
              created_at AS "createdAt", updated_at AS "updatedAt"
            FROM scheduled_reminders WHERE invoice_id = ? AND status = 'pending'
            ORDER BY scheduled_at, id LIMIT 100`
      const bindings = invoiceId === undefined ? [] : [invoiceId]
      const rows = await database.all<{
        id: number
        invoiceId: number
        scheduledAt: string
        intervalDays: number
        status: string
        template: string
        causationEventId: string
        createdAt: string
        updatedAt: string
      }>(query, bindings)
      return rows.map((row) => ({
        ...row,
        status: row.status as 'pending' | 'sent' | 'cancelled',
      }))
    },
  }
}

const containerAdapter = (
  database: BetterSqlite3.Database,
): ReminderDatabase => ({
  first: async <T>(query: string, bindings: readonly unknown[] = []) =>
    (database.prepare(query).get(...bindings) as T | undefined) ?? null,
  all: async <T>(query: string, bindings: readonly unknown[] = []) =>
    database.prepare(query).all(...bindings) as T[],
  run: async (query: string, bindings: readonly unknown[] = []) => {
    database.prepare(query).run(...bindings)
  },
})

const d1Adapter = (database: D1Database): ReminderDatabase => ({
  first: async <T>(query: string, bindings: readonly unknown[] = []) =>
    database
      .prepare(query)
      .bind(...bindings)
      .first<T>(),
  all: async <T>(query: string, bindings: readonly unknown[] = []) =>
    (
      await database
        .prepare(query)
        .bind(...bindings)
        .all<T>()
    ).results,
  run: async (query: string, bindings: readonly unknown[] = []) => {
    await database
      .prepare(query)
      .bind(...bindings)
      .run()
  },
})

export const createContainerReminderScheduler = (
  database: BetterSqlite3.Database,
): ReminderScheduler => createScheduler(containerAdapter(database))

export const createD1ReminderScheduler = (
  database: D1Database,
): ReminderScheduler => createScheduler(d1Adapter(database))
