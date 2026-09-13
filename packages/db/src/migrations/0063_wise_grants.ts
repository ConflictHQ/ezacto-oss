// What a contractor's Wise authorisation leaves behind (issue 543).
//
// Why per person rather than one row like QuickBooks. QuickBooks is a grant
// over the organisation's own books, so there is exactly one and the schema
// says `id = 1`. This is the opposite: the account being authorised belongs to
// the contractor, the choice of being paid that way is theirs, and two people
// connecting Wise are two unrelated grants. A single-row table here would make
// the second person's connection overwrite the first person's pay destination.
//
// Why the tokens are here and the identifier is in `user_payout_accounts`.
// They answer different questions and outlive each other by different amounts.
// The profile id is what a payout resolves to and must survive a revoked
// token, an expired refresh, a re-authorisation; the tokens are a credential
// that gets rotated on every refresh. Storing them together would mean either
// rewriting a payment destination on every token refresh, or keeping a stale
// destination alive because the credential beside it still works.
//
// So the callback does two things, and only one of them is money: it records
// the grant here, and it links or verifies the account there.

const canonicalTimestamp = (column: string) => `unixepoch(${column}) IS NOT NULL
  AND substr(${column}, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', ${column})
  AND (
    ${column} GLOB '????-??-??T??:??:??Z'
    OR ${column} GLOB '????-??-??T??:??:??.[0-9][0-9][0-9]Z'
  )`

export const wiseGrantsMigration = [
  `CREATE TABLE wise_grants (
    id INTEGER PRIMARY KEY,
    -- Whose account this authorises. Not who pressed the button: an
    -- administrator cannot connect somebody else's Wise, which is the point of
    -- doing this by OAuth rather than by asking for their details.
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    -- Sandbox and live are separate Wise deployments with separate account
    -- namespaces, so a grant carries which one it belongs to. A live payout
    -- against a sandbox profile id is not an error either side will catch.
    environment TEXT NOT NULL CHECK (environment IN ('sandbox','live')),
    -- Wise's identifier for the profile that authorised, as a string. It
    -- arrives as a JSON number large enough to lose precision as a double, and
    -- a rounded profile id addresses somebody else.
    profile_id TEXT NOT NULL CHECK (length(trim(profile_id)) BETWEEN 1 AND 64),
    profile_type TEXT NOT NULL CHECK (profile_type IN ('personal','business')),
    -- Credentials. Whoever holds the refresh token can move money out of this
    -- person's account until they revoke it.
    access_token TEXT NOT NULL CHECK (length(access_token) BETWEEN 1 AND 4096),
    refresh_token TEXT NOT NULL CHECK (length(refresh_token) BETWEEN 1 AND 4096),
    -- Absolute. Wise returns a duration, and a duration stored as-is expires
    -- the moment it is read back out of a row.
    access_token_expires_at TEXT NOT NULL
      CHECK (${canonicalTimestamp('access_token_expires_at')}),
    granted_at TEXT NOT NULL CHECK (${canonicalTimestamp('granted_at')}),
    -- Set rather than deleted, so a payout made last month still has the grant
    -- it was made under to point at.
    revoked_at TEXT CHECK (revoked_at IS NULL OR (${canonicalTimestamp('revoked_at')})),
    created_at TEXT NOT NULL CHECK (${canonicalTimestamp('created_at')}),
    updated_at TEXT NOT NULL CHECK (${canonicalTimestamp('updated_at')}),
    CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
  ) STRICT`,

  // One live grant per person. Re-authorising revokes the old one first, which
  // is what stops a refresh loop rotating tokens on a grant nobody reads.
  `CREATE UNIQUE INDEX wise_grants_current
    ON wise_grants(user_id)
    WHERE revoked_at IS NULL`,

  // And one person per Wise profile. Two people behind one profile means one of
  // them is paid for the other's work.
  `CREATE UNIQUE INDEX wise_grants_profile_current
    ON wise_grants(environment, profile_id)
    WHERE revoked_at IS NULL`,

  // Who the grant is for and which account it reaches are the facts. A token
  // refresh rewrites the credentials beside them every hour; letting that same
  // UPDATE path reach these columns is how a refresh quietly repoints somebody's
  // pay.
  `CREATE TRIGGER wise_grants_identity_immutable
    BEFORE UPDATE OF user_id, environment, profile_id ON wise_grants
    WHEN OLD.user_id IS NOT NEW.user_id
      OR OLD.environment IS NOT NEW.environment
      OR OLD.profile_id IS NOT NEW.profile_id
    BEGIN SELECT RAISE(ABORT, 'a wise grant identity is immutable'); END`,

  // Revoking is final. Re-authorising is a new row, so the record of when money
  // could have gone where stays true.
  `CREATE TRIGGER wise_grants_revoke_final
    BEFORE UPDATE OF revoked_at ON wise_grants
    WHEN OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at
    BEGIN SELECT RAISE(ABORT, 'a revoked wise grant cannot be restored'); END`,

  // A revoked grant's tokens are dead to us. Refreshing one would hand back a
  // working credential for an account the person disconnected.
  `CREATE TRIGGER wise_grants_revoked_tokens_frozen
    BEFORE UPDATE OF access_token, refresh_token, access_token_expires_at
    ON wise_grants
    WHEN OLD.revoked_at IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'a revoked wise grant cannot be refreshed'); END`,

  // The single-use value that ties a callback to the request that started it.
  //
  // Without it a third party can walk a contractor through connecting an
  // account, and every payout afterwards goes to a stranger. The row is deleted
  // on use, so a replayed callback finds nothing and is refused.
  `CREATE TABLE wise_oauth_states (
    state TEXT PRIMARY KEY CHECK (length(state) BETWEEN 16 AND 128),
    -- The person the grant will be recorded for. A callback cannot name whose
    -- account it is -- Wise does not know about our users -- so the state is
    -- where that is decided, at the moment the person asked.
    requested_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    environment TEXT NOT NULL CHECK (environment IN ('sandbox','live')),
    -- Must match what the authorize request was built with, or a code obtained
    -- for one deployment could be redeemed against another.
    redirect_uri TEXT NOT NULL CHECK (length(redirect_uri) BETWEEN 1 AND 512),
    created_at TEXT NOT NULL CHECK (${canonicalTimestamp('created_at')}),
    -- Short. A consent screen is answered in minutes; an hour-old state is a
    -- link somebody kept.
    expires_at TEXT NOT NULL CHECK (${canonicalTimestamp('expires_at')}),
    CHECK (expires_at > created_at)
  ) STRICT`,

  `CREATE INDEX wise_oauth_states_expiry ON wise_oauth_states(expires_at)`,
] as const
