/**
 * The public demo (issue 931).
 *
 * The demo prints its own administrator's password on its sign-in page, so the
 * Worker refuses everything there that would reach past the demo's database:
 * provider connections, payment links and payouts, the sender identity and the
 * invoice defaults, and file uploads. Its mail goes only to the recipient
 * domains the deployment lists. Those refusals are the control; this is only
 * how the screens say so. A control the demo refuses renders disabled or
 * withheld, with a note in its place, instead of failing after the click.
 *
 * The shell marks `<html>` when the Worker served the page as the demo, with
 * the domains its mail may reach, which every module can read without asking
 * the API.
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
 * because nobody it was addressed to is at a domain the demo may email.
 */
export const DEMO_RECIPIENT_NOT_ALLOWED = 'demo_recipient_not_allowed'

/**
 * The recipient domains the demo's mail reaches, as the Worker was deployed
 * with them. Empty on a demo that emails nobody, and anywhere that is not the
 * demo.
 */
export const demoMailDomains = (): readonly string[] =>
  (document.documentElement.getAttribute('data-demo-mail-domains') ?? '')
    .split(',')
    .map((domain) => domain.trim())
    .filter((domain) => domain !== '')

const domainList = (domains: readonly string[]): string =>
  new Intl.ListFormat('en-US', { style: 'long', type: 'conjunction' }).format(domains)

/** What a screen that sends mail says on the demo, before anything is sent. */
export const demoMailNote = (): string => {
  const domains = demoMailDomains()
  return domains.length === 0
    ? 'On the public demo, email is not delivered to anyone.'
    : `On the public demo, email is only delivered to ${domainList(domains)}.`
}

/** Why a message the demo held back never went, in place of the bare reason. */
export const demoMailRefusal = (): string => {
  const domains = demoMailDomains()
  if (domains.length > 0) {
    return `Not delivered: the public demo only emails ${domainList(domains)}.`
  }
  // Either the demo lists no domain, or this row outlived the demo it was
  // written on and the list is gone with it.
  return isDemoDeployment()
    ? 'Not delivered: the public demo emails nobody.'
    : 'Not delivered: the public demo did not email this address.'
}
