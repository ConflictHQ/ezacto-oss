/**
 * What a month-end pack would do, as a list somebody can read (#58).
 *
 * A run that cannot render its manifest does not propose (#63), so this is the
 * function that decides whether a month-end run exists at all. It returns the
 * concrete items -- this invoice, this client, this amount, this address --
 * because "38 invoices" is not something a person can agree to.
 *
 * Two things it deliberately refuses to include, because including them is how
 * a pack sends something nobody meant to send:
 *
 * - an invoice that is not in a state to receive one. A draft has not been
 *   sent, so attaching last month's detail to it and queueing a send would
 *   deliver an invoice the operator had not finished writing.
 * - an invoice with no recipient. The item would be confirmed, executed, and
 *   fail at the last step, which is the worst place to discover it: after the
 *   person agreed to it and after the other items went.
 *
 * Both are excluded with a reason rather than silently, because the reason is
 * what an operator needs to fix before next month.
 */

import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import type { RunItemInput } from './scheduled-actions.js'

type Database =
  | BetterSQLite3Database<typeof schema>
  | DrizzleD1Database<typeof schema>

export interface MonthEndScope {
  /** The client nodes this pack covers. Empty means every client. */
  readonly clientIds?: readonly number[]
}

export interface MonthEndExclusion {
  readonly invoiceId: number
  readonly number: string
  readonly reason: string
}

export interface MonthEndManifest {
  readonly periodStart: string
  readonly periodEnd: string
  readonly items: readonly RunItemInput[]
  /**
   * What was left out and why.
   *
   * Carried beside the items rather than dropped, because an operator looking
   * at a pack of nine when they expected eleven needs to know which two and
   * what to do about it -- and next month is when they can fix it.
   */
  readonly excluded: readonly MonthEndExclusion[]
}

interface CandidateRow {
  id: number
  number: string
  client_id: number
  client_name: string
  state: string
  currency: string
  amount_cents: number
  recipient: string | null
}

/**
 * The invoices a pack would act on for one period.
 *
 * Scoped by issue date rather than by the invoice's own period columns: those
 * are nullable, and a pack that silently skipped every invoice without them
 * would be a pack that quietly shrank. What "last month" means is the caller's
 * to decide and is passed in.
 */
export const monthEndManifest = async (
  database: Database,
  input: Readonly<{
    periodStart: string
    periodEnd: string
    scope?: MonthEndScope
  }>,
): Promise<MonthEndManifest> => {
  const clientIds = input.scope?.clientIds ?? []
  const rows = await database.all<CandidateRow>(sql`
    SELECT invoice.id, invoice.number, invoice.client_id,
      client.name AS "client_name", invoice.state, upper(invoice.currency) AS "currency",
      invoice.amount_cents,
      (SELECT contact.email FROM contacts contact
        WHERE contact.client_id = invoice.client_id
          AND contact.invoice_recipient_status = 'recipient'
          AND contact.email IS NOT NULL AND trim(contact.email) <> ''
        ORDER BY contact.id LIMIT 1) AS "recipient"
    FROM invoices invoice
    JOIN clients client ON client.id = invoice.client_id
    WHERE invoice.issue_date BETWEEN ${input.periodStart} AND ${input.periodEnd}
      ${
        clientIds.length === 0
          ? sql``
          : sql`AND invoice.client_id IN (${sql.join(
              clientIds.map((id) => sql`${id}`),
              sql`, `,
            )})`
      }
    ORDER BY invoice.id`)

  const items: RunItemInput[] = []
  const excluded: MonthEndExclusion[] = []
  for (const row of rows) {
    // Sent, and not yet settled. A draft is unfinished; a paid or closed
    // invoice is done and does not want last month's detail arriving after it.
    if (row.state !== 'open') {
      excluded.push({
        invoiceId: row.id,
        number: row.number,
        reason: `the invoice is ${row.state}, not open`,
      })
      continue
    }
    if (row.recipient === null) {
      excluded.push({
        invoiceId: row.id,
        number: row.number,
        reason: 'the client has no invoice recipient',
      })
      continue
    }
    items.push({
      subjectType: 'invoice',
      subjectId: row.id,
      description: `${row.client_name} — work detail for invoice ${row.number}`,
      amountCents: row.amount_cents,
      currency: row.currency,
      target: row.recipient,
    })
  }

  return {
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    items,
    excluded,
  }
}
