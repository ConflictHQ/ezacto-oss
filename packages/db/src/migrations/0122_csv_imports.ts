// Provenance: ezacto-pvt #1012, slice 2. Source identity for the vendor-neutral
// CSV time import, so that running the same file again adds nothing.
//
// A run is the pair (source id, file sha-256): the same file under the same
// source is one run however often it is applied, and the mapping that turned
// its people, clients, projects and tasks into this instance's is stored with
// it, so a retry after a partial failure cannot quietly use a different one.
//
// An entry row is the source key of one CSV row and the time entry it became.
// The key is unique per source id across runs, which is what makes an updated
// export of the same source add only the rows it did not carry before. It is
// written in the same batch as the time entry, so there is no moment at which
// one exists without the other.
//
// `time_entry_id` is set null when the entry is deleted: the key stays as a
// tombstone, so a deleted entry is not resurrected by the next run of the file.
// Nothing here is money, and the importer writes no invoice, payment or expense.
const sha256 = (column: string) => `length(${column}) = 64 AND ${column} NOT GLOB '*[^0-9a-f]*'`

export const csvImportsMigration = [
  `CREATE TABLE csv_import_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT NOT NULL
      CHECK (length(source_id) BETWEEN 1 AND 64 AND source_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
    file_sha256 TEXT NOT NULL CHECK (${sha256('file_sha256')}),
    mapping_json TEXT NOT NULL CHECK (json_valid(mapping_json)),
    mapping_sha256 TEXT NOT NULL CHECK (${sha256('mapping_sha256')}),
    status TEXT NOT NULL CHECK (status IN ('partial', 'aborted', 'complete')),
    total_rows INTEGER NOT NULL CHECK (total_rows >= 0),
    rejected_rows INTEGER NOT NULL DEFAULT 0 CHECK (rejected_rows >= 0),
    last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 2000),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT
  ) STRICT`,
  `CREATE UNIQUE INDEX csv_import_runs_identity ON csv_import_runs(source_id, file_sha256)`,
  `CREATE TABLE csv_import_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES csv_import_runs(id) ON DELETE RESTRICT,
    source_id TEXT NOT NULL,
    source_key TEXT NOT NULL CHECK (length(source_key) BETWEEN 1 AND 128),
    time_entry_id INTEGER REFERENCES time_entries(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  ) STRICT`,
  `CREATE UNIQUE INDEX csv_import_entries_source_key ON csv_import_entries(source_id, source_key)`,
  `CREATE UNIQUE INDEX csv_import_entries_time_entry
    ON csv_import_entries(time_entry_id) WHERE time_entry_id IS NOT NULL`,
  `CREATE INDEX csv_import_entries_run ON csv_import_entries(run_id)`,
]
