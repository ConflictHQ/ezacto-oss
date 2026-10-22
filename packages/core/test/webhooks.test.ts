import { createHmac } from 'node:crypto'
import { expect, it } from 'vitest'
import {
  isPublicWebhookAddress,
  webhookUrl,
  webhookEvents,
  webhookBody,
  webhookSignature,
  verifyWebhookSignature,
} from '../src/webhooks.js'

it('permits public HTTPS destinations and canonicalizes their host', () => {
  expect(webhookUrl('https://Hooks.Example.com.:443/events')).toBe(
    'https://hooks.example.com/events',
  )
  expect(webhookUrl('https://8.8.8.8/hooks')).toBe('https://8.8.8.8/hooks')
  expect(webhookUrl('https://[2606:4700:4700::1111]/hooks')).toBe(
    'https://[2606:4700:4700::1111]/hooks',
  )
})
it('rejects credentials, local names, private/special literals, alternate IPv4 encodings and IPv6 tunnels', () => {
  for (const value of [
    'http://hooks.example.com',
    'https://user:password@hooks.example.com',
    'https://hooks.example.com/#secret',
    'https://localhost',
    'https://name.localhost.',
    'https://metadata.google.internal',
    'https://app.local',
    'https://x.home.arpa',
    'https://127.1/',
    'https://2130706433/',
    'https://0x7f000001/',
    'https://0177.0.0.1/',
    'https://0.0.0.0',
    'https://10.10.0.1',
    'https://100.100.100.200',
    'https://169.254.169.254',
    'https://172.31.1.2',
    'https://192.168.10.1',
    'https://192.0.0.8',
    'https://192.0.2.1',
    'https://198.18.0.1',
    'https://198.51.100.1',
    'https://203.0.113.1',
    'https://224.0.0.1',
    'https://255.255.255.255',
    'https://[::1]',
    'https://[::ffff:127.0.0.1]',
    'https://[64:ff9b::a00:1]',
    'https://[2002:7f00:1::]',
    'https://[2001::1]',
    'https://[2001:db8::1]',
    'https://[fc00::1]',
    'https://[fe80::1]',
    'https://[ff02::1]',
    'https://hooks.example.com\\@127.0.0.1',
    'https://hooks.example.com/\nheader',
  ])
    expect(() => webhookUrl(value), value).toThrow()
})
it('classifies DNS answers as addresses, including nonpublic mapped IPv6 and public native IPv6', () => {
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888'])
    expect(isPublicWebhookAddress(address), address).toBe(true)
  for (const address of [
    'example.com',
    '127.0.0.1',
    '10.0.0.2',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
    '[::1]',
    '2001:db8::a',
    '3fff::1',
    '3ffe::1',
    'malformed',
  ])
    expect(isPublicWebhookAddress(address), address).toBe(false)
})
it('normalizes a closed event selection and constructs the payload without reading the private event body', () => {
  expect(webhookEvents(['invoice.sent', 'payment.recorded', 'invoice.sent'])).toEqual([
    'invoice.sent',
    'payment.recorded',
  ])
  for (const value of [
    [],
    ['account.deleted'],
    ['invoice.*'],
    ['expense.created'],
    { events: ['invoice.sent'] },
  ])
    expect(() => webhookEvents(value)).toThrow()
  const event = {
    id: 'fixture-event-1',
    eventType: 'payment.recorded',
    aggregateType: 'invoice',
    aggregateId: 12,
    aggregateSequence: 3,
    occurredAt: '2026-10-22T09:00:00.000Z',
    get payload(): never {
      throw new Error('Private payload must not be inspected')
    },
  }
  const body = webhookBody(event)
  expect(JSON.parse(body)).toEqual({
    schema_version: 1,
    event_id: 'fixture-event-1',
    event_type: 'payment.recorded',
    occurred_at: '2026-10-22T09:00:00.000Z',
    resource: { type: 'invoice', id: 12, sequence: 3 },
    links: { resource: '/api/v1/invoices/12' },
  })
  const metadata = {
    id: event.id,
    eventType: event.eventType,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    aggregateSequence: event.aggregateSequence,
    occurredAt: event.occurredAt,
  }
  expect(() => webhookBody({ ...metadata, eventType: 'account.deleted' })).toThrow()
  expect(() => webhookBody({ ...metadata, aggregateType: 'user' })).toThrow()
})

const current = 'fixture-current-secret-0123456789abcdef',
  previous = 'fixture-previous-secret-0123456789abcdef',
  timestamp = 1792659600
const body = '{"schema_version":1,"event_id":"fixture-1","event_type":"invoice.sent"}'
it('signs timestamp plus exact body bytes and agrees with an independent Node HMAC implementation', async () => {
  const expected = createHmac('sha256', current)
    .update(String(timestamp) + '.' + body)
    .digest('hex')
  const signature = await webhookSignature({ timestamp, body, secrets: [current] })
  expect(signature).toBe('v1=' + expected)
  expect(
    await verifyWebhookSignature({
      timestamp: String(timestamp),
      body: new TextEncoder().encode(body),
      signature,
      secrets: [current],
      now: timestamp,
    }),
  ).toBe(true)
})
it('rejects stale/future timestamps, changed bytes, malformed signatures and wrong keys', async () => {
  const signature = await webhookSignature({ timestamp, body, secrets: [current] })
  const input = {
    timestamp: String(timestamp),
    body: new TextEncoder().encode(body),
    signature,
    secrets: [current],
    now: timestamp,
  }
  for (const patch of [
    { now: timestamp + 301 },
    { now: timestamp - 301 },
    { body: new TextEncoder().encode(body + ' ') },
    { timestamp: '0' + String(timestamp) },
    { signature: 'v1=' + '0'.repeat(64) },
    { signature: 'v1=garbage' },
    { signature: signature + ',v1=garbage' },
    { secrets: [previous] },
    { toleranceSeconds: 100000 },
  ])
    expect(await verifyWebhookSignature({ ...input, ...patch })).toBe(false)
})
it('supports both keys during rotation; old keys cannot verify fresh deliveries after overlap', async () => {
  const overlap = await webhookSignature({ timestamp, body, secrets: [current, previous] })
  const verify = {
    timestamp: String(timestamp),
    body: new TextEncoder().encode(body),
    now: timestamp,
  }
  expect(await verifyWebhookSignature({ ...verify, signature: overlap, secrets: [previous] })).toBe(
    true,
  )
  expect(await verifyWebhookSignature({ ...verify, signature: overlap, secrets: [current] })).toBe(
    true,
  )
  const after = await webhookSignature({ timestamp: timestamp + 901, body, secrets: [current] })
  expect(
    await verifyWebhookSignature({
      ...verify,
      now: timestamp + 901,
      timestamp: String(timestamp + 901),
      signature: after,
      secrets: [previous],
    }),
  ).toBe(false)
  expect(
    await verifyWebhookSignature({
      ...verify,
      now: timestamp + 901,
      signature: overlap,
      secrets: [previous],
    }),
  ).toBe(false)
})
