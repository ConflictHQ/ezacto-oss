// Provenance: issue 522. "The model is not single-currency. It is multi-currency
// and honestly refuses to consolidate." True -- and it will honestly refuse to
// invoice, too, if the code is not a code.
//
// `clients.currency` is NOT NULL and unconstrained; `projects.billing_currency`
// is nullable and unconstrained. Estimates and invoices already require a
// canonical three-letter uppercase code, and the invoice generator matches on
//
//   upper(coalesce(project.billing_currency, client.currency)) = <invoice currency>
//
// so a client saved as 'dollars' becomes 'DOLLARS', matches nothing, and every
// time entry on that client is silently left out of the invoice. The operator
// gets an empty invoice and no reason for it -- the failure this schema is
// otherwise careful to make loud.
//
// Triggers rather than a table CHECK, deliberately. A CHECK is validated against
// every existing row when the table is rewritten, so one legacy value that
// cannot be repaired would fail the migration -- and migrations here apply
// lazily on the first data request, which means a bad row would take the
// instance down rather than fail a form. These fire only on a value being
// written, so what is already stored is left to be found and fixed rather than
// held against a deployment.
//
// The existing rows are normalised first, which fixes the common case -- 'usd'
// for 'USD' -- without touching anything that is not already a three-letter
// code.

const canonical = (column: string) =>
  `${column} = upper(${column})
   AND length(${column}) = 3
   AND ${column} NOT GLOB '*[^A-Z]*'`

export const canonicalCurrencyMigration = [
  // Repairs the case-only mistakes. A value that is not three letters is left
  // alone: this migration refuses to guess what somebody meant by it.
  `UPDATE clients SET currency = upper(trim(currency))
    WHERE currency <> upper(trim(currency))
      AND length(trim(currency)) = 3
      AND upper(trim(currency)) NOT GLOB '*[^A-Z]*'`,
  `UPDATE projects SET billing_currency = upper(trim(billing_currency))
    WHERE billing_currency IS NOT NULL
      AND billing_currency <> upper(trim(billing_currency))
      AND length(trim(billing_currency)) = 3
      AND upper(trim(billing_currency)) NOT GLOB '*[^A-Z]*'`,

  `CREATE TRIGGER clients_currency_canonical_insert
    BEFORE INSERT ON clients
    WHEN NOT (${canonical('NEW.currency')})
    BEGIN SELECT RAISE(ABORT, 'currency must be a three-letter uppercase code'); END`,
  `CREATE TRIGGER clients_currency_canonical_update
    BEFORE UPDATE OF currency ON clients
    WHEN NOT (${canonical('NEW.currency')})
    BEGIN SELECT RAISE(ABORT, 'currency must be a three-letter uppercase code'); END`,

  `CREATE TRIGGER projects_billing_currency_canonical_insert
    BEFORE INSERT ON projects
    WHEN NEW.billing_currency IS NOT NULL AND NOT (${canonical('NEW.billing_currency')})
    BEGIN SELECT RAISE(ABORT, 'billing currency must be a three-letter uppercase code'); END`,
  `CREATE TRIGGER projects_billing_currency_canonical_update
    BEFORE UPDATE OF billing_currency ON projects
    WHEN NEW.billing_currency IS NOT NULL AND NOT (${canonical('NEW.billing_currency')})
    BEGIN SELECT RAISE(ABORT, 'billing currency must be a three-letter uppercase code'); END`,
] as const
