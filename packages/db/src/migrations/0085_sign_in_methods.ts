// Provenance: ezacto-oss issue 761; which ways in an instance offers, as a
// setting an administrator can see rather than three separate secret checks.

/**
 * Only the decisions somebody made are recorded. An absent key means enabled,
 * so the default `{}` leaves every configured method exactly as it was before
 * this migration ran -- an upgrade that turns nothing off is the only safe kind
 * for the setting that decides who gets in.
 *
 * Whether a method is *available* is not stored. That is the deployment's
 * business (a client id, a signing key), it can change under a running
 * instance, and a row claiming Google is on would be a lie the moment the
 * credentials were removed.
 */
export const signInMethodsMigration = [
  `ALTER TABLE organizations ADD COLUMN sign_in_methods TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(sign_in_methods) AND json_type(sign_in_methods) = 'object')`,
] as const
