const centsLimit = 9_000_000_000_000
const rateScale = 1_000_000

const canonicalTimestamp = (column: string) => `unixepoch(${column}) IS NOT NULL
      AND substr(${column}, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', ${column})
      AND CAST(substr(${column}, 12, 2) AS INTEGER) BETWEEN 0 AND 23
      AND CAST(substr(${column}, 15, 2) AS INTEGER) BETWEEN 0 AND 59
      AND CAST(substr(${column}, 18, 2) AS INTEGER) BETWEEN 0 AND 59
      AND (
        ${column} GLOB '????-??-??T??:??:??Z'
        OR ${column} GLOB '????-??-??T??:??:??.[0-9]Z'
        OR ${column} GLOB '????-??-??T??:??:??.[0-9][0-9]Z'
        OR ${column} GLOB '????-??-??T??:??:??.[0-9][0-9][0-9]Z'
      )`

const nullableCanonicalTimestamp = (column: string) =>
  `${column} IS NULL OR (${canonicalTimestamp(column)})`

const nullableCanonicalDate = (column: string) =>
  `${column} IS NULL OR date(${column}) IS ${column}`

const timestampEpochMilliseconds = (column: string) => `(CAST(strftime('%s', ${column}) AS INTEGER) * 1000
  + CASE WHEN instr(${column}, '.') = 0 THEN 0 ELSE
    CAST(
      substr(${column}, 21, length(${column}) - 21)
      || substr('000', 1, 3 - (length(${column}) - 21))
      AS INTEGER
    )
  END)`

const rateCheck = (column: string) =>
  `${column} IS NULL OR ${column} BETWEEN 0 AND ${rateScale}`

const centsCheck = (column: string) => `abs(${column}) <= ${centsLimit}`

const nullableCentsCheck = (column: string) =>
  `${column} IS NULL OR abs(${column}) <= ${centsLimit}`

const boundedMagnitude = (value: string) => `(CASE
  WHEN ${value} < -${centsLimit} OR ${value} > ${centsLimit} THEN ${centsLimit + 1}
  WHEN ${value} < 0 THEN -${value} ELSE ${value} END)`

const roundRate = (base: string, rate: string) => {
  const numerator = `((${base}) * COALESCE(${rate}, 0))`
  return `(CASE WHEN ${numerator} >= 0
    THEN (${numerator} + ${rateScale / 2}) / ${rateScale}
    ELSE (${numerator} - ${rateScale / 2}) / ${rateScale}
  END)`
}

const subtotal = 'line_bases.subtotal_cents'
const taxBase = 'line_bases.tax_base_cents'
const tax2Base = 'line_bases.tax2_base_cents'
const discount = roundRate(subtotal, 'invoice.discount_rate_ppm')
const taxBaseDiscount = roundRate(taxBase, 'invoice.discount_rate_ppm')
const tax2BaseDiscount = roundRate(tax2Base, 'invoice.discount_rate_ppm')
const tax = roundRate(`(${taxBase} - ${taxBaseDiscount})`, 'invoice.tax_rate_ppm')
const tax2 = roundRate(`(${tax2Base} - ${tax2BaseDiscount})`, 'invoice.tax2_rate_ppm')

const recomputeInvoice = (invoiceId: string) => `UPDATE invoices
    SET (discount_amount_cents, tax_amount_cents, tax2_amount_cents,
      amount_cents, due_amount_cents) = (
      SELECT discount_amount_cents, tax_amount_cents, tax2_amount_cents,
        amount_cents, due_amount_cents
      FROM invoice_financial_calculation calculation
      WHERE calculation.invoice_id = invoices.id
    )
    WHERE id = ${invoiceId}`

const recomputeInvoices = (invoiceIds: string) => `UPDATE invoices
    SET (discount_amount_cents, tax_amount_cents, tax2_amount_cents,
      amount_cents, due_amount_cents) = (
      SELECT discount_amount_cents, tax_amount_cents, tax2_amount_cents,
        amount_cents, due_amount_cents
      FROM invoice_financial_calculation calculation
      WHERE calculation.invoice_id = invoices.id
    )
    WHERE id IN (${invoiceIds})`

export const invoicePaymentsTotalsMigration = [
  `ALTER TABLE invoices ADD COLUMN tax_rate_ppm INTEGER CHECK (${rateCheck('tax_rate_ppm')})`,
  `ALTER TABLE invoices ADD COLUMN tax2_rate_ppm INTEGER CHECK (${rateCheck('tax2_rate_ppm')})`,
  `ALTER TABLE invoices ADD COLUMN discount_rate_ppm INTEGER
    CHECK (${rateCheck('discount_rate_ppm')})`,
  `ALTER TABLE invoices ADD COLUMN amount_cents INTEGER NOT NULL DEFAULT 0
    CHECK (${centsCheck('amount_cents')})`,
  `ALTER TABLE invoices ADD COLUMN due_amount_cents INTEGER NOT NULL DEFAULT 0
    CHECK (${centsCheck('due_amount_cents')})`,
  `ALTER TABLE invoices ADD COLUMN tax_amount_cents INTEGER NOT NULL DEFAULT 0
    CHECK (${centsCheck('tax_amount_cents')})`,
  `ALTER TABLE invoices ADD COLUMN tax2_amount_cents INTEGER NOT NULL DEFAULT 0
    CHECK (${centsCheck('tax2_amount_cents')})`,
  `ALTER TABLE invoices ADD COLUMN discount_amount_cents INTEGER NOT NULL DEFAULT 0
    CHECK (${centsCheck('discount_amount_cents')})`,
  `ALTER TABLE invoices ADD COLUMN written_off_cents INTEGER NOT NULL DEFAULT 0
    CHECK (written_off_cents BETWEEN 0 AND ${centsLimit})`,
  `ALTER TABLE invoices ADD COLUMN payment_options TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(payment_options) AND json_type(payment_options) = 'array')`,
  `ALTER TABLE invoices ADD COLUMN reference_token TEXT CHECK (
    reference_token IS NULL OR (
      length(reference_token) = 15
      AND substr(reference_token, 1, 3) = 'EZ-'
      AND substr(reference_token, 4) NOT GLOB '*[^0-9A-F]*'
    )
  )`,
  `ALTER TABLE invoices ADD COLUMN source_amount_cents INTEGER
    CHECK (${nullableCentsCheck('source_amount_cents')})`,
  `ALTER TABLE invoices ADD COLUMN source_due_amount_cents INTEGER
    CHECK (${nullableCentsCheck('source_due_amount_cents')})`,
  `ALTER TABLE invoices ADD COLUMN source_tax_amount_cents INTEGER
    CHECK (${nullableCentsCheck('source_tax_amount_cents')})`,
  `ALTER TABLE invoices ADD COLUMN source_tax2_amount_cents INTEGER
    CHECK (${nullableCentsCheck('source_tax2_amount_cents')})`,
  `ALTER TABLE invoices ADD COLUMN source_discount_amount_cents INTEGER
    CHECK (${nullableCentsCheck('source_discount_amount_cents')})`,
  `ALTER TABLE invoices ADD COLUMN source_payment_options TEXT CHECK (
    source_payment_options IS NULL
    OR (json_valid(source_payment_options) AND json_type(source_payment_options) = 'array')
  )`,
  `ALTER TABLE invoices ADD COLUMN source_updated_at TEXT
    CHECK (${nullableCanonicalTimestamp('source_updated_at')})`,
  `CREATE UNIQUE INDEX invoices_reference_token_unique
    ON invoices(reference_token) WHERE reference_token IS NOT NULL`,
  `CREATE TABLE payment_provider_accounts (
    id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL
      CHECK (provider IN ('stripe','paypal','quickbooks','mercury','wise','bill_com')),
    provider_shape TEXT NOT NULL CHECK (provider_shape IN ('checkout','reconciliation')),
    external_account_id TEXT NOT NULL CHECK (length(external_account_id) > 0),
    display_name TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (provider, provider_shape, external_account_id),
    CHECK (
      (provider IN ('stripe','paypal','quickbooks') AND provider_shape = 'checkout')
      OR (provider IN ('mercury','wise') AND provider_shape = 'reconciliation')
      OR provider = 'bill_com'
    ),
    CHECK (${canonicalTimestamp('created_at')}),
    CHECK (${canonicalTimestamp('updated_at')})
  ) STRICT`,
  `CREATE TABLE bank_deposits (
    id INTEGER PRIMARY KEY,
    provider_account_id INTEGER NOT NULL
      REFERENCES payment_provider_accounts(id) ON DELETE RESTRICT,
    provider_transaction_id TEXT NOT NULL CHECK (length(provider_transaction_id) > 0),
    currency TEXT NOT NULL CHECK (
      length(currency) = 3 AND currency = upper(currency)
      AND currency NOT GLOB '*[^A-Z]*'
    ),
    posted_at TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents BETWEEN 1 AND ${centsLimit}),
    memo TEXT,
    counterparty TEXT,
    match_state TEXT NOT NULL DEFAULT 'unmatched'
      CHECK (match_state IN ('unmatched','suggested','confirmed')),
    suggested_invoice_id INTEGER REFERENCES invoices(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (provider_account_id, provider_transaction_id),
    CHECK (
      (match_state = 'unmatched' AND suggested_invoice_id IS NULL)
      OR (match_state = 'suggested' AND suggested_invoice_id IS NOT NULL)
      OR match_state = 'confirmed'
    ),
    CHECK (${canonicalTimestamp('posted_at')}),
    CHECK (${canonicalTimestamp('created_at')}),
    CHECK (${canonicalTimestamp('updated_at')})
  ) STRICT`,
  `CREATE INDEX bank_deposits_suggested_invoice_id ON bank_deposits(suggested_invoice_id)`,
  `CREATE INDEX bank_deposits_match_posted_id
    ON bank_deposits(match_state, posted_at, id)`,
  `CREATE TABLE invoice_payments (
    id INTEGER PRIMARY KEY,
    harvest_id INTEGER UNIQUE,
    invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    currency TEXT NOT NULL CHECK (
      length(currency) = 3 AND currency = upper(currency)
      AND currency NOT GLOB '*[^A-Z]*'
    ),
    amount_cents INTEGER NOT NULL CHECK (amount_cents BETWEEN 1 AND ${centsLimit}),
    paid_at TEXT,
    paid_date TEXT,
    source_paid_at TEXT,
    source_paid_date TEXT,
    source_recorded_by_name TEXT,
    source_recorded_by_email TEXT,
    source_gateway_id INTEGER,
    source_gateway_name TEXT,
    notes TEXT,
    recorded_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    provider TEXT NOT NULL
      CHECK (provider IN ('manual','stripe','paypal','quickbooks','mercury','wise','bill_com')),
    provider_shape TEXT NOT NULL CHECK (provider_shape IN ('manual','checkout','reconciliation')),
    provider_account_id INTEGER
      REFERENCES payment_provider_accounts(id) ON DELETE RESTRICT,
    provider_transaction_id TEXT,
    bank_deposit_id INTEGER UNIQUE REFERENCES bank_deposits(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((paid_at IS NULL) <> (paid_date IS NULL)),
    CHECK (${nullableCanonicalTimestamp('paid_at')}),
    CHECK (${nullableCanonicalDate('paid_date')}),
    CHECK (${nullableCanonicalTimestamp('source_paid_at')}),
    CHECK (${nullableCanonicalDate('source_paid_date')}),
    CHECK (${canonicalTimestamp('created_at')}),
    CHECK (${canonicalTimestamp('updated_at')}),
    CHECK (
      (provider = 'manual' AND provider_shape = 'manual'
        AND provider_account_id IS NULL AND bank_deposit_id IS NULL)
      OR (provider IN ('stripe','paypal','quickbooks','bill_com')
        AND provider_shape = 'checkout'
        AND provider_account_id IS NOT NULL AND bank_deposit_id IS NULL)
      OR (provider IN ('mercury','wise','bill_com')
        AND provider_shape = 'reconciliation'
        AND provider_account_id IS NOT NULL AND bank_deposit_id IS NOT NULL)
    ),
    CHECK (provider_transaction_id IS NULL OR length(provider_transaction_id) > 0),
    CHECK (provider = 'manual' OR (
      provider_transaction_id IS NOT NULL AND length(provider_transaction_id) > 0
    )),
    CHECK (harvest_id IS NULL OR (
      provider = 'manual' AND provider_shape = 'manual'
      AND provider_account_id IS NULL AND bank_deposit_id IS NULL
    )),
    CHECK (harvest_id IS NOT NULL OR (
      source_paid_at IS NULL AND source_paid_date IS NULL
      AND source_recorded_by_name IS NULL AND source_recorded_by_email IS NULL
      AND source_gateway_id IS NULL AND source_gateway_name IS NULL
    )),
    CHECK (harvest_id IS NULL OR (
      (source_paid_at IS NOT NULL AND paid_at IS source_paid_at AND paid_date IS NULL)
      OR (source_paid_at IS NULL AND source_paid_date IS NOT NULL
        AND paid_at IS NULL AND paid_date IS source_paid_date)
    ))
  ) STRICT`,
  `CREATE UNIQUE INDEX invoice_payments_provider_transaction_unique
    ON invoice_payments(provider_account_id, provider_transaction_id)
    WHERE provider_account_id IS NOT NULL AND provider_transaction_id IS NOT NULL`,
  `CREATE INDEX invoice_payments_invoice_id ON invoice_payments(invoice_id)`,
  `CREATE INDEX invoice_payments_recorded_by_user_id
    ON invoice_payments(recorded_by_user_id)`,
  `CREATE INDEX invoice_payments_provider_account_id
    ON invoice_payments(provider_account_id)`,
  `CREATE VIEW invoice_financial_calculation AS
    WITH line_bases AS (
      SELECT invoice.id AS invoice_id,
        COALESCE(SUM(line.amount_cents), 0) AS subtotal_cents,
        COALESCE(SUM(CASE WHEN line.taxed = 1 THEN line.amount_cents ELSE 0 END), 0)
          AS tax_base_cents,
        COALESCE(SUM(CASE WHEN line.taxed2 = 1 THEN line.amount_cents ELSE 0 END), 0)
          AS tax2_base_cents
      FROM invoices invoice
      LEFT JOIN invoice_line_items line ON line.invoice_id = invoice.id
      GROUP BY invoice.id
    ),
    payment_bases AS (
      SELECT invoice.id AS invoice_id,
        COALESCE(SUM(payment.amount_cents), 0) AS payment_cents
      FROM invoices invoice
      LEFT JOIN invoice_payments payment ON payment.invoice_id = invoice.id
      GROUP BY invoice.id
    ),
    components AS (
      SELECT invoice.id AS invoice_id,
        line_bases.subtotal_cents,
        ${discount} AS discount_amount_cents,
        ${tax} AS tax_amount_cents,
        ${tax2} AS tax2_amount_cents,
        payment_bases.payment_cents,
        invoice.written_off_cents
      FROM invoices invoice
      JOIN line_bases ON line_bases.invoice_id = invoice.id
      JOIN payment_bases ON payment_bases.invoice_id = invoice.id
    )
    SELECT invoice_id, discount_amount_cents, tax_amount_cents, tax2_amount_cents,
      subtotal_cents - discount_amount_cents + tax_amount_cents + tax2_amount_cents
        AS amount_cents,
      subtotal_cents - discount_amount_cents + tax_amount_cents + tax2_amount_cents
        - payment_cents - written_off_cents AS due_amount_cents
    FROM components`,
  `CREATE TABLE invoice_totals_migration_guard (
    invalid INTEGER NOT NULL CHECK (invalid = 0)
  ) STRICT`,
  `INSERT INTO invoice_totals_migration_guard(invalid)
    SELECT 1 WHERE EXISTS (
      WITH RECURSIVE ordered AS (
        SELECT invoice_id,
          row_number() OVER (PARTITION BY invoice_id ORDER BY id) AS position,
          ${boundedMagnitude('amount_cents')} AS magnitude
        FROM invoice_line_items
      ), running AS (
        SELECT invoice_id, position, magnitude AS magnitude_sum
        FROM ordered WHERE position = 1
        UNION ALL
        SELECT ordered.invoice_id, ordered.position,
          CASE WHEN running.magnitude_sum > ${centsLimit}
              OR ordered.magnitude > ${centsLimit}
              OR running.magnitude_sum > ${centsLimit} - ordered.magnitude
            THEN ${centsLimit + 1}
            ELSE running.magnitude_sum + ordered.magnitude END
        FROM running JOIN ordered
          ON ordered.invoice_id = running.invoice_id
          AND ordered.position = running.position + 1
      )
      SELECT 1 FROM running WHERE magnitude_sum > ${centsLimit}
    )`,
  `DROP TABLE invoice_totals_migration_guard`,
  recomputeInvoices('SELECT id FROM invoices'),
  `CREATE TRIGGER payment_provider_accounts_reject_identity_collision
    BEFORE INSERT ON payment_provider_accounts
    WHEN EXISTS (SELECT 1 FROM payment_provider_accounts WHERE id = NEW.id)
      OR EXISTS (
        SELECT 1 FROM payment_provider_accounts
        WHERE provider = NEW.provider AND provider_shape = NEW.provider_shape
          AND external_account_id = NEW.external_account_id
      )
    BEGIN SELECT RAISE(ABORT, 'payment provider account identity already exists'); END`,
  `CREATE TRIGGER payment_provider_accounts_identity_immutable
    BEFORE UPDATE OF id, provider, provider_shape, external_account_id
    ON payment_provider_accounts
    WHEN OLD.id IS NOT NEW.id OR OLD.provider IS NOT NEW.provider
      OR OLD.provider_shape IS NOT NEW.provider_shape
      OR OLD.external_account_id IS NOT NEW.external_account_id
    BEGIN SELECT RAISE(ABORT, 'payment provider account identity is immutable'); END`,
  `CREATE TRIGGER bank_deposits_reject_identity_collision
    BEFORE INSERT ON bank_deposits
    WHEN EXISTS (SELECT 1 FROM bank_deposits WHERE id = NEW.id)
      OR EXISTS (
        SELECT 1 FROM bank_deposits
        WHERE provider_account_id = NEW.provider_account_id
          AND provider_transaction_id = NEW.provider_transaction_id
      )
    BEGIN SELECT RAISE(ABORT, 'bank deposit identity already exists'); END`,
  `CREATE TRIGGER bank_deposits_identity_immutable
    BEFORE UPDATE OF id, provider_account_id, provider_transaction_id ON bank_deposits
    WHEN OLD.id IS NOT NEW.id
      OR OLD.provider_account_id IS NOT NEW.provider_account_id
      OR OLD.provider_transaction_id IS NOT NEW.provider_transaction_id
    BEGIN SELECT RAISE(ABORT, 'bank deposit identity is immutable'); END`,
  `CREATE TRIGGER bank_deposits_account_insert
    BEFORE INSERT ON bank_deposits
    WHEN NOT EXISTS (
      SELECT 1 FROM payment_provider_accounts account
      WHERE account.id = NEW.provider_account_id
        AND account.provider_shape = 'reconciliation'
    )
    BEGIN SELECT RAISE(ABORT, 'bank deposit requires a reconciliation account'); END`,
  `CREATE TRIGGER bank_deposits_suggestion_insert
    BEFORE INSERT ON bank_deposits
    WHEN NEW.match_state = 'confirmed'
      OR (NEW.suggested_invoice_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM invoices invoice
      WHERE invoice.id = NEW.suggested_invoice_id AND invoice.currency = NEW.currency
    ))
    BEGIN SELECT RAISE(ABORT, 'invalid bank deposit suggestion'); END`,
  `CREATE TRIGGER bank_deposits_suggestion_update
    BEFORE UPDATE OF suggested_invoice_id, currency, match_state ON bank_deposits
    WHEN NEW.suggested_invoice_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM invoices invoice
      WHERE invoice.id = NEW.suggested_invoice_id AND invoice.currency = NEW.currency
    )
    BEGIN SELECT RAISE(ABORT, 'bank deposit suggestion currency must match invoice'); END`,
  `CREATE TRIGGER invoice_payments_reject_identity_collision
    BEFORE INSERT ON invoice_payments
    WHEN EXISTS (SELECT 1 FROM invoice_payments WHERE id = NEW.id)
      OR (NEW.harvest_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM invoice_payments WHERE harvest_id = NEW.harvest_id
      ))
      OR (NEW.bank_deposit_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM invoice_payments WHERE bank_deposit_id = NEW.bank_deposit_id
      ))
      OR (NEW.provider_account_id IS NOT NULL AND NEW.provider_transaction_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM invoice_payments
          WHERE provider_account_id = NEW.provider_account_id
            AND provider_transaction_id = NEW.provider_transaction_id
        ))
    BEGIN SELECT RAISE(ABORT, 'invoice payment identity already exists'); END`,
  `CREATE TRIGGER invoice_payments_identity_immutable
    BEFORE UPDATE OF id, harvest_id, invoice_id, currency, provider, provider_shape,
      provider_account_id, provider_transaction_id, bank_deposit_id ON invoice_payments
    WHEN OLD.id IS NOT NEW.id OR OLD.harvest_id IS NOT NEW.harvest_id
      OR OLD.invoice_id IS NOT NEW.invoice_id OR OLD.currency IS NOT NEW.currency
      OR OLD.provider IS NOT NEW.provider OR OLD.provider_shape IS NOT NEW.provider_shape
      OR OLD.provider_account_id IS NOT NEW.provider_account_id
      OR OLD.provider_transaction_id IS NOT NEW.provider_transaction_id
      OR OLD.bank_deposit_id IS NOT NEW.bank_deposit_id
    BEGIN SELECT RAISE(ABORT, 'invoice payment identity is immutable'); END`,
  `CREATE TRIGGER invoice_payments_source_immutable
    BEFORE UPDATE OF source_paid_at, source_paid_date, source_recorded_by_name,
      source_recorded_by_email, source_gateway_id, source_gateway_name ON invoice_payments
    WHEN OLD.source_paid_at IS NOT NEW.source_paid_at
      OR OLD.source_paid_date IS NOT NEW.source_paid_date
      OR OLD.source_recorded_by_name IS NOT NEW.source_recorded_by_name
      OR OLD.source_recorded_by_email IS NOT NEW.source_recorded_by_email
      OR OLD.source_gateway_id IS NOT NEW.source_gateway_id
      OR OLD.source_gateway_name IS NOT NEW.source_gateway_name
    BEGIN SELECT RAISE(ABORT, 'invoice payment source provenance is immutable'); END`,
  `CREATE TRIGGER invoice_payments_imported_immutable
    BEFORE UPDATE OF amount_cents, paid_at, paid_date, notes, updated_at
    ON invoice_payments
    WHEN OLD.harvest_id IS NOT NULL AND (
      OLD.amount_cents IS NOT NEW.amount_cents OR OLD.paid_at IS NOT NEW.paid_at
      OR OLD.paid_date IS NOT NEW.paid_date OR OLD.notes IS NOT NEW.notes
      OR OLD.updated_at IS NOT NEW.updated_at
    )
    BEGIN SELECT RAISE(ABORT, 'imported invoice payment is immutable'); END`,
  `CREATE TRIGGER invoice_payments_external_immutable
    BEFORE UPDATE OF amount_cents, paid_at, paid_date, notes, recorded_by_user_id, updated_at
    ON invoice_payments
    WHEN OLD.provider <> 'manual' AND (
      OLD.amount_cents IS NOT NEW.amount_cents OR OLD.paid_at IS NOT NEW.paid_at
      OR OLD.paid_date IS NOT NEW.paid_date OR OLD.notes IS NOT NEW.notes
      OR (
        OLD.recorded_by_user_id IS NOT NEW.recorded_by_user_id
        AND NOT (
          NEW.recorded_by_user_id IS NULL AND OLD.recorded_by_user_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM users WHERE id = OLD.recorded_by_user_id)
        )
      )
      OR OLD.updated_at IS NOT NEW.updated_at
    )
    BEGIN SELECT RAISE(ABORT, 'external invoice payment is immutable'); END`,
  `CREATE TRIGGER invoice_payments_created_at_immutable
    BEFORE UPDATE OF created_at ON invoice_payments
    WHEN OLD.created_at IS NOT NEW.created_at
    BEGIN SELECT RAISE(ABORT, 'invoice payment created timestamp is immutable'); END`,
  `CREATE TRIGGER invoice_payments_account_insert
    BEFORE INSERT ON invoice_payments
    WHEN NEW.provider_account_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM payment_provider_accounts account
      WHERE account.id = NEW.provider_account_id
        AND account.provider = NEW.provider
        AND account.provider_shape = NEW.provider_shape
    )
    BEGIN SELECT RAISE(ABORT, 'payment provider account does not match payment'); END`,
  `CREATE TRIGGER invoice_payments_currency_insert
    BEFORE INSERT ON invoice_payments
    WHEN NOT EXISTS (
      SELECT 1 FROM invoices invoice
      WHERE invoice.id = NEW.invoice_id AND invoice.currency = NEW.currency
    )
    BEGIN SELECT RAISE(ABORT, 'payment currency must match invoice'); END`,
  `CREATE TRIGGER invoice_payments_deposit_insert
    BEFORE INSERT ON invoice_payments
    WHEN NEW.bank_deposit_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM bank_deposits deposit
      JOIN payment_provider_accounts account ON account.id = deposit.provider_account_id
      JOIN invoices invoice ON invoice.id = NEW.invoice_id
      WHERE deposit.id = NEW.bank_deposit_id
        AND deposit.match_state IN ('unmatched','suggested')
        AND (deposit.suggested_invoice_id IS NULL
          OR deposit.suggested_invoice_id = NEW.invoice_id)
        AND deposit.provider_account_id = NEW.provider_account_id
        AND deposit.provider_transaction_id = NEW.provider_transaction_id
        AND deposit.currency = NEW.currency AND invoice.currency = NEW.currency
        AND deposit.amount_cents = NEW.amount_cents
        AND account.provider = NEW.provider
        AND account.provider_shape = 'reconciliation'
    )
    BEGIN SELECT RAISE(ABORT, 'bank confirmation does not match deposit'); END`,
  `CREATE TRIGGER bank_deposits_confirm_guard
    BEFORE UPDATE OF match_state ON bank_deposits
    WHEN NEW.match_state = 'confirmed' AND NOT EXISTS (
      SELECT 1 FROM invoice_payments payment WHERE payment.bank_deposit_id = NEW.id
    )
    BEGIN SELECT RAISE(ABORT, 'bank deposit confirmation requires a payment'); END`,
  `CREATE TRIGGER bank_deposits_unconfirm_guard
    BEFORE UPDATE OF match_state, suggested_invoice_id ON bank_deposits
    WHEN (NEW.match_state <> 'confirmed'
      OR NEW.suggested_invoice_id IS NOT OLD.suggested_invoice_id) AND EXISTS (
      SELECT 1 FROM invoice_payments payment WHERE payment.bank_deposit_id = NEW.id
    )
    BEGIN SELECT RAISE(ABORT, 'confirmed bank deposit still has a payment'); END`,
  `CREATE TRIGGER bank_deposits_linked_tuple_immutable
    BEFORE UPDATE OF provider_account_id, provider_transaction_id, currency, amount_cents,
      match_state, suggested_invoice_id ON bank_deposits
    WHEN EXISTS (SELECT 1 FROM invoice_payments WHERE bank_deposit_id = OLD.id)
      AND NOT EXISTS (
        SELECT 1 FROM invoice_payments payment
        WHERE payment.bank_deposit_id = OLD.id
          AND payment.provider_account_id = NEW.provider_account_id
          AND payment.provider_transaction_id = NEW.provider_transaction_id
          AND payment.currency = NEW.currency
          AND payment.amount_cents = NEW.amount_cents
          AND (NEW.suggested_invoice_id IS NULL
            OR payment.invoice_id = NEW.suggested_invoice_id)
          AND NEW.match_state = 'confirmed'
      )
    BEGIN SELECT RAISE(ABORT, 'confirmed bank deposit tuple is immutable'); END`,
  `CREATE TRIGGER invoice_payments_confirm_deposit
    AFTER INSERT ON invoice_payments
    WHEN NEW.bank_deposit_id IS NOT NULL
    BEGIN
      UPDATE bank_deposits SET match_state = 'confirmed', updated_at = NEW.updated_at
      WHERE id = NEW.bank_deposit_id;
    END`,
  `CREATE TRIGGER invoice_payments_unconfirm_deposit
    AFTER DELETE ON invoice_payments
    WHEN OLD.bank_deposit_id IS NOT NULL
    BEGIN
      UPDATE bank_deposits
      SET match_state = CASE
          WHEN suggested_invoice_id IS NULL THEN 'unmatched' ELSE 'suggested' END,
        updated_at = OLD.updated_at
      WHERE id = OLD.bank_deposit_id;
    END`,
  `CREATE TRIGGER invoices_source_observation_insert_guard
    BEFORE INSERT ON invoices
    WHEN (NEW.harvest_id IS NULL AND (
        NEW.source_amount_cents IS NOT NULL OR NEW.source_due_amount_cents IS NOT NULL
        OR NEW.source_tax_amount_cents IS NOT NULL OR NEW.source_tax2_amount_cents IS NOT NULL
        OR NEW.source_discount_amount_cents IS NOT NULL OR NEW.source_payment_options IS NOT NULL
        OR NEW.source_updated_at IS NOT NULL
      )) OR (NEW.source_updated_at IS NULL AND (
        NEW.source_amount_cents IS NOT NULL OR NEW.source_due_amount_cents IS NOT NULL
        OR NEW.source_tax_amount_cents IS NOT NULL OR NEW.source_tax2_amount_cents IS NOT NULL
        OR NEW.source_discount_amount_cents IS NOT NULL OR NEW.source_payment_options IS NOT NULL
      ))
    BEGIN SELECT RAISE(ABORT, 'invoice source observation requires an import identity'); END`,
  `CREATE TRIGGER invoices_source_observation_guard
    BEFORE UPDATE OF source_amount_cents, source_due_amount_cents,
      source_tax_amount_cents, source_tax2_amount_cents, source_discount_amount_cents,
      source_payment_options, source_updated_at ON invoices
    WHEN (
      OLD.source_amount_cents IS NOT NEW.source_amount_cents
      OR OLD.source_due_amount_cents IS NOT NEW.source_due_amount_cents
      OR OLD.source_tax_amount_cents IS NOT NEW.source_tax_amount_cents
      OR OLD.source_tax2_amount_cents IS NOT NEW.source_tax2_amount_cents
      OR OLD.source_discount_amount_cents IS NOT NEW.source_discount_amount_cents
      OR OLD.source_payment_options IS NOT NEW.source_payment_options
      OR OLD.source_updated_at IS NOT NEW.source_updated_at
    ) AND (
      NEW.harvest_id IS NULL OR NEW.source_updated_at IS NULL
      OR (OLD.source_updated_at IS NOT NULL
        AND ${timestampEpochMilliseconds('NEW.source_updated_at')}
          <= ${timestampEpochMilliseconds('OLD.source_updated_at')})
    )
    BEGIN SELECT RAISE(ABORT, 'invoice source observation must be strictly newer'); END`,
  `CREATE TRIGGER invoices_source_observation_identity_immutable
    BEFORE UPDATE OF harvest_id ON invoices
    WHEN OLD.harvest_id IS NOT NEW.harvest_id AND (
      OLD.source_amount_cents IS NOT NULL OR OLD.source_due_amount_cents IS NOT NULL
      OR OLD.source_tax_amount_cents IS NOT NULL OR OLD.source_tax2_amount_cents IS NOT NULL
      OR OLD.source_discount_amount_cents IS NOT NULL OR OLD.source_payment_options IS NOT NULL
      OR OLD.source_updated_at IS NOT NULL OR NEW.source_amount_cents IS NOT NULL
      OR NEW.source_due_amount_cents IS NOT NULL OR NEW.source_tax_amount_cents IS NOT NULL
      OR NEW.source_tax2_amount_cents IS NOT NULL OR NEW.source_discount_amount_cents IS NOT NULL
      OR NEW.source_payment_options IS NOT NULL OR NEW.source_updated_at IS NOT NULL
    )
    BEGIN SELECT RAISE(ABORT, 'invoice source observation identity is immutable'); END`,
  `CREATE TRIGGER invoices_payment_options_insert
    BEFORE INSERT ON invoices
    WHEN EXISTS (
      SELECT 1 FROM json_each(NEW.payment_options) option
      WHERE option.type <> 'text' OR option.value NOT IN (
        'stripe_checkout','paypal_checkout','quickbooks_checkout',
        'mercury_transfer','wise_transfer','bill_com_checkout','bill_com_transfer'
      )
    ) OR (
      SELECT count(*) FROM json_each(NEW.payment_options)
    ) <> (
      SELECT count(DISTINCT value) FROM json_each(NEW.payment_options)
    ) OR NEW.reference_token IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'invalid or unavailable invoice payment options'); END`,
  `CREATE TRIGGER invoices_payment_options_update
    BEFORE UPDATE OF payment_options ON invoices
    WHEN EXISTS (
      SELECT 1 FROM json_each(NEW.payment_options) option
      WHERE option.type <> 'text' OR option.value NOT IN (
        'stripe_checkout','paypal_checkout','quickbooks_checkout',
        'mercury_transfer','wise_transfer','bill_com_checkout','bill_com_transfer'
      )
    ) OR (
      SELECT count(*) FROM json_each(NEW.payment_options)
    ) <> (
      SELECT count(DISTINCT value) FROM json_each(NEW.payment_options)
    )
    BEGIN SELECT RAISE(ABORT, 'invalid or unavailable invoice payment options'); END`,
  `CREATE TRIGGER invoices_reference_token_insert
    AFTER INSERT ON invoices
    WHEN EXISTS (
      SELECT 1 FROM json_each(NEW.payment_options)
      WHERE value IN ('mercury_transfer','wise_transfer','bill_com_transfer')
    )
    BEGIN
      UPDATE invoices SET reference_token = 'EZ-' || upper(hex(randomblob(6)))
      WHERE id = NEW.id;
    END`,
  `CREATE TRIGGER invoices_reference_token_options_update
    AFTER UPDATE OF payment_options ON invoices
    BEGIN
      UPDATE invoices SET reference_token = CASE
        WHEN EXISTS (
          SELECT 1 FROM json_each(NEW.payment_options)
          WHERE value IN ('mercury_transfer','wise_transfer','bill_com_transfer')
        ) THEN COALESCE(reference_token, 'EZ-' || upper(hex(randomblob(6))))
        ELSE NULL END
      WHERE id = NEW.id;
    END`,
  `CREATE TRIGGER invoices_reference_token_collision
    BEFORE UPDATE OF reference_token ON invoices
    WHEN NEW.reference_token IS NOT NULL AND EXISTS (
      SELECT 1 FROM invoices existing
      WHERE existing.reference_token = NEW.reference_token AND existing.id <> OLD.id
    )
    BEGIN SELECT RAISE(ABORT, 'invoice reference token already exists'); END`,
  `CREATE TRIGGER invoices_reference_token_insert_collision
    BEFORE INSERT ON invoices
    WHEN NEW.reference_token IS NOT NULL AND EXISTS (
      SELECT 1 FROM invoices existing WHERE existing.reference_token = NEW.reference_token
    )
    BEGIN SELECT RAISE(ABORT, 'invoice reference token already exists'); END`,
  `CREATE TRIGGER invoices_reference_token_coupling
    BEFORE UPDATE OF reference_token ON invoices
    WHEN (NEW.reference_token IS NOT NULL) <> EXISTS (
      SELECT 1 FROM json_each(NEW.payment_options)
      WHERE value IN ('mercury_transfer','wise_transfer','bill_com_transfer')
    )
    BEGIN SELECT RAISE(ABORT, 'invoice reference token requires a transfer option'); END`,
  `CREATE TRIGGER invoices_currency_financial_lock
    BEFORE UPDATE OF currency ON invoices
    WHEN OLD.currency IS NOT NEW.currency AND (
      EXISTS (SELECT 1 FROM invoice_payments WHERE invoice_id = OLD.id)
      OR EXISTS (
        SELECT 1 FROM bank_deposits
        WHERE suggested_invoice_id = OLD.id AND match_state IN ('suggested','confirmed')
      )
    )
    BEGIN SELECT RAISE(ABORT, 'invoice currency is immutable while money is linked'); END`,
  `CREATE TRIGGER invoice_line_items_reject_identity_collision
    BEFORE INSERT ON invoice_line_items
    WHEN EXISTS (SELECT 1 FROM invoice_line_items WHERE id = NEW.id)
      OR (NEW.harvest_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM invoice_line_items WHERE harvest_id = NEW.harvest_id
      ))
      OR EXISTS (
        SELECT 1 FROM invoice_line_items
        WHERE invoice_id = NEW.invoice_id AND position = NEW.position
      )
    BEGIN SELECT RAISE(ABORT, 'invoice line identity already exists'); END`,
  `CREATE TRIGGER invoice_line_items_reject_update_collision
    BEFORE UPDATE OF id, harvest_id, invoice_id, position ON invoice_line_items
    WHEN EXISTS (
        SELECT 1 FROM invoice_line_items WHERE id = NEW.id AND id <> OLD.id
      ) OR (NEW.harvest_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM invoice_line_items
        WHERE harvest_id = NEW.harvest_id AND id <> OLD.id
      )) OR EXISTS (
        SELECT 1 FROM invoice_line_items
        WHERE invoice_id = NEW.invoice_id AND position = NEW.position AND id <> OLD.id
      )
    BEGIN SELECT RAISE(ABORT, 'invoice line identity already exists'); END`,
  `CREATE TRIGGER invoice_line_items_total_bound_insert
    BEFORE INSERT ON invoice_line_items
    WHEN (
      SELECT COALESCE(SUM(CASE WHEN amount_cents < 0 THEN -amount_cents ELSE amount_cents END), 0)
      FROM invoice_line_items
      WHERE invoice_id = NEW.invoice_id
    ) + ${boundedMagnitude('NEW.amount_cents')} > ${centsLimit}
    BEGIN SELECT RAISE(ABORT, 'invoice line absolute aggregate exceeds limit'); END`,
  `CREATE TRIGGER invoice_line_items_total_bound_update
    BEFORE UPDATE OF invoice_id, amount_cents ON invoice_line_items
    WHEN (
      SELECT COALESCE(SUM(CASE WHEN amount_cents < 0 THEN -amount_cents ELSE amount_cents END), 0)
      FROM invoice_line_items
      WHERE invoice_id = NEW.invoice_id AND id <> OLD.id
    ) + ${boundedMagnitude('NEW.amount_cents')} > ${centsLimit}
    BEGIN SELECT RAISE(ABORT, 'invoice line absolute aggregate exceeds limit'); END`,
  `CREATE TRIGGER invoice_payments_total_bound_insert
    BEFORE INSERT ON invoice_payments
    WHEN (
      SELECT COALESCE(SUM(amount_cents), 0) FROM invoice_payments
      WHERE invoice_id = NEW.invoice_id
    ) + ${boundedMagnitude('NEW.amount_cents')} > ${centsLimit}
    BEGIN SELECT RAISE(ABORT, 'invoice payment absolute aggregate exceeds limit'); END`,
  `CREATE TRIGGER invoice_payments_total_bound_update
    BEFORE UPDATE OF amount_cents ON invoice_payments
    WHEN (
      SELECT COALESCE(SUM(amount_cents), 0) FROM invoice_payments
      WHERE invoice_id = NEW.invoice_id AND id <> OLD.id
    ) + ${boundedMagnitude('NEW.amount_cents')} > ${centsLimit}
    BEGIN SELECT RAISE(ABORT, 'invoice payment absolute aggregate exceeds limit'); END`,
  `CREATE TRIGGER invoices_financial_result_bound
    BEFORE UPDATE OF discount_amount_cents, tax_amount_cents, tax2_amount_cents,
      amount_cents, due_amount_cents ON invoices
    WHEN NEW.discount_amount_cents < -${centsLimit}
      OR NEW.discount_amount_cents > ${centsLimit}
      OR NEW.tax_amount_cents < -${centsLimit} OR NEW.tax_amount_cents > ${centsLimit}
      OR NEW.tax2_amount_cents < -${centsLimit} OR NEW.tax2_amount_cents > ${centsLimit}
      OR NEW.amount_cents < -${centsLimit} OR NEW.amount_cents > ${centsLimit}
      OR NEW.due_amount_cents < -${centsLimit} OR NEW.due_amount_cents > ${centsLimit}
    BEGIN SELECT RAISE(ABORT, 'invoice financial result exceeds limit'); END`,
  `CREATE TRIGGER invoice_line_items_totals_insert
    AFTER INSERT ON invoice_line_items
    BEGIN ${recomputeInvoice('NEW.invoice_id')}; END`,
  `CREATE TRIGGER invoice_line_items_totals_update
    AFTER UPDATE ON invoice_line_items
    BEGIN ${recomputeInvoices('OLD.invoice_id, NEW.invoice_id')}; END`,
  `CREATE TRIGGER invoice_line_items_totals_delete
    AFTER DELETE ON invoice_line_items
    BEGIN ${recomputeInvoice('OLD.invoice_id')}; END`,
  `CREATE TRIGGER invoice_payments_totals_insert
    AFTER INSERT ON invoice_payments
    BEGIN ${recomputeInvoice('NEW.invoice_id')}; END`,
  `CREATE TRIGGER invoice_payments_totals_update
    AFTER UPDATE ON invoice_payments
    BEGIN ${recomputeInvoice('NEW.invoice_id')}; END`,
  `CREATE TRIGGER invoice_payments_totals_delete
    AFTER DELETE ON invoice_payments
    BEGIN ${recomputeInvoice('OLD.invoice_id')}; END`,
  `CREATE TRIGGER invoices_financial_inputs_update
    AFTER UPDATE OF tax_rate_ppm, tax2_rate_ppm, discount_rate_ppm, written_off_cents
    ON invoices
    BEGIN ${recomputeInvoice('NEW.id')}; END`,
  `CREATE TRIGGER invoices_financial_totals_insert
    AFTER INSERT ON invoices
    BEGIN ${recomputeInvoice('NEW.id')}; END`,
  `CREATE TRIGGER invoices_derived_totals_canonical
    AFTER UPDATE OF amount_cents, due_amount_cents, tax_amount_cents,
      tax2_amount_cents, discount_amount_cents ON invoices
    WHEN EXISTS (
      SELECT 1 FROM invoice_financial_calculation calculation
      WHERE calculation.invoice_id = NEW.id AND (
        calculation.amount_cents IS NOT NEW.amount_cents
        OR calculation.due_amount_cents IS NOT NEW.due_amount_cents
        OR calculation.tax_amount_cents IS NOT NEW.tax_amount_cents
        OR calculation.tax2_amount_cents IS NOT NEW.tax2_amount_cents
        OR calculation.discount_amount_cents IS NOT NEW.discount_amount_cents
      )
    )
    BEGIN ${recomputeInvoice('NEW.id')}; END`,
] as const
