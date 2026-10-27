/** Ephemeral credentials are evidence in a backup, never usable in its restored copy. */
export const WORKER_BACKUP_CLEAR_TABLES = [
  "calendar_oauth_attempts",
  "sessions",
  "contact_sessions",
  "api_tokens",
  "auth_tokens",
  "auth_first_run",
  "auth_rate_limits",
  "magic_link_tokens",
  "staff_magic_links",
  "two_factor_challenges",
  "oidc_app_codes",
  "oidc_transactions",
  "quickbooks_oauth_states",
  "backup_download_links",
  "backup_download_limits",
] as const;
// The exact schema and its migration ledger travel together. Calendar grants
// instead become re-consent/cleanup custody through the normal restore finalizer.

/** Retain encrypted revocation custody, but require fresh consent in the restored instance. */
export const WORKER_BACKUP_REAUTHORIZE_TABLES = ["calendar_connections"] as const;
