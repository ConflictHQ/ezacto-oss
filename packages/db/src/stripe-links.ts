/**
 * The Stripe payment link an invoice was sent with (#102).
 *
 * Kept rather than re-minted. A Stripe payment link does not expire, so the URL
 * that went out in an email has to keep working -- re-minting on each read
 * would leave a client holding a link nobody can reconcile, and would create a
 * second Price on the account every time somebody opened the invoice.
 */

import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'

type Database =
  | BetterSQLite3Database<typeof schema>
  | DrizzleD1Database<typeof schema>

export interface StripeLinkRecord {
  invoiceId: number
  paymentLinkId: string
  url: string
}

export interface StripeLinkStore {
  read(invoiceId: number): Promise<StripeLinkRecord | null>
  /**
   * Records a link. Answers the link that is already there rather than
   * replacing it: the schema refuses a repoint, because replacing where a
   * client pays after they have been told where to pay is how somebody pays
   * into the wrong place.
   */
  save(input: {
    invoiceId: number
    paymentLinkId: string
    url: string
    now: string
  }): Promise<StripeLinkRecord>
  /** Our invoice for a Stripe link, for a payment arriving without metadata. */
  invoiceFor(paymentLinkId: string): Promise<number | null>
}

interface Row {
  invoice_id: number
  payment_link_id: string
  url: string
}

const record = (row: Row): StripeLinkRecord => ({
  invoiceId: row.invoice_id,
  paymentLinkId: row.payment_link_id,
  url: row.url,
})

export const createStripeLinkStore = (database: Database): StripeLinkStore => ({
  read: async (invoiceId) => {
    const rows = await database.all<Row>(sql`
      SELECT invoice_id, payment_link_id, url FROM stripe_payment_links
      WHERE invoice_id = ${invoiceId}`)
    return rows[0] === undefined ? null : record(rows[0])
  },

  save: async (input) => {
    const existing = await database.all<Row>(sql`
      SELECT invoice_id, payment_link_id, url FROM stripe_payment_links
      WHERE invoice_id = ${input.invoiceId}`)
    if (existing[0] !== undefined) return record(existing[0])
    const inserted = await database.all<Row>(sql`
      INSERT INTO stripe_payment_links
        (invoice_id, payment_link_id, url, created_at, updated_at)
      VALUES (${input.invoiceId}, ${input.paymentLinkId}, ${input.url},
        ${input.now}, ${input.now})
      RETURNING invoice_id, payment_link_id, url`)
    return record(inserted[0]!)
  },

  invoiceFor: async (paymentLinkId) => {
    const rows = await database.all<{ invoice_id: number }>(sql`
      SELECT invoice_id FROM stripe_payment_links
      WHERE payment_link_id = ${paymentLinkId}`)
    return rows[0]?.invoice_id ?? null
  },
})
