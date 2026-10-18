import type { SenderBoundQueuedMailer } from '@ezacto/mailer'
import type { AccountDeletionMailer, AccountDeletionRequest } from './profile.js'

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

const body = (
  request: AccountDeletionRequest,
  company: string,
): { subject: string; text: string; html: string } => {
  const who =
    request.person.email === null
      ? request.person.name
      : `${request.person.name} (${request.person.email})`
  const asked = `${who} asked on ${request.requestedAt.slice(0, 10)} to have their ${company} account, and the data held against it, deleted.`
  const nothing =
    'Nothing has been deleted or deactivated. The account stays as it is until an administrator ' +
    "acts on the request in Company settings → Erasure and retention, as your organization's retention policy allows."
  const logged = 'Review the request and its recorded disclosure in the deletion-request queue. Queued email does not complete account erasure.'
  return {
    subject: `${request.person.name} asked to have their ${company} account deleted`,
    text: [asked, '', nothing, '', logged].join('\n'),
    html: [asked, nothing, logged].map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join(''),
  }
}

/**
 * The administrators' notice of a deletion request: composed inline and
 * enqueued on the deployment sender, as the staff sign-in mail is. It is
 * mail to the instance's own administrators, not to a client, so it is not one
 * of the organization-editable templates.
 */
export const createQueuedAccountDeletionMailer = (
  mailer: SenderBoundQueuedMailer,
  organizationName: () => Promise<string>,
): AccountDeletionMailer => ({
  notify: async (request) => {
    const { subject, text, html } = body(request, await organizationName())
    const delivery = await mailer.enqueue({
      to: request.administrators.map((email) => ({ email })),
      template: 'account_deletion_request:v1',
      subject,
      text,
      html,
    })
    return { deliveryId: delivery.id, queued: delivery.status === 'queued' || delivery.status === 'sent' }
  },
})
