// Provenance: ezacto-pvt #1008, slice 1. The provider-neutral seam between time
// and an issue tracker: which trackers this instance has connected, and which
// tracker item a time entry or project points at. No provider is called from
// here.
//
// A connection is instance-wide (there is one organization), so there is at
// most one row per provider and no organization column. Reconnecting a
// provider revives its row rather than adding a second, which is what keeps the
// links made earlier attached to the connection they were made through.
//
// `credential_ref` is the NAME of the deployment secret that holds the
// credential, never the credential itself, and it is set by the server from a
// fixed per-provider table. Disconnecting clears it and keeps the row and its
// links: the history of what was linked outlives the access to read it.
//
// A link joins exactly one target (a time entry or a project) to one provider
// item. An item collects any number of entries, but a time entry points at one
// item per connection, so the "which issue was this" question has one answer.
// A deleted entry or project takes its links with it; a deleted item upstream
// leaves the link, which is for a later slice to surface.
export const workItemLinksMigration = [
  `CREATE TABLE work_item_connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL UNIQUE CHECK (provider GLOB '[a-z]*' AND length(provider) BETWEEN 1 AND 32),
    status TEXT NOT NULL CHECK (status IN ('active', 'disconnected')),
    owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    credential_ref TEXT CHECK (credential_ref IS NULL OR length(credential_ref) BETWEEN 1 AND 128),
    connected_at TEXT NOT NULL,
    disconnected_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
      (status = 'active' AND credential_ref IS NOT NULL AND disconnected_at IS NULL)
      OR (status = 'disconnected' AND credential_ref IS NULL AND disconnected_at IS NOT NULL)
    )
  ) STRICT`,
  `CREATE TRIGGER work_item_connections_provider_immutable
    BEFORE UPDATE OF provider ON work_item_connections
    WHEN OLD.provider IS NOT NEW.provider
    BEGIN SELECT RAISE(ABORT, 'a work item connection keeps its provider'); END`,
  `CREATE TABLE work_item_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id INTEGER NOT NULL REFERENCES work_item_connections(id) ON DELETE RESTRICT,
    time_entry_id INTEGER REFERENCES time_entries(id) ON DELETE CASCADE,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    provider_item_id TEXT NOT NULL CHECK (length(provider_item_id) BETWEEN 1 AND 256),
    url TEXT CHECK (url IS NULL OR length(url) BETWEEN 1 AND 2048),
    created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((time_entry_id IS NULL) <> (project_id IS NULL))
  ) STRICT`,
  `CREATE UNIQUE INDEX work_item_links_entry
    ON work_item_links(connection_id, time_entry_id) WHERE time_entry_id IS NOT NULL`,
  `CREATE UNIQUE INDEX work_item_links_project_item
    ON work_item_links(connection_id, project_id, provider_item_id) WHERE project_id IS NOT NULL`,
  `CREATE INDEX work_item_links_item ON work_item_links(connection_id, provider_item_id)`,
  `CREATE INDEX work_item_links_time_entry ON work_item_links(time_entry_id)`,
  `CREATE INDEX work_item_links_project ON work_item_links(project_id)`,
  // A link made through a disconnected connection would look live. The store
  // checks first for a useful error; this is what holds when something else
  // writes the table.
  `CREATE TRIGGER work_item_links_active_connection
    BEFORE INSERT ON work_item_links
    WHEN (SELECT status FROM work_item_connections WHERE id = NEW.connection_id) IS NOT 'active'
    BEGIN SELECT RAISE(ABORT, 'work item connection is not active'); END`,
  // What a link points at never changes: re-pointing one would move time from
  // one issue to another without anyone having linked it. Unlink and link again.
  `CREATE TRIGGER work_item_links_target_immutable
    BEFORE UPDATE ON work_item_links
    WHEN OLD.connection_id IS NOT NEW.connection_id
      OR OLD.time_entry_id IS NOT NEW.time_entry_id
      OR OLD.project_id IS NOT NEW.project_id
      OR OLD.provider_item_id IS NOT NEW.provider_item_id
    BEGIN SELECT RAISE(ABORT, 'a work item link keeps its target and item'); END`,
] as const
