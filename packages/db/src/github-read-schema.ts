/** Internal schema component. Registered by the next coordinated dense migration. */
export const githubReadSchema = [
  `CREATE TABLE github_read_connections (
    id TEXT PRIMARY KEY, installation_id TEXT NOT NULL, account_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','disconnecting','disconnected','revoked')),
    generation INTEGER NOT NULL DEFAULT 1 CHECK(generation>0),
    cooldown INTEGER, failure_code TEXT,
    CHECK(cooldown IS NULL OR cooldown>=0)
  ) STRICT`,
  `CREATE TABLE github_read_resources (
    connection_id TEXT NOT NULL REFERENCES github_read_connections(id), repository_id TEXT NOT NULL,
    full_name TEXT, project_id INTEGER REFERENCES projects(id), task_id INTEGER REFERENCES tasks(id),
    state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','renamed','transferred','deleted','access_lost')),
    PRIMARY KEY(connection_id,repository_id)
  ) STRICT`,
  `CREATE TABLE github_read_items (
    connection_id TEXT NOT NULL REFERENCES github_read_connections(id), issue_id TEXT NOT NULL,
    repository_id TEXT NOT NULL, metadata TEXT NOT NULL CHECK(json_valid(metadata)),
    outcome TEXT NOT NULL CHECK(outcome IN ('inserted','updated','unchanged','stale')),
    PRIMARY KEY(connection_id,issue_id)
  ) STRICT`,
  `CREATE TABLE github_read_aliases (
    connection_id TEXT NOT NULL, issue_id TEXT NOT NULL, alias TEXT NOT NULL COLLATE NOCASE,
    PRIMARY KEY(connection_id,issue_id,alias),
    FOREIGN KEY(connection_id,issue_id) REFERENCES github_read_items(connection_id,issue_id) ON DELETE CASCADE
  ) STRICT`,
  `CREATE INDEX github_read_alias_lookup ON github_read_aliases(connection_id,alias)`,
  `CREATE TABLE github_read_checkpoints (
    connection_id TEXT NOT NULL REFERENCES github_read_connections(id), repository_id TEXT NOT NULL,
    cursor TEXT, watermark TEXT, version INTEGER NOT NULL CHECK(version>0),
    status TEXT NOT NULL CHECK(status IN ('running','complete')), token TEXT NOT NULL,
    PRIMARY KEY(connection_id,repository_id)
  ) STRICT`,
  `CREATE TABLE github_read_deliveries (
    connection_id TEXT NOT NULL REFERENCES github_read_connections(id), delivery_id TEXT NOT NULL,
    generation INTEGER NOT NULL DEFAULT 1, body_hash TEXT, effect TEXT CHECK(effect IS NULL OR json_valid(effect)),
    state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','applied')),
    PRIMARY KEY(connection_id,delivery_id)
  ) STRICT`,
  // A transaction-local guard row makes even a stale no-op fail after fencing.
  `CREATE TABLE github_read_guards (token TEXT PRIMARY KEY, connection_id TEXT NOT NULL, expected_generation INTEGER) STRICT`,
  `CREATE TRIGGER github_read_guard BEFORE INSERT ON github_read_guards
    WHEN NOT EXISTS(SELECT 1 FROM github_read_connections WHERE id=NEW.connection_id AND state='active' AND (NEW.expected_generation IS NULL OR generation=NEW.expected_generation))
    BEGIN SELECT RAISE(ABORT,'github_read_fenced'); END`,
] as const
