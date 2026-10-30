// Named-demand lifecycle and privacy completion for #1191. Keep 0158 immutable.
export const placeholderPlanningMigration = [
  `ALTER TABLE placeholders ADD COLUMN revision INTEGER NOT NULL DEFAULT 0
    CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991)`,
  `ALTER TABLE placeholders ADD COLUMN created_by_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT`,
  `CREATE TRIGGER placeholders_revision_guard BEFORE UPDATE ON placeholders
    WHEN OLD.is_active=0 OR NEW.revision<>OLD.revision+1
      OR NEW.id<>OLD.id OR NEW.created_at<>OLD.created_at
      OR NEW.created_by_user_id IS NOT OLD.created_by_user_id
    BEGIN SELECT RAISE(ABORT,'placeholder_definition_transition_refused'); END`,
  `CREATE TRIGGER placeholder_allocations_safe_revision BEFORE UPDATE ON placeholder_allocations
    WHEN NEW.revision>9007199254740991
    BEGIN SELECT RAISE(ABORT,'placeholder_revision_exhausted'); END`,
  `CREATE TRIGGER placeholder_assignment_keys_immutable BEFORE UPDATE ON placeholder_assignment_keys
    BEGIN SELECT RAISE(ABORT,'placeholder_assignment_receipt_immutable'); END`,
  // Plans are erased by 0119. Retain only the assigned demand's immutable id/state;
  // drop replay payloads referring to the closed actor OR target, never resurrect a plan.
  `CREATE TRIGGER account_closures_erase_placeholder_receipts AFTER INSERT ON account_closures
    BEGIN DELETE FROM placeholder_assignment_keys
      WHERE actor_id=NEW.user_id OR CAST(json_extract(result_json,'$.allocation.userId') AS INTEGER)=NEW.user_id;
    END`,
] as const
