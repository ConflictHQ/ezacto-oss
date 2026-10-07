/**
 * The public demo (issue 931).
 *
 * The demo prints its own administrator's password on its sign-in page, so the
 * Worker refuses everything there that would reach past the demo's database or
 * lock the next visitor out: provider connections, payment links and payouts,
 * the sender identity and the invoice defaults, file uploads, and the password,
 * second factor, sign-in methods, SSO domains, and who is active with what
 * permission profile. Its mail goes only to the addresses the deployment
 * approves. Those refusals are the control; this is only how the screens say
 * so. A control the demo refuses renders disabled or withheld, with a note in
 * its place, instead of failing after the click.
 *
 * The shell marks `<html>` when the Worker served the page as the demo, and
 * when its mail is held to an allowlist, which every module can read without
 * asking the API. Never which addresses are on that list: a visitor who could
 * read it off a page could use the demo to mail them.
 */

/** The Worker's own refusal message, word for word, so the two never disagree. */
export const DEMO_UNAVAILABLE = 'Not available on the public demo.'

/** The same note where it has to say which part of a screen it means. */
export const demoUnavailable = (what: string): string =>
  `${what}: ${DEMO_UNAVAILABLE.charAt(0).toLowerCase()}${DEMO_UNAVAILABLE.slice(1)}`

export const isDemoDeployment = (): boolean =>
  document.documentElement.hasAttribute('data-demo-deployment')

/**
 * The failure reason the mailer records on a message the demo would not send,
 * because nobody it was addressed to is at an address the demo may email.
 */
export const DEMO_RECIPIENT_NOT_ALLOWED = 'demo_recipient_not_allowed'

/**
 * Whether this deployment's mail is held to an allowlist -- the public demo's
 * always is, an empty list included. Only that it is: the list never reaches
 * a browser.
 */
export const isDemoMailRestricted = (): boolean =>
  document.documentElement.hasAttribute('data-demo-mail-restricted')

/** What a screen that sends mail says on the demo, before anything is sent. */
export const DEMO_MAIL_NOTE = 'On the public demo, email is only delivered to approved addresses.'

/** Why a message the demo held back never went, in place of the bare reason. */
export const DEMO_MAIL_REFUSAL = 'Not delivered: the public demo only emails approved addresses.'
