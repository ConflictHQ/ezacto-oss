import { emailLogMigration } from './0016_email_log.js'
import { emailDeliveryDetailsMigration } from './0017_email_delivery_details.js'
import { emailTemplatesMigration } from './0030_email_templates.js'

/**
 * `suppressed`: a message that was recorded and deliberately never handed to
 * a transport (#931).
 *
 * The public demo prints its own administrator's password on its front page,
 * so anything it can send, anyone can send -- from the verified domain the
 * operator's real mail goes out on. On the demo every message is logged and
 * stopped instead, which keeps the history honest ("this would have gone to
 * them") without one of them reaching Mailgun or SES. `failed` would say a
 * transport refused it and `queued` would say it is still on its way; neither
 * is true, so the state gets a name of its own. It is terminal: nothing that
 * was suppressed is delivered later.
 *
 * SQLite cannot widen a CHECK in place, so the table is rebuilt -- and it is a
 * parent, which rules out both rebuilds the earlier migrations used. Four
 * tables point at it with ON DELETE RESTRICT, and foreign keys are on here and
 * always on in D1: renaming `email_log` away rewrites those REFERENCES to
 * follow the new name, and dropping it under immediate enforcement is refused.
 *
 * So the rows are copied aside, the table is dropped and created again under
 * its own name with `defer_foreign_keys` on, and the rows go back in. The drop
 * counts every child row it orphans; each row put back finds its children and
 * takes them off the count again. The pragma is deliberately never switched
 * off: switching it off forgives whatever is outstanding, and this relies on
 * the commit checking that nothing is.
 *
 * The drop takes every trigger and index on the table with it. They are put
 * back from the text of the migrations that made them rather than retyped, so
 * what is restored is what was there -- except the status transition guard,
 * which is the one rule this changes, extended by replacement and asserted
 * first the way 0037 extended 0026.
 */

/** The single statement in `statements` that starts with `prefix`, or the migration does not build. */
const original = (statements: readonly string[], prefix: string): string => {
  const found = statements.filter((statement) => statement.startsWith(prefix))
  if (found.length !== 1) {
    throw new Error(`email log suppressed migration could not find ${prefix}`)
  }
  return found[0]!
}

const queuedTransition = `(OLD.status = 'queued' AND NEW.status IN ('sent','failed'))`
const historicalTransitionGuard = original(
  emailLogMigration,
  'CREATE TRIGGER email_log_status_transition_guard',
)
if (historicalTransitionGuard.split(queuedTransition).length - 1 !== 1) {
  throw new Error('email log suppressed migration found an unexpected transition guard')
}

const canonicalTimestamp = (column: string) => `unixepoch(${column}) IS NOT NULL
  AND substr(${column}, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', ${column})
  AND CAST(substr(${column}, 12, 2) AS INTEGER) BETWEEN 0 AND 23
  AND CAST(substr(${column}, 15, 2) AS INTEGER) BETWEEN 0 AND 59
  AND CAST(substr(${column}, 18, 2) AS INTEGER) BETWEEN 0 AND 59
  AND (
    ${column} GLOB '????-??-??T??:??:??Z'
    OR ${column} GLOB '????-??-??T??:??:??.[0-9]Z'
    OR ${column} GLOB '????-??-??T??:??:??.[0-9][0-9]Z'
    OR ${column} GLOB '????-??-??T??:??:??.[0-9][0-9][0-9]Z'
  )`

/** The table's own column order: 0016's, then what 0017, 0030 and 0099 appended. */
const columns = `id, to_json, template, subject, provider, provider_message_id, status,
    related_type, related_id, attempt_count, active_attempt_id, attempt_lease_expires_at,
    failure_code, created_at, updated_at, provider_request_id, provider_latency_ms,
    failure_reason, from_json, reply_to_json, cc_json`

export const emailLogSuppressedMigration = [
  `PRAGMA defer_foreign_keys = ON`,
  `CREATE TABLE email_log_0099 AS SELECT ${columns} FROM email_log`,
  `DROP TABLE email_log`,
  `CREATE TABLE email_log (
    id INTEGER PRIMARY KEY,
    to_json TEXT NOT NULL CHECK (
      json_valid(to_json) AND json_type(to_json) = 'array'
      AND json_array_length(to_json) BETWEEN 1 AND 100
    ),
    template TEXT NOT NULL CHECK (length(trim(template)) BETWEEN 1 AND 128),
    subject TEXT NOT NULL CHECK (length(trim(subject)) BETWEEN 1 AND 998),
    provider TEXT CHECK (provider IS NULL OR length(trim(provider)) BETWEEN 1 AND 128),
    provider_message_id TEXT CHECK (
      provider_message_id IS NULL OR length(trim(provider_message_id)) BETWEEN 1 AND 512
    ),
    status TEXT NOT NULL DEFAULT 'queued' CHECK (
      status IN ('queued','sent','bounced','complained','failed','suppressed')
    ),
    related_type TEXT CHECK (
      related_type IS NULL OR length(trim(related_type)) BETWEEN 1 AND 128
    ),
    related_id INTEGER CHECK (
      related_id IS NULL OR related_id BETWEEN 1 AND 9007199254740991
    ),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (
      attempt_count BETWEEN 0 AND 9007199254740991
    ),
    active_attempt_id TEXT CHECK (
      active_attempt_id IS NULL OR (
        length(active_attempt_id) BETWEEN 1 AND 128
        AND active_attempt_id NOT GLOB '*[^A-Za-z0-9._:-]*'
      )
    ),
    attempt_lease_expires_at TEXT CHECK (
      attempt_lease_expires_at IS NULL OR (${canonicalTimestamp('attempt_lease_expires_at')})
    ),
    failure_code TEXT CHECK (
      failure_code IS NULL OR failure_code IN (
        'queue_unavailable','provider_timeout','provider_rejected'
      )
    ),
    created_at TEXT NOT NULL CHECK (${canonicalTimestamp('created_at')}),
    updated_at TEXT NOT NULL CHECK (${canonicalTimestamp('updated_at')}),
    provider_request_id TEXT CHECK (
      provider_request_id IS NULL OR length(trim(provider_request_id)) BETWEEN 1 AND 512
    ),
    provider_latency_ms INTEGER CHECK (
      provider_latency_ms IS NULL OR provider_latency_ms BETWEEN 0 AND 3000000
    ),
    failure_reason TEXT CHECK (
      failure_reason IS NULL OR (
        length(failure_reason) BETWEEN 1 AND 128
        AND failure_reason NOT GLOB '*[^A-Za-z0-9_:]*'
      )
    ),
    from_json TEXT CHECK (
      from_json IS NULL OR (json_valid(from_json) AND json_type(from_json) = 'object')
    ),
    reply_to_json TEXT CHECK (
      reply_to_json IS NULL OR (json_valid(reply_to_json) AND json_type(reply_to_json) = 'array')
    ),
    cc_json TEXT CHECK (
      cc_json IS NULL OR (
        json_valid(cc_json) AND json_type(cc_json) = 'array'
        AND json_array_length(cc_json) BETWEEN 1 AND 99
      )
    ),
    CHECK ((related_type IS NULL) = (related_id IS NULL)),
    CHECK ((active_attempt_id IS NULL) = (attempt_lease_expires_at IS NULL)),
    CHECK (active_attempt_id IS NULL OR (
      status = 'queued' AND provider IS NOT NULL AND attempt_count > 0
    )),
    CHECK (julianday(updated_at) >= julianday(created_at)),
    CHECK (
      (status = 'queued' AND provider_message_id IS NULL AND failure_code IS NULL)
      OR (status = 'sent' AND provider IS NOT NULL AND provider_message_id IS NOT NULL
        AND failure_code IS NULL AND active_attempt_id IS NULL)
      OR (status IN ('bounced','complained') AND provider IS NOT NULL
        AND provider_message_id IS NOT NULL AND failure_code IS NULL
        AND active_attempt_id IS NULL)
      OR (status = 'failed' AND provider_message_id IS NULL AND failure_code IS NOT NULL
        AND active_attempt_id IS NULL)
      OR (status = 'suppressed' AND provider_message_id IS NULL AND failure_code IS NULL
        AND active_attempt_id IS NULL)
    )
  ) STRICT`,
  `INSERT INTO email_log (${columns}) SELECT ${columns} FROM email_log_0099`,
  `DROP TABLE email_log_0099`,
  original(emailLogMigration, 'CREATE INDEX email_log_status_created_id'),
  original(emailLogMigration, 'CREATE INDEX email_log_related_created_id'),
  original(emailLogMigration, 'CREATE INDEX email_log_provider_message_id'),
  original(emailLogMigration, 'CREATE TRIGGER email_log_recipients_guard'),
  original(emailLogMigration, 'CREATE TRIGGER email_log_id_collision_guard'),
  original(emailLogMigration, 'CREATE TRIGGER email_log_metadata_immutable'),
  historicalTransitionGuard.replace(
    queuedTransition,
    `(OLD.status = 'queued' AND NEW.status IN ('sent','failed','suppressed'))`,
  ),
  original(emailDeliveryDetailsMigration, 'CREATE TRIGGER email_log_delivery_details_guard'),
  original(emailDeliveryDetailsMigration, 'CREATE TRIGGER email_log_delivery_details_insert_guard'),
  original(emailTemplatesMigration, 'CREATE TRIGGER email_log_sender_metadata_immutable'),
  original(emailTemplatesMigration, 'CREATE TRIGGER email_log_sender_metadata_guard'),
] as const
