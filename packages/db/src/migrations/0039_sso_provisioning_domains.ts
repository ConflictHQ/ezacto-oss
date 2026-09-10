// Provenance: ezacto-oss #270; the domain scope #268 provisions from.

const canonicalTimestamp = (column: string) => `unixepoch(${column}) IS NOT NULL
  AND substr(${column}, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', ${column})
  AND CAST(substr(${column}, 12, 2) AS INTEGER) BETWEEN 0 AND 23
  AND CAST(substr(${column}, 15, 2) AS INTEGER) BETWEEN 0 AND 59
  AND CAST(substr(${column}, 18, 2) AS INTEGER) BETWEEN 0 AND 59
  AND (
    ${column} GLOB '????-??-??T??:??:??Z'
    OR ${column} GLOB '????-??-??T??:??:??.[0-9]Z'
    OR ${column} GLOB '????-??-??T??:??:??.[0-9][0-9]Z'
    OR ${column} GLOB '????-??-??T??:??:??.[0-9][0-9][0-9]Z'
  )`

/**
 * Which domains this instance may create a user for when nobody matches an SSO
 * assertion. The table exists because the answer is instance configuration and
 * an operator typing "we own example.com" into a settings form is an
 * assertion, not a proof: the row is inert until a TXT record published under
 * the domain repeats the token stored here.
 *
 * `challenge_token` is written by the server from random bytes and is not
 * derived from the domain, so knowing the name gives no help in publishing the
 * record; it is base64url so it survives a TXT string byte for byte.
 *
 * `verified_at` is nullable and stays writable in both directions on purpose.
 * Verification is revocable — a domain whose record is taken down must lose its
 * provisioning rights on the next check — so this is current state, not a
 * receipt. `last_checked_at` records that a check happened at all, which is how
 * a lapsed domain is told apart from one nobody has looked at since it was
 * added.
 */
export const ssoProvisioningDomainsMigration = [
  `CREATE TABLE sso_provisioning_domains (
    id INTEGER PRIMARY KEY,
    domain TEXT NOT NULL UNIQUE,
    challenge_token TEXT NOT NULL,
    verified_at TEXT,
    last_checked_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
      length(domain) BETWEEN 4 AND 253
      AND domain = lower(domain)
      AND domain NOT GLOB '*[^a-z0-9.-]*'
      AND domain GLOB '*?.?*'
      AND domain NOT GLOB '.*' AND domain NOT GLOB '*.'
      AND domain NOT GLOB '*..*'
      AND domain NOT GLOB '-*' AND domain NOT GLOB '*-'
      AND domain NOT GLOB '*-.*' AND domain NOT GLOB '*.-*'
    ),
    CHECK (
      length(challenge_token) BETWEEN 32 AND 128
      AND challenge_token NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    CHECK (verified_at IS NULL OR (${canonicalTimestamp('verified_at')})),
    CHECK (last_checked_at IS NULL OR (${canonicalTimestamp('last_checked_at')})),
    CHECK (${canonicalTimestamp('created_at')}),
    CHECK (${canonicalTimestamp('updated_at')}),
    -- A domain cannot be verified without a check having happened, and the
    -- verification cannot predate the lookup that granted it.
    CHECK (
      verified_at IS NULL
      OR (last_checked_at IS NOT NULL
        AND julianday(verified_at) <= julianday(last_checked_at))
    )
  ) STRICT`,
] as const
