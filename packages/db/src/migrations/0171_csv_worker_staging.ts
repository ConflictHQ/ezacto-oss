/** Worker CSV uses native D1 batches, a private R2 input and an outbox pointer. */
const relevantTables = [
  'organizations', 'users', 'user_emails', 'clients', 'projects', 'tasks',
  'user_assignments', 'task_assignments', 'timesheet_submissions',
  'timesheet_lock_windows', 'account_closures', 'time_entries',
  'user_billable_rates', 'user_cost_rates', 'client_rate_cards', 'client_rate_card_versions',
  'csv_import_datasets', 'csv_import_runs', 'csv_import_entries', 'csv_import_chunks', 'csv_import_setup',
] as const
export const csvWorkerStagingMigration = [
  `CREATE TABLE csv_worker_revision(singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991), orphan_cursor TEXT)`,
  `INSERT INTO csv_worker_revision(singleton,revision) VALUES(1,0)`,
  `CREATE TABLE csv_worker_fence(allowed INTEGER NOT NULL CHECK(allowed=1))`,
  `CREATE TABLE csv_worker_stages(
    id TEXT PRIMARY KEY, target_nonce TEXT NOT NULL, owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    version INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL CHECK(status IN('staged','previewed','confirmed','queued','running','paused','partial','completed','cancelled','failed','purged')),
    file_sha256 TEXT NOT NULL, file_bytes INTEGER NOT NULL CHECK(file_bytes BETWEEN 1 AND 5242880),
    object_key TEXT, choices_key TEXT, preview_key TEXT, preview_id TEXT, source_id TEXT, summary_json TEXT,
    revision INTEGER NOT NULL, policy_hash TEXT, native_run_id INTEGER REFERENCES csv_import_runs(id) ON DELETE SET NULL,
    session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
    command_id TEXT, confirmation_id TEXT, command_json TEXT, cancellation_id TEXT,
    lease_generation INTEGER NOT NULL DEFAULT 0, lease_holder TEXT, lease_expires_at TEXT,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3), next_attempt_at TEXT,
    budget_yields INTEGER NOT NULL DEFAULT 0, budget_progress INTEGER NOT NULL DEFAULT 0, last_published_at TEXT,
    safe_code TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, finished_at TEXT,
    publish_pending INTEGER NOT NULL DEFAULT 0 CHECK(publish_pending IN(0,1))
  )`,
  `CREATE TABLE csv_worker_commands(stage_id TEXT NOT NULL REFERENCES csv_worker_stages(id) ON DELETE CASCADE, command_id TEXT NOT NULL, actor_id INTEGER NOT NULL, request_json TEXT NOT NULL CHECK(length(request_json)<=2048), kind TEXT NOT NULL CHECK(kind IN('apply','resume','cancel')), created_at TEXT NOT NULL, PRIMARY KEY(stage_id,command_id))`,
  `CREATE INDEX csv_worker_stages_ready ON csv_worker_stages(status,next_attempt_at,lease_expires_at)`,
  `CREATE INDEX csv_worker_stages_owner ON csv_worker_stages(owner_id,target_nonce,file_sha256)`,
  ...relevantTables.flatMap(table => ['INSERT','UPDATE','DELETE'].map(operation =>
    `CREATE TRIGGER csv_worker_revision_${table}_${operation.toLowerCase()} AFTER ${operation === 'UPDATE' && table === 'users' ? 'UPDATE OF first_name,last_name,is_active,profile,manager_grants,has_access_to_all_future_projects,time_entry_notes_minimum_length,timezone' : operation === 'UPDATE' && table === 'csv_import_runs' ? 'UPDATE OF source_id,file_sha256,mapping_sha256,browser_plan_id,browser_plan_json,browser_state' : operation} ON ${table}
     BEGIN UPDATE csv_worker_revision SET revision=revision+1 WHERE singleton=1; END`,
  )),
] as const
