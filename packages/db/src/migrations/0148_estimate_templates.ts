import { canonicalTimestamp } from './0029_outbox_delivery.js'
const writer = (actor: string) =>
  `EXISTS(SELECT 1 FROM users WHERE id=${actor} AND is_active=1 AND profile IN('administrator','accounting','executive_manager'))`
export const estimateTemplatesMigration = [
  `CREATE TABLE estimate_templates (
    id TEXT PRIMARY KEY CHECK(length(id)=36),
    name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
    version INTEGER NOT NULL DEFAULT 0 CHECK(version BETWEEN 0 AND 9007199254740991),
    archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN(0,1)),
    content_json TEXT NOT NULL CHECK(json_valid(content_json) AND json_type(content_json)='object'),
    actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL CHECK(${canonicalTimestamp('created_at')}),
    updated_at TEXT NOT NULL CHECK(${canonicalTimestamp('updated_at')})
  ) STRICT`,
  `CREATE TABLE estimate_template_versions (
    template_id TEXT NOT NULL REFERENCES estimate_templates(id) ON DELETE RESTRICT,
    version INTEGER NOT NULL,
    name TEXT NOT NULL,
    archived INTEGER NOT NULL,
    content_json TEXT NOT NULL,
    actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    occurred_at TEXT NOT NULL,
    PRIMARY KEY(template_id,version)
  ) STRICT`,
  ...['INSERT', 'UPDATE'].map(
    (
      action,
    ) => `CREATE TRIGGER estimate_template_${action.toLowerCase()}_guard BEFORE ${action} ON estimate_templates BEGIN
    SELECT CASE WHEN NOT ${writer('NEW.actor_user_id')} THEN RAISE(ABORT,'estimate_template_forbidden') END;
    SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.content_json) WHERE key NOT IN('subject','notes','currency','tax_rate_ppm','tax2_rate_ppm','discount_rate_ppm','lines')) THEN RAISE(ABORT,'estimate_template_private_field') END;
    ${action === 'INSERT' ? "SELECT CASE WHEN NEW.version!=0 OR NEW.archived!=0 THEN RAISE(ABORT,'estimate_template_conflict') END;" : "SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.created_at IS NOT OLD.created_at OR NEW.version!=OLD.version+1 OR OLD.archived=1 THEN RAISE(ABORT,'estimate_template_conflict') END;"}
  END`,
  ),
  ...['INSERT', 'UPDATE'].map(
    (
      action,
    ) => `CREATE TRIGGER estimate_template_${action.toLowerCase()}_audit AFTER ${action} ON estimate_templates BEGIN
    INSERT INTO estimate_template_versions VALUES(NEW.id,NEW.version,NEW.name,NEW.archived,NEW.content_json,NEW.actor_user_id,NEW.updated_at);
  END`,
  ),
  ...['UPDATE', 'DELETE'].map(
    (action) =>
      `CREATE TRIGGER estimate_template_audit_no_${action.toLowerCase()} BEFORE ${action} ON estimate_template_versions BEGIN SELECT RAISE(ABORT,'estimate_template_audit_immutable'); END`,
  ),
  `CREATE TRIGGER estimate_template_no_delete BEFORE DELETE ON estimate_templates BEGIN SELECT RAISE(ABORT,'estimate_template_archive_instead'); END`,
  `CREATE TABLE estimate_draft_commands (
    command_id TEXT PRIMARY KEY,
    actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    request_json TEXT NOT NULL CHECK(json_valid(request_json)),
    template_id TEXT REFERENCES estimate_templates(id) ON DELETE RESTRICT,
    template_version INTEGER,
    estimate_id INTEGER UNIQUE REFERENCES estimates(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL CHECK(${canonicalTimestamp('created_at')}),
    CHECK((template_id IS NULL)=(template_version IS NULL)),
    FOREIGN KEY(template_id,template_version) REFERENCES estimate_template_versions(template_id,version)
  ) STRICT`,
  `CREATE TRIGGER estimate_draft_insert_guard BEFORE INSERT ON estimate_draft_commands BEGIN
    SELECT CASE WHEN NOT ${writer('NEW.actor_user_id')} THEN RAISE(ABORT,'estimate_template_forbidden') END;
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM clients WHERE id=json_extract(NEW.request_json,'$.client_id') AND is_active=1) THEN RAISE(ABORT,'estimate_draft_conflict') END;
    SELECT CASE WHEN NEW.template_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM estimate_templates WHERE id=NEW.template_id AND version=NEW.template_version AND archived=0) THEN RAISE(ABORT,'estimate_template_conflict') END;
  END`,
  `CREATE TRIGGER estimate_draft_update_guard BEFORE UPDATE ON estimate_draft_commands WHEN
    NEW.command_id IS NOT OLD.command_id OR NEW.actor_user_id IS NOT OLD.actor_user_id OR NEW.request_json IS NOT OLD.request_json
    OR NEW.template_id IS NOT OLD.template_id OR NEW.template_version IS NOT OLD.template_version OR NEW.created_at IS NOT OLD.created_at
    OR (OLD.estimate_id IS NOT NULL AND NEW.estimate_id IS NOT OLD.estimate_id)
    BEGIN SELECT RAISE(ABORT,'estimate_draft_conflict'); END`,
  `CREATE TRIGGER estimate_draft_no_delete BEFORE DELETE ON estimate_draft_commands BEGIN SELECT RAISE(ABORT,'estimate_draft_receipt_immutable'); END`,
] as const
