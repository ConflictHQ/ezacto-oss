/** Explicit write policy, per-link consent and durable remote mutation journal. */
export const githubPublicationMigration = [
  `CREATE TABLE github_publication_instance(singleton INTEGER PRIMARY KEY CHECK(singleton=1),nonce TEXT NOT NULL CHECK(length(nonce)=64)) STRICT`,
  `INSERT INTO github_publication_instance VALUES(1,lower(hex(randomblob(32))))`,
  `CREATE TRIGGER github_publication_organization_erasure AFTER DELETE ON organizations BEGIN
    UPDATE github_publication_instance SET nonce=lower(hex(randomblob(32))) WHERE singleton=1;
    UPDATE github_publication_policy SET enabled=0,generation=generation+1;
  END`,
  `CREATE TABLE github_publication_dispatch (id INTEGER PRIMARY KEY CHECK(id=1), token TEXT, expires_at INTEGER NOT NULL DEFAULT 0, cooldown_until INTEGER NOT NULL DEFAULT 0) STRICT`,
  `INSERT INTO github_publication_dispatch(id) VALUES(1)`,
  `CREATE TABLE github_publication_assertions (token TEXT PRIMARY KEY, ok INTEGER NOT NULL CHECK(ok=1)) STRICT`,
  `CREATE TABLE github_publication_policy (
    connection_id TEXT PRIMARY KEY REFERENCES github_read_connections(id),
    enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
    generation INTEGER NOT NULL DEFAULT 1, marker TEXT NOT NULL CHECK(length(marker)=64),
    verified_app_id TEXT NOT NULL, verified_at TEXT NOT NULL, instance_nonce TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE github_publications (
    id INTEGER PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES github_read_connections(id),
    entry_id INTEGER NOT NULL, link_id INTEGER, repository_id TEXT NOT NULL, issue_id TEXT NOT NULL,
    issue_number TEXT NOT NULL, destination TEXT NOT NULL,
    desired_date TEXT, desired_seconds INTEGER, source_version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','attempted','published','ambiguous','conflicted','deferred','retired','failed','adopted','unlinked')),
    remote_id TEXT, last_body TEXT, last_date TEXT, last_seconds INTEGER, attempted_at INTEGER,
    pending_write TEXT CHECK(pending_write IS NULL OR json_valid(pending_write)),
    create_attempts INTEGER NOT NULL DEFAULT 0 CHECK(create_attempts BETWEEN 0 AND 2),
    retry_at INTEGER, next_due INTEGER NOT NULL DEFAULT 0, failure_code TEXT,
    fence INTEGER NOT NULL DEFAULT 0, lease_until INTEGER,
    UNIQUE(connection_id,entry_id,issue_id),
    CHECK((desired_date IS NULL)=(desired_seconds IS NULL))
  ) STRICT`,
  `CREATE INDEX github_publications_due ON github_publications(next_due,lease_until)`,
  `CREATE TABLE github_publication_receipts (
    command_id TEXT PRIMARY KEY, body_hash TEXT NOT NULL, actor_user_id INTEGER NOT NULL,
    operation TEXT NOT NULL, publication_id INTEGER, connection_id TEXT NOT NULL, occurred_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TRIGGER github_publication_receipt_immutable BEFORE UPDATE ON github_publication_receipts
    BEGIN SELECT RAISE(ABORT,'github_publication_receipt_immutable'); END`,
  `CREATE TRIGGER github_publication_receipt_retained BEFORE DELETE ON github_publication_receipts
    BEGIN SELECT RAISE(ABORT,'github_publication_receipt_retained'); END`,
  `CREATE TABLE github_publication_guards (token TEXT PRIMARY KEY, actor INTEGER NOT NULL, session_id INTEGER NOT NULL, now TEXT NOT NULL, administrator INTEGER NOT NULL) STRICT`,
  `CREATE TRIGGER github_publication_authority BEFORE INSERT ON github_publication_guards BEGIN
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM users u JOIN sessions s ON s.user_id=u.id
      WHERE u.id=NEW.actor AND u.is_active=1 AND s.id=NEW.session_id AND s.revoked_at IS NULL
        AND s.profile_snapshot=u.profile AND s.manager_grants_snapshot=u.manager_grants AND (NEW.administrator=0 OR u.profile='administrator')
        AND julianday(s.idle_expires_at)>julianday('now') AND julianday(s.absolute_expires_at)>julianday('now')
        AND NOT EXISTS(SELECT 1 FROM account_closures WHERE user_id=u.id))
      OR EXISTS(SELECT 1 FROM account_restore_quarantine WHERE id=1 AND quarantined=1)
      OR EXISTS(SELECT 1 FROM migration_loads WHERE status<>'completed' AND (status<>'cancelled' OR started_at IS NOT NULL))
      THEN RAISE(ABORT,'github_publication_forbidden') END;
  END`,
  `CREATE TRIGGER github_publication_subject_closed AFTER UPDATE OF is_active ON users
    WHEN NEW.is_active=0 AND OLD.is_active<>0 BEGIN
      UPDATE github_publications SET status='failed',failure_code='source_unavailable',source_version=source_version+1
      WHERE entry_id IN (SELECT id FROM time_entries WHERE user_id=NEW.id) AND desired_date IS NOT NULL AND status<>'unlinked';
    END`,
  `CREATE TRIGGER github_publication_entry_change AFTER UPDATE OF spent_date,seconds,project_id ON time_entries
    WHEN NEW.spent_date IS NOT OLD.spent_date OR NEW.seconds IS NOT OLD.seconds OR NEW.project_id IS NOT OLD.project_id BEGIN
    UPDATE github_publications SET desired_date=CASE WHEN NEW.project_id=OLD.project_id AND NEW.seconds>0 THEN NEW.spent_date END,
      desired_seconds=CASE WHEN NEW.project_id=OLD.project_id AND NEW.seconds>0 THEN NEW.seconds END,
      link_id=CASE WHEN NEW.project_id<>OLD.project_id THEN NULL ELSE link_id END,
      source_version=source_version+1,next_due=0,status=CASE WHEN status='adopted' THEN 'pending' ELSE status END
      WHERE entry_id=NEW.id AND link_id IS NOT NULL AND status<>'unlinked';
  END`,
  `CREATE TRIGGER github_publication_entry_delete BEFORE DELETE ON time_entries BEGIN
    UPDATE github_publications SET desired_date=NULL,desired_seconds=NULL,link_id=NULL,source_version=source_version+1,next_due=0
      WHERE entry_id=OLD.id AND status<>'unlinked';
  END`,
  `CREATE TRIGGER github_publication_link_delete BEFORE DELETE ON work_item_links BEGIN
    UPDATE github_publications SET desired_date=NULL,desired_seconds=NULL,link_id=NULL,source_version=source_version+1,next_due=0
      WHERE link_id=OLD.id AND status<>'unlinked';
  END`,
] as const
