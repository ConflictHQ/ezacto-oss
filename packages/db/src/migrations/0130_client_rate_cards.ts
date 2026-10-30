// Provenance: ezacto-pvt #34, slice B. Named rate cards attached to client nodes.
//
// A card belongs to exactly one client, and a client has at most one: nearest
// card on the parent chain wins, so a second card on the same node would have
// nothing to decide. Its rates live in append-only, effective-dated versions,
// the way `user_billable_rates` does: a correction is a new version, never an
// update or a delete. `lines` is a JSON array of {task_id, amount_cents}; a
// null task_id is the card default, and an empty array retires the card (the
// resolver skips it). Version and lines are one row, so a version is atomic on
// D1 and container SQLite alike and can never be half written.
//
// Nothing here touches time entries, invoices or their snapshots. A card only
// answers "what would this price at?" for work resolved after it is written.
export const clientRateCardsMigration = [
  `CREATE TABLE client_rate_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL UNIQUE REFERENCES clients(id) ON DELETE RESTRICT,
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE client_rate_card_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id INTEGER NOT NULL REFERENCES client_rate_cards(id) ON DELETE RESTRICT,
    start_date TEXT CHECK (
      start_date IS NULL OR (
        start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        AND date(start_date) = start_date
      )
    ),
    lines TEXT NOT NULL CHECK (json_valid(lines) AND json_type(lines) = 'array'),
    created_at TEXT NOT NULL,
    UNIQUE (card_id, start_date)
  ) STRICT`,
  `CREATE INDEX client_rate_card_versions_card ON client_rate_card_versions(card_id)`,
  `CREATE TRIGGER client_rate_card_versions_chronological
    BEFORE INSERT ON client_rate_card_versions
    WHEN EXISTS (
      SELECT 1 FROM client_rate_card_versions
      WHERE card_id = NEW.card_id
        AND coalesce(start_date, '0000-01-01') >= coalesce(NEW.start_date, '0000-01-01')
    )
    BEGIN SELECT RAISE(ABORT, 'rate card versions must be appended chronologically'); END`,
  `CREATE TRIGGER client_rate_card_versions_no_update
    BEFORE UPDATE ON client_rate_card_versions
    BEGIN SELECT RAISE(ABORT, 'rate card versions are append-only'); END`,
  `CREATE TRIGGER client_rate_card_versions_no_delete
    BEFORE DELETE ON client_rate_card_versions
    BEGIN SELECT RAISE(ABORT, 'rate card versions are append-only'); END`,
  `CREATE TRIGGER client_rate_cards_immutable
    BEFORE UPDATE ON client_rate_cards
    BEGIN SELECT RAISE(ABORT, 'rate cards cannot be changed; add a version'); END`,
  `CREATE TRIGGER client_rate_cards_no_delete
    BEFORE DELETE ON client_rate_cards
    BEGIN SELECT RAISE(ABORT, 'rate cards cannot be deleted'); END`,
] as const
