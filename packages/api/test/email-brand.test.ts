import { describe, expect, it } from 'vitest'
import type { EmailQueue, QueuedEmailJob } from '@ezacto/mailer'
import { emailBrandFrom, withEmailBrand, type StoredBrandAsset } from '../src/index.js'

const logo: StoredBrandAsset = {
  slot: 'wordmark_light',
  contentHash: 'a'.repeat(64),
  fileKey: 'brand/sha256/aa/x',
  contentType: 'image/png',
  byteSize: 10,
  updatedAt: '2026-10-19T00:00:00.000Z',
}

const job = (html?: string): QueuedEmailJob => ({
  schemaVersion: 1,
  deliveryId: 1,
  message: {
    from: { email: 'billing@example.com', name: 'Acme Billing' },
    to: [{ email: 'client@example.com' }],
    template: 't',
    subject: 'Invoice 1',
    text: 'plain body',
    ...(html === undefined ? {} : { html }),
  },
})

const capture = (): { queue: EmailQueue; sent: QueuedEmailJob[] } => {
  const sent: QueuedEmailJob[] = []
  return { sent, queue: { send: async (value) => void sent.push(value) } }
}

describe('branded outgoing mail (#1011)', () => {
  const origin = 'https://time.example.com'

  it('[unit] builds the stable absolute logo URL and reads the action colour from the palette', () => {
    const brand = emailBrandFrom(
      { assets: [logo], palette: { action: '#DB394C', ink: '#000000' }, organizationName: 'Acme' },
      origin,
    )
    expect(brand).toEqual({
      accentColor: '#DB394C',
      logoUrl: `https://time.example.com/brand/wordmark-light/${'a'.repeat(64)}`,
      name: 'Acme',
    })
  })

  it('[unit] has no brand when nothing is set', () => {
    expect(emailBrandFrom({ assets: [], palette: {}, organizationName: 'Acme' }, origin)).toBeNull()
    expect(emailBrandFrom({ assets: [], palette: null, organizationName: 'Acme' }, origin)).toBeNull()
  })

  it('[unit] dresses the HTML part only; sender, subject and text are untouched', async () => {
    const { queue, sent } = capture()
    const branded = withEmailBrand(queue, async () =>
      emailBrandFrom({ assets: [logo], palette: { action: '#DB394C' }, organizationName: 'Acme' }, origin),
    )
    await branded.send(job('<p>Pay up</p>'))
    const message = sent[0]!.message
    expect(message.html).toContain('/brand/wordmark-light/')
    expect(message.html!.endsWith('<p>Pay up</p>')).toBe(true)
    expect(message.text).toBe('plain body')
    expect(message.from).toEqual({ email: 'billing@example.com', name: 'Acme Billing' })
    expect(message.subject).toBe('Invoice 1')
  })

  it('[unit] passes a text-only message and an unbranded instance through as the same job', async () => {
    const { queue, sent } = capture()
    const none = withEmailBrand(queue, async () => null)
    const textOnly = job()
    const plain = job('<p>x</p>')
    await none.send(textOnly)
    await none.send(plain)
    expect(sent[0]).toBe(textOnly)
    expect(sent[1]).toBe(plain)
  })

  it('[unit] still sends, unbranded, when the brand cannot be read', async () => {
    const { queue, sent } = capture()
    const failing = withEmailBrand(queue, async () => {
      throw new Error('database unavailable')
    })
    const message = job('<p>x</p>')
    await failing.send(message)
    expect(sent).toEqual([message])
  })
})
