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

export const emailLogMigration = [
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
      status IN ('queued','sent','bounced','complained','failed')
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
    )
  ) STRICT`,
  `CREATE INDEX email_log_status_created_id
    ON email_log(status, created_at DESC, id DESC)`,
  `CREATE INDEX email_log_related_created_id
    ON email_log(related_type, related_id, created_at DESC, id DESC)
    WHERE related_type IS NOT NULL`,
  `CREATE INDEX email_log_provider_message_id
    ON email_log(provider, provider_message_id)
    WHERE provider_message_id IS NOT NULL`,
  `CREATE TRIGGER email_log_recipients_guard BEFORE INSERT ON email_log
    WHEN EXISTS (
      SELECT 1 FROM json_each(NEW.to_json) recipient
      WHERE recipient.type <> 'object'
        OR (SELECT count(*) FROM json_each(recipient.value) field
          WHERE field.key = 'email') <> 1
        OR json_type(recipient.value, '$.email') IS NOT 'text'
        OR length(trim(json_extract(recipient.value, '$.email'))) NOT BETWEEN 3 AND 254
        OR (SELECT count(*) FROM json_each(recipient.value) field
          WHERE field.key = 'name') > 1
        OR EXISTS (
          SELECT 1 FROM json_each(recipient.value) field
          WHERE field.key NOT IN ('email','name')
        )
        OR (json_type(recipient.value, '$.name') IS NOT NULL
          AND json_type(recipient.value, '$.name') <> 'text')
    )
    BEGIN SELECT RAISE(ABORT, 'email log recipients are invalid'); END`,
  `CREATE TRIGGER email_log_id_collision_guard BEFORE INSERT ON email_log
    WHEN EXISTS (SELECT 1 FROM email_log current WHERE current.id = NEW.id)
    BEGIN SELECT RAISE(ABORT, 'email log identity collision cannot replace delivery'); END`,
  `CREATE TRIGGER email_log_metadata_immutable
    BEFORE UPDATE OF id, to_json, template, subject, related_type, related_id, created_at
    ON email_log
    WHEN OLD.id IS NOT NEW.id OR OLD.to_json IS NOT NEW.to_json
      OR OLD.template IS NOT NEW.template OR OLD.subject IS NOT NEW.subject
      OR OLD.related_type IS NOT NEW.related_type OR OLD.related_id IS NOT NEW.related_id
      OR OLD.created_at IS NOT NEW.created_at
    BEGIN SELECT RAISE(ABORT, 'email log message metadata is immutable'); END`,
  `CREATE TRIGGER email_log_status_transition_guard
    BEFORE UPDATE OF status ON email_log
    WHEN OLD.status IS NOT NEW.status AND NOT (
      (OLD.status = 'queued' AND NEW.status IN ('sent','failed'))
      OR (OLD.status = 'sent' AND NEW.status IN ('bounced','complained'))
    )
    BEGIN SELECT RAISE(ABORT, 'email log delivery status transition is invalid'); END`,
] as const
