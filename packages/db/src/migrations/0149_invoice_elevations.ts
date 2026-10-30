import {
  invoiceElevationSnapshotSql,
  invoiceTimeUnlinkSnapshotSql,
} from '../invoice-elevation-audit.js'
import { canonicalTimestamp } from './0029_outbox_delivery.js'
/** Evaluated at the command boundary too: possession never outlives the base authority. */
export const invoiceElevationBindingSql = (row: string, now: string) => `EXISTS(
  SELECT 1 FROM users actor JOIN api_tokens token ON token.user_id=actor.id
  JOIN user_passwords password ON password.user_id=actor.id
  JOIN invoices invoice ON invoice.id=${row}.invoice_id
  WHERE actor.id=${row}.user_id AND actor.is_active=1 AND actor.profile='administrator'
    AND token.id=${row}.token_id AND token.revoked_at IS NULL
    AND (token.expires_at IS NULL OR julianday(token.expires_at)>julianday(${now}))
    AND EXISTS(SELECT 1 FROM json_each(token.scopes) WHERE value='invoices:write')
    AND password.credential_version=${row}.credential_version AND invoice.state='draft'
)`
export const invoiceElevationSecondFactorSql = (
  row: string,
) => `(${row}.request_hash IS NOT NULL OR (
  NOT EXISTS(SELECT 1 FROM user_totp_enrolments WHERE user_id=${row}.user_id AND confirmed_at IS NOT NULL)
  AND NOT EXISTS(SELECT 1 FROM user_email_second_factors WHERE user_id=${row}.user_id)
))`
export const invoiceElevationsMigration = [
  `CREATE TABLE invoice_elevation_requests (
   challenge_hash TEXT PRIMARY KEY CHECK(length(challenge_hash)=64 AND challenge_hash NOT GLOB '*[^0-9a-f]*'),
   user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
   token_id INTEGER NOT NULL,
   invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
   credential_version INTEGER NOT NULL CHECK(credential_version>0),
   created_at TEXT NOT NULL CHECK(${canonicalTimestamp('created_at')}),
   expires_at TEXT NOT NULL CHECK(${canonicalTimestamp('expires_at')}),
   consumed_at TEXT CHECK(consumed_at IS NULL OR (${canonicalTimestamp('consumed_at')})),
   CHECK(julianday(expires_at)>julianday(created_at) AND unixepoch(expires_at)-unixepoch(created_at)<=900)
 ) STRICT`,
  `CREATE TABLE invoice_elevations (
   id TEXT PRIMARY KEY CHECK(length(id)=36),
   secret_hash TEXT NOT NULL UNIQUE CHECK(length(secret_hash)=64 AND secret_hash NOT GLOB '*[^0-9a-f]*'),
   user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
   token_id INTEGER NOT NULL,
   invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
   credential_version INTEGER NOT NULL CHECK(credential_version>0),
   scope TEXT NOT NULL DEFAULT 'invoice_drafts:write' CHECK(scope='invoice_drafts:write'),
   request_hash TEXT UNIQUE REFERENCES invoice_elevation_requests(challenge_hash) ON DELETE RESTRICT,
   created_at TEXT NOT NULL CHECK(${canonicalTimestamp('created_at')}),
   expires_at TEXT NOT NULL CHECK(${canonicalTimestamp('expires_at')}),
   revoked_at TEXT CHECK(revoked_at IS NULL OR (${canonicalTimestamp('revoked_at')})),
   CHECK(julianday(expires_at)>julianday(created_at) AND unixepoch(expires_at)-unixepoch(created_at)<=900)
 ) STRICT`,
  `CREATE TRIGGER invoice_elevation_second_factor_guard BEFORE INSERT ON invoice_elevations BEGIN SELECT CASE WHEN NOT ${invoiceElevationSecondFactorSql('NEW')} THEN RAISE(ABORT,'invoice_elevation_unavailable') END; END`,
  `CREATE TRIGGER invoice_elevation_verified_request BEFORE INSERT ON invoice_elevations WHEN NEW.request_hash IS NOT NULL BEGIN
   SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM invoice_elevation_requests request
     WHERE request.challenge_hash=NEW.request_hash AND request.user_id=NEW.user_id AND request.token_id=NEW.token_id
       AND request.invoice_id=NEW.invoice_id AND request.credential_version=NEW.credential_version
       AND request.consumed_at=NEW.created_at AND julianday(request.expires_at)>julianday(NEW.created_at)
   ) THEN RAISE(ABORT,'invoice_elevation_unavailable') END;
 END`,
  ...['invoice_elevation_requests', 'invoice_elevations'].map(
    (table) => `CREATE TRIGGER ${table}_binding_guard BEFORE INSERT ON ${table} BEGIN
   SELECT CASE WHEN NOT ${invoiceElevationBindingSql('NEW', 'NEW.created_at')} THEN RAISE(ABORT,'invoice_elevation_unavailable') END;
 END`,
  ),
  `CREATE TRIGGER invoice_elevation_request_consume_guard BEFORE UPDATE ON invoice_elevation_requests WHEN
   NEW.challenge_hash IS NOT OLD.challenge_hash OR NEW.user_id IS NOT OLD.user_id OR NEW.token_id IS NOT OLD.token_id
   OR NEW.invoice_id IS NOT OLD.invoice_id OR NEW.credential_version IS NOT OLD.credential_version
   OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
   OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
   OR julianday(NEW.consumed_at)<julianday(OLD.created_at) OR julianday(NEW.consumed_at)>=julianday(OLD.expires_at)
   OR NOT ${invoiceElevationBindingSql('NEW', 'NEW.consumed_at')}
   BEGIN SELECT RAISE(ABORT,'invoice_elevation_unavailable'); END`,
  `CREATE TRIGGER invoice_elevation_revoke_only BEFORE UPDATE ON invoice_elevations WHEN
   NEW.id IS NOT OLD.id OR NEW.secret_hash IS NOT OLD.secret_hash OR NEW.user_id IS NOT OLD.user_id
   OR NEW.token_id IS NOT OLD.token_id OR NEW.invoice_id IS NOT OLD.invoice_id OR NEW.credential_version IS NOT OLD.credential_version
   OR NEW.scope IS NOT OLD.scope OR NEW.request_hash IS NOT OLD.request_hash
   OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
   OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
   BEGIN SELECT RAISE(ABORT,'invoice_elevation_immutable'); END`,
  ...['invoice_elevation_requests', 'invoice_elevations'].map(
    (table) =>
      `CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'invoice_elevation_audit_immutable'); END`,
  ),
  `ALTER TABLE invoice_command_ledger ADD COLUMN elevation_id TEXT REFERENCES invoice_elevations(id) ON DELETE RESTRICT`,
  `ALTER TABLE invoice_command_ledger ADD COLUMN elevation_token_id INTEGER`,
  `ALTER TABLE invoice_command_ledger ADD COLUMN elevation_before_json TEXT CHECK(elevation_before_json IS NULL OR json_valid(elevation_before_json))`,
  `ALTER TABLE invoice_command_ledger ADD COLUMN elevation_after_json TEXT CHECK(elevation_after_json IS NULL OR json_valid(elevation_after_json))`,
  `CREATE TRIGGER invoice_command_elevation_snapshot_guard BEFORE INSERT ON invoice_command_ledger WHEN
    (NEW.elevation_id IS NULL AND (NEW.elevation_before_json IS NOT NULL OR NEW.elevation_after_json IS NOT NULL))
    OR (NEW.elevation_id IS NOT NULL AND (
      NEW.elevation_before_json IS NOT (${invoiceElevationSnapshotSql('NEW.invoice_id')}) OR NEW.elevation_after_json IS NOT NULL
    )) BEGIN SELECT RAISE(ABORT,'invoice_elevation_audit_required'); END`,
  `CREATE TRIGGER invoice_command_elevation_snapshot_immutable BEFORE UPDATE ON invoice_command_ledger WHEN
    NEW.elevation_before_json IS NOT OLD.elevation_before_json OR CASE
      WHEN OLD.elevation_id IS NOT NULL AND OLD.completed=0 AND NEW.completed=1
        THEN NEW.elevation_after_json IS NULL OR NEW.elevation_after_json IS NOT (${invoiceElevationSnapshotSql('NEW.invoice_id')})
      ELSE NEW.elevation_after_json IS NOT OLD.elevation_after_json END
    BEGIN SELECT RAISE(ABORT,'invoice_elevation_audit_immutable'); END`,
  `CREATE TRIGGER invoice_command_elevation_guard BEFORE INSERT ON invoice_command_ledger WHEN NEW.elevation_id IS NOT NULL OR NEW.elevation_token_id IS NOT NULL BEGIN
   SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM invoice_elevations elevation
     WHERE elevation.id=NEW.elevation_id AND elevation.token_id=NEW.elevation_token_id
       AND elevation.invoice_id=NEW.invoice_id AND NEW.actor_type='user' AND elevation.user_id=NEW.actor_id
       AND elevation.revoked_at IS NULL AND julianday(elevation.created_at)<=julianday(NEW.occurred_at)
       AND julianday(elevation.expires_at)>julianday(NEW.occurred_at)
       AND ${invoiceElevationBindingSql('elevation', 'NEW.occurred_at')} AND ${invoiceElevationSecondFactorSql('elevation')}
   ) THEN RAISE(ABORT,'invoice_elevation_required') END;
 END`,
  `CREATE TRIGGER invoice_command_elevation_immutable BEFORE UPDATE ON invoice_command_ledger
   WHEN NEW.elevation_id IS NOT OLD.elevation_id OR NEW.elevation_token_id IS NOT OLD.elevation_token_id
   BEGIN SELECT RAISE(ABORT,'invoice_elevation_audit_immutable'); END`,
  `CREATE TABLE invoice_elevated_time_commands (
    invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
    command_id TEXT NOT NULL CHECK(length(command_id) BETWEEN 1 AND 128),
    elevation_id TEXT NOT NULL REFERENCES invoice_elevations(id) ON DELETE RESTRICT,
    token_id INTEGER NOT NULL,
    actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    expected_invoice_version INTEGER NOT NULL CHECK(expected_invoice_version>=0),
    input_fingerprint TEXT NOT NULL CHECK(length(input_fingerprint)=71 AND substr(input_fingerprint,1,7)='sha256:' AND substr(input_fingerprint,8) NOT GLOB '*[^0-9a-f]*'),
    entry_ids_json TEXT NOT NULL CHECK(json_valid(entry_ids_json) AND json_type(entry_ids_json)='array' AND json_array_length(entry_ids_json) BETWEEN 1 AND 1000),
    before_json TEXT NOT NULL CHECK(json_valid(before_json)),
    after_json TEXT CHECK(after_json IS NULL OR json_valid(after_json)),
    result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
    completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN(0,1)),
    occurred_at TEXT NOT NULL CHECK(${canonicalTimestamp('occurred_at')}),
    PRIMARY KEY(invoice_id,command_id),
    CHECK((completed=0 AND after_json IS NULL AND result_json IS NULL) OR (completed=1 AND after_json IS NOT NULL AND result_json IS NOT NULL))
  ) STRICT`,
  `CREATE TRIGGER invoice_elevated_time_claim_guard BEFORE INSERT ON invoice_elevated_time_commands BEGIN
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM invoice_elevations elevation
      WHERE elevation.id=NEW.elevation_id AND elevation.token_id=NEW.token_id AND elevation.user_id=NEW.actor_user_id AND elevation.invoice_id=NEW.invoice_id
        AND elevation.revoked_at IS NULL AND julianday(elevation.created_at)<=julianday(NEW.occurred_at) AND julianday(elevation.expires_at)>julianday(NEW.occurred_at)
        AND ${invoiceElevationBindingSql('elevation', 'NEW.occurred_at')} AND ${invoiceElevationSecondFactorSql('elevation')}
        AND EXISTS(SELECT 1 FROM api_tokens token,json_each(token.scopes) scope WHERE token.id=NEW.token_id AND scope.value='time_entries:write')
    ) THEN RAISE(ABORT,'invoice_elevation_required') END;
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM invoices WHERE id=NEW.invoice_id AND state='draft' AND version=NEW.expected_invoice_version)
      OR NEW.completed!=0 OR EXISTS(SELECT 1 FROM json_each(NEW.entry_ids_json) WHERE type!='integer' OR value<1)
      OR (SELECT count(*) FROM time_entries WHERE id IN(SELECT value FROM json_each(NEW.entry_ids_json)) AND invoice_id=NEW.invoice_id
        AND timer_started_at IS NULL AND NOT(started_time IS NOT NULL AND ended_time IS NULL))!=json_array_length(NEW.entry_ids_json)
      OR NEW.before_json IS NOT (${invoiceTimeUnlinkSnapshotSql('NEW.entry_ids_json')})
      THEN RAISE(ABORT,'invoice_time_selection_conflict') END;
  END`,
  `CREATE TRIGGER invoice_elevated_time_complete_guard BEFORE UPDATE ON invoice_elevated_time_commands WHEN
    OLD.completed!=0 OR NEW.completed!=1
    OR NEW.invoice_id IS NOT OLD.invoice_id OR NEW.command_id IS NOT OLD.command_id OR NEW.elevation_id IS NOT OLD.elevation_id
    OR NEW.token_id IS NOT OLD.token_id OR NEW.actor_user_id IS NOT OLD.actor_user_id OR NEW.expected_invoice_version IS NOT OLD.expected_invoice_version
    OR NEW.input_fingerprint IS NOT OLD.input_fingerprint OR NEW.entry_ids_json IS NOT OLD.entry_ids_json OR NEW.before_json IS NOT OLD.before_json OR NEW.occurred_at IS NOT OLD.occurred_at
    OR NEW.after_json IS NOT (${invoiceTimeUnlinkSnapshotSql('NEW.entry_ids_json')}) OR NEW.result_json IS NULL
    OR (SELECT count(*) FROM time_entries WHERE id IN(SELECT value FROM json_each(NEW.entry_ids_json)) AND invoice_id IS NULL)!=json_array_length(NEW.entry_ids_json)
    OR json_extract(NEW.result_json,'$.invoiceId') IS NOT NEW.invoice_id OR json_extract(NEW.result_json,'$.elevationId') IS NOT NEW.elevation_id
    OR json_extract(NEW.result_json,'$.releasedEntryIds') IS NOT json(NEW.entry_ids_json)
    BEGIN SELECT RAISE(ABORT,'invoice_time_audit_immutable'); END`,
  `CREATE TRIGGER invoice_elevated_time_no_delete BEFORE DELETE ON invoice_elevated_time_commands BEGIN SELECT RAISE(ABORT,'invoice_time_audit_immutable'); END`,
] as const
