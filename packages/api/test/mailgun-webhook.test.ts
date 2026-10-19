import { describe, expect, it, vi } from 'vitest'
import type { MailgunFeedbackResult, MailgunFeedbackService } from '@ezacto/mailer'
import { createApiApp, installMailgunWebhookRoute } from '../src/index.js'

const shippedApp = (service?: MailgunFeedbackService) =>
  createApiApp({
    installApp(app) {
      if (service !== undefined) installMailgunWebhookRoute(app, service)
    },
  })

const answering = (result: MailgunFeedbackResult): MailgunFeedbackService => ({
  receive: vi.fn(async () => result),
})

const deliver = (service: MailgunFeedbackService | undefined) =>
  shippedApp(service).request('http://localhost/webhooks/mailgun', {
    method: 'POST',
    body: '{"signature":{}}',
  })

describe('the Mailgun webhook route', () => {
  it('[security] takes no session and hands the raw body to the verifier', async () => {
    const service = answering({ kind: 'applied', outcome: 'bounced' })
    const response = await deliver(service)
    expect(response.status).toBe(200)
    expect(service.receive).toHaveBeenCalledWith('{"signature":{}}')
  })

  it('[security] is a 404 where no signing key mounted it', async () => {
    expect((await deliver(undefined)).status).toBe(404)
  })

  it.each([
    [{ kind: 'unverified' }, 401],
    [{ kind: 'stale' }, 401],
    [{ kind: 'replayed' }, 401],
    [{ kind: 'malformed' }, 406],
    [{ kind: 'retry' }, 503],
    [{ kind: 'duplicate' }, 200],
    [{ kind: 'applied', outcome: 'ignored' }, 200],
  ] as const)('[api] answers %j with %i', async (result, status) => {
    const response = await deliver(answering(result))
    expect(response.status).toBe(status)
  })
})
