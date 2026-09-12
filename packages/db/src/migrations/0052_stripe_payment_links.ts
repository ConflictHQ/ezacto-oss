// Provenance: ezacto-oss #102. A client needs somewhere to pay.
//
// One link per invoice, and it is kept rather than re-minted. A Stripe payment
// link does not expire, so the URL that went out in an invoice email has to
// keep working -- re-minting on each read would leave a client holding a link
// nobody can reconcile, and would create a second Price on the account every
// time somebody opened the invoice.
//
// `payment_link_id` is Stripe's own id for the link and `url` is where the
// client goes. Both are kept: the id is what an operator searches for in the
// Stripe dashboard, and the URL is what was actually sent.
//
// There is no amount here on purpose. What was owed is the invoice's business
// and it is already recorded there; a copy would be a second figure that can
// disagree with the first about money.

const canonicalTimestamp = (column: string) => `unixepoch(${column}) IS NOT NULL
  AND substr(${column}, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', ${column})
  AND (
    ${column} GLOB '????-??-??T??:??:??Z'
    OR ${column} GLOB '????-??-??T??:??:??.[0-9][0-9][0-9]Z'
  )`

export const stripePaymentLinksMigration = [
  `CREATE TABLE stripe_payment_links (
    invoice_id INTEGER PRIMARY KEY REFERENCES invoices(id) ON DELETE CASCADE,
    -- Stripe's id for the link, beginning 'plink'. What an operator searches
    -- for in the dashboard.
    payment_link_id TEXT NOT NULL
      CHECK (length(trim(payment_link_id)) BETWEEN 1 AND 255),
    -- Where the client actually goes. Kept because it is what was sent.
    url TEXT NOT NULL CHECK (url GLOB 'https://*' AND length(url) BETWEEN 1 AND 2048),
    created_at TEXT NOT NULL CHECK (${canonicalTimestamp('created_at')}),
    updated_at TEXT NOT NULL CHECK (${canonicalTimestamp('updated_at')})
  ) STRICT`,

  `CREATE UNIQUE INDEX stripe_payment_links_link
    ON stripe_payment_links(payment_link_id)`,

  // A link that went out in an email cannot be repointed. Replacing where a
  // client pays, after they have been told where to pay, is how somebody pays
  // into the wrong place -- a new invoice gets a new link instead.
  `CREATE TRIGGER stripe_payment_links_immutable
    BEFORE UPDATE ON stripe_payment_links
    FOR EACH ROW WHEN
      NEW.invoice_id IS NOT OLD.invoice_id
      OR NEW.payment_link_id IS NOT OLD.payment_link_id
      OR NEW.url IS NOT OLD.url
    BEGIN SELECT RAISE(ABORT, 'a Stripe payment link is immutable'); END`,
] as const
