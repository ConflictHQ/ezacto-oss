// The client-facing subjects named the wrong number.
//
// Three seeded templates -- invoice, reminder and thank_you -- built their
// subject from `%invoice_id%`, which the delivery path fills with the primary
// key. Their bodies used `%invoice_number%`. So one message said two different
// things about one invoice: a subject reading "Invoice #852537948661725" over a
// body reading "Please find invoice 249".
//
// Found by sending a real invoice from the dev deployment to a real mailbox and
// reading what arrived, which is the only way this surfaces: every template test
// asserts substitution rather than which variable was chosen, and both are
// valid variables that substitute correctly.
//
// The reference product put the invoice number there -- its own subject line
// reads "Invoice #<number> from <company>", and its body labels that same value
// "Invoice ID". So the number is what a client is expected to recognise, and the
// primary key is not something they have ever seen.
//
// A new version rather than an edit. `email_template_versions` is append-only by
// design and `email_template_heads` names the live one, so history stays
// readable: a message sent last week can still be explained by the version that
// was current when it went out.
//
// The head only moves where it still points at the seeded version. An operator
// who has already authored their own subject keeps it -- silently replacing
// somebody's wording is a worse bug than the one being fixed here, and the
// guard costs one WHERE clause.

const seededAt = '1970-01-01T00:00:00.000Z'

export const invoiceSubjectNumberMigration = [
  `INSERT INTO email_template_versions (
      template_kind, version, subject_template, text_template,
      unknown_variable_policy, created_at
    )
    SELECT v.template_kind, 2,
      replace(v.subject_template, '%invoice_id%', '%invoice_number%'),
      v.text_template, v.unknown_variable_policy, '${seededAt}'
    FROM email_template_versions v
    JOIN email_template_heads h
      ON h.template_kind = v.template_kind AND h.current_version = v.version
    WHERE v.template_kind IN ('invoice', 'reminder', 'thank_you')
      AND v.version = 1
      AND v.subject_template LIKE '%\\%invoice_id\\%%' ESCAPE '\\'
      AND NOT EXISTS (
        SELECT 1 FROM email_template_versions existing
        WHERE existing.template_kind = v.template_kind AND existing.version = 2
      )`,
  `UPDATE email_template_heads
    SET current_version = 2, updated_at = '${seededAt}'
    WHERE template_kind IN ('invoice', 'reminder', 'thank_you')
      AND current_version = 1
      AND EXISTS (
        SELECT 1 FROM email_template_versions v
        WHERE v.template_kind = email_template_heads.template_kind AND v.version = 2
      )`,
] as const
