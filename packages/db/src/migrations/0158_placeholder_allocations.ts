import { canonicalTimestamp } from './0029_outbox_delivery.js'

// Provenance: ezacto-pvt #1191 (parent #1007). Named unassigned project demand.
//
// Two NEW tables, on purpose: `allocations.user_id` stays NOT NULL with its
// foreign key, so a plan for a real person is never weakened to allow "nobody".
// A placeholder names no user, holds no capacity, rate, money or time, and its
// hours never reach the capacity read.
//
// Identifiers are AUTOINCREMENT and rows are never deleted, so an id is never
// reused after archive or erasure. `assigned_allocation_id` is a plain integer,
// not a foreign key: erasing a person's plan on account closure must not unlink
// the record that the demand was once met.
const canonicalDate = (column: string) =>
  `${column} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(${column}) = ${column}`

export const placeholderAllocationsMigration = [
  `CREATE TABLE placeholders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120 AND name = trim(name)),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL CHECK (${canonicalTimestamp('created_at')}),
    updated_at TEXT NOT NULL CHECK (${canonicalTimestamp('updated_at')})
  ) STRICT`,
  `CREATE TABLE placeholder_allocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    placeholder_id INTEGER NOT NULL REFERENCES placeholders(id) ON DELETE RESTRICT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    start_date TEXT NOT NULL CHECK (${canonicalDate('start_date')}),
    end_date TEXT NOT NULL CHECK (${canonicalDate('end_date')}),
    planned_seconds_per_week INTEGER NOT NULL
      CHECK (planned_seconds_per_week BETWEEN 1 AND 604800),
    state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'assigned', 'archived')),
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    assigned_allocation_id INTEGER,
    created_at TEXT NOT NULL CHECK (${canonicalTimestamp('created_at')}),
    updated_at TEXT NOT NULL CHECK (${canonicalTimestamp('updated_at')}),
    CHECK (end_date >= start_date),
    CHECK ((state = 'assigned') = (assigned_allocation_id IS NOT NULL))
  ) STRICT`,
  `CREATE INDEX placeholder_allocations_project_dates
    ON placeholder_allocations(project_id, start_date, end_date)`,
  `CREATE UNIQUE INDEX placeholder_allocations_assigned_once
    ON placeholder_allocations(assigned_allocation_id) WHERE assigned_allocation_id IS NOT NULL`,
  `CREATE TRIGGER placeholder_allocations_no_delete BEFORE DELETE ON placeholder_allocations
    BEGIN SELECT RAISE(ABORT, 'placeholder allocations are never deleted'); END`,
  `CREATE TRIGGER placeholders_no_delete BEFORE DELETE ON placeholders
    BEGIN SELECT RAISE(ABORT, 'placeholders are never deleted'); END`,
  // An assigned or archived row is final; a committed change raises the revision by one.
  `CREATE TRIGGER placeholder_allocations_transition BEFORE UPDATE ON placeholder_allocations
    WHEN OLD.state <> 'open'
      OR NEW.revision <> OLD.revision + 1
      OR NEW.id <> OLD.id OR NEW.placeholder_id <> OLD.placeholder_id
      OR NEW.project_id <> OLD.project_id OR NEW.created_at <> OLD.created_at
    BEGIN SELECT RAISE(ABORT, 'placeholder allocation transition refused'); END`,
  // The claim of one actor's idempotency key and the result it produced.
  `CREATE TABLE placeholder_assignment_keys (
    actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
    fingerprint TEXT NOT NULL,
    placeholder_allocation_id INTEGER NOT NULL
      REFERENCES placeholder_allocations(id) ON DELETE RESTRICT,
    result_json TEXT NOT NULL CHECK (json_valid(result_json)),
    created_at TEXT NOT NULL CHECK (${canonicalTimestamp('created_at')}),
    PRIMARY KEY (actor_id, idempotency_key)
  ) STRICT, WITHOUT ROWID`,
] as const
