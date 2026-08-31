import type {
  EmailLogStore,
  EmailQueue,
  HttpEmailProvider,
  QueuedEmailJob,
} from '@ezacto/mailer'
import {
  createQueuedMailer,
  processQueuedEmail,
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
): Promise<void> => {
  await Promise.all(
    batch.messages.map(async (message) => {
      const disposition = await processQueuedEmail(
        message.body,
        message.attempts,
        log,
        provider,
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

export const createWorkerAuthMailer = (
  queue: Queue<QueuedEmailJob>,
  log: EmailLogStore,
  appOrigin: string,
): AuthMailer =>
  createQueuedAuthMailer(
    createQueuedMailer(log, createCloudflareEmailQueue(queue)),
    appOrigin,
  )
