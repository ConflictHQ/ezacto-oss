// Provenance: ezacto-pvt issue 770, slice B. A user turns the emailed second
// factor on, and password sign-in starts issuing and mailing the code that
// slice A (0116) taught the challenge to carry.

// D1 refuses a GLOB pattern much longer than this one, so the shape is a short
// pattern plus a round trip through strftime, which rejects an impossible date.
const canonicalInstant = (column: string) => `${column} GLOB '????-??-??T??:??:??.[0-9][0-9][0-9]Z'
    AND unixepoch(${column}) IS NOT NULL
    AND substr(${column}, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', ${column})`

/**
 * Three things the factor needs that nothing else stores.
 *
 * `user_email_second_factors` is the enrolment: a row means the person asked
 * for a mailed code. It carries no secret, because the code is generated per
 * challenge, so there is nothing to confirm and nothing to leak -- which is why
 * it is not folded into `user_totp_enrolments`, whose rows mean a seed.
 *
 * `two_factor_email_code_sends` is the resend ledger. The challenge table
 * cannot be it: a fresh challenge deletes the one it supersedes and the sweep
 * drops expired rows, so after five minutes it has forgotten how many mails
 * went out. The hourly cap needs a record that outlives the challenge.
 *
 * `email_code_allowed` marks the challenges that may be mailed a code. Only a
 * password sign-in sets it. A magic link is already a credential delivered to
 * the mailbox, so a code to the same mailbox adds a step and no factor, and a
 * federated sign-in leaves the factor policy to its identity provider. The
 * refusal belongs on the row, where every route that reads a challenge sees
 * it, and not in each route's good intentions.
 */
export const emailSecondFactorMigration = [
  `CREATE TABLE user_email_second_factors (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    enabled_at TEXT NOT NULL CHECK (${canonicalInstant('enabled_at')})
  ) STRICT`,
  `CREATE TABLE two_factor_email_code_sends (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sent_at TEXT NOT NULL CHECK (${canonicalInstant('sent_at')})
  ) STRICT`,
  `CREATE INDEX two_factor_email_code_sends_user ON two_factor_email_code_sends(user_id, sent_at)`,
  `ALTER TABLE two_factor_challenges ADD COLUMN email_code_allowed INTEGER NOT NULL
    DEFAULT 0 CHECK (email_code_allowed IN (0, 1))`,
  // A challenge that could be rewritten to allow a code could be turned into
  // one for a sign-in that never earned it.
  `DROP TRIGGER two_factor_challenges_identity_immutable`,
  `CREATE TRIGGER two_factor_challenges_identity_immutable
    BEFORE UPDATE ON two_factor_challenges
    WHEN OLD.id IS NOT NEW.id
      OR OLD.user_id IS NOT NEW.user_id
      OR OLD.token_hash IS NOT NEW.token_hash
      OR OLD.code_hash IS NOT NEW.code_hash
      OR OLD.email_code_allowed IS NOT NEW.email_code_allowed
      OR OLD.expires_at IS NOT NEW.expires_at
      OR OLD.created_at IS NOT NEW.created_at
      OR OLD.consumed_at IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'a two-factor challenge is single use and immutable'); END`,
  // Closing an account erases its sign-in credentials (0103); these are two
  // more, and a closed account must not be handed a new one.
  `CREATE TRIGGER account_closures_erase_email_second_factor
    AFTER INSERT ON account_closures
    BEGIN
      DELETE FROM user_email_second_factors WHERE user_id = NEW.user_id;
      DELETE FROM two_factor_email_code_sends WHERE user_id = NEW.user_id;
    END`,
  `CREATE TRIGGER user_email_second_factors_closed_account_insert_guard
    BEFORE INSERT ON user_email_second_factors
    WHEN EXISTS (SELECT 1 FROM account_closures WHERE user_id = NEW.user_id)
    BEGIN SELECT RAISE(ABORT, 'a closed account cannot receive sign-in credentials'); END`,
] as const
