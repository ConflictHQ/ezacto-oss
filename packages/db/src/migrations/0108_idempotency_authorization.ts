/**
 * Replays must observe row-level authority changes as well as credentials.
 * These are the inputs to team/project visibility, module policy and tracked
 * resource ownership. Advance a durable revision in the same transaction as
 * each change, including changes made outside the HTTP entry. A monotonic
 * revision also catches access being removed and subsequently restored.
 *
 * Ordinary time/expense writes, names, budgets and authentication last-seen
 * updates do not change authority and must not invalidate unrelated receipts.
 * New resource authorization inputs must extend this list.
 */
const authorities = [
  ['users', ['profile', 'manager_grants', 'is_active', 'is_owner', 'saml_exempt', 'has_access_to_all_future_projects']],
  ['organizations', ['modules', 'require_sso', 'require_2fa']],
  ['user_assignments', ['project_id', 'user_id', 'is_active', 'is_project_manager']],
  ['teammate_assignments', ['manager_id', 'user_id']],
  ['task_assignments', ['project_id', 'task_id', 'is_active']],
  ['projects', ['client_id', 'is_active']],
  ['clients', ['is_active']],
  ['tasks', ['is_active']],
  ['contacts', ['client_id']],
] as const

const advance = 'UPDATE idempotency_authorization SET revision = revision + 1 WHERE id = 1;'

export const idempotencyAuthorizationMigration = [
  `CREATE TABLE idempotency_authorization (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL CHECK (revision >= 0)
  ) STRICT`,
  'INSERT INTO idempotency_authorization (id, revision) VALUES (1, 0)',
  ...authorities.flatMap(([table, columns]) => [
    ...['INSERT', 'DELETE'].map((event) =>
      `CREATE TRIGGER idempotency_authority_${table}_${event.toLowerCase()}
       AFTER ${event} ON ${table} BEGIN ${advance} END`),
    `CREATE TRIGGER idempotency_authority_${table}_update
     AFTER UPDATE OF ${columns.join(', ')} ON ${table}
     WHEN ${columns.map((column) => `OLD.${column} IS NOT NEW.${column}`).join(' OR ')}
     BEGIN ${advance} END`,
  ]),
  ...['time_entries', 'expenses'].map((table) =>
    `CREATE TRIGGER idempotency_authority_${table}_owner
     AFTER UPDATE OF user_id ON ${table} WHEN OLD.user_id IS NOT NEW.user_id
     BEGIN ${advance} END`),
] as const
