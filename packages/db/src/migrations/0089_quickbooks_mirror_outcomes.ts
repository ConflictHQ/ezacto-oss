// Provenance: ezacto-oss issue 819; the QuickBooks mirror ran from the outbox
// and nothing on the invoice said whether it succeeded, was refused, or failed.

import { canonicalTimestamp } from './0029_outbox_delivery.js'

/**
 * The most recent mirror attempt for each invoice, overwritten on every
 * attempt: the invoice mirror on `invoice.sent`, the payment mirror on
 * `payment.recorded`, and a Sync pressed from the invoice page.
 *
 * Keyed on the invoice alone rather than on (realm, invoice), because the
 * attempt this exists to report -- "QuickBooks is not connected" -- has no
 * realm to be keyed under. The realm is carried where there was one so a
 * bookkeeper can tell which company an outcome was against.
 *
 * `refused` is a decision the mirror made and `failed` is an error it did not
 * expect; both carry a reason. The success kinds carry the QuickBooks id.
 */
export const quickBooksMirrorOutcomesMigration = [
  `CREATE TABLE quickbooks_mirror_outcomes (
    invoice_id INTEGER PRIMARY KEY CHECK (invoice_id > 0),
    realm_id TEXT CHECK (realm_id IS NULL OR length(trim(realm_id)) BETWEEN 1 AND 64),
    kind TEXT NOT NULL CHECK (
      kind IN ('created', 'updated', 'adopted', 'linked', 'refused', 'failed')
    ),
    reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 2000),
    quickbooks_id TEXT CHECK (
      quickbooks_id IS NULL OR length(trim(quickbooks_id)) BETWEEN 1 AND 64
    ),
    attempted_at TEXT NOT NULL CHECK (${canonicalTimestamp('attempted_at')}),
    CHECK ((kind IN ('refused', 'failed')) = (reason IS NOT NULL))
  )`,
] as const
