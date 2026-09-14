// Executing a confirmed run, exactly once per item (#62).
//
// The model in 0067 says what a run would do. This says what it has done, and
// the whole of it is one rule: an item that completed is never done again.
//
// Why state lives on the item rather than the run. "Partial failure names
// failed items and is re-runnable for exactly those" is the acceptance, and a
// run-level state cannot express it -- a run that half worked is neither done
// nor undone, and re-running it from a run-level flag repeats the half that
// succeeded. Sending an invoice twice is the failure this prevents.
//
// Why an attempt is recorded before the work rather than after. A process
// killed mid-item leaves a row that says it was attempted and not that it
// finished, which is exactly what a resume needs to see. Writing only on
// success means a kill between the work and the write is indistinguishable
// from a kill before the work, and the safe reading of that ambiguity is to
// redo it -- which for an email means sending it twice.

const canonicalTimestamp = (column: string) => `unixepoch(${column}) IS NOT NULL
  AND substr(${column}, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', ${column})
  AND (
    ${column} GLOB '????-??-??T??:??:??Z'
    OR ${column} GLOB '????-??-??T??:??:??.[0-9][0-9][0-9]Z'
  )`

export const runExecutionMigration = [
  `ALTER TABLE run_items ADD COLUMN state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'running', 'done', 'failed'))`,

  // When this item was last picked up. Set before the work, so a process that
  // dies mid-item leaves a row that says so.
  //
  // Held to the same canonical shape as every other instant in the schema. An
  // execution record whose timestamps are whatever the caller passed is one
  // that cannot be ordered against anything else, and ordering is the question
  // asked of it: what had already run when this died.
  `ALTER TABLE run_items ADD COLUMN attempted_at TEXT
    CHECK (attempted_at IS NULL OR (${canonicalTimestamp('attempted_at')}))`,

  `ALTER TABLE run_items ADD COLUMN completed_at TEXT
    CHECK (completed_at IS NULL OR (${canonicalTimestamp('completed_at')}))`,

  // Why it failed, in the words whoever re-runs it will read. A failed item
  // with no reason is one nobody can decide about.
  `ALTER TABLE run_items ADD COLUMN failure_reason TEXT
    CHECK (failure_reason IS NULL OR length(trim(failure_reason)) BETWEEN 1 AND 2000)`,

  // How many times it has been tried. A run that keeps failing the same item
  // should be visible as that rather than as a run that never finishes.
  `ALTER TABLE run_items ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (attempt_count >= 0)`,

  `CREATE INDEX run_items_outstanding
    ON run_items(run_id, state)
    WHERE state <> 'done'`,

  // Exactly once. A completed item cannot be moved back to anything, which is
  // what makes a resume safe to run as often as it likes: whatever it picks up,
  // it cannot pick up work that already happened.
  `CREATE TRIGGER run_items_done_is_final
    BEFORE UPDATE OF state ON run_items
    WHEN OLD.state = 'done' AND NEW.state IS NOT OLD.state
    BEGIN SELECT RAISE(ABORT, 'a completed run item cannot run again'); END`,

  // A done item has an instant; a failed one has a reason. Neither is optional,
  // because a record of execution that cannot say when or why is not a record.
  `CREATE TRIGGER run_items_result_is_complete
    BEFORE UPDATE OF state ON run_items
    WHEN (NEW.state = 'done' AND NEW.completed_at IS NULL)
      OR (NEW.state = 'failed' AND NEW.failure_reason IS NULL)
    BEGIN SELECT RAISE(ABORT, 'a run item result must say when or why'); END`,

  // Only a confirmed run executes. Nothing proposed, cancelled or expired has
  // been agreed to, and this is the last place that can say so before work
  // happens -- 0067 stops a settled run changing state, and this stops its
  // items moving underneath it.
  `CREATE TRIGGER run_items_only_confirmed_execute
    BEFORE UPDATE OF state ON run_items
    WHEN NEW.state <> OLD.state
      AND NOT EXISTS (
        SELECT 1 FROM proposed_runs
        WHERE id = NEW.run_id AND state IN ('confirmed', 'completed')
      )
    BEGIN SELECT RAISE(ABORT, 'only a confirmed run executes'); END`,
] as const
