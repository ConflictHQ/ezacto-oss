// Provenance: ezacto-pvt payout provider choice. Which payout providers an
// administrator has made available to people.
//
// One row per provider. A person may hold an account at every enabled provider
// (the schema already allows one current account per person per provider), and
// their preferred provider picks the primary. Both are enabled by default, so
// nothing changes for an instance until an administrator turns one off.
//
// Deliberately no CHECK on `provider`: the set of providers is code, and a new
// provider should be an added row, not a table rebuild.

export const payoutProviderEnablementMigration = [
  `CREATE TABLE payout_provider_enablement (
    provider TEXT PRIMARY KEY CHECK (length(trim(provider)) BETWEEN 1 AND 40),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    updated_at TEXT NOT NULL,
    updated_by_user_id INTEGER
  ) STRICT`,
  `INSERT INTO payout_provider_enablement (provider, enabled, updated_at)
    VALUES ('deel', 1, '1970-01-01T00:00:00.000Z'),
           ('wise', 1, '1970-01-01T00:00:00.000Z')`,
] as const
