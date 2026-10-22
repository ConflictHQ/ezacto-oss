import type * as Https from 'node:https'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webhookSignature, verifyWebhookSignature } from '@ezacto/core'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { webhookLimits } from '@ezacto/core'
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }))
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }))
vi.mock('node:https', () => ({ request: mocks.request }))
import { createNodeWebhookTransport } from '../src/node-webhooks.js'
import { createWorkerWebhookTransport } from '../src/outbound-webhooks.js'
const input = () => ({
  url: 'https://receiver.example/webhook',
  body: '{"id":"event-one"}',
  eventId: 'event-one',
  timestamp: '1792589541',
  signature: 'v1=signature',
  signal: AbortSignal.timeout(webhookLimits.deliveryTimeoutMs),
})
afterEach(() => {
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})
describe('outbound webhook transports', () => {
  it('rejects private and mixed DNS answers before opening a socket', async () => {
    for (const addresses of [
      [],
      [{ address: '127.0.0.1', family: 4 }],
      [
        { address: '8.8.8.8', family: 4 },
        { address: 'fd00::1', family: 6 },
      ],
    ]) {
      mocks.lookup.mockResolvedValueOnce(addresses)
      await expect(createNodeWebhookTransport().send(input())).rejects.toMatchObject({
        code: 'webhook_destination_forbidden',
      })
    }
    expect(mocks.request).not.toHaveBeenCalled()
  })
  it('pins validated DNS answers, preserves TLS hostname, and discards redirect bodies', async () => {
    mocks.lookup.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ])
    const destroy = vi.fn(),
      end = vi.fn()
    mocks.request.mockImplementation((url, options, callback) => {
      expect(url.hostname).toBe('receiver.example')
      expect(options.agent).toBe(false)
      expect(options.rejectUnauthorized).not.toBe(false)
      const single = vi.fn(),
        all = vi.fn()
      options.lookup('receiver.example', { family: 4 }, single)
      expect(single).toHaveBeenCalledWith(null, '8.8.8.8', 4)
      options.lookup('receiver.example', { all: true }, all)
      expect(all).toHaveBeenCalledWith(
        null,
        expect.arrayContaining([{ address: '8.8.8.8', family: 4 }]),
      )
      queueMicrotask(() => callback({ statusCode: 302, destroy }))
      return Object.assign(new EventEmitter(), { end })
    })
    expect(await createNodeWebhookTransport().send(input())).toEqual({ status: 302 })
    expect(mocks.lookup).toHaveBeenCalledExactlyOnceWith('receiver.example.', {
      all: true,
      verbatim: true,
    })
    expect(end).toHaveBeenCalledWith(input().body)
    expect(destroy).toHaveBeenCalledOnce()
    expect(mocks.request).toHaveBeenCalledOnce()
  })
  it('does not send after cancellation or accept a private literal', async () => {
    const signal = AbortSignal.abort()
    await expect(createNodeWebhookTransport().send({ ...input(), signal })).rejects.toThrow()
    await expect(
      createNodeWebhookTransport().send({ ...input(), url: 'https://169.254.169.254/' }),
    ).rejects.toMatchObject({ code: 'webhook_destination_forbidden' })
    expect(mocks.request).not.toHaveBeenCalled()
  })
  it('uses global Worker fetch with fixed headers, manual redirects and no credentials', async () => {
    const cancel = vi.fn(),
      fetch = vi.fn().mockResolvedValue({ status: 307, body: { cancel } })
    vi.stubGlobal('fetch', fetch)
    expect(await createWorkerWebhookTransport().send(input())).toEqual({ status: 307 })
    expect(fetch).toHaveBeenCalledWith(
      input().url,
      expect.objectContaining({
        method: 'POST',
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'ezacto-webhooks/1',
          'x-ezacto-event-id': 'event-one',
          'x-ezacto-timestamp': '1792589541',
          'x-ezacto-signature': 'v1=signature',
        },
      }),
    )
    expect(cancel).toHaveBeenCalledOnce()
  })
})

it('delivers exact signed bytes over TLS to an owned receiver with hostname verification', async () => {
  const https = await vi.importActual<typeof Https>('node:https')
  const directory = await mkdtemp(join(tmpdir(), 'ezacto-webhook-tls-'))
  let server: ReturnType<typeof https.createServer> | undefined
  try {
    const keyPath = join(directory, 'key.pem'),
      certPath = join(directory, 'cert.pem')
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '1',
        '-subj',
        '/CN=receiver.example',
        '-addext',
        'subjectAltName=DNS:receiver.example',
      ],
      { stdio: 'ignore' },
    )
    const key = await readFile(keyPath),
      cert = await readFile(certPath)
    const signingKey = 'ezwh_' + 'a'.repeat(43),
      body = '{"event_id":"owned-receiver","resource":{"id":7}}'
    const timestamp = Math.floor(Date.now() / 1000)
    let received: { body: string; verified: boolean; id: string | undefined } | undefined
    server = https.createServer({ key, cert }, async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const raw = Buffer.concat(chunks)
      received = {
        body: raw.toString(),
        id: request.headers['x-ezacto-event-id'] as string | undefined,
        verified: await verifyWebhookSignature({
          body: raw,
          timestamp: request.headers['x-ezacto-timestamp'] as string,
          signature: request.headers['x-ezacto-signature'] as string,
          secrets: [signingKey],
          now: timestamp,
        }),
      }
      response.writeHead(204)
      response.end()
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    mocks.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
    // Test network mapping only: retain the real HTTPS stack, SNI, and certificate validation.
    mocks.request.mockImplementation((url, options, callback) => {
      const pin = vi.fn()
      options.lookup(url.hostname, { family: 4 }, pin)
      expect(pin).toHaveBeenCalledWith(null, '8.8.8.8', 4)
      return https.request(
        url,
        {
          ...options,
          ca: cert,
          lookup(_name, options, done) {
            if (options.all) done(null, [{ address: '127.0.0.1', family: 4 }])
            else done(null, '127.0.0.1', 4)
          },
        },
        callback,
      )
    })
    const result = await createNodeWebhookTransport().send({
      ...input(),
      url: `https://receiver.example:${address.port}/events`,
      body,
      eventId: 'owned-receiver',
      timestamp: String(timestamp),
      signature: await webhookSignature({ body, timestamp, secrets: [signingKey] }),
    })
    expect(result.status).toBe(204)
    expect(received).toEqual({ body, verified: true, id: 'owned-receiver' })
  } finally {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})
