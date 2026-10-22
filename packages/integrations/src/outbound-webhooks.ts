import { webhookUrl, type WebhookTransport } from '@ezacto/core'

export const webhookRequestHeaders = (input: Parameters<WebhookTransport['send']>[0]) => ({
  'content-type': 'application/json',
  'user-agent': 'ezacto-webhooks/1',
  'x-ezacto-event-id': input.eventId,
  'x-ezacto-timestamp': input.timestamp,
  'x-ezacto-signature': input.signature,
})

/** Cloudflare global fetch uses public-network egress; never pass a private-network binding. */
export const createWorkerWebhookTransport = (): WebhookTransport => ({
  async send(input) {
    const response = await fetch(webhookUrl(input.url), {
      method: 'POST',
      headers: webhookRequestHeaders(input),
      body: input.body,
      signal: input.signal,
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
    })
    await response.body?.cancel()
    return { status: response.status }
  },
})
