// Provenance: ezacto-pvt #42, slice B. What Mailgun told us about a message.
//
// Mailgun delivers events at least once and out of order, and the only thing
// that makes a post ours to act on is a signature over its timestamp and token.
// The signature does not cover the body, so the token is spent here: a row per
// verified event, keyed on Mailgun's event id, with the token unique. A retry
// is the same event again and finds its row; a captured signature carried by a
// different event finds its token already taken and is refused.
//
// Every verified event is recorded, including those nothing was done about
// (`outcome = 'ignored'`, with why). "Ignored" is a different fact from "never
// arrived", and the difference is what somebody reads when a bounce does not
// show on a message. `processed_at` stays null between accepting an event and
// finishing it, so a crash in between is visible and the retry resumes it.
//
// Nothing here touches email_log's table definition: a message moves through
// the statuses it already has.
const canonicalTimestamp = (column: string) => `unixepoch(${column}) IS NOT NULL
  AND substr(${column}, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', ${column})
  AND (
    ${column} GLOB '????-??-??T??:??:??Z'
    OR ${column} GLOB '????-??-??T??:??:??.[0-9][0-9][0-9]Z'
  )`

export const emailFeedbackEventsMigration = [
  `CREATE TABLE email_feedback_events (
    event_id TEXT PRIMARY KEY CHECK (length(trim(event_id)) BETWEEN 1 AND 255),
    signature_token TEXT NOT NULL UNIQUE
      CHECK (length(trim(signature_token)) BETWEEN 1 AND 255),
    event_type TEXT NOT NULL CHECK (length(trim(event_type)) BETWEEN 1 AND 64),
    severity TEXT CHECK (severity IS NULL OR length(severity) <= 32),
    recipient TEXT CHECK (recipient IS NULL OR length(recipient) <= 320),
    provider_message_id TEXT
      CHECK (provider_message_id IS NULL OR length(provider_message_id) <= 512),
    -- The message the event was matched to, where it was ours.
    delivery_id INTEGER REFERENCES email_log(id) ON DELETE RESTRICT,
    received_at TEXT NOT NULL CHECK (${canonicalTimestamp('received_at')}),
    processed_at TEXT
      CHECK (processed_at IS NULL OR (${canonicalTimestamp('processed_at')})),
    outcome TEXT CHECK (outcome IS NULL OR outcome IN ('bounced', 'complained', 'delivered', 'ignored')),
    detail TEXT CHECK (detail IS NULL OR length(detail) <= 255),
    CHECK ((processed_at IS NULL) = (outcome IS NULL)),
    CHECK (processed_at IS NULL OR processed_at >= received_at)
  ) STRICT`,

  `CREATE INDEX email_feedback_events_unprocessed
    ON email_feedback_events(received_at)
    WHERE processed_at IS NULL`,

  `CREATE INDEX email_feedback_events_delivery
    ON email_feedback_events(delivery_id)
    WHERE delivery_id IS NOT NULL`,

  // What arrived is the record of what arrived. Only the disposition may be
  // written after the fact.
  `CREATE TRIGGER email_feedback_events_immutable
    BEFORE UPDATE OF event_id, signature_token, event_type, severity, recipient,
      provider_message_id, delivery_id, received_at ON email_feedback_events
    BEGIN SELECT RAISE(ABORT, 'a recorded email feedback event is immutable'); END`,
] as const
