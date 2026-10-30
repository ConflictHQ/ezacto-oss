import type { SenderBoundQueuedMailer } from '@ezacto/mailer'
import type { TwoFactorEmailCodeMailer } from './two-factor-challenge.js'

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

/**
 * The emailed second factor: a code, and deliberately nothing to click.
 *
 * A link in a second-factor email is a phishing target, and mail scanners
 * follow links, which would spend the factor before its owner saw it. The only
 * thing here is six digits to type into the page that is already waiting.
 */
const body = (
  code: string,
  minutes: number,
  company: string,
): { subject: string; text: string; html: string } => ({
  subject: `Your ${company} verification code`,
  text: [
    `Your ${company} verification code is ${code}`,
    '',
    `It expires in ${minutes} minutes and can be used once.`,
    'Enter it on the sign-in page. Nobody from us will ask you for it any other way.',
    'If you did not just sign in with your password, someone may have it: change it now.',
  ].join('\n'),
  html: [
    `<p>Your ${escapeHtml(company)} verification code is</p>`,
    `<p style="font-size:24px;letter-spacing:4px"><strong>${escapeHtml(code)}</strong></p>`,
    `<p>It expires in ${minutes} minutes and can be used once. Enter it on the sign-in page.</p>`,
    '<p>If you did not just sign in with your password, someone may have it: change it now.</p>',
  ].join(''),
})

/** Rides the deployment sender and queue the other sign-in mail does. */
export const createQueuedTwoFactorEmailCodeMailer = (
  mailer: SenderBoundQueuedMailer,
  organizationName: () => Promise<string>,
): TwoFactorEmailCodeMailer => ({
  enqueue: async (delivery) => {
    const minutes = Math.max(
      1,
      Math.round((Date.parse(delivery.expiresAt) - Date.now()) / 60_000),
    )
    const { subject, text, html } = body(delivery.code, minutes, await organizationName())
    await mailer.enqueue({
      to: [{ email: delivery.to }],
      template: 'two_factor_email_code:v1',
      subject,
      text,
      html,
    })
  },
})
