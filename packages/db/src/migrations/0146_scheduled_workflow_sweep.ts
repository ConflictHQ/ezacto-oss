import { canonicalTimestamp } from './0029_outbox_delivery.js'
/** Fair control-plane scheduling metadata; independent of financial authority. */
export const scheduledWorkflowSweepMigration = [
  `ALTER TABLE proposed_runs ADD COLUMN workflow_checked_at TEXT CHECK(workflow_checked_at IS NULL OR (${canonicalTimestamp('workflow_checked_at')}))`,
  `CREATE INDEX proposed_runs_workflow_sweep ON proposed_runs(state,workflow_checked_at,id)`,
] as const
