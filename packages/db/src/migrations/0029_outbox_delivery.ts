/**
 * Exported so the partition roll recreates the hot table with the same CHECK
 * rather than a retyped one. Copying a predicate by hand cost three separate
 * defects elsewhere in this repo, two of which loosened validation -- the
 * direction that does not announce itself.
 */
export const canonicalTimestamp = (column: string) => `unixepoch(${column}) IS NOT NULL
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

const nullableCanonicalTimestamp = (column: string) =>
  `${column} IS NULL OR (${canonicalTimestamp(column)})`

export const outboxDeliveryMigration = [
  `CREATE TABLE outbox_delivery_receipts (
    subscriber_id TEXT NOT NULL CHECK (
      length(subscriber_id) BETWEEN 1 AND 128
      AND subscriber_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
    event_id TEXT NOT NULL REFERENCES event_outbox(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
      status IN ('pending','processing','delivered','failed')
    ),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (
      attempt_count BETWEEN 0 AND 9007199254740991
    ),
    next_attempt_at TEXT,
    active_attempt_id TEXT CHECK (
      active_attempt_id IS NULL OR (
        length(active_attempt_id) BETWEEN 1 AND 128
        AND active_attempt_id NOT GLOB '*[^A-Za-z0-9._:-]*'
      )
    ),
    attempt_lease_expires_at TEXT,
    last_error_code TEXT CHECK (
      last_error_code IS NULL OR last_error_code IN (
        'subscriber_timeout','subscriber_rejected'
      )
    ),
    delivered_at TEXT,
    failed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (subscriber_id, event_id),
    CHECK (${nullableCanonicalTimestamp('next_attempt_at')}),
    CHECK (${nullableCanonicalTimestamp('attempt_lease_expires_at')}),
    CHECK (${nullableCanonicalTimestamp('delivered_at')}),
    CHECK (${nullableCanonicalTimestamp('failed_at')}),
    CHECK (${canonicalTimestamp('created_at')}),
    CHECK (${canonicalTimestamp('updated_at')}),
    CHECK ((active_attempt_id IS NULL) = (attempt_lease_expires_at IS NULL)),
    CHECK (julianday(updated_at) >= julianday(created_at)),
    CHECK (
      (status = 'pending' AND active_attempt_id IS NULL
        AND delivered_at IS NULL AND failed_at IS NULL)
      OR (status = 'processing' AND active_attempt_id IS NOT NULL
        AND next_attempt_at IS NULL AND delivered_at IS NULL AND failed_at IS NULL
        AND attempt_count > 0)
      OR (status = 'delivered' AND active_attempt_id IS NULL
        AND next_attempt_at IS NULL AND last_error_code IS NULL
        AND delivered_at IS NOT NULL AND failed_at IS NULL)
      OR (status = 'failed' AND active_attempt_id IS NULL
        AND next_attempt_at IS NULL AND last_error_code IS NOT NULL
        AND delivered_at IS NULL AND failed_at IS NOT NULL)
    )
  ) WITHOUT ROWID, STRICT`,
  `CREATE INDEX outbox_delivery_receipts_ready
    ON outbox_delivery_receipts(subscriber_id, status, next_attempt_at, updated_at, event_id)`,
  `CREATE INDEX outbox_delivery_receipts_failures
    ON outbox_delivery_receipts(status, failed_at DESC, subscriber_id, event_id)
    WHERE status = 'failed'`,
  `CREATE TABLE activity_log (
    event_id TEXT PRIMARY KEY REFERENCES event_outbox(id) ON DELETE RESTRICT,
    recorded_at TEXT NOT NULL CHECK (${canonicalTimestamp('recorded_at')})
  ) STRICT`,
  `CREATE INDEX activity_log_recorded_event
    ON activity_log(recorded_at DESC, event_id DESC)`,
  `CREATE TRIGGER outbox_delivery_receipts_identity_guard
    BEFORE INSERT ON outbox_delivery_receipts
    WHEN EXISTS (
      SELECT 1 FROM outbox_delivery_receipts current
      WHERE current.subscriber_id = NEW.subscriber_id
        AND current.event_id = NEW.event_id
    )
    BEGIN SELECT RAISE(ABORT, 'outbox delivery receipt identity already exists'); END`,
  `CREATE TRIGGER outbox_delivery_receipts_identity_immutable
    BEFORE UPDATE OF subscriber_id, event_id, created_at ON outbox_delivery_receipts
    WHEN OLD.subscriber_id IS NOT NEW.subscriber_id
      OR OLD.event_id IS NOT NEW.event_id
      OR OLD.created_at IS NOT NEW.created_at
    BEGIN SELECT RAISE(ABORT, 'outbox delivery receipt identity is immutable'); END`,
  `CREATE TRIGGER outbox_delivery_receipts_reject_delete
    BEFORE DELETE ON outbox_delivery_receipts
    BEGIN SELECT RAISE(ABORT, 'outbox delivery receipts are append-only'); END`,
  `CREATE TRIGGER outbox_delivery_receipts_delivered_immutable
    BEFORE UPDATE ON outbox_delivery_receipts
    WHEN OLD.status = 'delivered' AND (
      OLD.status IS NOT NEW.status OR OLD.attempt_count IS NOT NEW.attempt_count
      OR OLD.next_attempt_at IS NOT NEW.next_attempt_at
      OR OLD.active_attempt_id IS NOT NEW.active_attempt_id
      OR OLD.attempt_lease_expires_at IS NOT NEW.attempt_lease_expires_at
      OR OLD.last_error_code IS NOT NEW.last_error_code
      OR OLD.delivered_at IS NOT NEW.delivered_at
      OR OLD.failed_at IS NOT NEW.failed_at
      OR OLD.updated_at IS NOT NEW.updated_at
    )
    BEGIN SELECT RAISE(ABORT, 'delivered outbox receipt is immutable'); END`,
  `CREATE TRIGGER activity_log_identity_guard
    BEFORE INSERT ON activity_log
    WHEN EXISTS (SELECT 1 FROM activity_log current WHERE current.event_id = NEW.event_id)
    BEGIN SELECT RAISE(ABORT, 'activity log event already exists'); END`,
  `CREATE TRIGGER activity_log_immutable
    BEFORE UPDATE ON activity_log
    BEGIN SELECT RAISE(ABORT, 'activity log entries are immutable'); END`,
  `CREATE TRIGGER activity_log_reject_delete
    BEFORE DELETE ON activity_log
    BEGIN SELECT RAISE(ABORT, 'activity log entries are append-only'); END`,
] as const
