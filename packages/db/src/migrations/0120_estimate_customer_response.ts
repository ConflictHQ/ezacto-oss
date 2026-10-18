// Provenance: ezacto-pvt #1010, slice 1. A contact of the client answers a sent
// estimate, and the answer is bound to the exact content they were shown.
//
// `sent_content_hash` is the content hash recorded when staff last sent the
// estimate. A customer response is accepted only while the estimate still hashes
// to it, so an edit to a sent estimate quietly stops it being answerable until it
// is sent again. Estimates imported as already sent carry no hash and need one
// send before a customer can answer them; nothing is guessed on their behalf.
//
// A customer response is an `estimate_messages` row like a staff one, plus the
// contact who answered, the content hash they saw and the estimate version they
// answered. (estimate_id, estimate_version) is unique among customer responses, so
// two answers racing for the same version cannot both be recorded; re-opening
// bumps the version and so allows a fresh answer.
const sha256Hex = (column: string) =>
  `${column} IS NULL OR (length(${column}) = 64 AND ${column} NOT GLOB '*[^0-9a-f]*')`

export const estimateCustomerResponseMigration = [
  `ALTER TABLE estimates ADD COLUMN sent_content_hash TEXT
    CHECK (${sha256Hex('sent_content_hash')})`,
  `ALTER TABLE estimate_messages ADD COLUMN contact_id INTEGER
    REFERENCES contacts(id) ON DELETE SET NULL`,
  `ALTER TABLE estimate_messages ADD COLUMN content_hash TEXT
    CHECK (${sha256Hex('content_hash')})`,
  `ALTER TABLE estimate_messages ADD COLUMN estimate_version INTEGER
    CHECK (estimate_version IS NULL OR estimate_version BETWEEN 0 AND 9007199254740991)`,
  `CREATE UNIQUE INDEX estimate_messages_customer_response_unique
    ON estimate_messages(estimate_id, estimate_version) WHERE estimate_version IS NOT NULL`,
  `CREATE TRIGGER estimate_messages_customer_response_shape
    BEFORE INSERT ON estimate_messages
    WHEN (NEW.contact_id IS NOT NULL OR NEW.content_hash IS NOT NULL
        OR NEW.estimate_version IS NOT NULL)
      AND NOT (NEW.contact_id IS NOT NULL AND NEW.content_hash IS NOT NULL
        AND NEW.estimate_version IS NOT NULL AND NEW.event_type IN ('accept', 'decline'))
    BEGIN SELECT RAISE(ABORT, 'estimate customer response is incomplete'); END`,
  `CREATE TRIGGER estimate_messages_customer_response_immutable
    BEFORE UPDATE OF content_hash, estimate_version ON estimate_messages
    WHEN OLD.estimate_version IS NOT NULL
      AND (OLD.content_hash IS NOT NEW.content_hash
        OR OLD.estimate_version IS NOT NEW.estimate_version)
    BEGIN SELECT RAISE(ABORT, 'estimate customer response is immutable'); END`,
] as const
