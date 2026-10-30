// Materialize a proposal and every concrete item in one SQLite/D1 statement.
// Existing proposals retain their rows; only new store writes carry this input.
export const atomicRunManifestsMigration = [
  `ALTER TABLE proposed_runs ADD COLUMN proposal_manifest_json TEXT
    CHECK(proposal_manifest_json IS NULL OR
      (json_valid(proposal_manifest_json) AND json_type(proposal_manifest_json)='array'
        AND json_array_length(proposal_manifest_json)>0))`,
  `CREATE TRIGGER proposed_runs_materialize_manifest AFTER INSERT ON proposed_runs
    WHEN NEW.proposal_manifest_json IS NOT NULL
    BEGIN
      INSERT INTO run_items(run_id,subject_type,subject_id,description,amount_cents,currency,
        target,quantity_seconds,client_name,created_at)
      SELECT NEW.id,json_extract(item.value,'$.subjectType'),json_extract(item.value,'$.subjectId'),
        json_extract(item.value,'$.description'),json_extract(item.value,'$.amountCents'),
        json_extract(item.value,'$.currency'),json_extract(item.value,'$.target'),
        json_extract(item.value,'$.quantitySeconds'),json_extract(item.value,'$.clientName'),NEW.proposed_at
      FROM json_each(NEW.proposal_manifest_json) item ORDER BY CAST(item.key AS INTEGER);
    END`,
  `CREATE TRIGGER proposed_runs_manifest_input_immutable BEFORE UPDATE OF proposal_manifest_json ON proposed_runs
    WHEN NEW.proposal_manifest_json IS NOT OLD.proposal_manifest_json
    BEGIN SELECT RAISE(ABORT,'The original proposed manifest is immutable'); END`,
] as const
