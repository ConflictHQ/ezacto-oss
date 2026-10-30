import { canonicalTimestamp } from './0029_outbox_delivery.js'
export const offsiteBackupSyncMigration = [
  `CREATE TABLE offsite_backup_syncs (
    id TEXT PRIMARY KEY,
    backup_run_id INTEGER NOT NULL REFERENCES backup_runs(id) ON DELETE RESTRICT,
    destination_id TEXT NOT NULL CHECK(length(destination_id)=64),
    destination_label TEXT NOT NULL,
    encryption_key_id TEXT NOT NULL CHECK(length(encryption_key_id)=32),
    source_prefix TEXT NOT NULL,
    source_manifest_json TEXT NOT NULL CHECK(json_valid(source_manifest_json)),
    target_prefix TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','running','completed','failed')),
    lease_token TEXT,
    lease_expires_at TEXT CHECK(lease_expires_at IS NULL OR (${canonicalTimestamp('lease_expires_at')})),
    retry_at TEXT CHECK(retry_at IS NULL OR (${canonicalTimestamp('retry_at')})),
    error_message TEXT,
    started_at TEXT NOT NULL CHECK(${canonicalTimestamp('started_at')}),
    updated_at TEXT NOT NULL CHECK(${canonicalTimestamp('updated_at')}),
    completed_at TEXT CHECK(completed_at IS NULL OR (${canonicalTimestamp('completed_at')})),
    UNIQUE(backup_run_id,destination_id),
    CHECK((lease_token IS NULL)=(lease_expires_at IS NULL)),
    CHECK((status='completed')=(completed_at IS NOT NULL))
  ) STRICT`,
  `CREATE TABLE offsite_backup_objects (
    sync_id TEXT NOT NULL REFERENCES offsite_backup_syncs(id) ON DELETE RESTRICT,
    name TEXT NOT NULL,
    encryption_key_id TEXT NOT NULL CHECK(length(encryption_key_id)=32),
    nonce TEXT NOT NULL CHECK(length(nonce)=16),
    source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'),
    cipher_sha256 TEXT CHECK(cipher_sha256 IS NULL OR (length(cipher_sha256)=64 AND cipher_sha256 NOT GLOB '*[^0-9a-f]*')),
    cipher_size INTEGER CHECK(cipher_size IS NULL OR cipher_size>=0),
    uploaded_at TEXT CHECK(uploaded_at IS NULL OR (${canonicalTimestamp('uploaded_at')})),
    PRIMARY KEY(sync_id,name), UNIQUE(encryption_key_id,nonce),
    CHECK((uploaded_at IS NULL)=(cipher_sha256 IS NULL)),
    CHECK((uploaded_at IS NULL)=(cipher_size IS NULL))
  ) STRICT`,
  `CREATE INDEX offsite_backup_sync_due ON offsite_backup_syncs(destination_id,status,retry_at,started_at)`,
  `CREATE TRIGGER offsite_backup_sync_identity_final BEFORE UPDATE ON offsite_backup_syncs
    WHEN NEW.id IS NOT OLD.id OR NEW.backup_run_id IS NOT OLD.backup_run_id
      OR NEW.destination_id IS NOT OLD.destination_id OR NEW.destination_label IS NOT OLD.destination_label
      OR NEW.encryption_key_id IS NOT OLD.encryption_key_id OR NEW.source_prefix IS NOT OLD.source_prefix
      OR NEW.source_manifest_json IS NOT OLD.source_manifest_json OR NEW.target_prefix IS NOT OLD.target_prefix OR NEW.started_at IS NOT OLD.started_at
      OR (OLD.status='completed' AND (NEW.status IS NOT OLD.status OR NEW.completed_at IS NOT OLD.completed_at))
    BEGIN SELECT RAISE(ABORT,'Off-site backup identity and completion are final'); END`,
  `CREATE TRIGGER offsite_backup_object_identity_final BEFORE UPDATE ON offsite_backup_objects
    WHEN NEW.sync_id IS NOT OLD.sync_id OR NEW.name IS NOT OLD.name
      OR NEW.encryption_key_id IS NOT OLD.encryption_key_id OR NEW.nonce IS NOT OLD.nonce
      OR NEW.source_sha256 IS NOT OLD.source_sha256
      OR (OLD.uploaded_at IS NOT NULL AND (NEW.uploaded_at IS NOT OLD.uploaded_at
        OR NEW.cipher_sha256 IS NOT OLD.cipher_sha256 OR NEW.cipher_size IS NOT OLD.cipher_size))
    BEGIN SELECT RAISE(ABORT,'Encrypted backup nonces, input hashes and upload receipts are final'); END`,
  `CREATE TRIGGER offsite_backup_object_guard BEFORE INSERT ON offsite_backup_objects
    WHEN NOT EXISTS(SELECT 1 FROM offsite_backup_syncs WHERE id=NEW.sync_id AND encryption_key_id=NEW.encryption_key_id AND status='running')
    BEGIN SELECT RAISE(ABORT,'Backup objects require their active encrypted sync'); END`,
  `CREATE TRIGGER offsite_backup_manifest_last BEFORE UPDATE OF uploaded_at ON offsite_backup_objects
    WHEN NEW.name='manifest.json' AND NEW.uploaded_at IS NOT NULL AND EXISTS(
      SELECT 1 FROM offsite_backup_objects WHERE sync_id=NEW.sync_id AND name<>'manifest.json' AND uploaded_at IS NULL)
    BEGIN SELECT RAISE(ABORT,'The encrypted manifest must be uploaded last'); END`,
  `CREATE TRIGGER offsite_backup_complete_guard BEFORE UPDATE OF status ON offsite_backup_syncs
    WHEN NEW.status='completed' AND (NOT EXISTS(SELECT 1 FROM offsite_backup_objects WHERE sync_id=NEW.id AND name='manifest.json')
      OR EXISTS(SELECT 1 FROM offsite_backup_objects WHERE sync_id=NEW.id AND uploaded_at IS NULL))
    BEGIN SELECT RAISE(ABORT,'A complete off-site backup requires every verified object'); END`,
  `CREATE TRIGGER offsite_backup_sync_no_delete BEFORE DELETE ON offsite_backup_syncs
    BEGIN SELECT RAISE(ABORT,'Off-site backup receipts are permanent'); END`,
  `CREATE TRIGGER offsite_backup_object_no_delete BEFORE DELETE ON offsite_backup_objects
    BEGIN SELECT RAISE(ABORT,'Off-site backup object receipts are permanent'); END`,
] as const
