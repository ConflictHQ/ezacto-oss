// Provenance: ezacto-pvt #1010, estimate expiry (owner decision 2026-10-19).
//
// `estimates.expires_on` is the last calendar day a customer can still answer,
// set by staff; NULL means staff set none. When it is NULL the organization's
// `estimate_validity_days` applies instead, counted from the day the estimate was
// first sent (`sent_at`) in the instance timezone; NULL there means estimates do
// not expire by default.
//
// Both are plain local calendar days. The expiry is not part of the content hash a
// customer answers, so moving it never invalidates the version they were shown.
export const estimateExpiryMigration = [
  `ALTER TABLE estimates ADD COLUMN expires_on TEXT
    CHECK (expires_on IS NULL OR (
      expires_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(expires_on) IS expires_on
    ))`,
  `ALTER TABLE organizations ADD COLUMN estimate_validity_days INTEGER
    CHECK (estimate_validity_days IS NULL OR estimate_validity_days BETWEEN 1 AND 3650)`,
] as const
