import type { SenderBoundQueuedMailer } from '@ezacto/mailer'
import type {
  StaffMagicLinkDelivery,
  StaffMagicLinkMailer,
} from './staff-magic-link.js'

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

const body = (
  delivery: StaffMagicLinkDelivery,
  company: string,
): { subject: string; text: string; html: string } => ({
  subject: `Your ${company} sign-in link`,
  text: [
    `Sign in to ${company}.`,
    '',
    'Open this link on the device you want to sign in on:',
    delivery.link,
    '',
    `Or enter this code: ${delivery.code}`,
    '',
    'The link and code expire in 10 minutes and can each be used once.',
    'If you did not ask to sign in, you can ignore this email.',
  ].join('\n'),
  html: [
    `<p>Sign in to ${escapeHtml(company)}.</p>`,
    `<p><a href="${escapeHtml(delivery.link)}">Tap here to finish signing in</a></p>`,
    `<p>Or enter this code: <strong>${escapeHtml(delivery.code)}</strong></p>`,
    '<p>The link and code expire in 10 minutes and can each be used once. ' +
      'If you did not ask to sign in, you can ignore this email.</p>',
  ].join(''),
})

/**
 * The staff sign-in email: one tappable link and one typed code, composed
 * inline and enqueued on the deployment sender the other auth mail rides. It is
 * not (yet) one of the org-editable DB templates the password and verification
 * mail are, so the copy lives here rather than in email configuration.
 */
export const createQueuedStaffMagicLinkMailer = (
  mailer: SenderBoundQueuedMailer,
  organizationName: () => Promise<string>,
): StaffMagicLinkMailer => ({
  enqueue: async (delivery) => {
    const { subject, text, html } = body(delivery, await organizationName())
    await mailer.enqueue({
      to: [{ email: delivery.to }],
      template: 'staff_magic_link_signin:v1',
      subject,
      text,
      html,
    })
  },
})
