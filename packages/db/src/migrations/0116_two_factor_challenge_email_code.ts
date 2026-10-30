// Provenance: ezacto-pvt issue 770, slice A. An emailed six-digit second factor
// needs somewhere to keep the code and count the guesses against it.

const sha256Hex = (column: string) => `length(${column}) = 64
  AND ${column} NOT GLOB '*[^0-9a-f]*'`

/**
 * A challenge may now carry a code that was mailed to its user.
 *
 * The ceiling for the TOTP factor lives on the enrolment, but a user with only
 * the email factor has no enrolment row, so the count lives here, beside the
 * hash, the way `staff_magic_links` keeps its own. The code belongs to one
 * challenge, the challenge is short-lived, and a fresh one costs another
 * password attempt -- so a per-challenge count cannot be reset for free.
 *
 * Only a keyed hash of the code is stored. `code_hash` joins the columns the
 * immutability trigger already pins: a code that could be rewritten in place
 * could be replaced with one the writer knows.
 */
export const twoFactorChallengeEmailCodeMigration = [
  `ALTER TABLE two_factor_challenges ADD COLUMN code_hash TEXT
    CHECK (code_hash IS NULL OR (${sha256Hex('code_hash')}))`,
  `ALTER TABLE two_factor_challenges ADD COLUMN code_attempts INTEGER NOT NULL
    DEFAULT 0 CHECK (code_attempts BETWEEN 0 AND 1000)`,
  `DROP TRIGGER two_factor_challenges_identity_immutable`,
  `CREATE TRIGGER two_factor_challenges_identity_immutable
    BEFORE UPDATE ON two_factor_challenges
    WHEN OLD.id IS NOT NEW.id
      OR OLD.user_id IS NOT NEW.user_id
      OR OLD.token_hash IS NOT NEW.token_hash
      OR OLD.code_hash IS NOT NEW.code_hash
      OR OLD.expires_at IS NOT NEW.expires_at
      OR OLD.created_at IS NOT NEW.created_at
      OR OLD.consumed_at IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'a two-factor challenge is single use and immutable'); END`,
] as const
