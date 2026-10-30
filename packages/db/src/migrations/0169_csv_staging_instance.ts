/** A private target incarnation, not CSV content or a second import ledger. */
export const csvStagingInstanceMigration = [
  `CREATE TABLE csv_staging_instance (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    nonce TEXT NOT NULL CHECK(length(nonce)=64 AND nonce NOT GLOB '*[^0-9a-f]*')
  )`,
  `INSERT INTO csv_staging_instance VALUES(1,lower(hex(randomblob(32))))`,
  `CREATE TRIGGER csv_staging_instance_retain BEFORE DELETE ON csv_staging_instance
    BEGIN SELECT RAISE(ABORT,'csv_staging_instance_required'); END`,
  // Normal account closure retains the subject and its audit identity. Physical
  // replacement is different: no reused numeric identity may inherit raw files.
  `CREATE TRIGGER csv_staging_user_replacement AFTER DELETE ON users
    BEGIN UPDATE csv_staging_instance SET nonce=lower(hex(randomblob(32))) WHERE singleton=1; END`,
  `CREATE TRIGGER csv_staging_organization_replacement AFTER DELETE ON organizations
    BEGIN UPDATE csv_staging_instance SET nonce=lower(hex(randomblob(32))) WHERE singleton=1; END`,
] as const
