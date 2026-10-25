/** Browser CSV source registration and lease/chunk metadata. The canonical
 * csv_import_entries unique key remains the only imported-row dedup ledger. */
export const csvBrowserDatasetMigration = [
  `CREATE TABLE csv_import_datasets (
    singleton INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK(singleton=1),
    source_id TEXT PRIMARY KEY NOT NULL CHECK(length(source_id) BETWEEN 1 AND 64),
    workspace_identity TEXT NOT NULL UNIQUE CHECK(length(workspace_identity) BETWEEN 1 AND 255),
    created_at TEXT NOT NULL
  )`,
  `ALTER TABLE csv_import_runs ADD COLUMN browser_plan_json TEXT CHECK(browser_plan_json IS NULL OR json_valid(browser_plan_json))`,
  `ALTER TABLE csv_import_runs ADD COLUMN browser_plan_id TEXT`,
  `ALTER TABLE csv_import_runs ADD COLUMN browser_state TEXT CHECK(browser_state IS NULL OR browser_state IN ('draft','partial','complete','cancelled'))`,
  `ALTER TABLE csv_import_runs ADD COLUMN confirmed_by_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT`,
  `ALTER TABLE csv_import_runs ADD COLUMN lease_holder TEXT`,
  `ALTER TABLE csv_import_runs ADD COLUMN lease_actor_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT`,
  `ALTER TABLE csv_import_runs ADD COLUMN lease_generation INTEGER NOT NULL DEFAULT 0 CHECK(lease_generation BETWEEN 0 AND 9007199254740991)`,
  `ALTER TABLE csv_import_runs ADD COLUMN lease_expires_at INTEGER`,
  `ALTER TABLE csv_import_runs ADD COLUMN committed_chunks INTEGER NOT NULL DEFAULT 0 CHECK(committed_chunks>=0)`,
  `CREATE UNIQUE INDEX csv_import_browser_dataset ON csv_import_runs(source_id) WHERE browser_plan_json IS NOT NULL`,
  `ALTER TABLE csv_import_entries ADD COLUMN source_line INTEGER CHECK(source_line IS NULL OR source_line>0)`,
  `ALTER TABLE csv_import_entries ADD COLUMN source_seconds INTEGER CHECK(source_seconds IS NULL OR source_seconds>=0)`,
  `CREATE TABLE csv_import_chunks (
    run_id INTEGER NOT NULL REFERENCES csv_import_runs(id) ON DELETE RESTRICT,
    actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    chunk_index INTEGER NOT NULL CHECK(chunk_index>=0),
    request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
    source_key TEXT NOT NULL CHECK(length(source_key) BETWEEN 1 AND 128),
    source_line INTEGER NOT NULL CHECK(source_line>0),
    source_seconds INTEGER NOT NULL CHECK(source_seconds>=0),
    inserted_rows INTEGER NOT NULL CHECK(inserted_rows IN (0,1)),
    already_imported_rows INTEGER NOT NULL CHECK(already_imported_rows IN (0,1)),
    committed_at TEXT NOT NULL,
    PRIMARY KEY(run_id,chunk_index),
    CHECK(inserted_rows+already_imported_rows=1)
  )`,
  `CREATE UNIQUE INDEX csv_import_chunks_source_position ON csv_import_chunks(run_id,source_key)`,
  `CREATE TABLE csv_import_setup (
    run_id INTEGER NOT NULL REFERENCES csv_import_runs(id) ON DELETE RESTRICT,
    actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    setup_key TEXT NOT NULL CHECK(length(setup_key) BETWEEN 1 AND 128),
    entity_kind TEXT NOT NULL CHECK(entity_kind IN ('users','clients','projects','tasks','user-assignments','task-assignments')),
    entity_id INTEGER NOT NULL CHECK(entity_id>0),
    request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
    created_at TEXT NOT NULL,
    policy_facts_sha256 TEXT CHECK(policy_facts_sha256 IS NULL OR length(policy_facts_sha256)=64),
    PRIMARY KEY(run_id,setup_key),
    UNIQUE(run_id,entity_kind,entity_id)
  )`,
  `CREATE TRIGGER csv_import_setup_immutable BEFORE UPDATE ON csv_import_setup
    WHEN OLD.policy_facts_sha256 IS NOT NULL OR NEW.policy_facts_sha256 IS NULL
      OR NEW.run_id IS NOT OLD.run_id OR NEW.actor_user_id IS NOT OLD.actor_user_id OR NEW.setup_key IS NOT OLD.setup_key
      OR NEW.entity_kind IS NOT OLD.entity_kind OR NEW.entity_id IS NOT OLD.entity_id
      OR NEW.request_sha256 IS NOT OLD.request_sha256 OR NEW.created_at IS NOT OLD.created_at
    BEGIN SELECT RAISE(ABORT,'csv_browser_setup_immutable'); END`,
  `CREATE TRIGGER csv_import_browser_seal_immutable BEFORE UPDATE ON csv_import_runs
    WHEN OLD.browser_state IS NOT NULL AND OLD.browser_state<>'draft' AND (
      NEW.source_id IS NOT OLD.source_id OR NEW.file_sha256 IS NOT OLD.file_sha256
      OR NEW.mapping_sha256 IS NOT OLD.mapping_sha256 OR NEW.mapping_json IS NOT OLD.mapping_json OR NEW.total_rows IS NOT OLD.total_rows
      OR NEW.browser_plan_json IS NOT OLD.browser_plan_json OR NEW.browser_plan_id IS NOT OLD.browser_plan_id
      OR NEW.confirmed_by_user_id IS NOT OLD.confirmed_by_user_id
      OR NEW.browser_state='draft'
      OR (OLD.browser_state IN ('complete','cancelled') AND NEW.browser_state IS NOT OLD.browser_state))
    BEGIN SELECT RAISE(ABORT,'csv_browser_seal_immutable'); END`,
  `CREATE TRIGGER csv_import_entries_identity_immutable BEFORE UPDATE ON csv_import_entries
    WHEN NEW.run_id IS NOT OLD.run_id OR NEW.source_id IS NOT OLD.source_id
      OR NEW.source_key IS NOT OLD.source_key OR NEW.source_line IS NOT OLD.source_line
      OR NEW.source_seconds IS NOT OLD.source_seconds OR NEW.created_at IS NOT OLD.created_at
    BEGIN SELECT RAISE(ABORT,'csv_import_identity_immutable'); END`,
  `CREATE TRIGGER csv_import_entries_retain BEFORE DELETE ON csv_import_entries
    BEGIN SELECT RAISE(ABORT,'csv_import_identity_retained'); END`,
  `CREATE TRIGGER csv_import_chunks_retain BEFORE DELETE ON csv_import_chunks
    BEGIN SELECT RAISE(ABORT,'csv_browser_chunk_retained'); END`,
  `CREATE TRIGGER csv_import_setup_retain BEFORE DELETE ON csv_import_setup
    BEGIN SELECT RAISE(ABORT,'csv_browser_setup_retained'); END`,
  `CREATE TRIGGER csv_import_chunks_immutable BEFORE UPDATE ON csv_import_chunks
    BEGIN SELECT RAISE(ABORT,'csv_browser_chunk_immutable'); END`,
] as const
