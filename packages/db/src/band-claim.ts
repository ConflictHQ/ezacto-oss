/**
 * What a band claims: the one rule, shared by everything that raises one.
 *
 * A band is a flat fee that consumes the hours it covers instead of pricing
 * them (#484). The recurring engine raises one every period from a definition,
 * and the New invoice dialog raises one by hand. Both ask the same question --
 * of the hours that could be covered, which ones are -- and two answers to it
 * would be two bands that cover different hours for the same ceiling, which is
 * a reconciliation nobody can do. So the answer lives here, as SQL both callers
 * run, and each caller only says which hours are eligible.
 *
 * Without a ceiling the band takes every eligible entry. With one (#707) it
 * takes the oldest entries up to the limit, measured in tracked duration or in
 * billable value at list, and leaves the rest.
 */

export interface BandClaimSql {
  text: string
  params: Array<string | number | null>
}

/**
 * How much of the eligible work a band takes, in one unit or the other: a
 * capacity promise ("400 hours") or a budget ("work worth up to X at list").
 * They are different deals and neither is a rounding of the other.
 */
export interface BandClaimCeiling {
  readonly unit: 'seconds' | 'cents'
  readonly limit: number
}

/**
 * The ids of the eligible entries a band claims, as a `SELECT id` over
 * `time_entries`. `eligible` is a predicate on unqualified `time_entries`
 * columns with its own parameters.
 */
export const bandClaimSelection = (
  eligible: BandClaimSql,
  ceiling: BandClaimCeiling | null,
): BandClaimSql => {
  if (ceiling === null) {
    return { text: `SELECT id FROM time_entries WHERE ${eligible.text}`, params: eligible.params }
  }
  const measure =
    ceiling.unit === 'seconds'
      ? {
          // Duration as tracked, so a rounding policy the client already sees
          // on their invoice is the same duration the band counts.
          value: 'coalesce(rounded_seconds, seconds)',
          // Time needs no price, so nothing disqualifies an entry.
          blocked: '0',
        }
      : {
          // Billable value at list, per entry, which is the same arithmetic
          // `foregone_billable_cents` runs below -- so what the ceiling admits
          // and what the band is recorded as absorbing agree by construction
          // rather than by coincidence.
          value: `CAST(ROUND(
                    coalesce(rounded_seconds, seconds)
                      * coalesce(billable_rate_cents, 0) / 3600.0
                  ) AS INTEGER)`,
          // An entry with no billable rate is worth nothing to a running money
          // total, so a ceiling that ignored it would step straight over it and
          // keep claiming -- and a project of unpriced work would be claimed
          // whole however small the ceiling. The band stops there instead. The
          // rest stays billable, which is visible and correctable, where
          // silently absorbing work nobody can value is neither.
          // Only a *billable* entry with no rate is missing data. A
          // non-billable one is worth zero at list by definition, which is a
          // fact rather than a gap, so it passes through contributing nothing
          // instead of stopping the claim.
          blocked: 'billable = 1 AND billable_rate_cents IS NULL',
        }
  return {
    // Oldest first, and only while the running total is still inside the
    // ceiling. An entry that would straddle it is left out whole: half a time
    // entry has one rate, one person and one approval state, and splitting one
    // would invent a row nobody tracked.
    //
    // `ORDER BY spent_date, id` is the ordering that survives a re-run.
    // Anything depending on insertion order would claim a different subset the
    // second time, and a band whose claimed hours move between attempts is one
    // nobody can reconcile. The same ordering carries the block forward: once
    // an entry the ceiling cannot measure appears, every later row is out too.
    text: `SELECT id FROM (
              SELECT id,
                sum(${measure.value}) OVER (
                  ORDER BY spent_date, id ROWS UNBOUNDED PRECEDING
                ) AS running,
                sum(${measure.blocked}) OVER (
                  ORDER BY spent_date, id ROWS UNBOUNDED PRECEDING
                ) AS unmeasurable
              FROM time_entries WHERE ${eligible.text}
            ) WHERE running <= ? AND unmeasurable = 0`,
    params: [...eligible.params, ceiling.limit],
  }
}

/**
 * What the band absorbed: billable value delivered and never charged, written
 * onto the invoice that claimed it. Deliberately not `written_off_cents` --
 * that is settlement, and this client owes and pays the whole flat amount.
 * Recording it there would make a fully collectible invoice read as partly
 * written off and would block returning it to draft.
 *
 * It reads the invoice total the line triggers maintain, so it runs after the
 * lines. Every entry on the invoice counts, and so does every line: hours
 * billed past a ceiling are priced on the invoice at the same value they add
 * here, so what is left is the value of the covered hours less the fee. Never
 * below zero -- a band that charged more than the work it covered forwent
 * nothing, it was simply a good month.
 *
 * `pending` holds the statement to the command writing the invoice.
 */
export const bandForegoneUpdate = (invoiceId: number, pending: BandClaimSql): BandClaimSql => ({
  text: `UPDATE invoices SET foregone_billable_cents = max(
            0,
            coalesce((
              SELECT sum(CAST(ROUND(
                coalesce(entry.rounded_seconds, entry.seconds)
                  * coalesce(entry.billable_rate_cents, 0) / 3600.0
              ) AS INTEGER))
              FROM time_entries entry WHERE entry.invoice_id = invoices.id
            ), 0) - invoices.amount_cents
          )
          WHERE id = ? AND ${pending.text}`,
  params: [invoiceId, ...pending.params],
})
