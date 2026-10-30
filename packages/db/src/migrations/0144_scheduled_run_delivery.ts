import { canonicalTimestamp } from './0029_outbox_delivery.js'
// Capture a report and its review warnings with the original manifest. Object
// bytes are immutable by content hash; the file-object row travels in backups.
export const scheduledRunDeliveryMigration = [
  `ALTER TABLE run_items ADD COLUMN report_people_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(report_people_json) AND json_type(report_people_json)='array')`,
  `ALTER TABLE run_items ADD COLUMN report_file_key TEXT`,
  `ALTER TABLE run_items ADD COLUMN report_content_hash TEXT REFERENCES file_objects(content_hash) ON DELETE RESTRICT`,
  `ALTER TABLE run_items ADD COLUMN report_name TEXT`,
  `ALTER TABLE run_items ADD COLUMN report_byte_size INTEGER CHECK(report_byte_size IS NULL OR report_byte_size>0)`,
  `ALTER TABLE run_items ADD COLUMN report_warnings_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(report_warnings_json) AND json_type(report_warnings_json)='array')`,
  `ALTER TABLE proposed_runs ADD COLUMN report_warnings_acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(report_warnings_acknowledged IN(0,1))`,
  `ALTER TABLE run_items ADD COLUMN attempt_limit INTEGER NOT NULL DEFAULT 3 CHECK(attempt_limit>=3)`,
  `CREATE TRIGGER run_items_capture_report AFTER INSERT ON run_items
    WHEN NEW.report_content_hash IS NOT NULL
    BEGIN
      INSERT INTO file_objects(content_hash,file_key,byte_size,content_type,created_at,updated_at)
        SELECT NEW.report_content_hash,NEW.report_file_key,NEW.report_byte_size,'application/pdf',NEW.created_at,NEW.created_at
        WHERE NOT EXISTS(SELECT 1 FROM file_objects WHERE content_hash=NEW.report_content_hash);
      SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM file_objects WHERE content_hash=NEW.report_content_hash
        AND file_key=NEW.report_file_key AND byte_size=NEW.report_byte_size AND content_type='application/pdf')
        THEN RAISE(ABORT,'The saved report does not match its file identity') END;
    END`,
  `CREATE TRIGGER run_items_report_complete BEFORE INSERT ON run_items
    WHEN (NEW.report_content_hash IS NULL AND (NEW.report_file_key IS NOT NULL OR NEW.report_name IS NOT NULL OR NEW.report_byte_size IS NOT NULL))
      OR (NEW.report_content_hash IS NOT NULL AND (NEW.report_file_key IS NULL OR NEW.report_name IS NULL OR NEW.report_byte_size IS NULL))
    BEGIN SELECT RAISE(ABORT,'A saved report must include its complete file identity'); END`,
  `CREATE TRIGGER run_items_report_immutable BEFORE UPDATE OF report_file_key,report_content_hash,report_name,report_byte_size,report_warnings_json,report_people_json ON run_items
    WHEN NEW.report_file_key IS NOT OLD.report_file_key OR NEW.report_content_hash IS NOT OLD.report_content_hash
      OR NEW.report_name IS NOT OLD.report_name OR NEW.report_byte_size IS NOT OLD.report_byte_size OR NEW.report_warnings_json IS NOT OLD.report_warnings_json OR NEW.report_people_json IS NOT OLD.report_people_json
    BEGIN SELECT RAISE(ABORT,'The proposed report is immutable'); END`,
  `DROP TRIGGER proposed_runs_materialize_manifest`,
  `CREATE TRIGGER proposed_runs_materialize_manifest AFTER INSERT ON proposed_runs
    WHEN NEW.proposal_manifest_json IS NOT NULL
    BEGIN
      INSERT INTO run_items(run_id,subject_type,subject_id,description,amount_cents,currency,
        target,quantity_seconds,client_name,created_at,report_file_key,report_content_hash,report_name,report_byte_size,report_warnings_json,report_people_json)
      SELECT NEW.id,json_extract(item.value,'$.subjectType'),json_extract(item.value,'$.subjectId'),
        json_extract(item.value,'$.description'),json_extract(item.value,'$.amountCents'),json_extract(item.value,'$.currency'),
        json_extract(item.value,'$.target'),json_extract(item.value,'$.quantitySeconds'),json_extract(item.value,'$.clientName'),NEW.proposed_at,
        json_extract(item.value,'$.report.key'),json_extract(item.value,'$.report.contentHash'),json_extract(item.value,'$.report.name'),
        json_extract(item.value,'$.report.byteSize'),coalesce(json_extract(item.value,'$.reportWarnings'),'[]'),coalesce(json_extract(item.value,'$.reportPeople'),'[]')
      FROM json_each(NEW.proposal_manifest_json) item ORDER BY CAST(item.key AS INTEGER);
    END`,
  `CREATE TABLE scheduled_run_deliveries (
    run_item_id INTEGER PRIMARY KEY REFERENCES run_items(id) ON DELETE RESTRICT,
    delivery_id INTEGER NOT NULL UNIQUE REFERENCES email_log(id) ON DELETE RESTRICT,
    attachment_id INTEGER NOT NULL UNIQUE CHECK(attachment_id>0),
    sender_identity_id INTEGER NOT NULL REFERENCES sender_identities(id) ON DELETE RESTRICT,
    sender_identity_version INTEGER NOT NULL,
    sender_evidence_version INTEGER NOT NULL,
    message_json TEXT NOT NULL CHECK(json_valid(message_json) AND json_type(message_json)='object'),
    created_at TEXT NOT NULL CHECK(${canonicalTimestamp('created_at')}),
    FOREIGN KEY(sender_identity_id,sender_evidence_version) REFERENCES sender_identity_evidence(sender_identity_id,evidence_version) ON DELETE RESTRICT
  ) STRICT`,
  `CREATE TRIGGER scheduled_run_deliveries_no_update BEFORE UPDATE ON scheduled_run_deliveries
    BEGIN SELECT RAISE(ABORT,'A scheduled delivery intent is immutable'); END`,
  `CREATE TRIGGER scheduled_run_deliveries_no_delete BEFORE DELETE ON scheduled_run_deliveries
    BEGIN SELECT RAISE(ABORT,'A scheduled delivery receipt is permanent'); END`,
  `ALTER TABLE run_items ADD COLUMN retry_requested_by_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT`,
  `ALTER TABLE run_items ADD COLUMN retry_requested_at TEXT CHECK(retry_requested_at IS NULL OR (${canonicalTimestamp('retry_requested_at')}))`,
  `CREATE TRIGGER proposed_runs_warning_review_required BEFORE UPDATE OF state ON proposed_runs
    WHEN NEW.state='confirmed' AND NEW.report_warnings_acknowledged=0 AND EXISTS(SELECT 1 FROM run_items WHERE run_id=NEW.id AND json_array_length(report_warnings_json)>0)
    BEGIN SELECT RAISE(ABORT,'Review and acknowledge report warnings before confirming'); END`,
  `CREATE TRIGGER proposed_runs_warning_review_final BEFORE UPDATE OF report_warnings_acknowledged ON proposed_runs
    WHEN OLD.state<>'proposed' AND NEW.report_warnings_acknowledged<>OLD.report_warnings_acknowledged
    BEGIN SELECT RAISE(ABORT,'The recorded warning acknowledgement is final'); END`,
  `ALTER TABLE proposed_runs ADD COLUMN cancelled_by_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT`,
  `CREATE TRIGGER scheduled_run_proposed_event AFTER INSERT ON proposed_runs
    WHEN NEW.proposal_manifest_json IS NOT NULL BEGIN
      INSERT INTO event_outbox(id,aggregate_type,aggregate_id,aggregate_sequence,event_type,payload_json,occurred_at,available_at)
      SELECT 'scheduled-run:'||NEW.id||':'||next.seq,'scheduled_run',NEW.id,next.seq,'scheduled_run.proposed',
        json_object('schema_version',1,'event_id','scheduled-run:'||NEW.id||':'||next.seq,'event_type','scheduled_run.proposed','occurred_at',NEW.proposed_at,
          'aggregate',json_object('type','scheduled_run','id',NEW.id,'sequence',next.seq),
          'actor',json_object('type','system','id',NULL),
          'scheduled_run',json_object('job_id',NEW.job_id,'occurrence_key',NEW.occurrence_key,'state',NEW.state,'expires_at',NEW.expires_at)),NEW.proposed_at,NEW.proposed_at
      FROM (SELECT coalesce(max(aggregate_sequence),0)+1 AS seq FROM event_outbox WHERE aggregate_type='scheduled_run' AND aggregate_id=NEW.id) next;
    END`,
  `CREATE TRIGGER scheduled_run_state_event AFTER UPDATE OF state ON proposed_runs
    WHEN NEW.state<>OLD.state BEGIN
      INSERT INTO event_outbox(id,aggregate_type,aggregate_id,aggregate_sequence,event_type,payload_json,occurred_at,available_at)
      SELECT 'scheduled-run:'||NEW.id||':'||next.seq,'scheduled_run',NEW.id,next.seq,'scheduled_run.'||NEW.state,
        json_object('schema_version',1,'event_id','scheduled-run:'||NEW.id||':'||next.seq,'event_type','scheduled_run.'||NEW.state,'occurred_at',NEW.updated_at,
          'aggregate',json_object('type','scheduled_run','id',NEW.id,'sequence',next.seq),
          'actor',json_object('type',CASE WHEN NEW.state='confirmed' OR (NEW.state='cancelled' AND NEW.cancelled_by_user_id IS NOT NULL) THEN 'user' ELSE 'system' END,'id',CASE WHEN NEW.state='confirmed' THEN NEW.confirmed_by_user_id WHEN NEW.state='cancelled' THEN NEW.cancelled_by_user_id ELSE NULL END),
          'scheduled_run',json_object('job_id',NEW.job_id,'occurrence_key',NEW.occurrence_key,'state',NEW.state,'report_warnings_acknowledged',NEW.report_warnings_acknowledged)),NEW.updated_at,NEW.updated_at
      FROM (SELECT coalesce(max(aggregate_sequence),0)+1 AS seq FROM event_outbox WHERE aggregate_type='scheduled_run' AND aggregate_id=NEW.id) next;
    END`,
  `CREATE TRIGGER scheduled_run_item_event AFTER UPDATE OF state,attempt_count ON run_items
    WHEN NEW.state<>OLD.state OR NEW.attempt_count<>OLD.attempt_count BEGIN
      INSERT INTO event_outbox(id,aggregate_type,aggregate_id,aggregate_sequence,event_type,payload_json,occurred_at,available_at)
      SELECT 'scheduled-run:'||NEW.run_id||':'||next.seq,'scheduled_run',NEW.run_id,next.seq,CASE NEW.state WHEN 'running' THEN 'scheduled_run.item_started' WHEN 'done' THEN 'scheduled_run.item_completed' ELSE 'scheduled_run.item_failed' END,
        json_object('schema_version',1,'event_id','scheduled-run:'||NEW.run_id||':'||next.seq,'event_type',CASE NEW.state WHEN 'running' THEN 'scheduled_run.item_started' WHEN 'done' THEN 'scheduled_run.item_completed' ELSE 'scheduled_run.item_failed' END,'occurred_at',coalesce(NEW.completed_at,NEW.attempted_at),
          'aggregate',json_object('type','scheduled_run','id',NEW.run_id,'sequence',next.seq),
          'actor',json_object('type','system','id',NULL),
          'scheduled_run',json_object('item_id',NEW.id,'subject_type',NEW.subject_type,'subject_id',NEW.subject_id,'state',NEW.state,'attempt_count',NEW.attempt_count,'failure_reason',NEW.failure_reason)),coalesce(NEW.completed_at,NEW.attempted_at),coalesce(NEW.completed_at,NEW.attempted_at)
      FROM (SELECT coalesce(max(aggregate_sequence),0)+1 AS seq FROM event_outbox WHERE aggregate_type='scheduled_run' AND aggregate_id=NEW.run_id) next;
    END`,
  `CREATE TRIGGER scheduled_run_retry_event AFTER UPDATE OF attempt_limit ON run_items
    WHEN NEW.attempt_limit<>OLD.attempt_limit BEGIN
      INSERT INTO event_outbox(id,aggregate_type,aggregate_id,aggregate_sequence,event_type,payload_json,occurred_at,available_at)
      SELECT 'scheduled-run:'||NEW.run_id||':'||next.seq,'scheduled_run',NEW.run_id,next.seq,'scheduled_run.item_retry_requested',
        json_object('schema_version',1,'event_id','scheduled-run:'||NEW.run_id||':'||next.seq,'event_type','scheduled_run.item_retry_requested','occurred_at',NEW.retry_requested_at,
          'aggregate',json_object('type','scheduled_run','id',NEW.run_id,'sequence',next.seq),
          'actor',json_object('type','user','id',NEW.retry_requested_by_user_id),
          'scheduled_run',json_object('item_id',NEW.id,'subject_type',NEW.subject_type,'subject_id',NEW.subject_id,'attempt_limit',NEW.attempt_limit)),NEW.retry_requested_at,NEW.retry_requested_at
      FROM (SELECT coalesce(max(aggregate_sequence),0)+1 AS seq FROM event_outbox WHERE aggregate_type='scheduled_run' AND aggregate_id=NEW.run_id) next;
    END`,
] as const
