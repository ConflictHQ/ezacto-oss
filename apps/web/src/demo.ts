/**
 * The public demo (issue 931).
 *
 * The demo prints its own administrator's password on its sign-in page, so the
 * Worker refuses everything there that would reach past the demo's database:
 * provider connections, payment links and payouts, the sender identity and the
 * invoice defaults, and file uploads. Those refusals are the control; this is
 * only how the screens say so. A control the demo refuses renders disabled or
 * withheld, with a note in its place, instead of failing after the click.
 *
 * The shell marks `<html>` when the Worker served the page as the demo, which
 * every module can read without asking the API.
 */

/** The Worker's own refusal message, word for word, so the two never disagree. */
export const DEMO_UNAVAILABLE = 'Not available on the public demo.'

/** The same note where it has to say which part of a screen it means. */
export const demoUnavailable = (what: string): string =>
  `${what}: ${DEMO_UNAVAILABLE.charAt(0).toLowerCase()}${DEMO_UNAVAILABLE.slice(1)}`

export const isDemoDeployment = (): boolean =>
  document.documentElement.hasAttribute('data-demo-deployment')
