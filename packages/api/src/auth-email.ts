import type { QueuedMailer } from '@ezacto/mailer'
import type { AuthDelivery, AuthMailer } from './password-auth.js'

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
