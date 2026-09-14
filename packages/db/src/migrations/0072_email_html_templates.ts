// An HTML part for the mail this instance sends (issue 666).
//
// The templates seeded by 0030 are subject and plain text, and nothing has ever
// set `html_template` -- so the surface a *client* sees has no design at all,
// while the web app has a compiled token system and a contrast check. That is
// the gap 666 describes, and the reason it matters more than the others it
// lists: an invoice email is the one place where being off-brand does not read
// as a design slip but as a different company.
//
// Colours are the `precision` theme's own, from `apps/web/theme-tokens.json`
// via `generated/theme-palette.json`: ground #FFFFFF, surface #F5F6F7, border
// #E3E5E8, ink #14161A, muted #676C74. They are written here as literals on
// purpose -- a template is a database row and cannot import a build artefact,
// and a row that quietly changed colour when a token moved would be a document
// whose appearance is not in its own version history.
//
// Three constraints shape the markup rather than taste:
//
// 1. **Inline styles and tables.** A `<style>` block is dropped by several
//    desktop clients and stripped by some webmail, so every rule is on the
//    element it applies to and layout is a table rather than flex.
// 2. **No payment button.** `invoice_payment_url` is an empty string whenever
//    the deployment has no Stripe or the invoice owes nothing, and this
//    template system substitutes variables without conditionals -- so a
//    hardcoded call to action would render `href=""` on most sends. A dead Pay
//    button on a client-facing invoice is worse than no button.
// 3. **The text part is untouched.** This adds an HTML alternative; it does not
//    rewrite what a plain-text reader already receives. `%invoice_line_items%`
//    is referenced in the HTML so the block lands inside the layout rather than
//    being appended after it, which is what happens when a template does not
//    mention it.
//
// Only templates nobody has edited are replaced, and the head only moves for
// those. A person who rewrote their invoice wording meant it, and a colour
// change is not a reason to discard it -- so an edited kind keeps its version
// and simply does not gain an HTML part. In practice every kind is still
// system-authored, so this reaches all five.

const GROUND = '#FFFFFF'
const SURFACE = '#F5F6F7'
const BORDER = '#E3E5E8'
const INK = '#14161A'
const MUTED = '#676C74'

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"

/** One row of the small facts table under the heading. */
const fact = (label: string, value: string): string =>
  `<tr>` +
  `<td style="padding:4px 12px 4px 0;font:400 13px ${FONT};color:${MUTED};white-space:nowrap">${label}</td>` +
  `<td style="padding:4px 0;font:600 13px ${FONT};color:${INK}">${value}</td>` +
  `</tr>`

/**
 * The shell every kind shares.
 *
 * 600px is the width every mail client agrees on, and the outer table is what
 * centres it in the ones that ignore `margin:auto`.
 */
const shell = (heading: string, facts: readonly string[], body: string): string =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ` +
  `style="background:${SURFACE};margin:0;padding:24px 0">` +
  `<tr><td align="center">` +
  `<table role="presentation" width="600" cellpadding="0" cellspacing="0" ` +
  `style="width:600px;max-width:100%;background:${GROUND};border:1px solid ${BORDER};border-radius:6px">` +
  `<tr><td style="padding:28px 28px 8px 28px">` +
  `<p style="margin:0 0 4px 0;font:600 12px ${FONT};letter-spacing:0.08em;text-transform:uppercase;color:${MUTED}">%company_name%</p>` +
  `<h1 style="margin:0;font:600 20px ${FONT};color:${INK}">${heading}</h1>` +
  `</td></tr>` +
  (facts.length === 0
    ? ''
    : `<tr><td style="padding:12px 28px 0 28px">` +
      `<table role="presentation" cellpadding="0" cellspacing="0">${facts.join('')}</table>` +
      `</td></tr>`) +
  `<tr><td style="padding:20px 28px 28px 28px;font:400 14px ${FONT};color:${INK};line-height:1.5">${body}</td></tr>` +
  `</table>` +
  `</td></tr></table>`

const INVOICE_HTML = shell(
  'Invoice %invoice_number%',
  [
    fact('Amount', '%invoice_amount%'),
    fact('Issued', '%invoice_issue_date%'),
    fact('Due', '%invoice_due_date%'),
  ],
  `<p style="margin:0 0 16px 0">Please find invoice %invoice_number% for %invoice_amount%. ` +
    `Payment is due %invoice_due_date%.</p>%invoice_line_items%`,
)

const REMINDER_HTML = shell(
  'Invoice %invoice_number% is due %invoice_due_date%',
  [fact('Amount', '%invoice_amount%'), fact('Due', '%invoice_due_date%')],
  `<p style="margin:0 0 16px 0">Invoice %invoice_number% for %invoice_amount% ` +
    `is due on %invoice_due_date%.</p>%invoice_line_items%`,
)

const THANK_YOU_HTML = shell(
  'Payment received',
  [fact('Invoice', '%invoice_number%'), fact('Paid', '%invoice_paid_date%')],
  `<p style="margin:0 0 16px 0">Thank you. Payment for invoice %invoice_number% ` +
    `from %company_name% has been recorded.</p>%invoice_line_items%`,
)

/**
 * The two authentication kinds.
 *
 * These carry a link that is always present -- unlike the payment URL -- so
 * they get the one call to action in the set. The address is printed beneath
 * it because a client that strips the anchor still has to leave somebody a way
 * in, and because a link whose target you cannot read is the shape of every
 * phishing mail.
 */
const action = (lead: string): string =>
  `<p style="margin:0 0 20px 0">${lead}</p>` +
  `<p style="margin:0 0 20px 0"><a href="%action_url%" ` +
  `style="display:inline-block;padding:10px 18px;background:#16794A;color:#FFFFFF;` +
  `font:600 14px ${FONT};text-decoration:none;border-radius:4px">Continue</a></p>` +
  `<p style="margin:0 0 8px 0;font:400 13px ${FONT};color:${MUTED};word-break:break-all">%action_url%</p>` +
  `<p style="margin:0;font:400 13px ${FONT};color:${MUTED}">This one-time link expires at %expires_at%.</p>`

const VERIFICATION_HTML = shell(
  'Verify your email',
  [],
  action('Confirm this address to finish setting up your %company_name% account.'),
)

const RESET_HTML = shell(
  'Reset your password',
  [],
  action('Use the link below to choose a new %company_name% password.'),
)

const HTML_BY_KIND: readonly (readonly [string, string])[] = [
  ['invoice', INVOICE_HTML],
  ['reminder', REMINDER_HTML],
  ['thank_you', THANK_YOU_HTML],
  ['auth_email_verification', VERIFICATION_HTML],
  ['auth_password_reset', RESET_HTML],
]

const quoted = (value: string): string => `'${value.replaceAll("'", "''")}'`

export const emailHtmlTemplatesMigration = [
  ...HTML_BY_KIND.flatMap(([kind, html]) => [
    // Carries the live subject and text forward unchanged. This version is the
    // same mail with an HTML part, not a rewrite of what anybody receives.
    //
    // `version` is read as the head's + 1 because 0030's sequence guard refuses
    // anything else, and the whole statement is conditional on the live version
    // being one the system wrote: `created_by_user_id` is null for a seeded row
    // and set for one a person saved.
    `INSERT INTO email_template_versions (
        template_kind, version, subject_template, text_template, html_template,
        unknown_variable_policy, created_at
      )
      SELECT head.template_kind, head.current_version + 1, live.subject_template,
        live.text_template, ${quoted(html)}, live.unknown_variable_policy,
        strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      FROM email_template_heads head
      JOIN email_template_versions live
        ON live.template_kind = head.template_kind AND live.version = head.current_version
      WHERE head.template_kind = ${quoted(kind)}
        AND live.created_by_user_id IS NULL
        AND live.html_template IS NULL`,
    // Moved only where the version above was actually written. An edited
    // template never got one, so its head has nothing new to point at.
    `UPDATE email_template_heads
      SET current_version = current_version + 1,
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE template_kind = ${quoted(kind)}
        AND EXISTS (
          SELECT 1 FROM email_template_versions candidate
          WHERE candidate.template_kind = email_template_heads.template_kind
            AND candidate.version = email_template_heads.current_version + 1
            AND candidate.html_template IS NOT NULL
        )`,
  ]),
] as const
