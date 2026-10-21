import type { EmailSuppressionReason } from '@ezacto/mailer'
import type {
  EmailLogStore,
  EmailQueue,
  HttpEmailProvider,
  QueuedEmailJob,
} from '@ezacto/mailer'
import {
  RECIPIENT_NOT_ALLOWED,
  createDeploymentSenderQueuedMailer,
  createQueuedMailer,
  createSenderBoundQueuedMailer,
  processQueuedEmail,
  restrictRecipients,
  type EmailAttachmentResolver,
  type SenderBoundQueuedMailer,
  type SenderIdentityResolver,
} from '@ezacto/mailer'
import {
  createDeploymentNotificationMailer,
  createQueuedAccountDeletionMailer,
  createQueuedAuthMailer,
  createQueuedStaffMagicLinkMailer,
  createQueuedPortalMagicLinkMailer,
  type MagicLinkMailer,
  createQueuedTwoFactorEmailCodeMailer,
  type AccountDeletionMailer,
  type AuthMailer,
  type NotificationMailer,
  type StaffMagicLinkMailer,
  type TwoFactorEmailCodeMailer,
} from '@ezacto/api'

/** Cloudflare Queues producer adapter. Provider I/O never runs in fetch(). */
export const createCloudflareEmailQueue = (
  queue: Queue<QueuedEmailJob>,
): EmailQueue => ({
  send: async (job) => {
    await queue.send(job)
  },
})

export const consumeCloudflareEmailBatch = async (
  batch: MessageBatch<QueuedEmailJob>,
  log: EmailLogStore,
  provider: HttpEmailProvider,
  /**
   * Fetches an attachment the job names. Absent where a deployment has no
   * object store, in which case a job naming a file is refused rather than
   * sent without it (issue 626).
   */
  resolveAttachment?: EmailAttachmentResolver,
  /**
   * The public demo's allowlist (#931): the only recipient domains a job may
   * reach. The demo's producer already sends nothing else; this holds whatever
   * reached the queue another way -- before the deployment became the demo, or
   * through a path the producer never saw. Absent everywhere but the demo.
   */
  allowedDomains?: readonly string[],
  getRecipientSuppression?: (recipients: readonly string[]) => Promise<EmailSuppressionReason | null>,
): Promise<void> => {
  const allowed =
    allowedDomains === undefined
      ? null
      : new Set(allowedDomains.map((domain) => domain.trim().toLowerCase()))
  await Promise.all(
    batch.messages.map(async (message) => {
      let job = message.body
      if (allowed !== null) {
        const restricted = restrictRecipients(job.message, allowed)
        if (restricted === null) {
          // Nobody it may reach. A message still queued ends refused; one that
          // already ended, however it ended, is only acknowledged. A live
          // provider lease makes the batch throw, so the queue offers it again
          // once the lease has run out.
          const current = await log.get(job.deliveryId)
          if (current?.status === 'queued') await log.markRefused(current.id, RECIPIENT_NOT_ALLOWED)
          message.ack()
          return
        }
        job = { ...job, message: restricted }
      }
      const disposition = await processQueuedEmail(
        job,
        message.attempts,
        log,
        provider,
        {
          ...(resolveAttachment === undefined ? {} : { resolveAttachment }),
          ...(getRecipientSuppression === undefined ? {} : { getRecipientSuppression }),
        },
      )
      if (disposition.action === 'retry') {
        message.retry({ delaySeconds: disposition.delaySeconds })
      } else {
        message.ack()
      }
    }),
  )
}

export { createQueuedAuthMailer } from '@ezacto/api'

export const createWorkerDeploymentAuthMailer = (
  queue: EmailQueue,
  log: EmailLogStore,
  from: string,
  templates: {
    getTemplate: Parameters<typeof createQueuedAuthMailer>[1]['getTemplate']
  },
  organizationName: () => Promise<string>,
  appOrigin: string,
): AuthMailer =>
  createQueuedAuthMailer(
    createDeploymentSenderQueuedMailer(from, createQueuedMailer(log, queue)),
    templates,
    organizationName,
    appOrigin,
  )

/**
 * The administrators' notice of an account deletion request, on the same
 * queue and deployment sender as the other deployment mail. On the public
 * demo that queue holds mail to the domains it lists, as it does all mail.
 */
export const createWorkerAccountDeletionMailer = (
  queue: EmailQueue,
  log: EmailLogStore,
  from: string,
  organizationName: () => Promise<string>,
): AccountDeletionMailer =>
  createQueuedAccountDeletionMailer(
    createDeploymentSenderQueuedMailer(from, createQueuedMailer(log, queue)),
    organizationName,
  )

/** The staff sign-in email on the same queue as the other deployment mail. */
export const createWorkerStaffMagicLinkMailer = (
  queue: EmailQueue,
  log: EmailLogStore,
  from: string,
  organizationName: () => Promise<string>,
): StaffMagicLinkMailer =>
  createQueuedStaffMagicLinkMailer(
    createDeploymentSenderQueuedMailer(from, createQueuedMailer(log, queue)),
    organizationName,
  )

/** Contact sign-in uses the same deployment sender, durable queue and demo restrictions. */
export const createWorkerPortalMagicLinkMailer = (
  queue: EmailQueue,
  log: EmailLogStore,
  from: string,
  organizationName: () => Promise<string>,
  appBaseUrl: string,
): MagicLinkMailer =>
  createQueuedPortalMagicLinkMailer(
    createDeploymentSenderQueuedMailer(from, createQueuedMailer(log, queue)),
    organizationName,
    appBaseUrl,
  )

/** The emailed second-factor code, on the same queue and deployment sender (issue 770). */
export const createWorkerTwoFactorEmailCodeMailer = (
  queue: EmailQueue,
  log: EmailLogStore,
  from: string,
  organizationName: () => Promise<string>,
): TwoFactorEmailCodeMailer =>
  createQueuedTwoFactorEmailCodeMailer(
    createDeploymentSenderQueuedMailer(from, createQueuedMailer(log, queue)),
    organizationName,
  )

export const createWorkerOrganizationMailer = (
  queue: EmailQueue,
  log: EmailLogStore,
  provider: string,
  identities: SenderIdentityResolver,
): SenderBoundQueuedMailer =>
  createSenderBoundQueuedMailer(identities, createQueuedMailer(log, queue), provider)

/**
 * The mail the instance sends its own people -- budget alerts, time reminders --
 * on the deployment sender and the same queue as the rest, so the demo's
 * allowlist holds it too.
 */
export const createWorkerNotificationMailer = (
  queue: EmailQueue,
  log: EmailLogStore,
  from: string,
): NotificationMailer => createDeploymentNotificationMailer(from, createQueuedMailer(log, queue))
