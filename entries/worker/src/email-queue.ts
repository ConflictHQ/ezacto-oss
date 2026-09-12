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
import { createQueuedAuthMailer, type AuthMailer } from '@ezacto/api'

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

export { createQueuedAuthMailer } from '@ezacto/api'

export const createWorkerDeploymentAuthMailer = (
  queue: Queue<QueuedEmailJob>,
  log: EmailLogStore,
  from: string,
  templates: {
    getTemplate: Parameters<typeof createQueuedAuthMailer>[1]['getTemplate']
  },
  organizationName: () => Promise<string>,
  appOrigin: string,
): AuthMailer =>
  createQueuedAuthMailer(
    createDeploymentSenderQueuedMailer(
      from,
      createQueuedMailer(log, createCloudflareEmailQueue(queue)),
    ),
    templates,
    organizationName,
    appOrigin,
  )

export const createWorkerOrganizationMailer = (
  queue: Queue<QueuedEmailJob>,
  log: EmailLogStore,
  provider: string,
  identities: SenderIdentityResolver,
): SenderBoundQueuedMailer =>
  createSenderBoundQueuedMailer(
    identities,
    createQueuedMailer(log, createCloudflareEmailQueue(queue)),
    provider,
  )
