// What Wise has already told us (issue 543).
//
// Wise retries a delivery it did not get a 2xx for, and a retry that arrives
// after a successful-but-slow handler is indistinguishable from a first
// delivery. Recording what has been acted on is what stops one transfer being
// settled twice against a payout -- which is money, not bookkeeping.
//
// Keyed on Wise's own delivery id. Where a delivery carries none, the caller
// derives a key from the event's own identity (subscription, type, resource,
// instant), which is stable across a retry for the same reason Intuit's
// (realm, entity, operation, last_updated) tuple is in 0048: a retry is the
// same event again, so anything derived from the event alone collides with it.
//
// Why the whole event is recorded and not just the id. A delivery we decided
// not to act on is a different fact from one that never arrived, and the
// difference is what somebody reads when a payout did not settle and nobody
// can say whether Wise ever mentioned it. `skipped_reason` is that answer:
// an event type we do not act on, a state that is not final, a transfer that
// is not one of ours.

const canonicalTimestamp = (column: string) => `unixepoch(${column}) IS NOT NULL
  AND substr(${column}, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', ${column})
  AND (
    ${column} GLOB '????-??-??T??:??:??Z'
    OR ${column} GLOB '????-??-??T??:??:??.[0-9][0-9][0-9]Z'
  )`

export const wiseWebhookDeliveriesMigration = [
  `CREATE TABLE wise_webhook_deliveries (
    delivery_id TEXT PRIMARY KEY CHECK (length(trim(delivery_id)) BETWEEN 1 AND 255),
    subscription_id TEXT NOT NULL CHECK (length(subscription_id) <= 128),
    event_type TEXT NOT NULL CHECK (length(trim(event_type)) BETWEEN 1 AND 64),
    -- Wise's transfer id as text, for the reason profile ids are text: it
    -- arrives as a JSON number, and a rounded id names somebody else's payment.
    -- Null where the event names no transfer, which the two other subscribed
    -- event types do not.
    transfer_id TEXT
      CHECK (transfer_id IS NULL OR length(trim(transfer_id)) BETWEEN 1 AND 64),
    current_state TEXT CHECK (current_state IS NULL OR length(current_state) <= 64),
    -- Wise's own instant for the change, where it gave one. Not a timestamp we
    -- can validate the shape of, because it is theirs to define.
    occurred_at TEXT CHECK (occurred_at IS NULL OR length(occurred_at) <= 64),
    received_at TEXT NOT NULL CHECK (${canonicalTimestamp('received_at')}),
    -- Null while the delivery is known but not yet acted on, so a crash between
    -- accepting and handling is visible rather than silently dropped.
    processed_at TEXT
      CHECK (processed_at IS NULL OR (${canonicalTimestamp('processed_at')})),
    -- Why it was not acted on, where that was a decision rather than a failure.
    skipped_reason TEXT CHECK (skipped_reason IS NULL OR length(skipped_reason) <= 255),
    CHECK (processed_at IS NULL OR processed_at >= received_at)
  ) STRICT`,

  `CREATE INDEX wise_webhook_deliveries_unprocessed
    ON wise_webhook_deliveries(received_at)
    WHERE processed_at IS NULL`,

  // Reading back what Wise said about one transfer, which is the question asked
  // when a payout did not settle.
  `CREATE INDEX wise_webhook_deliveries_transfer
    ON wise_webhook_deliveries(transfer_id)
    WHERE transfer_id IS NOT NULL`,

  // What a delivery said is the record of what Wise sent. Correcting it would
  // make the ledger a summary of our current beliefs rather than of what
  // arrived, and the whole reason to keep it is that those differ.
  `CREATE TRIGGER wise_webhook_deliveries_immutable
    BEFORE UPDATE OF subscription_id, event_type, transfer_id, current_state,
      occurred_at, received_at ON wise_webhook_deliveries
    BEGIN SELECT RAISE(ABORT, 'a recorded wise delivery is immutable'); END`,
] as const
