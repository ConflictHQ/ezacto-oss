// Provenance: ezacto-pvt issue 1013, slices 2 and 3; a webhook Intuit never
// delivered left no trace, and a payment voided or deleted in QuickBooks was
// completed as "not mirrored back" while the receipt here stayed on the invoice.

import { canonicalTimestamp } from './0029_outbox_delivery.js'

/**
 * Where change-data-capture catch-up resumes, and a record of the payments
 * QuickBooks no longer counts.
 *
 * The cursor is its own row per company. It is not derived from
 * `quickbooks_webhook_deliveries`: a delivery row is stamped when it arrives,
 * which is later than the change it describes, so the newest delivery would
 * sit past a gap and resuming from it would skip that gap for good.
 *
 * `cdc_cursor` moves only after every change in a window has been applied.
 * `last_outcome` is what the last run came to; `full_reconcile_needed` means
 * the cursor is older than Intuit's 30-day horizon and the gap cannot be read
 * back, so the reconciliation report is the only way to compare the books.
 *
 * A divergence is a fact about one QuickBooks payment, written only where a
 * receipt here came from it. Nothing reads it as an instruction: the receipt,
 * the invoice and the QuickBooks document are all left as they are.
 */
export const quickBooksRecoveryMigration = [
  `CREATE TABLE quickbooks_sync_cursors (
    realm_id TEXT PRIMARY KEY CHECK (length(trim(realm_id)) BETWEEN 1 AND 64),
    cdc_cursor TEXT NOT NULL CHECK (${canonicalTimestamp('cdc_cursor')}),
    last_run_at TEXT NOT NULL CHECK (${canonicalTimestamp('last_run_at')}),
    last_outcome TEXT NOT NULL CHECK (
      last_outcome IN ('caught_up', 'failed', 'full_reconcile_needed')
    )
  ) STRICT`,

  `CREATE TABLE quickbooks_payment_divergences (
    realm_id TEXT NOT NULL CHECK (length(trim(realm_id)) BETWEEN 1 AND 64),
    quickbooks_payment_id TEXT NOT NULL CHECK (
      length(trim(quickbooks_payment_id)) BETWEEN 1 AND 64
    ),
    kind TEXT NOT NULL CHECK (kind IN ('voided', 'deleted')),
    -- Intuit's instant for the change; an older report never overwrites a newer one.
    quickbooks_updated_at TEXT NOT NULL CHECK (${canonicalTimestamp('quickbooks_updated_at')}),
    detected_at TEXT NOT NULL CHECK (${canonicalTimestamp('detected_at')}),
    PRIMARY KEY (realm_id, quickbooks_payment_id)
  ) STRICT`,
] as const
