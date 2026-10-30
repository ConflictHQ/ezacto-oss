import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  LINEAR_STATE_TYPES,
  LINEAR_WEBHOOK_TOLERANCE_MS,
  linearBudget,
  linearStateToCommon,
  verifyLinearWebhook,
} from '../src/work-items/linear-contract.js'

const secret = 'test-secret'
const now = 1_700_000_000_000
const sign = (body: string) => createHmac('sha256', secret).update(body).digest('hex')
const deliver = (body: string, headers: Record<string, string> = {}) => ({
  headers: { 'linear-signature': sign(body), 'linear-delivery': 'd-1', ...headers },
  body,
})

describe('linear state mapping', () => {
  it('[unit] closes only completed and canceled', () => {
    const mapped = Object.fromEntries(LINEAR_STATE_TYPES.map((t) => [t, linearStateToCommon(t)]))
    expect(mapped).toEqual({
      triage: 'open',
      backlog: 'open',
      unstarted: 'open',
      started: 'open',
      completed: 'closed',
      canceled: 'closed',
    })
  })

  it('[unit] refuses to guess an unknown type', () => {
    expect(linearStateToCommon('archived')).toBeNull()
  })
})

describe('linear webhook verification', () => {
  const body = JSON.stringify({ webhookTimestamp: now, action: 'update' })

  it('[security] accepts a signed, fresh delivery and returns its id', async () => {
    expect(await verifyLinearWebhook(deliver(body), { secret, now })).toEqual({
      verified: true,
      deliveryId: 'd-1',
    })
  })

  it('[security] refuses missing, wrong and body-tampered signatures', async () => {
    expect(await verifyLinearWebhook({ headers: {}, body }, { secret, now })).toMatchObject({
      reason: 'missing_signature',
    })
    expect(
      await verifyLinearWebhook(deliver(body, { 'linear-signature': 'ab' }), { secret, now }),
    ).toMatchObject({ reason: 'bad_signature' })
    const tampered = { ...deliver(body), body: body.replace('update', 'remove') }
    expect(await verifyLinearWebhook(tampered, { secret, now })).toMatchObject({
      reason: 'bad_signature',
    })
  })

  it('[security] does not accept a GitHub-style prefixed signature', async () => {
    const req = deliver(body, { 'linear-signature': `sha256=${sign(body)}` })
    expect(await verifyLinearWebhook(req, { secret, now })).toMatchObject({
      reason: 'bad_signature',
    })
  })

  it('[security] refuses a replay outside the tolerance, either direction', async () => {
    const edge = LINEAR_WEBHOOK_TOLERANCE_MS
    expect((await verifyLinearWebhook(deliver(body), { secret, now: now + edge })).verified).toBe(
      true,
    )
    expect(await verifyLinearWebhook(deliver(body), { secret, now: now + edge + 1 })).toMatchObject(
      {
        reason: 'malformed',
      },
    )
    expect(await verifyLinearWebhook(deliver(body), { secret, now: now - edge - 1 })).toMatchObject(
      {
        reason: 'malformed',
      },
    )
  })

  it('[unit] refuses a signed body with no timestamp or delivery id', async () => {
    const bare = JSON.stringify({ action: 'update' })
    expect(await verifyLinearWebhook(deliver(bare), { secret, now })).toMatchObject({
      reason: 'malformed',
    })
    const notJson = 'nope'
    expect(await verifyLinearWebhook(deliver(notJson), { secret, now })).toMatchObject({
      reason: 'malformed',
    })
    const noId = { headers: { 'linear-signature': sign(body) }, body }
    expect(await verifyLinearWebhook(noId, { secret, now })).toMatchObject({ reason: 'malformed' })
  })
})

describe('linear budget', () => {
  it('[unit] proceeds while both buckets have room', () => {
    expect(
      linearBudget({
        headers: {
          'x-ratelimit-requests-remaining': '10',
          'x-ratelimit-complexity-remaining': '500',
        },
        now,
      }),
    ).toEqual({ action: 'proceed' })
  })

  it('[unit] cools down until the reset of the exhausted bucket (epoch seconds)', () => {
    expect(
      linearBudget({
        headers: {
          'x-ratelimit-complexity-remaining': '0',
          'x-ratelimit-complexity-reset': '1700000100',
        },
        now,
      }),
    ).toEqual({ action: 'cooldown', why: 'complexity', untilEpochMs: 1_700_000_100_000 })
  })

  it('[unit] treats RATELIMITED as a cooldown, with a fallback when no reset is given', () => {
    expect(linearBudget({ headers: {}, errorCode: 'RATELIMITED', now })).toEqual({
      action: 'cooldown',
      why: 'ratelimited',
      untilEpochMs: now + 60_000,
    })
  })
})
