// Provenance: ezacto-pvt #1238. Tenant-owned Deel connection and the durable
// intent that makes an unknown timesheet-create result safe.
//
// Deel has no idempotency key on timesheet creation. The transfer log (0129) is
// written only after Deel answers, so a lost response or a crash between the
// two leaves hours that may be at Deel with no record. `deel_transfer_intents`
// is written BEFORE the create and removed only when the log row lands (or a
// definite rejection / an operator says nothing was created). An entry with an
// intent is never planned again.
import { canonicalTimestamp } from './0029_outbox_delivery.js'

export const managedDeelConnectionMigration = [
  `CREATE TABLE deel_connection_generation (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    generation INTEGER NOT NULL CHECK(generation BETWEEN 0 AND 9007199254740991)
  ) STRICT`,
  `INSERT INTO deel_connection_generation VALUES(1,0)`,
  `CREATE TRIGGER deel_generation_identity BEFORE UPDATE ON deel_connection_generation
    WHEN NEW.singleton IS NOT OLD.singleton OR NEW.generation<>OLD.generation+1
    BEGIN SELECT RAISE(ABORT,'deel_generation_immutable'); END`,
  `CREATE TRIGGER deel_generation_retain BEFORE DELETE ON deel_connection_generation
    BEGIN SELECT RAISE(ABORT,'deel_generation_retained'); END`,
  `CREATE TABLE deel_connection (
    id INTEGER PRIMARY KEY CHECK(id=1),
    token TEXT NOT NULL CHECK(length(token) BETWEEN 1 AND 4096 AND token NOT GLOB '*[^!-~]*'),
    start_date TEXT NOT NULL CHECK(start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND date(start_date)=start_date),
    connected_by_user_id INTEGER NOT NULL CHECK(connected_by_user_id>0),
    connected_at TEXT NOT NULL CHECK(${canonicalTimestamp('connected_at')}),
    updated_at TEXT NOT NULL CHECK(${canonicalTimestamp('updated_at')})
  ) STRICT`,
  // Any lifecycle change advances the counter AND returns the sync to manual:
  // automatic scheduling needs its own explicit opt-in after every change.
  ...['INSERT', 'UPDATE', 'DELETE'].map(
    (
      verb,
    ) => `CREATE TRIGGER deel_connection_${verb.toLowerCase()}_lifecycle AFTER ${verb} ON deel_connection
    BEGIN
      UPDATE deel_connection_generation SET generation=generation+1 WHERE singleton=1;
      UPDATE deel_sync_settings SET mode='manual' WHERE id=1 AND mode<>'manual';
    END`,
  ),
  `CREATE TABLE deel_transfer_intents (
    entry_id INTEGER PRIMARY KEY CHECK(entry_id>0),
    contract_id TEXT NOT NULL CHECK(length(trim(contract_id)) BETWEEN 1 AND 128),
    fingerprint TEXT NOT NULL CHECK(length(trim(fingerprint)) BETWEEN 1 AND 255),
    started_at TEXT NOT NULL CHECK(${canonicalTimestamp('started_at')})
  ) STRICT`,
  `CREATE TRIGGER deel_transfer_log_resolves_intent AFTER INSERT ON deel_transfer_log
    BEGIN DELETE FROM deel_transfer_intents WHERE entry_id=NEW.entry_id; END`,
] as const
