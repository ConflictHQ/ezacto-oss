import { invoiceFinancialComponents } from './0005_invoice_payments_totals.js'

/**
 * Invoice totals recompute one invoice, not the organization (issue 950).
 *
 * 0005's triggers keep every invoice's derived totals equal to
 * `invoice_financial_calculation` by recomputing on each line, payment and
 * rate change, and its canonical trigger re-derives any total written
 * directly. They read the view with a correlated key:
 * `WHERE calculation.invoice_id = invoices.id`. The view groups lines and
 * payments across every invoice, and SQLite pushes an invoice key down into
 * that grouping only when the key is a plain parameter. A correlated
 * `invoices.id` is not pushed down, and neither is `NEW.id` in the canonical
 * trigger's WHEN clause. So every inserted line aggregated the whole
 * organization twice, once for the recompute and once for the check. On a
 * 14-year organization that cost about 5 ms per line, and a 100-line invoice
 * spent half a second to 1.6 s inside SQLite. The cost grew with history, not
 * with the invoice.
 *
 * The same nine triggers are recreated with the same names, events and `OF`
 * lists. Each recomputes exactly the invoice its row names. The two
 * aggregates read that invoice's lines and payments straight off an index,
 * keyed on `NEW`/`OLD`. That needs no planner push-down, so the cost no longer
 * depends on how SQLite or D1 plans a view. The arithmetic is 0005's own text
 * (`invoiceFinancialComponents`) over a row-for-row equivalent of the view's
 * `line_bases` and `payment_bases`, so every invoice rounds exactly as before.
 * The view stays as the canonical definition: tests compare the stored totals
 * with it.
 *
 * What does not change:
 *
 * - Totals stay database-enforced per row. They are not computed in a
 *   repository, so the importer, the Harvest shim, the API and raw SQL all keep
 *   canonical totals by construction. SQLite has no `FOR EACH STATEMENT`
 *   triggers, so a row's work becomes proportional to that invoice's lines
 *   rather than every line in the organization.
 * - A line edit still fires exactly one recompute of its invoice. A line moved
 *   between invoices still recomputes both, because the second statement runs
 *   only when the invoice actually changed.
 * - Recreating a trigger moves it first among triggers with the same table and
 *   event, since SQLite fires newest first. None of the triggers it now
 *   precedes reads or writes invoice totals: deposit confirmation, import
 *   binding, reference tokens and number sequences. So the stored results are
 *   unchanged.
 *
 * The covering index makes both aggregates, and 0005's absolute-aggregate
 * bound on every line insert, index-only. It replaces
 * `invoice_line_items_invoice_id`, which is its prefix: every lookup by
 * invoice still finds an index led by `invoice_id`, and line writes maintain
 * one index fewer. No table is rebuilt and no row is touched; the stored
 * totals are already canonical.
 */
const { discount, tax, tax2 } = invoiceFinancialComponents

// One invoice's calculation, keyed by an expression that names it. The
// aggregates carry no GROUP BY across invoices: each reads only the key's rows.
const invoiceCalculation = (invoiceId: string) => `SELECT discount_amount_cents,
      tax_amount_cents, tax2_amount_cents,
      subtotal_cents - discount_amount_cents + tax_amount_cents + tax2_amount_cents
        AS amount_cents,
      subtotal_cents - discount_amount_cents + tax_amount_cents + tax2_amount_cents
        - payment_cents - written_off_cents AS due_amount_cents
    FROM (
      SELECT line_bases.subtotal_cents,
        ${discount} AS discount_amount_cents,
        ${tax} AS tax_amount_cents,
        ${tax2} AS tax2_amount_cents,
        payment_bases.payment_cents,
        invoice.written_off_cents
      FROM invoices invoice,
        (SELECT COALESCE(SUM(line.amount_cents), 0) AS subtotal_cents,
            COALESCE(SUM(CASE WHEN line.taxed = 1 THEN line.amount_cents ELSE 0 END), 0)
              AS tax_base_cents,
            COALESCE(SUM(CASE WHEN line.taxed2 = 1 THEN line.amount_cents ELSE 0 END), 0)
              AS tax2_base_cents
          FROM invoice_line_items line
          WHERE line.invoice_id = ${invoiceId}) AS line_bases,
        (SELECT COALESCE(SUM(payment.amount_cents), 0) AS payment_cents
          FROM invoice_payments payment
          WHERE payment.invoice_id = ${invoiceId}) AS payment_bases
      WHERE invoice.id = ${invoiceId}
    )`

const recomputeInvoice = (invoiceId: string, when = '') => `UPDATE invoices
    SET (discount_amount_cents, tax_amount_cents, tax2_amount_cents,
      amount_cents, due_amount_cents) = (${invoiceCalculation(invoiceId)})
    WHERE id = ${invoiceId}${when}`

const replaceTrigger = (name: string, definition: string) => [
  `DROP TRIGGER ${name}`,
  `CREATE TRIGGER ${name}
    ${definition}`,
]

export const invoiceTotalsPerInvoiceMigration = [
  `CREATE INDEX invoice_line_items_invoice_totals
    ON invoice_line_items(invoice_id, amount_cents, taxed, taxed2)`,
  `DROP INDEX invoice_line_items_invoice_id`,
  ...replaceTrigger(
    'invoice_line_items_totals_insert',
    `AFTER INSERT ON invoice_line_items
    BEGIN ${recomputeInvoice('NEW.invoice_id')}; END`,
  ),
  ...replaceTrigger(
    'invoice_line_items_totals_update',
    `AFTER UPDATE ON invoice_line_items
    BEGIN
      ${recomputeInvoice('OLD.invoice_id')};
      ${recomputeInvoice('NEW.invoice_id', ' AND NEW.invoice_id IS NOT OLD.invoice_id')};
    END`,
  ),
  ...replaceTrigger(
    'invoice_line_items_totals_delete',
    `AFTER DELETE ON invoice_line_items
    BEGIN ${recomputeInvoice('OLD.invoice_id')}; END`,
  ),
  ...replaceTrigger(
    'invoice_payments_totals_insert',
    `AFTER INSERT ON invoice_payments
    BEGIN ${recomputeInvoice('NEW.invoice_id')}; END`,
  ),
  ...replaceTrigger(
    'invoice_payments_totals_update',
    `AFTER UPDATE ON invoice_payments
    BEGIN ${recomputeInvoice('NEW.invoice_id')}; END`,
  ),
  ...replaceTrigger(
    'invoice_payments_totals_delete',
    `AFTER DELETE ON invoice_payments
    BEGIN ${recomputeInvoice('OLD.invoice_id')}; END`,
  ),
  ...replaceTrigger(
    'invoices_financial_inputs_update',
    `AFTER UPDATE OF tax_rate_ppm, tax2_rate_ppm, discount_rate_ppm, written_off_cents
    ON invoices
    BEGIN ${recomputeInvoice('NEW.id')}; END`,
  ),
  ...replaceTrigger(
    'invoices_financial_totals_insert',
    `AFTER INSERT ON invoices
    BEGIN ${recomputeInvoice('NEW.id')}; END`,
  ),
  ...replaceTrigger(
    'invoices_derived_totals_canonical',
    `AFTER UPDATE OF amount_cents, due_amount_cents, tax_amount_cents,
      tax2_amount_cents, discount_amount_cents ON invoices
    WHEN EXISTS (
      SELECT 1 FROM (${invoiceCalculation('NEW.id')}) calculation
      WHERE calculation.amount_cents IS NOT NEW.amount_cents
        OR calculation.due_amount_cents IS NOT NEW.due_amount_cents
        OR calculation.tax_amount_cents IS NOT NEW.tax_amount_cents
        OR calculation.tax2_amount_cents IS NOT NEW.tax2_amount_cents
        OR calculation.discount_amount_cents IS NOT NEW.discount_amount_cents
    )
    BEGIN ${recomputeInvoice('NEW.id')}; END`,
  ),
] as const
