import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import { isIP } from 'node:net'
import {
  WebhookError,
  isPublicWebhookAddress,
  webhookUrl,
  type WebhookTransport,
} from '@ezacto/core'
import { webhookRequestHeaders } from './outbound-webhooks.js'

/** Resolve once, reject mixed public/private answers, then pin the socket while retaining TLS SNI. */
export const createNodeWebhookTransport = (): WebhookTransport => ({
  async send(input) {
    input.signal.throwIfAborted()
    const url = new URL(webhookUrl(input.url))
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await lookup(hostname + '.', { all: true, verbatim: true })
    input.signal.throwIfAborted()
    if (!addresses.length || addresses.some(({ address }) => !isPublicWebhookAddress(address)))
      throw new WebhookError('webhook_destination_forbidden', 'url')
    return new Promise((resolve, reject) => {
      const outgoing = request(
        url,
        {
          method: 'POST',
          agent: false,
          signal: input.signal,
          headers: webhookRequestHeaders(input),
          // No second DNS lookup and no pooled connection from another subscription.
          lookup(_hostname, options, callback) {
            const eligible = addresses.filter(
              ({ family }) => !options.family || family === options.family,
            )
            const selected = eligible[0]
            if (!selected) {
              callback(new Error('No permitted address'), '', 4)
            } else if (options.all) {
              callback(null, eligible)
            } else {
              callback(null, selected.address, selected.family)
            }
          },
        },
        (response) => {
          const status = response.statusCode ?? 0
          // Ignore and close the untrusted response body. HTTPS does not follow redirects.
          response.destroy()
          resolve({ status })
        },
      )
      outgoing.on('error', reject)
      outgoing.end(input.body)
    })
  },
})
