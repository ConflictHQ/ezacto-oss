/**
 * Claiming the hours a band was issued before it could claim them (#712).
 *
 * `claims_project_ids` makes a flat invoice consume the hours it covers, and
 * the claim is written inside the generation command. An invoice raised before
 * the definition carried that setting claimed nothing, and nothing afterwards
 * could correct it. Those hours read as uninvoiced for ever -- they are not,
 * they were paid for by a flat invoice that has settled -- so every figure
 * asking "what has been delivered and not billed" counts them.
 *
 * ## It reuses the engine's rule rather than restating it
 *
 * The eligibility predicate here is the one `recurring.generate` applies: still
 * unbilled, on the named projects, not mid-timer, spent on or before the
 * invoice's issue date. A second implementation of "what a band claims" would
 * be a second answer, and the whole point is that a backfilled invoice ends up
 * holding what a live generation would have given it.
 *
 * ## Which invoices are named, not inferred
 *
 * The caller passes the invoices. On real data a definition's own invoices are
 * not reliably linked to it -- an import can leave `recurring_invoice_id` null
 * on invoices that plainly belong to the band -- so inferring the list would
 * silently do the wrong amount of work. Naming them also makes the rehearsal
 * mean something: the operator approves a list and the figures beside it.
 *
 * ## Oldest invoice first
 *
 * Each invoice takes what is still unbilled at its issue date, so the earliest
 * takes the earliest work and later ones take what is left. Any other order
 * hands old hours to a recent invoice and leaves the old one holding nothing,
 * which is a period nobody can reconcile.
 */

import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'

type Database =
  | BetterSQLite3Database<typeof schema>
  | DrizzleD1Database<typeof schema>

export interface BandClaimBackfillInput {
  /** The invoices to fill, in any order; they are applied oldest issue first. */
  readonly invoiceIds: readonly number[]
  /** The projects the band covers. */
  readonly projectIds: readonly number[]
  readonly actorUserId: number
  readonly runId: string
  readonly occurredAt: string
  /** The definition the band belongs to, recorded on each row where known. */
  readonly recurringInvoiceId?: number | null
  /**
   * Default. A run that writes nothing is the one somebody reads before
   * approving the one that does, and the figures are large enough that nobody
   * should approve them from a description.
   */
  readonly apply?: boolean
}

export interface BandClaimBackfillInvoice {
  invoiceId: number
  number: string
  issueDate: string
  state: string
  amountCents: number
  entryCount: number
  seconds: number
  /** Billable value at list of what this invoice would absorb. */
  billableValueCents: number
  /** Entries among them carrying no billable rate, so the value above is partial. */
  entriesWithoutBillableRate: number
  /** What the band absorbed: value beyond the flat amount, never below zero. */
  foregoneBillableCents: number
}

export interface BandClaimBackfillReport {
  runId: string
  applied: boolean
  invoices: BandClaimBackfillInvoice[]
  /** Still unbilled on those projects afterwards -- work no named invoice covers. */
  remainingEntryCount: number
  remainingSeconds: number
}

interface CandidateRow {
  id: number
  seconds: number
  billableRateCents: number | null
}

interface InvoiceRow {
  id: number
  number: string
  issueDate: string
  state: string
  amountCents: number
}

const assertPositive = (value: number, label: string): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`)
  }
}

/**
 * Value at list for one entry, rounded once per entry.
 *
 * The same arithmetic the engine's `foregone_billable_cents` statement runs.
 * Pricing a summed duration instead would drift from what an invoice built from
 * those same entries charges, by a half-cent per entry.
 */
const entryValueCents = (seconds: number, rateCents: number | null): number =>
  rateCents === null ? 0 : Math.round((seconds * rateCents) / 3600)

export const backfillBandClaims = async (
  database: Database,
  input: Readonly<BandClaimBackfillInput>,
): Promise<BandClaimBackfillReport> => {
  if (input.invoiceIds.length === 0) {
    throw new TypeError('name at least one invoice to fill')
  }
  if (input.projectIds.length === 0) {
    throw new TypeError('name at least one project the band covers')
  }
  for (const id of input.invoiceIds) assertPositive(id, 'invoice id')
  for (const id of input.projectIds) assertPositive(id, 'project id')
  assertPositive(input.actorUserId, 'actor user id')
  const apply = input.apply === true
  const projects = JSON.stringify([...new Set(input.projectIds)])

  const invoices = await database.all<InvoiceRow>(sql`
    SELECT id, number, issue_date AS "issueDate", state, amount_cents AS "amountCents"
    FROM invoices
    WHERE id IN (SELECT CAST(member.value AS INTEGER)
                 FROM json_each(${JSON.stringify([...input.invoiceIds])}) member)
    ORDER BY issue_date, id
  `)
  if (invoices.length !== new Set(input.invoiceIds).size) {
    throw new TypeError('every named invoice must exist')
  }

  const report: BandClaimBackfillReport = {
    runId: input.runId,
    applied: apply,
    invoices: [],
    remainingEntryCount: 0,
    remainingSeconds: 0,
  }
  // Claimed in this run but not yet written, so a dry run allocates exactly as
  // an applied one would: without it every invoice would be offered the same
  // hours and the report would claim the work several times over.
  const taken = new Set<number>()

  for (const invoice of invoices) {
    const candidates = await database.all<CandidateRow>(sql`
      SELECT id, coalesce(rounded_seconds, seconds) AS "seconds",
        billable_rate_cents AS "billableRateCents"
      FROM time_entries
      WHERE invoice_id IS NULL AND billable = 1
        AND timer_started_at IS NULL
        AND NOT (started_time IS NOT NULL AND ended_time IS NULL)
        AND spent_date <= ${invoice.issueDate}
        AND project_id IN (
          SELECT CAST(member.value AS INTEGER) FROM json_each(${projects}) member
        )
      ORDER BY spent_date, id
    `)
    const claimed = candidates.filter((entry) => !taken.has(entry.id))
    for (const entry of claimed) taken.add(entry.id)

    let seconds = 0
    let billableValueCents = 0
    let entriesWithoutBillableRate = 0
    for (const entry of claimed) {
      seconds += entry.seconds
      if (entry.billableRateCents === null) entriesWithoutBillableRate += 1
      billableValueCents += entryValueCents(entry.seconds, entry.billableRateCents)
    }
    report.invoices.push({
      invoiceId: invoice.id,
      number: invoice.number,
      issueDate: invoice.issueDate,
      state: invoice.state,
      amountCents: invoice.amountCents,
      entryCount: claimed.length,
      seconds,
      billableValueCents,
      entriesWithoutBillableRate,
      // Never below zero, as the engine records it: a band that delivered less
      // than it charged forwent nothing, it was simply a good month.
      foregoneBillableCents: Math.max(0, billableValueCents - invoice.amountCents),
    })

    if (!apply || claimed.length === 0) continue
    for (const entry of claimed) {
      // Through the audit record, never by touching the column: the trigger
      // applies the claim, and refuses an entry that already belongs to an
      // invoice -- which is what makes a second run a no-op by rule rather than
      // by a WHERE clause somebody has to remember.
      await database.run(sql`
        INSERT INTO time_entry_claim_backfills
          (run_id, time_entry_id, invoice_id, recurring_invoice_id, actor_user_id, claimed_at)
        VALUES (${input.runId}, ${entry.id}, ${invoice.id},
          ${input.recurringInvoiceId ?? null}, ${input.actorUserId}, ${input.occurredAt})
      `)
    }
    // What the band absorbed, recorded as a live generation would. Deliberately
    // not `written_off_cents`: that is settlement, and this client owes and
    // pays the whole flat amount.
    await database.run(sql`
      UPDATE invoices SET foregone_billable_cents = max(
        0,
        coalesce((
          SELECT sum(CAST(ROUND(
            coalesce(entry.rounded_seconds, entry.seconds)
              * coalesce(entry.billable_rate_cents, 0) / 3600.0
          ) AS INTEGER))
          FROM time_entries entry WHERE entry.invoice_id = invoices.id
        ), 0) - invoices.amount_cents
      )
      WHERE id = ${invoice.id}
    `)
  }

  const remaining = await database.all<{ entries: number; seconds: number }>(sql`
    SELECT count(*) AS "entries",
      coalesce(sum(coalesce(rounded_seconds, seconds)), 0) AS "seconds"
    FROM time_entries
    WHERE invoice_id IS NULL AND billable = 1
      AND project_id IN (
        SELECT CAST(member.value AS INTEGER) FROM json_each(${projects}) member
      )
  `)
  const left = remaining[0]
  report.remainingEntryCount = (left?.entries ?? 0) - (apply ? 0 : taken.size)
  report.remainingSeconds = left?.seconds ?? 0
  if (!apply) {
    // A dry run has written nothing, so the database still counts what this run
    // would have claimed. Subtracted rather than re-queried, so the figure means
    // the same thing in both modes.
    let claimedSeconds = 0
    for (const line of report.invoices) claimedSeconds += line.seconds
    report.remainingSeconds -= claimedSeconds
  }
  return report
}
