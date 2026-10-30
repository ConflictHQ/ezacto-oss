import { LEASE_SCHEMA } from '../load-lease-schema.js'

/** Frozen list: later schema additions must never change an applied migration checksum. */
const protectedTables = [
  'instance_bootstrap',
  'organizations',
  'users',
  'organization_owner',
  'user_emails',
  'user_identities',
  'user_passwords',
  'auth_tokens',
  'auth_first_run',
  'sessions',
  'api_tokens',
  'clients',
  'projects',
  'time_entries',
  'expenses',
  'invoices',
  'estimates',
  'event_outbox',
  'outbox_delivery_receipts',
] as const
const barrier = `EXISTS(SELECT 1 FROM migration_loads
  WHERE status<>'completed' AND (status<>'cancelled' OR started_at IS NOT NULL))`
const context = `EXISTS(SELECT 1 FROM _ezacto_migration_write_context context
  JOIN migration_loads job ON job.id=context.run_id
  JOIN _ezacto_load_lease lease ON lease.singleton=1
  WHERE job.status='running' AND job.snapshot_sha256=lease.snapshot_sha256
    AND lease.holder=context.holder AND lease.fence=context.fence
    AND lease.released_at IS NULL AND lease.expires_at>context.at_ms)`

export const queuedMigrationsMigration = [
  ...LEASE_SCHEMA.map((statement) => statement.sql),
  `CREATE TABLE migration_loads (
    id TEXT PRIMARY KEY CHECK(length(id)=36),
    destination_slot INTEGER NOT NULL DEFAULT 1 CHECK(destination_slot=1),
    catalog_json TEXT NOT NULL CHECK(json_valid(catalog_json)),
    options_json TEXT NOT NULL CHECK(json_valid(options_json)),
    snapshot_sha256 TEXT NOT NULL CHECK(length(snapshot_sha256)=64),
    source_rows INTEGER NOT NULL CHECK(source_rows>=0),
    status TEXT NOT NULL CHECK(status IN ('ready','queued','running','completed','failed','cancelled')),
    resource TEXT,
    rows_done INTEGER NOT NULL DEFAULT 0 CHECK(rows_done>=0),
    sequence INTEGER NOT NULL DEFAULT 0 CHECK(sequence>=0),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
    error_code TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    source_cleaned_at TEXT,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE UNIQUE INDEX migration_loads_destination ON migration_loads(destination_slot)
    WHERE status<>'completed' AND (status<>'cancelled' OR started_at IS NOT NULL)`,
  `CREATE TRIGGER migration_loads_empty_destination BEFORE INSERT ON migration_loads
    WHEN NEW.status<>'ready' OR NEW.started_at IS NOT NULL OR NEW.sequence<>0 OR NEW.rows_done<>0
      OR EXISTS(SELECT 1 FROM organizations) OR EXISTS(SELECT 1 FROM users)
      OR EXISTS(SELECT 1 FROM clients) OR EXISTS(SELECT 1 FROM projects)
      OR EXISTS(SELECT 1 FROM time_entries) OR EXISTS(SELECT 1 FROM expenses)
      OR EXISTS(SELECT 1 FROM invoices) OR EXISTS(SELECT 1 FROM estimates)
    BEGIN SELECT RAISE(ABORT,'migration_destination_not_empty'); END`,
  `CREATE TRIGGER migration_loads_immutable_input BEFORE UPDATE ON migration_loads
    WHEN NEW.id IS NOT OLD.id OR NEW.destination_slot IS NOT OLD.destination_slot
      OR NEW.catalog_json IS NOT OLD.catalog_json OR NEW.options_json IS NOT OLD.options_json
      OR NEW.snapshot_sha256 IS NOT OLD.snapshot_sha256 OR NEW.source_rows IS NOT OLD.source_rows
      OR NEW.created_at IS NOT OLD.created_at
      OR (OLD.started_at IS NOT NULL AND NEW.started_at IS NOT OLD.started_at)
      OR NEW.sequence<OLD.sequence OR NEW.rows_done<OLD.rows_done OR NEW.attempts<OLD.attempts
      OR (OLD.status IN ('completed','cancelled') AND NEW.status IS NOT OLD.status)
    BEGIN SELECT RAISE(ABORT,'migration_input_immutable'); END`,
  `CREATE TRIGGER migration_loads_retain BEFORE DELETE ON migration_loads
    BEGIN SELECT RAISE(ABORT,'migration_audit_retained'); END`,
  `CREATE TABLE migration_load_intents (
    run_id TEXT NOT NULL REFERENCES migration_loads(id) ON DELETE RESTRICT,
    sequence INTEGER NOT NULL CHECK(sequence>=0),
    created_at TEXT NOT NULL,
    sent_at TEXT,
    PRIMARY KEY(run_id,sequence)
  ) STRICT`,
  `CREATE TABLE _ezacto_migration_write_context (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    run_id TEXT NOT NULL REFERENCES migration_loads(id),
    holder TEXT NOT NULL,
    fence INTEGER NOT NULL,
    at_ms INTEGER NOT NULL,
    allowed INTEGER NOT NULL CHECK(allowed=1)
  ) STRICT`,
  ...protectedTables.flatMap((table) =>
    ['INSERT', 'UPDATE', 'DELETE'].map(
      (verb) =>
        `CREATE TRIGGER migration_barrier_${table}_${verb.toLowerCase()} BEFORE ${verb} ON ${table}
      WHEN ${barrier} AND NOT ${context}
      BEGIN SELECT RAISE(ABORT,'migration_in_progress'); END`,
    ),
  ),
] as const
