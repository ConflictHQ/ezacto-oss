// Provenance: ezacto-pvt #428, slice 1. Calendar events become *proposed* time
// entries a person accepts or discards.
//
// A proposal is deliberately not a `time_entries` row. Every row in that table
// is real time, so reports, locks, approvals and invoice generation never have
// to ask "is this one only a suggestion?". The failure mode of reading somebody's
// calendar stays noise (a proposal is discarded) and cannot become a wrong
// invoice.
//
// The event's identity is (user, provider, event, occurrence): the same meeting
// offered twice is one row, and a discarded one stays discarded because the
// second offer finds the first and changes nothing. `occurrence` separates the
// instances of a recurring event where a provider's event id does not, and is
// empty otherwise.
//
// Instants are stored in one fixed UTC shape (milliseconds, `Z`) so that a week
// is a plain string comparison. A proposal has an interval or it does not exist:
// an all-day event has no instants to store, which is how it stays out.
//
// Account closure erases a person's proposals: a meeting title is personal data
// and is not time worked.
// D1 refuses a GLOB pattern much longer than this one, so the shape is a short
// pattern plus a round trip through strftime, which rejects an impossible date.
const canonicalInstant = (column: string) => `${column} GLOB '????-??-??T??:??:??.[0-9][0-9][0-9]Z'
    AND unixepoch(${column}) IS NOT NULL
    AND substr(${column}, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', ${column})`

export const calendarProposalsMigration = [
  `CREATE TABLE calendar_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    provider TEXT NOT NULL CHECK (provider IN ('google', 'microsoft')),
    calendar_id TEXT NOT NULL CHECK (length(calendar_id) BETWEEN 1 AND 1024),
    event_id TEXT NOT NULL CHECK (length(event_id) BETWEEN 1 AND 1024),
    occurrence TEXT NOT NULL DEFAULT '' CHECK (length(occurrence) <= 64),
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 10000),
    starts_at TEXT NOT NULL CHECK (${canonicalInstant('starts_at')}),
    ends_at TEXT NOT NULL CHECK (${canonicalInstant('ends_at')} AND ends_at > starts_at),
    status TEXT NOT NULL DEFAULT 'proposed'
      CHECK (status IN ('proposed', 'accepted', 'discarded', 'cancelled')),
    source_version TEXT CHECK (source_version IS NULL OR length(source_version) BETWEEN 1 AND 256),
    time_entry_id INTEGER REFERENCES time_entries(id) ON DELETE SET NULL,
    decided_at TEXT CHECK (decided_at IS NULL OR (${canonicalInstant('decided_at')})),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (time_entry_id IS NULL OR status IN ('accepted', 'cancelled'))
  ) STRICT`,
  `CREATE UNIQUE INDEX calendar_proposals_event_identity
    ON calendar_proposals(user_id, provider, event_id, occurrence)`,
  `CREATE INDEX calendar_proposals_user_starts ON calendar_proposals(user_id, starts_at)`,
  `CREATE UNIQUE INDEX calendar_proposals_time_entry
    ON calendar_proposals(time_entry_id) WHERE time_entry_id IS NOT NULL`,
  // Whose proposal it is, and which event it came from, never change: every
  // read is scoped by the owner, so a row that could be handed to somebody else
  // would be a way to read their calendar.
  `CREATE TRIGGER calendar_proposals_identity_immutable
    BEFORE UPDATE ON calendar_proposals
    WHEN OLD.user_id IS NOT NEW.user_id
      OR OLD.provider IS NOT NEW.provider
      OR OLD.event_id IS NOT NEW.event_id
      OR OLD.occurrence IS NOT NEW.occurrence
    BEGIN SELECT RAISE(ABORT, 'a calendar proposal keeps its owner and event'); END`,
  // The rule that makes accepting atomic: a decision is made once. Accepting
  // writes the time entry and this status change in one batch; if the proposal
  // was already decided (a double click, two tabs) this aborts the batch and the
  // entry is never created.
  `CREATE TRIGGER calendar_proposals_decided_once
    BEFORE UPDATE OF status ON calendar_proposals
    WHEN OLD.status <> 'proposed' AND NEW.status IN ('accepted', 'discarded')
    BEGIN SELECT RAISE(ABORT, 'calendar proposal is not open'); END`,
  `CREATE TRIGGER account_closures_erase_calendar_proposals
    AFTER INSERT ON account_closures
    BEGIN DELETE FROM calendar_proposals WHERE user_id = NEW.user_id; END`,
] as const
