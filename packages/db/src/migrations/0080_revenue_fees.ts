/**
 * Referral fees and sales commissions (#711).
 *
 * These are recognized charges against revenue, not time or expenses. Keeping
 * them separate prevents a commission from inventing hours, lowering
 * utilization, appearing in payroll, or being offered back to a client as a
 * billable expense.
 *
 * `basis` and `recognized_on` make the accounting decision explicit: an
 * invoiced-amount fee points at an invoice and is recognized on issue; a
 * collected-amount fee points at a payment and is recognized on receipt.
 */
export const revenueFeesMigration = [
  `CREATE TABLE revenue_fees (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    invoice_id INTEGER REFERENCES invoices(id) ON DELETE RESTRICT,
    payment_id INTEGER REFERENCES invoice_payments(id) ON DELETE RESTRICT,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    basis TEXT NOT NULL CHECK (basis IN ('invoiced_amount','collected_amount')),
    basis_cents INTEGER NOT NULL CHECK (basis_cents BETWEEN 0 AND 9000000000000),
    rate_ppm INTEGER NOT NULL CHECK (rate_ppm BETWEEN 0 AND 1000000),
    fee_cents INTEGER NOT NULL CHECK (fee_cents BETWEEN 0 AND 9000000000000),
    recognized_on TEXT NOT NULL CHECK (date(recognized_on, '+0 days') IS recognized_on),
    treatment TEXT NOT NULL DEFAULT 'margin_only'
      CHECK (treatment IN ('margin_only','delivery_cost')),
    currency TEXT NOT NULL CHECK (
      length(currency) = 3 AND currency = upper(currency)
      AND currency NOT GLOB '*[^A-Z]*'
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
      (basis = 'invoiced_amount' AND invoice_id IS NOT NULL AND payment_id IS NULL)
      OR
      (basis = 'collected_amount' AND payment_id IS NOT NULL AND invoice_id IS NULL)
    ),
    CHECK (fee_cents = CAST((basis_cents * rate_ppm + 500000) / 1000000 AS INTEGER))
  ) STRICT`,
  `CREATE INDEX revenue_fees_project_recognized
    ON revenue_fees(project_id, recognized_on)`,
  `CREATE UNIQUE INDEX revenue_fees_invoice_agreement_unique
    ON revenue_fees(invoice_id, name) WHERE invoice_id IS NOT NULL`,
  `CREATE UNIQUE INDEX revenue_fees_payment_agreement_unique
    ON revenue_fees(payment_id, name) WHERE payment_id IS NOT NULL`,
] as const
