import { describe, expect, it } from 'vitest'
import {
  issueScheduledReviewToken,
  scheduledReviewTokenHash,
  verifyScheduledReviewToken,
} from '../src/scheduled-review-links.js'
const key = new Uint8Array(32).fill(0x43),
  context = { runId: 7, userId: 3, expiresAt: '2026-10-02T09:00:00.000Z' }
describe('signed scheduled review links (#61)', () => {
  it('issues distinct opaque credentials with separate lookup hashes', async () => {
    const first = await issueScheduledReviewToken(context, key),
      second = await issueScheduledReviewToken(context, key)
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/u)
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/u)
    expect(first.token).not.toBe(second.token)
    expect(await scheduledReviewTokenHash(first.token)).toBe(first.hash)
    expect(await verifyScheduledReviewToken(first.token, context, key)).toBe(true)
  })
  it('binds the signature to the run, recipient, deadline and instance key', async () => {
    const { token } = await issueScheduledReviewToken(context, key)
    for (const changed of [
      { ...context, runId: 8 },
      { ...context, userId: 4 },
      { ...context, expiresAt: '2026-10-03T09:00:00.000Z' },
    ])
      expect(await verifyScheduledReviewToken(token, changed, key)).toBe(false)
    expect(await verifyScheduledReviewToken(token, context, new Uint8Array(32).fill(0x44))).toBe(
      false,
    )
    expect(
      await verifyScheduledReviewToken(
        (token[0] === 'A' ? 'B' : 'A') + token.slice(1),
        context,
        key,
      ),
    ).toBe(false)
    expect(await verifyScheduledReviewToken('not-a-token', context, key)).toBe(false)
  })
})
