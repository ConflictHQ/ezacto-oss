import type { SenderBoundQueuedMailer } from '@ezacto/mailer'
import type { MagicLinkMailer } from './magic-link-auth.js'
const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
/** Contact credentials stay in a fragment until the page exchanges them in a
 * POST body. The deployment owns the destination and sender; callers provide
 * only their email address, never a return URL or a recipient override. */
export const createQueuedPortalMagicLinkMailer = (
  mailer: SenderBoundQueuedMailer,
  organizationName: () => Promise<string>,
  appBaseUrl: string,
): MagicLinkMailer => {
  const destination = new URL('/portal/estimate-review', appBaseUrl)
  if (
    (destination.protocol !== 'https:' &&
      !(destination.protocol === 'http:' && destination.hostname === 'localhost')) ||
    destination.username ||
    destination.password
  )
    throw new RangeError('Portal sign-in requires HTTPS (or localhost) without URL credentials')
  return {
    enqueue: async (delivery) => {
      const company = await organizationName()
      const link = new URL(destination)
      link.hash = new URLSearchParams({ token: delivery.token }).toString()
      const text = [
        `Sign in to ${company} to review your estimates.`,
        '',
        link.href,
        '',
        `This link can be used once and expires at ${delivery.expiresAt}.`,
        'If you did not ask to sign in, you can ignore this email.',
      ].join('\n')
      await mailer.enqueue({
        to: [{ email: delivery.to }],
        template: 'portal_magic_link_signin:v1',
        subject: `Your ${company} estimate review sign-in link`,
        text,
        html: `<p>Sign in to ${escapeHtml(company)} to review your estimates.</p><p><a href="${escapeHtml(link.href)}">Review your estimates</a></p><p>This link can be used once and expires at ${escapeHtml(delivery.expiresAt)}.</p><p>If you did not ask to sign in, you can ignore this email.</p>`,
      })
    },
  }
}
