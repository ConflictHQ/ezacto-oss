import type {
  EmailLogStore,
  EmailQueue,
  HttpEmailProvider,
  QueuedEmailJob,
  QueuedMailer,
} from '@ezacto/mailer'
import {
  createQueuedMailer,
  processQueuedEmail,
} from '@ezacto/mailer'
import type { AuthDelivery, AuthMailer } from '@ezacto/api'

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

const authMessage = (delivery: AuthDelivery, appOrigin: string) => {
  const action =
    delivery.kind === 'verify_email' ? 'verify-email' : 'password-reset'
  const url = new URL('/', appOrigin)
  url.searchParams.set('auth', action)
  url.searchParams.set('token', delivery.token)
  return {
    to: [{ email: delivery.to }],
    template: delivery.kind,
    subject:
      delivery.kind === 'verify_email'
        ? 'Verify your ezacto email'
        : 'Reset your ezacto password',
    text: `${
      delivery.kind === 'verify_email'
        ? 'Verify your ezacto email'
        : 'Reset your ezacto password'
    }: ${url.toString()}\n\nThis one-time link expires at ${delivery.expiresAt}.`,
  } as const
}

export const createQueuedAuthMailer = (
  mailer: QueuedMailer,
  appOrigin: string,
): AuthMailer => {
  const origin = new URL(appOrigin)
  if (origin.pathname !== '/' || origin.search !== '' || origin.hash !== '') {
    throw new TypeError('APP_ORIGIN must be an absolute origin without a path')
  }
  if (origin.protocol !== 'https:' && origin.hostname !== 'localhost') {
    throw new TypeError('APP_ORIGIN must use HTTPS outside localhost')
  }
  return {
    enqueue: async (delivery) => {
      await mailer.enqueue(authMessage(delivery, origin.origin))
    },
  }
}

export const createWorkerAuthMailer = (
  queue: Queue<QueuedEmailJob>,
  log: EmailLogStore,
  appOrigin: string,
): AuthMailer =>
  createQueuedAuthMailer(
    createQueuedMailer(log, createCloudflareEmailQueue(queue)),
    appOrigin,
  )
