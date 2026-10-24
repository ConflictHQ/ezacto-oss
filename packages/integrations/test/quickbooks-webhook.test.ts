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

/** Sanitized CloudEvents v1.0 fixture following Intuit's current webhook reference. */
const cloudEvent = (overrides: Record<string, unknown> = {}) => ({
  specversion: '1.0',
  id: 'a485044f-9891-431d-8ae5-8142dbdb9f27',
  source: 'intuit.fixture-source',
  type: 'qbo.payment.created.v1',
  datacontenttype: 'application/json',
  time: '2026-09-11T12:00:00.179851517Z',
  intuitentityid: 'qb-pay-1',
  intuitaccountid: 'realm-a',
  data: {},
  ...overrides,
})

describe('CloudEvents deliveries', () => {
  it('[1013] verifies the raw signed array before normalizing each company and entity', async () => {
    const payload = JSON.stringify(
      [
        cloudEvent({ data: { id: 'wrong-record', realmId: 'wrong-company' } }),
        cloudEvent({
          id: 'second-envelope',
          type: 'qbo.invoice.updated.v1',
          intuitentityid: 'qb-inv-7',
          intuitaccountid: 'realm-b',
        }),
        cloudEvent({ type: 'qbo.billpayment.voided.v1', intuitentityid: 'qb-bill-2' }),
      ],
      null,
      2,
    )
    const signature = await sign(payload)
    await expect(verifyWebhookSignature({ payload, signature, verifierToken })).resolves.toBe(true)
    expect(parseWebhookNotification(payload)).toEqual([
      {
        realmId: 'realm-a',
        name: 'Payment',
        id: 'qb-pay-1',
        operation: 'Create',
        lastUpdated: '2026-09-11T12:00:00.179851517Z',
      },
      {
        realmId: 'realm-b',
        name: 'Invoice',
        id: 'qb-inv-7',
        operation: 'Update',
        lastUpdated: '2026-09-11T12:00:00.179851517Z',
      },
      {
        realmId: 'realm-a',
        name: 'BillPayment',
        id: 'qb-bill-2',
        operation: 'Void',
        lastUpdated: '2026-09-11T12:00:00.179851517Z',
      },
    ])
    await expect(
      verifyWebhookSignature({
        payload: JSON.stringify(JSON.parse(payload)),
        signature,
        verifierToken,
      }),
    ).resolves.toBe(false)
    await expect(
      verifyWebhookSignature({
        payload: payload.replace('qb-pay-1', 'forged-pay'),
        signature,
        verifierToken,
      }),
    ).resolves.toBe(false)
  })

  it.each([
    ['created', 'Create'],
    ['updated', 'Update'],
    ['deleted', 'Delete'],
    ['voided', 'Void'],
    ['merged', 'Merge'],
    ['emailed', 'Emailed'],
  ])('[1013] maps the %s operation to the existing %s handling', (event, operation) => {
    expect(
      parseWebhookNotification(JSON.stringify([cloudEvent({ type: `qbo.payment.${event}.v1` })]))[0]
        ?.operation,
    ).toBe(operation)
  })

  it.each([
    { intuitaccountid: '' },
    { intuitaccountid: ' realm-a' },
    { intuitaccountid: 123 },
    { intuitentityid: '' },
    { intuitentityid: 'qb\u0000pay' },
    { intuitentityid: null },
    { specversion: '2.0' },
    { type: 'qbo.payment.created.v2' },
    { type: 'other.payment.created.v1' },
    { type: 'qbo.payment.create.v1' },
    { type: 'qbo.constructor.created.v1' },
    { type: 'qbo.payment.constructor.v1' },
    { time: 'not-a-date' },
    { time: '2026-09-11' },
    { time: '2026-09-11T12:00:00' },
    { time: '2026-02-29T12:00:00Z' },
    { time: '2026-09-31T12:00:00Z' },
    { time: '2026-09-11T24:00:00Z' },
    { time: '2026-09-11T12:60:00Z' },
    { time: '2026-09-11T12:00:60Z' },
    { time: '2026-09-11T12:00:00+99:00' },
    { time: '2026-09-11T12:00:00.Z' },
    { time: '9999-12-31T23:59:59-23:59' },
    { time: '0000-01-01T00:00:00+23:59' },
  ])('[1013] skips malformed or unsupported identity fields: %j', (override) => {
    expect(parseWebhookNotification(JSON.stringify([cloudEvent(override)]))).toEqual([])
  })

  it('[1013] accepts nanosecond fractions and explicit RFC 3339 zones with canonical legacy precision', () => {
    for (const time of [
      '2026-09-11T12:00:00.179851517Z',
      '2026-09-11T12:00:00.179851517123Z',
      '2026-09-11T13:00:00.179851517+01:00',
      '2026-09-11t12:00:00.179851517z',
    ]) {
      const change = parseWebhookNotification(JSON.stringify([cloudEvent({ time })]))[0]!
      expect(canonicalLastUpdated(change.lastUpdated)).toBe('2026-09-11T12:00:00.179Z')
    }
    expect(
      parseWebhookNotification(JSON.stringify([cloudEvent({ time: '2028-02-29T00:00:00Z' })])),
    ).toHaveLength(1)
  })

  it('[1013] skips non-event entries while retaining valid signed notifications and empty pings', () => {
    expect(parseWebhookNotification('[]')).toEqual([])
    expect(
      parseWebhookNotification(JSON.stringify([null, [], 'not-an-event', 3, cloudEvent()])),
    ).toHaveLength(1)
  })
})
