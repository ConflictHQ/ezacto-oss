import type BetterSqlite3 from 'better-sqlite3'
import {
  EmailSuppressionError,
  type EmailSuppressionStore,
  type EmailSuppressionRecord,
  type EmailSuppressionLift,
  type EmailSuppressionReason,
} from '@ezacto/mailer/suppressions'
interface Portable {
  all<T>(query: string, bindings?: readonly unknown[]): Promise<T[]>
}
const active = `event.id>COALESCE((SELECT max(lift.through_event_id) FROM email_suppression_lifts lift WHERE lift.address=event.address),0)`
const projection = `max(event.id) AS id,event.address,
  CASE WHEN max(event.reason='complaint')=1 THEN 'complaint' ELSE 'bounce' END AS reason,
  min(event.created_at) AS firstSeenAt,max(event.created_at) AS lastSeenAt,count(*) AS events`
const positive = (value: number): boolean => Number.isSafeInteger(value) && value > 0
const create = (db: Portable): EmailSuppressionStore => ({
  async snapshot() {
    return (
      await db.all<{ id: number }>('SELECT coalesce(max(id),0) AS id FROM email_suppression_events')
    )[0]!.id
  },
  async list(input) {
    if (
      !Number.isSafeInteger(input.snapshot) ||
      input.snapshot < 0 ||
      !positive(input.take) ||
      input.take > 201 ||
      (input.after !== undefined && !positive(input.after))
    )
      throw new EmailSuppressionError('invalid', 'Invalid suppression page.')
    return db.all<EmailSuppressionRecord>(
      `SELECT * FROM (SELECT ${projection}
      FROM email_suppression_events event WHERE ${active} AND event.id<=? GROUP BY event.address)
      WHERE (? IS NULL OR id>?) ORDER BY id ASC LIMIT ?`,
      [input.snapshot, input.after ?? null, input.after ?? null, input.take],
    )
  },
  async lookup(recipients) {
    if (!recipients.length) return null
    const rows = await db.all<{ reason: EmailSuppressionReason }>(
      `SELECT CASE WHEN max(event.reason='complaint')=1 THEN 'complaint' ELSE 'bounce' END AS reason
      FROM email_suppression_events event WHERE ${active}
        AND event.address IN(SELECT value FROM json_each(?)) HAVING count(*)>0`,
      [JSON.stringify([...new Set(recipients.map((value) => value.trim().toLowerCase()))])],
    )
    return rows[0]?.reason ?? null
  },
  async lift(input, now) {
    if (
      !positive(input.eventId) ||
      !positive(input.actorId) ||
      !input.note.trim() ||
      input.note.trim().length > 1000
    )
      throw new EmailSuppressionError(
        'invalid',
        'Provide the reviewed suppression and a reason for allowing delivery again.',
      )
    const [actor] = await db.all<{ id: number }>(
      `SELECT id FROM users WHERE id=? AND is_active=1 AND profile='administrator'`,
      [input.actorId],
    )
    if (!actor)
      throw new EmailSuppressionError(
        'profile_forbidden',
        'Only an active administrator may allow delivery again.',
      )
    const [record] = await db.all<EmailSuppressionRecord>(
      `SELECT ${projection} FROM email_suppression_events event WHERE ${active}
      AND event.address=(SELECT address FROM email_suppression_events WHERE id=?) GROUP BY event.address`,
      [input.eventId],
    )
    if (!record)
      throw new EmailSuppressionError(
        'not_found',
        'This address is no longer suppressed. Refresh the list.',
      )
    if (record.id !== input.eventId)
      throw new EmailSuppressionError(
        'state_conflict',
        'New feedback arrived. Review the current evidence before allowing delivery again.',
      )
    if (record.reason === 'complaint' && input.confirmation.trim().toLowerCase() !== record.address)
      throw new EmailSuppressionError(
        'confirmation_required',
        'Type the suppressed email address to acknowledge its complaint.',
      )
    try {
      const [lift] = await db.all<
        Omit<EmailSuppressionLift, 'complaintAcknowledged'> & { complaintAcknowledged: number }
      >(
        `INSERT INTO email_suppression_lifts(address,through_event_id,actor_user_id,note,complaint_acknowledged,lifted_at)
        SELECT event.address,event.id,?,?,?,? FROM email_suppression_events event
        WHERE event.id=? AND ${active} AND event.id=(SELECT max(current.id) FROM email_suppression_events current WHERE current.address=event.address)
        RETURNING id,address,through_event_id AS throughEventId,actor_user_id AS actorId,note,complaint_acknowledged AS complaintAcknowledged,lifted_at AS liftedAt`,
        [
          input.actorId,
          input.note.trim(),
          record.reason === 'complaint' ? 1 : 0,
          now,
          input.eventId,
        ],
      )
      if (lift) return { ...lift, complaintAcknowledged: lift.complaintAcknowledged === 1 }
    } catch (error) {
      if (
        !/Suppression evidence or administrator authority changed|UNIQUE constraint failed: email_suppression_lifts/i.test(
          String(error),
        )
      )
        throw error
    }
    throw new EmailSuppressionError(
      'state_conflict',
      'Suppression evidence or administrator authority changed. Refresh and review again.',
    )
  },
})
export const createContainerEmailSuppressionStore = (
  db: BetterSqlite3.Database,
): EmailSuppressionStore =>
  create({
    all: async <T>(query: string, bindings: readonly unknown[] = []) =>
      db.prepare(query).all(...bindings) as T[],
  })
export const createD1EmailSuppressionStore = (db: D1Database): EmailSuppressionStore =>
  create({
    all: async <T>(query: string, bindings: readonly unknown[] = []) =>
      (
        await db
          .prepare(query)
          .bind(...bindings)
          .all<T>()
      ).results,
  })
