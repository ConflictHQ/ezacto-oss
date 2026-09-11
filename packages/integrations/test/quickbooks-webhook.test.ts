import { describe, expect, it } from 'vitest'
import {
  QuickBooksWebhookError,
  canonicalLastUpdated,
  parseWebhookNotification,
  verifyWebhookSignature,
} from '../src/quickbooks/webhook.js'

const verifierToken = 'verifier-token-for-tests'

const sign = async (payload: string, token = verifierToken): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(token),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return btoa(String.fromCharCode(...new Uint8Array(mac)))
}

const notification = JSON.stringify({
  eventNotifications: [
    {
      realmId: 'realm-a',
      dataChangeEvent: {
        entities: [
          {
            name: 'Payment',
            id: 'qb-pay-1',
            operation: 'Create',
            lastUpdated: '2026-09-11T12:00:00',
          },
          {
            name: 'Invoice',
            id: 'qb-inv-7',
            operation: 'Update',
            lastUpdated: '2026-09-11T12:01:00',
          },
        ],
      },
    },
  ],
})

describe('webhook signatures', () => {
  it('[security] accepts a delivery Intuit actually signed', async () => {
    await expect(
      verifyWebhookSignature({
        payload: notification,
        signature: await sign(notification),
        verifierToken,
      }),
    ).resolves.toBe(true)
  })

  it('[security] refuses a body that was altered after signing', async () => {
    // The case this exists for: the endpoint is a public URL, and a forged
    // delivery that got through records a payment against an invoice nobody
    // paid.
    const signature = await sign(notification)
    const tampered = notification.replace('qb-pay-1', 'qb-pay-2')
    await expect(
      verifyWebhookSignature({ payload: tampered, signature, verifierToken }),
    ).resolves.toBe(false)
  })

  it('[security] refuses a signature made with a different verifier', async () => {
    await expect(
      verifyWebhookSignature({
        payload: notification,
        signature: await sign(notification, 'someone-elses-token'),
        verifierToken,
      }),
    ).resolves.toBe(false)
  })

  it('[security] refuses a missing or unreadable signature rather than skipping the check', async () => {
    for (const signature of [null, '', '   ', 'not-base64-!!']) {
      await expect(
        verifyWebhookSignature({ payload: notification, signature, verifierToken }),
      ).resolves.toBe(false)
    }
  })

  it('[security] refuses to verify at all when no verifier is configured', async () => {
    // Answering "valid" for a blank verifier would turn a misconfigured
    // deployment into an open endpoint, which is the worst possible reading of
    // an empty setting. Throwing makes it a deployment error instead.
    await expect(
      verifyWebhookSignature({
        payload: notification,
        signature: await sign(notification),
        verifierToken: '',
      }),
    ).rejects.toThrow(QuickBooksWebhookError)
  })
})

describe('reading a delivery', () => {
  it('[unit] flattens the batch, keeping each change with its realm', () => {
    // A delivery for a company we are not connected to has to be refused rather
    // than applied to whichever one we happen to hold, so the realm travels with
    // the change rather than being read once for the batch.
    expect(parseWebhookNotification(notification)).toEqual([
      {
        realmId: 'realm-a',
        name: 'Payment',
        id: 'qb-pay-1',
        operation: 'Create',
        lastUpdated: '2026-09-11T12:00:00',
      },
      {
        realmId: 'realm-a',
        name: 'Invoice',
        id: 'qb-inv-7',
        operation: 'Update',
        lastUpdated: '2026-09-11T12:01:00',
      },
    ])
  })

  it('[unit] drops a change missing part of its identity', () => {
    // A change that cannot be deduplicated cannot be applied safely: the
    // identity is what tells a retry from a second edit.
    const partial = JSON.stringify({
      eventNotifications: [
        {
          realmId: 'realm-a',
          dataChangeEvent: {
            entities: [
              { name: 'Payment', id: 'qb-1', operation: 'Create' },
              { name: 'Payment', operation: 'Create', lastUpdated: '2026-09-11T12:00:00' },
              {
                name: 'Payment',
                id: 'qb-2',
                operation: 'Create',
                lastUpdated: '2026-09-11T12:00:00',
              },
            ],
          },
        },
      ],
    })
    expect(parseWebhookNotification(partial).map((change) => change.id)).toEqual(['qb-2'])
  })

  it('[unit] an empty or shapeless notification is not an error', () => {
    // Intuit sends test pings and batches with nothing in them. A 500 here
    // makes Intuit retry something that will never succeed.
    expect(parseWebhookNotification('{}')).toEqual([])
    expect(parseWebhookNotification(JSON.stringify({ eventNotifications: [] }))).toEqual([])
    expect(
      parseWebhookNotification(JSON.stringify({ eventNotifications: [{ realmId: 'r' }] })),
    ).toEqual([])
  })

  it('[unit] refuses a payload that is not JSON at all', () => {
    expect(() => parseWebhookNotification('<html>nope</html>')).toThrow(QuickBooksWebhookError)
  })

  it('[unit] makes Intuit zoneless timestamps explicit UTC', () => {
    // Intuit sends `lastUpdated` without a zone, meaning UTC. Stored timestamps
    // here are canonical ISO with a Z and the delivery table checks that shape.
    expect(canonicalLastUpdated('2026-09-11T12:00:00')).toBe('2026-09-11T12:00:00.000Z')
    expect(canonicalLastUpdated('2026-09-11T12:00:00Z')).toBe('2026-09-11T12:00:00.000Z')
    expect(canonicalLastUpdated('2026-09-11T13:00:00+01:00')).toBe('2026-09-11T12:00:00.000Z')
    expect(() => canonicalLastUpdated('not a date')).toThrow(QuickBooksWebhookError)
  })
})
