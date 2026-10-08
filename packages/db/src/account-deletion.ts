import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import { captureActivityEvent } from './activity-log.js'

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>

/**
 * A person asking for their own account to be deleted.
 *
 * An app that lets an account be created has to let its person start the
 * account's deletion from inside it (App Store Guideline 5.1.1(v), and Google
 * Play's account deletion policy). An account on an instance belongs to the
 * organization that runs it, and what goes and what is kept is that
 * organization's retention decision, so the request is a request: it records
 * who asked and when, and names the administrators who decide. It deletes,
 * deactivates and changes nothing about the account itself. That is also what
 * keeps it safe on the public demo, whose published accounts every visitor
 * signs in as.
 *
 * The record is the activity log's, so the administrators read it where they
 * already read who signed in and who took an export, and it outlives any one
 * delivery of the mail that announces it.
 */

export interface AccountDeletionRequestInput {
  readonly userId: number
  readonly occurredAt: string
  /** The request's id: a retry of the same request records nothing new. */
  readonly captureId: string
}

export interface AccountDeletionRequestRecord {
  /** When the person first asked. Asking again keeps it. */
  readonly requestedAt: string
  /** False when this request id was already recorded: a retry, not a new ask. */
  readonly recorded: boolean
  readonly person: { readonly name: string; readonly email: string | null }
  /** Every active administrator's primary address: the people who decide. */
  readonly administrators: readonly string[]
}

export const requestAccountDeletion = async (
  database: Database,
  input: Readonly<AccountDeletionRequestInput>,
): Promise<AccountDeletionRequestRecord> => {
  const [person] = await database.all<{ name: string; email: string | null }>(sql`
    SELECT trim(person.first_name || ' ' || person.last_name) AS "name",
      (SELECT address FROM user_emails
        WHERE user_id = person.id AND is_primary = 1 AND invalidated_at IS NULL) AS "email"
    FROM users person WHERE person.id = ${input.userId}
  `)
  if (person === undefined) throw new RangeError('the person asking must exist')
  const capture = await captureActivityEvent(database, {
    eventType: 'account.deletion_requested',
    subjectId: input.userId,
    actor: { type: 'user', id: input.userId },
    occurredAt: input.occurredAt,
    captureId: input.captureId,
  })
  const [first] = await database.all<{ requestedAt: string }>(sql`
    SELECT min(occurred_at) AS "requestedAt" FROM event_outbox
    WHERE aggregate_type = 'user_account' AND aggregate_id = ${input.userId}
      AND event_type = 'account.deletion_requested'
  `)
  const administrators = await database.all<{ address: string }>(sql`
    SELECT DISTINCT address.address AS "address"
    FROM users admin
    JOIN user_emails address ON address.user_id = admin.id
      AND address.is_primary = 1 AND address.invalidated_at IS NULL
    WHERE admin.profile = 'administrator' AND admin.is_active = 1
    ORDER BY address.address
  `)
  return {
    requestedAt: first?.requestedAt ?? input.occurredAt,
    recorded: capture.captured,
    person: { name: person.name, email: person.email },
    administrators: administrators.map((row) => row.address),
  }
}
