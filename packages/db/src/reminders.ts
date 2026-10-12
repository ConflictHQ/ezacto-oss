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

/** Optional bounds for a resumable pass over a fixed set of reminder IDs.
 * Capture throughId and dueThrough before the first batch, then persist
 * lastExaminedId with the caller's transaction. The processing clock may be
 * later than the fixed due cutoff so newly booked overdue rows can be updated
 * without giving them an updated_at before their created_at.
 */
export interface ReminderProcessOptions {
  limit?: number
  selection?: { afterId: number; throughId: number; dueThrough?: string }
}

export interface ReminderProcessSummary {
  examined: number
  sent: number
  scheduled: number
  /** Present only when selection was supplied; includes failed/cancelled rows. */
  lastExaminedId?: number
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
  // The invoice's own policy where it has one, the organisation's default
  // where it does not (issue 801). Read at send time rather than copied onto
  // the invoice, so a default switched on today governs an invoice raised
  // yesterday and sent tomorrow.
  const invoice = await database.first<
    InvoiceReminderContext & { sendReminderOn: string | null; extras: string | null }
  >(
    `SELECT invoice.due_date AS "dueDate",
            COALESCE(invoice.reminder_policy, organization.reminder_policy) AS "reminderPolicy",
            invoice.invoice_extras AS "extras",
            (SELECT message.send_reminder_on FROM invoice_messages message
              WHERE message.invoice_id = invoice.id AND message.event_type = 'send'
              ORDER BY message.id DESC LIMIT 1) AS "sendReminderOn"
     FROM invoices invoice
     LEFT JOIN organizations organization ON organization.id = (
       SELECT id FROM organizations ORDER BY id LIMIT 1
     )
     WHERE invoice.id = ?`,
    [event.aggregateId],
  )
  if (invoice === null) return
  // The invoice's own "no reminders" (issue 850) beats a policy and a named
  // date alike: an operator who switched them off for this invoice, because
  // the client said they will pay, meant it.
  if (remindersMuted(invoice.extras)) return
  const namedDate =
    invoice.sendReminderOn !== null && /^\d{4}-\d{2}-\d{2}$/.test(invoice.sendReminderOn)
      ? invoice.sendReminderOn
      : null
  // A date named on the send is a decision even where no policy exists: the
  // composer has offered "send a reminder on" since the invoice screen shipped,
  // and an operator who picked one expects mail on it. Without a policy to
  // continue on, it repeats weekly until the invoice settles.
  const policy =
    parseReminderPolicy(invoice.reminderPolicy) ??
    (namedDate === null ? null : { first_after_days: 0, every_days: 7 })
  if (policy === null) return
  // The named date wins over the policy's own offset, which is the answer for a
  // send that did not choose.
  const scheduledAt =
    namedDate === null ? addDays(invoice.dueDate, policy.first_after_days) : addDays(namedDate, 0)
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

/** `invoice_extras.reminders === false`: this invoice asked for no reminders. */
export const remindersMuted = (extras: string | null): boolean => {
  if (extras === null) return false
  try {
    const parsed: unknown = JSON.parse(extras)
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as Record<string, unknown>).reminders === false
    )
  } catch {
    return false
  }
}

/**
 * Books a reminder for every open invoice that has a policy to book from and
 * nothing pending (issue 850). Two callers: the organisation policy being
 * set, which must reach the invoices already out rather than only the ones
 * sent from now on; and an invoice whose reminders are switched back on.
 * Muted invoices and invoices already carrying a pending reminder are left
 * as they are, so a second pass books nothing twice.
 *
 * The date is the policy's own -- due date plus the first offset -- even
 * where that is already past: an invoice a policy finds late is one the
 * policy would have reminded on by now, and the next daily pass sends it.
 */
const applyReminderPolicy = async (
  database: ReminderDatabase,
  options: { readonly now: string; readonly invoiceId?: number; readonly causation: string },
): Promise<number> => {
  assertCanonicalTimestamp(options.now, 'reminder apply clock')
  const rows = await database.all<
    InvoiceReminderContext & { id: number; extras: string | null }
  >(
    `SELECT invoice.id, invoice.due_date AS "dueDate",
            COALESCE(invoice.reminder_policy, organization.reminder_policy) AS "reminderPolicy",
            invoice.invoice_extras AS "extras"
     FROM invoices invoice
     LEFT JOIN organizations organization ON organization.id = (
       SELECT id FROM organizations ORDER BY id LIMIT 1
     )
     WHERE invoice.state = 'open'
       AND (? IS NULL OR invoice.id = ?)
       AND NOT EXISTS (
         SELECT 1 FROM scheduled_reminders pending
         WHERE pending.invoice_id = invoice.id AND pending.status = 'pending'
       )
     ORDER BY invoice.id`,
    [options.invoiceId ?? null, options.invoiceId ?? null],
  )
  let booked = 0
  for (const invoice of rows) {
    if (remindersMuted(invoice.extras)) continue
    const policy = parseReminderPolicy(invoice.reminderPolicy)
    if (policy === null) continue
    await database.run(
      `INSERT INTO scheduled_reminders (
        invoice_id, scheduled_at, interval_days, status, template,
        causation_event_id, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', 'reminder', ?, ?, ?)`,
      [
        invoice.id,
        addDays(invoice.dueDate, policy.first_after_days),
        policy.every_days,
        // Unique per row, as the schema asks of an event id; one apply pass
        // books many invoices, so the invoice is part of it.
        `${options.causation}:${String(invoice.id)}`,
        options.now,
        options.now,
      ],
    )
    booked += 1
  }
  return booked
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
  processReminders(options: ReminderProcessOptions & {
    now: string
    send: (reminder: ScheduledReminderRecord) => Promise<void>
  }): Promise<ReminderProcessSummary>
  listPending(invoiceId?: number): Promise<ScheduledReminderRecord[]>
  /** Books reminders for open invoices with a policy and nothing pending; how many. */
  applyPolicy(options: { now: string; invoiceId?: number; causation: string }): Promise<number>
  /** Cancels whatever is pending for one invoice; how many. */
  cancelPending(invoiceId: number, now: string): Promise<number>
}

const createScheduler = (database: ReminderDatabase): ReminderScheduler => {
  const subscriber = createSubscriber(database)

  return {
    subscriber,

    applyPolicy: (options) => applyReminderPolicy(database, options),

    async cancelPending(invoiceId, now) {
      assertCanonicalTimestamp(now, 'reminder cancel clock')
      const pending = await database.all<{ id: number }>(
        `SELECT id FROM scheduled_reminders WHERE invoice_id = ? AND status = 'pending'`,
        [invoiceId],
      )
      if (pending.length === 0) return 0
      await database.run(
        `UPDATE scheduled_reminders SET status = 'cancelled', updated_at = ?
         WHERE invoice_id = ? AND status = 'pending'`,
        [now, invoiceId],
      )
      return pending.length
    },

    async processReminders(options) {
      assertCanonicalTimestamp(options.now, 'reminder process clock')
      const limit = options.limit ?? 25
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new RangeError('reminder process limit must be between 1 and 100')
      }
      const selection = options.selection
      if (selection !== undefined && (!Number.isSafeInteger(selection.afterId) || selection.afterId < 0 ||
          !Number.isSafeInteger(selection.throughId) || selection.throughId < selection.afterId)) {
        throw new RangeError('reminder selection must contain ordered nonnegative safe integer IDs')
      }
      if (selection?.dueThrough !== undefined) {
        assertCanonicalTimestamp(selection.dueThrough, 'reminder due cutoff')
        if (Date.parse(selection.dueThrough) > Date.parse(options.now)) {
          throw new RangeError('reminder due cutoff cannot follow processing time')
        }
      }
      const summary: ReminderProcessSummary = {
        examined: 0,
        sent: 0,
        scheduled: 0,
        ...(selection === undefined ? {} : { lastExaminedId: selection.afterId }),
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
        ${selection === undefined ? '' : 'AND id > ? AND id <= ?'}
        ORDER BY ${selection === undefined ? 'scheduled_at, id' : 'id'}
        LIMIT ?`,
        [selection?.dueThrough ?? options.now,
          ...(selection === undefined ? [] : [selection.afterId, selection.throughId]), limit],
      )
      for (const row of rows) {
        summary.examined += 1
        if (selection !== undefined) summary.lastExaminedId = row.id
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
