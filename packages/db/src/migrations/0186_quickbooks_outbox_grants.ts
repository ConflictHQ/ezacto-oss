/** Capture grant identity in the same native commit as the accounting event.
 * Existing events are deliberately not attributed to a later/current grant.
 */
export const quickBooksOutboxGrantsMigration = [
  `CREATE TABLE quickbooks_outbox_grants (
    event_id TEXT PRIMARY KEY REFERENCES event_outbox(id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK(state IN ('bound','absent','unavailable')),
    generation INTEGER NOT NULL CHECK(generation>=0),
    grant_id TEXT,
    realm_id TEXT,
    connected_at TEXT,
    CHECK((state='bound' AND grant_id IS NOT NULL AND realm_id IS NOT NULL AND connected_at IS NOT NULL)
      OR (state<>'bound' AND grant_id IS NULL))
  ) STRICT`,
  `CREATE TRIGGER quickbooks_outbox_capture_grant AFTER INSERT ON event_outbox
    WHEN NEW.aggregate_type='invoice' AND NEW.event_type IN ('invoice.sent','payment.recorded')
    BEGIN INSERT INTO quickbooks_outbox_grants(event_id,state,generation,grant_id,realm_id,connected_at)
      SELECT NEW.id,CASE WHEN c.realm_id IS NULL OR c.disconnected_at IS NOT NULL THEN 'absent'
        WHEN m.grant_id IS NULL THEN 'unavailable' ELSE 'bound' END,
        g.generation,CASE WHEN c.disconnected_at IS NULL THEN m.grant_id ELSE NULL END,c.realm_id,c.connected_at
      FROM quickbooks_connection_generation g LEFT JOIN quickbooks_connections c ON c.id=1
      LEFT JOIN quickbooks_managed_grants m ON m.realm_id=c.realm_id AND m.recorded_at=c.connected_at
        AND m.accepted_generation=g.generation
      WHERE g.singleton=1;
    END`,
  `CREATE TRIGGER quickbooks_outbox_grant_immutable BEFORE UPDATE ON quickbooks_outbox_grants
    BEGIN SELECT RAISE(ABORT,'managed_quickbooks_outbox_grant_immutable'); END`,
  `CREATE TRIGGER quickbooks_outbox_grant_retained BEFORE DELETE ON quickbooks_outbox_grants
    WHEN EXISTS(SELECT 1 FROM event_outbox WHERE id=OLD.event_id)
    BEGIN SELECT RAISE(ABORT,'managed_quickbooks_outbox_grant_retained'); END`,
] as const
