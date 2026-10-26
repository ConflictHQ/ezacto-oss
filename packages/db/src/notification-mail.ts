import { sql } from 'drizzle-orm'
import { runAtomic, type InvoiceStateDatabase } from './invoice-state.js'

/**
 * The ledger behind every notification ezacto mails to its own people: a
 * budget alert (issue 934), a time reminder (issue 935).
 *
 * One row per (kind, person, scope, period), and the key is the whole point. A
 * redelivered outbox event, a sweep that runs twice, two Workers racing the
 * same minute: each reaches the same key, and the schema refuses the second.
 * Nothing has to remember what was already sent, which is the only kind of
 * "sent once" that survives a crash.
 *
 * The message is recorded before it is queued, in one atomic batch with its
 * `email_log` row. A record with no send costs one reminder that the next pass
 * re-queues from the record; a send with no record costs a person two.
 */

export interface NotificationKey {
  /** A closed vocabulary in code: `budget_alert`, `time_reminder`, ... */
  readonly kind: string
  readonly userId: number
  /** What the notification is about (a project id), or '' for nothing in particular. */
  readonly scope: string
  /** What makes it a new occurrence: an alert id, a local date, a week start. */
  readonly period: string
}

export interface NotificationMailInput extends NotificationKey {
  readonly from: { readonly email: string; readonly name?: string }
  readonly to: { readonly email: string; readonly name: string }
  readonly template: string
  readonly subject: string
  readonly text: string
  readonly related?: { readonly type: string; readonly id: number }
  readonly now: string
}

export interface RecordedNotification {
  readonly deliveryId: number
  readonly from: { readonly email: string; readonly name?: string }
  readonly to: { readonly email: string; readonly name: string }
  readonly template: string
  readonly subject: string
  readonly text: string
  readonly related?: { readonly type: string; readonly id: number }
}

export type NotificationRecordOutcome =
  | { readonly outcome: 'recorded'; readonly notification: RecordedNotification }
  | { readonly outcome: 'already_recorded' }

interface LedgerRow {
  outcome: 'queued' | 'skipped'
  deliveryId: number | null
}

const readLedger = async (
  database: InvoiceStateDatabase,
  key: NotificationKey,
): Promise<LedgerRow | null> => {
  const rows = await database.all<LedgerRow>(
    sql`SELECT outcome AS outcome, delivery_id AS deliveryId FROM notification_deliveries
        WHERE kind = ${key.kind} AND user_id = ${key.userId}
          AND scope = ${key.scope} AND period = ${key.period}`,
  )
  return rows[0] ?? null
}

/** Whether this occurrence has been decided, by a send or by a recorded skip. */
export const notificationDecided = async (
  database: InvoiceStateDatabase,
  key: NotificationKey,
): Promise<boolean> => (await readLedger(database, key)) !== null

/**
 * Records the message and its ledger row, or answers that the occurrence was
 * already decided. Both rows or neither: the ledger points at the log, and a
 * log row with nothing explaining it is the record of a send nobody can trace.
 * Domain receipts (for example a single-use review link) may join the same
 * transaction after the notification row, without disturbing its log identity.
 */
export const recordNotificationMail = async (
  database: InvoiceStateDatabase,
  input: Readonly<NotificationMailInput>,
  additionalStatements: Parameters<typeof runAtomic>[1] = [],
): Promise<NotificationRecordOutcome> => {
  if ((await readLedger(database, input)) !== null) return { outcome: 'already_recorded' }
  const toJson = JSON.stringify([
    input.to.name === '' ? { email: input.to.email } : { email: input.to.email, name: input.to.name },
  ])
  try {
    await runAtomic(database, [
      {
        text: `INSERT INTO email_log (
            from_json, to_json, template, subject, related_type, related_id,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          JSON.stringify(input.from),
          toJson,
          input.template,
          input.subject,
          input.related?.type ?? null,
          input.related?.id ?? null,
          input.now,
          input.now,
        ],
      },
      {
        // `last_insert_rowid()` is the log row the statement above wrote: the
        // two run back to back in one transaction, and a trigger's own inserts
        // do not move it.
        text: `INSERT INTO notification_deliveries (
            kind, user_id, scope, period, outcome, delivery_id, to_email,
            subject, text_body, created_at
          ) VALUES (?, ?, ?, ?, 'queued', last_insert_rowid(), ?, ?, ?, ?)`,
        params: [
          input.kind,
          input.userId,
          input.scope,
          input.period,
          input.to.email,
          input.subject,
          input.text,
          input.now,
        ],
      },
      ...additionalStatements,
    ])
  } catch (error) {
    // Two evaluators racing the same occurrence: the second lost on the key and
    // its batch, log row included, rolled back. That is the design working.
    if ((await readLedger(database, input)) !== null) return { outcome: 'already_recorded' }
    throw error
  }
  const written = await readLedger(database, input)
  if (written?.deliveryId == null) {
    throw new Error('notification ledger row was not written')
  }
  return {
    outcome: 'recorded',
    notification: {
      deliveryId: written.deliveryId,
      from: input.from,
      to: input.to,
      template: input.template,
      subject: input.subject,
      text: input.text,
      ...(input.related === undefined ? {} : { related: input.related }),
    },
  }
}

/**
 * Records that an occurrence was looked at and deliberately not sent, with the
 * reason. A person who had tracked enough that day is decided; so is a sweep
 * that arrived hours late. Without the row the next minute would decide again,
 * and a reminder that was late once would arrive at midnight.
 */
export const recordNotificationSkip = async (
  database: InvoiceStateDatabase,
  key: NotificationKey,
  reason: string,
  now: string,
): Promise<boolean> => {
  if ((await readLedger(database, key)) !== null) return false
  try {
    await runAtomic(database, [
      {
        text: `INSERT INTO notification_deliveries (
            kind, user_id, scope, period, outcome, skip_reason, created_at
          ) VALUES (?, ?, ?, ?, 'skipped', ?, ?)`,
        params: [key.kind, key.userId, key.scope, key.period, reason, now],
      },
    ])
  } catch (error) {
    if ((await readLedger(database, key)) !== null) return false
    throw error
  }
  return true
}

interface QueuedLedgerRow {
  deliveryId: number
  userId: number
  scope: string
  period: string
  fromJson: string
  toEmail: string
  toJson: string
  template: string
  subject: string
  textBody: string
  relatedType: string | null
  relatedId: number | null
}

/**
 * The recorded messages of a kind that the log still says are queued: the ones
 * a queue failure or a crash between record and enqueue left behind. They are
 * re-queued from the record, never re-composed, so what a person receives is
 * what was decided when the occurrence was.
 *
 * `olderThan` keeps a pass from re-queueing a message another pass queued a
 * moment ago and the provider has not yet picked up. Re-queueing is harmless
 * (the log's lease and status make a second attempt a no-op), but it is noise.
 * `newerThan` is the other end: a reminder that has sat unsent for hours is no
 * longer the reminder it was, and is not queued again.
 */
export const readStrandedNotifications = async (
  database: InvoiceStateDatabase,
  filter: Readonly<{
    kind: string
    olderThan: string
    /** Messages recorded before this are stale: not worth sending any more. */
    newerThan?: string
    scope?: string
    period?: string
    limit?: number
  }>,
): Promise<readonly RecordedNotification[]> => {
  const rows = await database.all<QueuedLedgerRow>(
    sql`SELECT notification.delivery_id AS deliveryId, notification.user_id AS userId,
               notification.scope AS scope, notification.period AS period,
               log.from_json AS fromJson, log.to_json AS toJson,
               notification.to_email AS toEmail, log.template AS template,
               notification.subject AS subject, notification.text_body AS textBody,
               log.related_type AS relatedType, log.related_id AS relatedId
        FROM notification_deliveries notification
        JOIN email_log log ON log.id = notification.delivery_id
        WHERE notification.kind = ${filter.kind} AND notification.outcome = 'queued'
          AND log.status = 'queued' AND notification.created_at <= ${filter.olderThan}
          AND (${filter.newerThan ?? null} IS NULL OR notification.created_at >= ${filter.newerThan ?? null})
          AND (${filter.scope ?? null} IS NULL OR notification.scope = ${filter.scope ?? null})
          AND (${filter.period ?? null} IS NULL OR notification.period = ${filter.period ?? null})
        ORDER BY notification.delivery_id LIMIT ${filter.limit ?? -1}`,
  )
  return rows.map((row) => {
    const [to] = JSON.parse(row.toJson) as { email: string; name?: string }[]
    return {
      deliveryId: row.deliveryId,
      from: JSON.parse(row.fromJson) as { email: string; name?: string },
      to: { email: to?.email ?? row.toEmail, name: to?.name ?? '' },
      template: row.template,
      subject: row.subject,
      text: row.textBody,
      ...(row.relatedType === null || row.relatedId === null
        ? {}
        : { related: { type: row.relatedType, id: row.relatedId } }),
    }
  })
}
