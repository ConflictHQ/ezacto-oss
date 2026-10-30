/**
 * Mailgun's event deliveries (ezacto-pvt #42, slice B).
 *
 * Outside the API surface and taking no principal: Mailgun has no session with
 * us, so the signature is the authorisation. The route is mounted only where
 * the deployment carries the signing key, so without one it is a 404 and no
 * unsigned post is ever read.
 *
 * What each answer tells Mailgun, which retries anything but a 2xx or a 406 for
 * about eight hours: 401 for a signature, a stale timestamp or a spent token
 * (retrying a forgery is harmless, and a fixed key still lands); 406 for a
 * signed body that can never be processed, which Mailgun does not retry; 503
 * where the message may still be mid-send, so the retry finds it.
 */

import type { Hono } from 'hono'
import type { MailgunFeedbackService } from '@ezacto/mailer'
import type { ApiContext } from './context.js'

export const installMailgunWebhookRoute = <Bindings extends object>(
  app: Hono<ApiContext<Bindings>>,
  service: Readonly<MailgunFeedbackService>,
): void => {
  app.post('/webhooks/mailgun', async (context) => {
    const result = await service.receive(await context.req.text())
    switch (result.kind) {
      case 'unverified':
      case 'stale':
      case 'replayed':
        return context.json({ error: { code: 'signature_invalid' } }, 401)
      case 'malformed':
        return context.json({ error: { code: 'event_malformed' } }, 406)
      case 'retry':
        return context.json({ error: { code: 'message_in_flight' } }, 503, {
          'retry-after': '60',
        })
      default:
        return context.json({ data: { received: true } }, 200)
    }
  })
}
