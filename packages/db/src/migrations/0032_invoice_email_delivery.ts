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

/** Immutable confirmation snapshots plus one durable provider receipt per recipient. */
export const invoiceEmailDeliveryMigration = [
  `CREATE TABLE invoice_email_intents (
    invoice_message_id INTEGER PRIMARY KEY
      REFERENCES invoice_messages(id) ON DELETE RESTRICT,
    event_id TEXT NOT NULL UNIQUE
      REFERENCES event_outbox(id) ON DELETE RESTRICT,
    template_kind TEXT NOT NULL CHECK (template_kind = 'invoice'),
    template_version INTEGER NOT NULL CHECK (
      template_version BETWEEN 1 AND 9007199254740991
    ),
    sender_identity_id INTEGER NOT NULL
      REFERENCES sender_identities(id) ON DELETE RESTRICT,
    sender_identity_version INTEGER NOT NULL CHECK (
      sender_identity_version BETWEEN 0 AND 9007199254740991
    ),
    sender_evidence_version INTEGER NOT NULL CHECK (
      sender_evidence_version BETWEEN 1 AND 9007199254740991
    ),
    from_name TEXT NOT NULL CHECK (length(trim(from_name)) BETWEEN 1 AND 200),
    from_email TEXT NOT NULL CHECK (length(trim(from_email)) BETWEEN 3 AND 254),
    reply_to_email TEXT CHECK (
      reply_to_email IS NULL OR length(trim(reply_to_email)) BETWEEN 3 AND 254
    ),
    subject TEXT NOT NULL CHECK (length(trim(subject)) BETWEEN 1 AND 998),
    text_body TEXT NOT NULL CHECK (length(trim(text_body)) BETWEEN 1 AND 1000000),
    html_body TEXT CHECK (
      html_body IS NULL OR length(trim(html_body)) BETWEEN 1 AND 2000000
    ),
    confirmed_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    confirmed_at TEXT NOT NULL CHECK (${canonicalTimestamp('confirmed_at')}),
    FOREIGN KEY (template_kind, template_version)
      REFERENCES email_template_versions(template_kind, version) ON DELETE RESTRICT,
    FOREIGN KEY (sender_identity_id, sender_evidence_version)
      REFERENCES sender_identity_evidence(sender_identity_id, evidence_version)
      ON DELETE RESTRICT
  ) STRICT`,
  `CREATE TABLE invoice_email_recipients (
    invoice_message_id INTEGER NOT NULL
      REFERENCES invoice_email_intents(invoice_message_id) ON DELETE RESTRICT,
    recipient_index INTEGER NOT NULL CHECK (recipient_index BETWEEN 0 AND 999),
    delivery_id INTEGER NOT NULL UNIQUE REFERENCES email_log(id) ON DELETE RESTRICT,
    name TEXT NOT NULL CHECK (length(name) <= 200),
    email TEXT NOT NULL COLLATE NOCASE CHECK (
      length(email) BETWEEN 3 AND 254 AND email = lower(trim(email))
      AND instr(email, ' ') = 0 AND instr(email, '@') > 1
      AND instr(substr(email, instr(email, '@') + 1), '@') = 0
      AND instr(substr(email, instr(email, '@') + 1), '.') > 1
    ),
    created_at TEXT NOT NULL CHECK (${canonicalTimestamp('created_at')}),
    PRIMARY KEY (invoice_message_id, recipient_index),
    UNIQUE (invoice_message_id, email)
  ) STRICT`,
  `CREATE INDEX invoice_email_recipients_message
    ON invoice_email_recipients(invoice_message_id, recipient_index)`,
  `CREATE TRIGGER invoice_email_intents_no_update BEFORE UPDATE ON invoice_email_intents
    BEGIN SELECT RAISE(ABORT, 'invoice email intent is immutable'); END`,
  `CREATE TRIGGER invoice_email_intents_no_delete BEFORE DELETE ON invoice_email_intents
    BEGIN SELECT RAISE(ABORT, 'invoice email intent is immutable'); END`,
  `CREATE TRIGGER invoice_email_recipients_no_update BEFORE UPDATE ON invoice_email_recipients
    BEGIN SELECT RAISE(ABORT, 'invoice email recipient receipt is immutable'); END`,
  `CREATE TRIGGER invoice_email_recipients_no_delete BEFORE DELETE ON invoice_email_recipients
    BEGIN SELECT RAISE(ABORT, 'invoice email recipient receipt is immutable'); END`,
] as const
