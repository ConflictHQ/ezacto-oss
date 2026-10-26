// Older links remain redeemable by their high-entropy email token. Their code
// exchange has no browser binding and therefore cannot authenticate after this migration.
export const staffCodeRequesterMigration = [
  "ALTER TABLE staff_magic_links ADD COLUMN requester_hash TEXT CHECK (requester_hash IS NULL OR (length(requester_hash)=64 AND requester_hash NOT GLOB '*[^0-9a-f]*'))",
  'CREATE UNIQUE INDEX staff_magic_links_requester ON staff_magic_links(user_id, requester_hash) WHERE requester_hash IS NOT NULL AND consumed_at IS NULL'
] as const
