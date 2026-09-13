// Provenance: issue 647. Migration 0056 wrote down the threshold and this is it.
//
// Three booleans had accumulated, each a nullable column on `invoices` paired
// with a NOT NULL default on `organizations`: the invoice document (0055), the
// files staged against it (0056), and the automatic thank-you (0053). The work
// journal wants a fourth, and 0056 said what to do when it arrived: "Three
// independent booleans are three independent choices; four is a list wearing a
// disguise."
//
// Each pair cost a migration, a store function triple, a field in two route
// bodies, a field in two contract schemas, and a branch in both runtimes. The
// thank-you routes are a near-copy of the document routes with the nouns
// changed, which is the shape of a list being written out longhand.
//
// One column per table instead.
//
// `organizations.invoice_extras` is the complete answer: a JSON object from kind
// to value. `invoices.invoice_extras` is a partial override, and a key absent
// from it means "follow the organization" -- which is how the three states
// survive the move. Two sets, or a set of enabled kinds, could not express the
// difference between "this invoice says no" and "this invoice has not said",
// and that difference is the whole point of the per-invoice half.
//
// The value is not restricted to a boolean, because the journal is not one: it
// renders detailed or summary, and a preference that can only say yes would have
// forced a second column beside the first the day it landed.
//
// Nothing about behaviour changes here. The translation below is exact,
// including the null-means-defer distinction, and every default stays off --
// attachments already exist on invoices in this account, and a default of on
// would email files nobody chose to send on the day it deployed.

const KINDS = `'document','files','thank_you','journal'`

export const invoiceExtrasSetMigration = [
  `ALTER TABLE organizations ADD COLUMN invoice_extras TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(invoice_extras) AND json_type(invoice_extras) = 'object')`,

  `ALTER TABLE invoices ADD COLUMN invoice_extras TEXT
    CHECK (invoice_extras IS NULL OR (
      json_valid(invoice_extras) AND json_type(invoice_extras) = 'object'
    ))`,

  // Carried across exactly. The organization's answer is complete by
  // definition, so all three keys are written even when false: an absent key
  // and a false one mean the same thing there, and writing them makes the
  // stored value say what was decided rather than leaving it to be inferred.
  `UPDATE organizations SET invoice_extras = json_object(
     'document', json(CASE WHEN attach_invoice_pdf = 1 THEN 'true' ELSE 'false' END),
     'files', json(CASE WHEN attach_invoice_files = 1 THEN 'true' ELSE 'false' END),
     'thank_you', json(CASE WHEN auto_thank_you = 1 THEN 'true' ELSE 'false' END)
   )`,

  // An invoice writes only the keys it actually answered. A NULL column was
  // "follow the organization", and an absent key is the same sentence.
  `UPDATE invoices SET invoice_extras = (
     SELECT json_group_object(key, json(value)) FROM (
       SELECT 'document' AS key,
         CASE WHEN attach_invoice_pdf = 1 THEN 'true' ELSE 'false' END AS value
         WHERE attach_invoice_pdf IS NOT NULL
       UNION ALL
       SELECT 'files',
         CASE WHEN attach_invoice_files = 1 THEN 'true' ELSE 'false' END
         WHERE attach_invoice_files IS NOT NULL
       UNION ALL
       SELECT 'thank_you',
         CASE WHEN auto_thank_you = 1 THEN 'true' ELSE 'false' END
         WHERE auto_thank_you IS NOT NULL
     )
   )
   WHERE attach_invoice_pdf IS NOT NULL
      OR attach_invoice_files IS NOT NULL
      OR auto_thank_you IS NOT NULL`,

  // Only the vocabulary, so a typo becomes a refusal rather than a preference
  // that silently never applies. Checked on both tables and on write, because a
  // key nobody reads is indistinguishable from one nobody set.
  `CREATE TRIGGER organizations_invoice_extras_vocabulary_insert
    BEFORE INSERT ON organizations
    WHEN EXISTS (
      SELECT 1 FROM json_each(NEW.invoice_extras) WHERE key NOT IN (${KINDS})
    )
    BEGIN SELECT RAISE(ABORT, 'unknown invoice extra'); END`,
  `CREATE TRIGGER organizations_invoice_extras_vocabulary_update
    BEFORE UPDATE OF invoice_extras ON organizations
    WHEN EXISTS (
      SELECT 1 FROM json_each(NEW.invoice_extras) WHERE key NOT IN (${KINDS})
    )
    BEGIN SELECT RAISE(ABORT, 'unknown invoice extra'); END`,
  `CREATE TRIGGER invoices_invoice_extras_vocabulary_insert
    BEFORE INSERT ON invoices
    WHEN NEW.invoice_extras IS NOT NULL AND EXISTS (
      SELECT 1 FROM json_each(NEW.invoice_extras) WHERE key NOT IN (${KINDS})
    )
    BEGIN SELECT RAISE(ABORT, 'unknown invoice extra'); END`,
  `CREATE TRIGGER invoices_invoice_extras_vocabulary_update
    BEFORE UPDATE OF invoice_extras ON invoices
    WHEN NEW.invoice_extras IS NOT NULL AND EXISTS (
      SELECT 1 FROM json_each(NEW.invoice_extras) WHERE key NOT IN (${KINDS})
    )
    BEGIN SELECT RAISE(ABORT, 'unknown invoice extra'); END`,

  // The pairs go, rather than lingering as a second place the answer could be
  // read from. Two sources of truth about what a client receives is worse than
  // the longhand this replaces.
  `ALTER TABLE organizations DROP COLUMN attach_invoice_pdf`,
  `ALTER TABLE organizations DROP COLUMN attach_invoice_files`,
  `ALTER TABLE organizations DROP COLUMN auto_thank_you`,
  `ALTER TABLE invoices DROP COLUMN attach_invoice_pdf`,
  `ALTER TABLE invoices DROP COLUMN attach_invoice_files`,
  `ALTER TABLE invoices DROP COLUMN auto_thank_you`,
] as const
