const syncRequest = `INSERT INTO apple_deletion_subjects(request_id,subject_hash,origin,grant_id,generation,updated_at)
  SELECT id,NEW.subject_hash,NEW.origin,NEW.grant_id,NEW.generation,NEW.updated_at FROM account_deletion_requests
  WHERE user_id=NEW.user_id AND status<>'completed'
  ON CONFLICT(request_id,subject_hash) DO UPDATE SET origin=excluded.origin,grant_id=excluded.grant_id,generation=excluded.generation,updated_at=excluded.updated_at
  WHERE apple_deletion_subjects.generation IS NULL OR excluded.generation>apple_deletion_subjects.generation;`

export const appleLifecycleMigration = [
  `CREATE TABLE apple_identity_channels (
    subject_hash TEXT NOT NULL CHECK(length(subject_hash)=64),
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    channel TEXT NOT NULL CHECK(channel IN ('native','web')),
    known_from_first_link INTEGER NOT NULL CHECK(known_from_first_link IN (0,1)),
    PRIMARY KEY(subject_hash,user_id,channel)
  ) STRICT`,
  `CREATE TABLE apple_native_grants (
    subject_hash TEXT PRIMARY KEY CHECK(length(subject_hash)=64),
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    origin TEXT NOT NULL, grant_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation>0),
    binding_jti TEXT NOT NULL UNIQUE, updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE apple_deletion_subjects (
    request_id TEXT NOT NULL REFERENCES account_deletion_requests(id) ON DELETE RESTRICT,
    subject_hash TEXT NOT NULL CHECK(length(subject_hash)=64), origin TEXT, grant_id TEXT, generation INTEGER,
    updated_at TEXT NOT NULL, PRIMARY KEY(request_id,subject_hash),
    CHECK((origin IS NULL AND grant_id IS NULL AND generation IS NULL) OR (origin IS NOT NULL AND grant_id IS NOT NULL AND generation>0))
  ) STRICT`,
  `CREATE TABLE apple_deletion_unknown (
    request_id TEXT PRIMARY KEY REFERENCES account_deletion_requests(id) ON DELETE RESTRICT
  ) STRICT`,
  // Previous closures have only an aggregate Apple flag. One later proof cannot
  // establish that every historical identity was revoked.
  `INSERT INTO apple_deletion_unknown SELECT request_id FROM account_closures WHERE apple_cleanup='pending'`,
  `CREATE TABLE apple_revocation_events (
    request_id TEXT NOT NULL, subject_hash TEXT NOT NULL, origin TEXT NOT NULL,
    grant_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation>0),
    event_id TEXT NOT NULL UNIQUE, revoked_at TEXT NOT NULL, accepted_at TEXT NOT NULL,
    PRIMARY KEY(request_id,subject_hash,generation),
    FOREIGN KEY(request_id,subject_hash) REFERENCES apple_deletion_subjects(request_id,subject_hash) ON DELETE RESTRICT
  ) STRICT`,
  `CREATE TABLE apple_lifecycle_limits(window_minute INTEGER PRIMARY KEY,attempts INTEGER NOT NULL CHECK(attempts BETWEEN 1 AND 121)) STRICT`,
  ...['INSERT', 'UPDATE'].map(
    (
      operation,
    ) => `CREATE TRIGGER apple_native_grants_active_${operation.toLowerCase()} BEFORE ${operation} ON apple_native_grants
    WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND is_active=1) OR EXISTS(SELECT 1 FROM account_closures WHERE user_id=NEW.user_id)
    BEGIN SELECT RAISE(ABORT,'a closed account cannot receive an Apple grant'); END`,
  ),
  ...['INSERT', 'UPDATE'].map(
    (operation) =>
      `CREATE TRIGGER apple_native_grants_request_${operation.toLowerCase()} AFTER ${operation} ON apple_native_grants BEGIN
        INSERT INTO apple_identity_channels(subject_hash,user_id,channel,known_from_first_link) VALUES(NEW.subject_hash,NEW.user_id,'native',1) ON CONFLICT DO NOTHING;
        ${syncRequest} END`,
  ),
  `CREATE TRIGGER apple_request_capture AFTER INSERT ON account_deletion_requests BEGIN
    INSERT INTO apple_deletion_subjects(request_id,subject_hash,origin,grant_id,generation,updated_at)
      SELECT NEW.id,subject_hash,origin,grant_id,generation,NEW.requested_at FROM apple_native_grants WHERE user_id=NEW.user_id;
  END`,
  `CREATE TRIGGER apple_closure_capture AFTER INSERT ON account_closures BEGIN
    INSERT INTO apple_deletion_subjects(request_id,subject_hash,origin,grant_id,generation,updated_at)
      SELECT NEW.request_id,json_extract(key.value,'$.digest'),grant_record.origin,grant_record.grant_id,grant_record.generation,NEW.closed_at
      FROM json_each(NEW.replay_keys) key LEFT JOIN apple_native_grants grant_record ON grant_record.subject_hash=json_extract(key.value,'$.digest')
      WHERE json_extract(key.value,'$.provider')='apple' AND (grant_record.subject_hash IS NOT NULL OR NOT EXISTS(
        SELECT 1 FROM apple_identity_channels channel WHERE channel.subject_hash=json_extract(key.value,'$.digest') AND channel.user_id=NEW.user_id AND channel.channel='web' AND channel.known_from_first_link=1
          AND NOT EXISTS(SELECT 1 FROM apple_identity_channels native WHERE native.subject_hash=channel.subject_hash AND native.user_id=channel.user_id AND native.channel='native')))
      ON CONFLICT(request_id,subject_hash) DO NOTHING;
  END`,
  ...['UPDATE', 'DELETE'].map(
    (
      operation,
    ) => `CREATE TRIGGER apple_revocation_events_immutable_${operation.toLowerCase()} BEFORE ${operation} ON apple_revocation_events
    BEGIN SELECT RAISE(ABORT,'Apple revocation evidence is immutable'); END`,
  ),
  `CREATE TRIGGER apple_deletion_subjects_completed BEFORE UPDATE ON apple_deletion_subjects
    WHEN EXISTS(SELECT 1 FROM account_deletion_requests WHERE id=OLD.request_id AND status='completed')
    BEGIN SELECT RAISE(ABORT,'completed Apple cleanup cannot be rebound'); END`,
] as const
