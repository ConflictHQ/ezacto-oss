// Linking a person to their account at a payout provider.
//
// Why not a column on users. Deel is not the only destination -- Wise is
// already wanted, and somebody with a Wise id should be payable without a Deel
// account at all. A `deel_id` column makes the second provider a schema change
// and the third another, so the provider is a value rather than a column name.
//
// Why not matching on email. That was the shape the first pass assumed, and its
// failure mode is paying the wrong person: an address is a guess about identity,
// and a person with a personal and a work address either fails to match or
// matches somebody else's record. The provider's own identifier is the fact, so
// that is what gets stored. An address remains useful for *proposing* a match a
// human then confirms, which is what `user_emails` is for.

const canonicalTimestamp = (column: string) => `unixepoch(${column}) IS NOT NULL
  AND substr(${column}, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', ${column})
  AND (
    ${column} GLOB '????-??-??T??:??:??Z'
    OR ${column} GLOB '????-??-??T??:??:??.[0-9][0-9][0-9]Z'
  )`

export const payoutAccountsMigration = [
  `CREATE TABLE user_payout_accounts (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    provider TEXT NOT NULL CHECK (provider IN ('deel','wise')),
    -- The provider's own identifier, verbatim. Not parsed, not normalised:
    -- what it means is theirs to define, and a value we reshaped is a value we
    -- can no longer hand back to them.
    external_id TEXT NOT NULL CHECK (length(trim(external_id)) BETWEEN 1 AND 255),
    -- Who attached it, and when. A payment destination that appeared with no
    -- author is one nobody can be asked about.
    linked_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    linked_at TEXT NOT NULL CHECK (${canonicalTimestamp('linked_at')}),
    -- Null until the provider itself confirmed the id resolves to this person.
    -- A link nobody checked is a claim, and paying against a claim is the
    -- failure this table exists to prevent.
    verified_at TEXT CHECK (verified_at IS NULL OR (${canonicalTimestamp('verified_at')})),
    -- Set rather than deleted, so a person's payout history stays readable
    -- after they move providers.
    detached_at TEXT CHECK (detached_at IS NULL OR (${canonicalTimestamp('detached_at')})),
    created_at TEXT NOT NULL CHECK (${canonicalTimestamp('created_at')}),
    updated_at TEXT NOT NULL CHECK (${canonicalTimestamp('updated_at')}),
    CHECK (detached_at IS NULL OR verified_at IS NULL OR detached_at >= verified_at)
  ) STRICT`,

  // One current account per person per provider. Partial, so detached rows keep
  // the history without colliding with the account that replaced them.
  `CREATE UNIQUE INDEX user_payout_accounts_current
    ON user_payout_accounts(user_id, provider)
    WHERE detached_at IS NULL`,

  // And one person per provider account. Two people pointing at the same Deel
  // id means one of them is being paid for the other's work, which is not a
  // state to discover from a bank statement.
  `CREATE UNIQUE INDEX user_payout_accounts_external_current
    ON user_payout_accounts(provider, external_id)
    WHERE detached_at IS NULL`,

  `CREATE INDEX user_payout_accounts_user
    ON user_payout_accounts(user_id)
    WHERE detached_at IS NULL`,

  // An external id is the thing payments follow, so it is immutable. Repointing
  // a link at a different account is detaching one and attaching another, which
  // leaves both in the history; an UPDATE would leave neither.
  `CREATE TRIGGER user_payout_accounts_identity_immutable
    BEFORE UPDATE OF user_id, provider, external_id ON user_payout_accounts
    WHEN OLD.user_id IS NOT NEW.user_id
      OR OLD.provider IS NOT NEW.provider
      OR OLD.external_id IS NOT NEW.external_id
    BEGIN SELECT RAISE(ABORT, 'a payout account identity is immutable'); END`,

  // Detaching is final. Re-attaching is a new row, so the record of when money
  // could have gone where stays true.
  `CREATE TRIGGER user_payout_accounts_detach_final
    BEFORE UPDATE OF detached_at ON user_payout_accounts
    WHEN OLD.detached_at IS NOT NULL AND NEW.detached_at IS NOT OLD.detached_at
    BEGIN SELECT RAISE(ABORT, 'a detached payout account cannot be reattached'); END`,
] as const
