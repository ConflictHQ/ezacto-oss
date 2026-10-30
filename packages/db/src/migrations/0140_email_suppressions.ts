// A provider event supplies immutable evidence. An administrator lift acknowledges
// exactly the evidence reviewed; later feedback reactivates the address.
const timestamp = (column: string) => `unixepoch(${column}) IS NOT NULL
  AND substr(${column},1,19)=strftime('%Y-%m-%dT%H:%M:%S',${column})
  AND (${column} GLOB '????-??-??T??:??:??Z' OR ${column} GLOB '????-??-??T??:??:??.[0-9][0-9][0-9]Z')`
const eligible = `SELECT feedback.event_id,
    lower(trim(feedback.recipient)) AS address,
    CASE feedback.event_type WHEN 'complained' THEN 'complaint' ELSE 'bounce' END AS reason,
    feedback.processed_at
  FROM email_feedback_events feedback JOIN email_log message ON message.id=feedback.delivery_id
  WHERE feedback.processed_at IS NOT NULL
    AND (feedback.event_type='complained' OR (feedback.event_type='failed' AND feedback.severity='permanent'))
    AND EXISTS (SELECT 1 FROM json_each(message.to_json) person
      WHERE json_extract(person.value,'$.email')=lower(trim(feedback.recipient))
      UNION ALL SELECT 1 FROM json_each(message.cc_json) person
      WHERE json_extract(person.value,'$.email')=lower(trim(feedback.recipient)))`
export const emailSuppressionsMigration = [
  `CREATE TABLE email_suppression_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_event_id TEXT NOT NULL UNIQUE REFERENCES email_feedback_events(event_id) ON DELETE RESTRICT,
    address TEXT NOT NULL CHECK(length(address) BETWEEN 3 AND 254 AND address=lower(trim(address))),
    reason TEXT NOT NULL CHECK(reason IN('bounce','complaint')),
    created_at TEXT NOT NULL CHECK(${timestamp('created_at')})
  ) STRICT`,
  `CREATE INDEX email_suppression_events_address ON email_suppression_events(address,id)`,
  `CREATE TABLE email_suppression_lifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT NOT NULL,
    through_event_id INTEGER NOT NULL UNIQUE REFERENCES email_suppression_events(id) ON DELETE RESTRICT,
    actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    note TEXT NOT NULL CHECK(length(trim(note)) BETWEEN 1 AND 1000),
    complaint_acknowledged INTEGER NOT NULL CHECK(complaint_acknowledged IN(0,1)),
    lifted_at TEXT NOT NULL CHECK(${timestamp('lifted_at')})
  ) STRICT`,
  `CREATE INDEX email_suppression_lifts_address ON email_suppression_lifts(address,through_event_id)`,
  `CREATE TRIGGER email_suppression_lift_guard BEFORE INSERT ON email_suppression_lifts
    WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.actor_user_id AND is_active=1 AND profile='administrator')
      OR NOT EXISTS(SELECT 1 FROM email_suppression_events event WHERE event.id=NEW.through_event_id AND event.address=NEW.address
        AND event.id=(SELECT max(current.id) FROM email_suppression_events current WHERE current.address=event.address)
        AND event.created_at<=NEW.lifted_at)
      OR (NEW.complaint_acknowledged=0 AND EXISTS(SELECT 1 FROM email_suppression_events event
        WHERE event.address=NEW.address AND event.reason='complaint'
          AND event.id>COALESCE((SELECT max(lift.through_event_id) FROM email_suppression_lifts lift WHERE lift.address=NEW.address),0)))
    BEGIN SELECT RAISE(ABORT,'Suppression evidence or administrator authority changed'); END`,
  ...['email_suppression_events', 'email_suppression_lifts'].flatMap((table) => [
    `CREATE TRIGGER ${table}_immutable BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Email suppression evidence is immutable'); END`,
    `CREATE TRIGGER ${table}_append_only BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Email suppression evidence is append-only'); END`,
  ]),
  `INSERT INTO email_suppression_events(provider_event_id,address,reason,created_at) ${eligible} ORDER BY processed_at,event_id`,
  `CREATE TRIGGER email_feedback_suppression AFTER UPDATE OF processed_at ON email_feedback_events
    WHEN OLD.processed_at IS NULL AND NEW.processed_at IS NOT NULL
    BEGIN INSERT INTO email_suppression_events(provider_event_id,address,reason,created_at)
      ${eligible} AND feedback.event_id=NEW.event_id ON CONFLICT(provider_event_id) DO NOTHING; END`,
] as const
