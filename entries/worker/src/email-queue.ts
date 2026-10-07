import type {
  EmailLogStore,
  EmailQueue,
  HttpEmailProvider,
  QueuedEmailJob,
} from '@ezacto/mailer'
import {
  createDeploymentSenderQueuedMailer,
  createQueuedMailer,
  createSenderBoundQueuedMailer,
  processQueuedEmail,
  type EmailAttachmentResolver,
  type SenderBoundQueuedMailer,
  type SenderIdentityResolver,
} from '@ezacto/mailer'
import {
  createQueuedAuthMailer,
  createQueuedStaffMagicLinkMailer,
  type AuthMailer,
  type StaffMagicLinkMailer,
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
): Promise<void> => {
  await Promise.all(
    batch.messages.map(async (message) => {
      const disposition = await processQueuedEmail(
        message.body,
        message.attempts,
        log,
        provider,
        resolveAttachment === undefined ? {} : { resolveAttachment },
      )
      if (disposition.action === 'retry') {
        message.retry({ delaySeconds: disposition.delaySeconds })
      } else {
        message.ack()
      }
    }),
  )
}

/**
 * The public demo's consumer (#931): it takes no provider, so it has nothing
 * to send with. The demo's producer never puts a job on the queue at all --
 * this is for whatever was already there when a deployment became the demo,
 * and for anything a future path manages to enqueue regardless.
 *
 * A message still queued is suppressed; one that already ended, however it
 * ended, is only acknowledged. A message under a live provider lease makes the
 * batch throw, so the queue offers it again once the lease has run out.
 */
export const suppressCloudflareEmailBatch = async (
  batch: MessageBatch<QueuedEmailJob>,
  log: EmailLogStore,
): Promise<void> => {
  await Promise.all(
    batch.messages.map(async (message) => {
      const current = await log.get(message.body.deliveryId)
      if (current?.status === 'queued') await log.markSuppressed(current.id)
      message.ack()
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

export const createWorkerOrganizationMailer = (
  queue: EmailQueue,
  log: EmailLogStore,
  provider: string,
  identities: SenderIdentityResolver,
): SenderBoundQueuedMailer =>
  createSenderBoundQueuedMailer(identities, createQueuedMailer(log, queue), provider)
