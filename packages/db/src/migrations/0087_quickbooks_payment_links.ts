// Provenance: ezacto-oss issue 799; a payment recorded here never reached the
// mirrored invoice in QuickBooks, so "Mark paid" settled one book and not the other.

import { canonicalTimestamp } from './0029_outbox_delivery.js'

/**
 * One row per receipt this instance has copied into QuickBooks.
 *
 * Its own table rather than a third `kind` on `quickbooks_links`: that table's
 * CHECK and its existence guard both spell out the two kinds, and SQLite
 * rewrites a table to change a CHECK. A receipt also links by its own id, not
 * by the invoice's, because an invoice can be settled by several payments and
 * each one is its own document in QuickBooks.
 *
 * The same discipline as the invoice links: the pair a row names is the fact,
 * and correcting one means deleting it and making it again.
 */
export const quickBooksPaymentLinksMigration = [
  `CREATE TABLE quickbooks_payment_links (
    realm_id TEXT NOT NULL CHECK (length(trim(realm_id)) BETWEEN 1 AND 64),
    payment_id INTEGER NOT NULL CHECK (payment_id > 0),
    quickbooks_id TEXT NOT NULL CHECK (length(trim(quickbooks_id)) BETWEEN 1 AND 64),
    sync_token TEXT NOT NULL CHECK (length(trim(sync_token)) BETWEEN 1 AND 32),
    mirrored_at TEXT NOT NULL CHECK (${canonicalTimestamp('mirrored_at')}),
    created_at TEXT NOT NULL CHECK (${canonicalTimestamp('created_at')}),
    updated_at TEXT NOT NULL CHECK (${canonicalTimestamp('updated_at')}),
    PRIMARY KEY (realm_id, payment_id)
  )`,

  // Two of our receipts pointing at one QuickBooks payment is a double count,
  // and the schema refuses it the way it refuses it for invoices.
  `CREATE UNIQUE INDEX quickbooks_payment_links_remote
    ON quickbooks_payment_links(realm_id, quickbooks_id)`,

  `CREATE TRIGGER quickbooks_payment_links_insert_guard
    BEFORE INSERT ON quickbooks_payment_links
    WHEN NOT EXISTS (SELECT 1 FROM invoice_payments WHERE id = NEW.payment_id)
    BEGIN SELECT RAISE(ABORT, 'quickbooks payment link points at a payment that does not exist'); END`,

  `CREATE TRIGGER quickbooks_payment_links_identity_immutable
    BEFORE UPDATE ON quickbooks_payment_links
    WHEN OLD.realm_id IS NOT NEW.realm_id
      OR OLD.payment_id IS NOT NEW.payment_id
      OR OLD.quickbooks_id IS NOT NEW.quickbooks_id
    BEGIN SELECT RAISE(ABORT, 'quickbooks payment link identity is immutable'); END`,
] as const
