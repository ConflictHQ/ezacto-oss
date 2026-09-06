import { describe, expect, it, vi } from 'vitest'
import {
  computeReputationSnapshot,
  processFeedbackEvent,
  type EmailLogRecord,
  type EmailLogStore,
} from '../src/index.js'

const record = (overrides: Partial<EmailLogRecord> = {}): EmailLogRecord => ({
  id: 7,
  from: { email: 'billing@example.test', name: 'Ezacto' },
  replyTo: [],
  to: [{ email: 'owner@example.test', name: 'Avery' }],
  template: 'invoice_sent',
  subject: 'Invoice #1042',
  provider: 'ses',
  providerMessageId: 'ses-msg-001',
  providerRequestId: 'ses-req-001',
  providerLatencyMs: 120,
  status: 'sent',
  relatedType: 'invoice',
  relatedId: 1042,
  attemptCount: 1,
  failureCode: null,
  failureReason: null,
  createdAt: '2026-09-01T12:00:00.000Z',
  updatedAt: '2026-09-01T12:00:01.000Z',
  ...overrides,
})

const store = (): EmailLogStore => {
  let attemptCount = 0
  return {
    createQueued: vi.fn(async () => record({ status: 'queued', provider: null, providerMessageId: null })),
    get: vi.fn(async () => record()),
    claimAttempt: vi.fn(async () => {
      attemptCount += 1
      return attemptCount
    }),
    releaseAttempt: vi.fn(async () => true),
    markSent: vi.fn(async () => record()),
    markProviderFailed: vi.fn(async () => record({ status: 'failed' })),
    markQueueFailed: vi.fn(async () => record({ status: 'failed', failureCode: 'queue_unavailable' })),
    markBounced: vi.fn(async () => record({ status: 'bounced' })),
    markComplained: vi.fn(async () => record({ status: 'complained' })),
    getByProviderMessageId: vi.fn(async () => record()),
    countByStatus: vi.fn(async () => ({
      queued: 0,
      sent: 950,
      bounced: 30,
      complained: 5,
      failed: 15,
    })),
    list: vi.fn(async () => []),
  }
}

describe('feedback processing', () => {
  it('[unit] bounce webhook updates message status to bounced', async () => {
    const log = store()
    const result = await processFeedbackEvent(
      { type: 'bounce', providerMessageId: 'ses-msg-001' },
      log,
    )
    expect(result).toMatchObject({ status: 'bounced' })
    expect(log.getByProviderMessageId).toHaveBeenCalledWith('ses-msg-001')
    expect(log.markBounced).toHaveBeenCalledWith(7)
    expect(log.markComplained).not.toHaveBeenCalled()
  })

  it('[unit] complaint webhook updates message status to complained', async () => {
    const log = store()
    const result = await processFeedbackEvent(
      { type: 'complaint', providerMessageId: 'ses-msg-001' },
      log,
    )
    expect(result).toMatchObject({ status: 'complained' })
    expect(log.markComplained).toHaveBeenCalledWith(7)
    expect(log.markBounced).not.toHaveBeenCalled()
  })

  it('[unit] returns null when provider message ID is unknown', async () => {
    const log = store()
    vi.mocked(log.getByProviderMessageId).mockResolvedValue(null)
    const result = await processFeedbackEvent(
      { type: 'bounce', providerMessageId: 'unknown-id' },
      log,
    )
    expect(result).toBeNull()
    expect(log.markBounced).not.toHaveBeenCalled()
  })

  it('[unit] does not overwrite an already terminal record', async () => {
    const log = store()
    vi.mocked(log.getByProviderMessageId).mockResolvedValue(
      record({ status: 'bounced' }),
    )
    const result = await processFeedbackEvent(
      { type: 'complaint', providerMessageId: 'ses-msg-001' },
      log,
    )
    expect(result).toMatchObject({ status: 'bounced' })
    expect(log.markComplained).not.toHaveBeenCalled()
    expect(log.markBounced).not.toHaveBeenCalled()
  })

  it('[unit] does not mark a queued record that has not been sent yet', async () => {
    const log = store()
    vi.mocked(log.getByProviderMessageId).mockResolvedValue(
      record({ status: 'queued', provider: null, providerMessageId: null }),
    )
    const result = await processFeedbackEvent(
      { type: 'bounce', providerMessageId: 'ses-msg-001' },
      log,
    )
    expect(result).toMatchObject({ status: 'queued' })
    expect(log.markBounced).not.toHaveBeenCalled()
  })

  it('[unit] rejects invalid feedback event type', async () => {
    const log = store()
    await expect(
      processFeedbackEvent(
        { type: 'invalid' as 'bounce', providerMessageId: 'ses-msg-001' },
        log,
      ),
    ).rejects.toThrow('feedback event type must be bounce or complaint')
  })

  it('[unit] rejects empty provider message ID', async () => {
    const log = store()
    await expect(
      processFeedbackEvent({ type: 'bounce', providerMessageId: '' }, log),
    ).rejects.toThrow()
  })
})

describe('reputation snapshot', () => {
  it('[unit] computes bounce and complaint rates per identity from log counts', () => {
    const snapshot = computeReputationSnapshot({
      queued: 10,
      sent: 950,
      bounced: 30,
      complained: 5,
      failed: 15,
    })
    // sent denominator = sent + bounced + complained = 985
    expect(snapshot.sent).toBe(985)
    expect(snapshot.bounced).toBe(30)
    expect(snapshot.complained).toBe(5)
    expect(snapshot.failed).toBe(15)
    expect(snapshot.bounceRatePpm).toBe(Math.round((30 / 985) * 1_000_000))
    expect(snapshot.complaintRatePpm).toBe(Math.round((5 / 985) * 1_000_000))
  })

  it('[unit] returns zero rates when no messages have been delivered', () => {
    const snapshot = computeReputationSnapshot({
      queued: 5,
      sent: 0,
      bounced: 0,
      complained: 0,
      failed: 3,
    })
    expect(snapshot.sent).toBe(0)
    expect(snapshot.bounceRatePpm).toBe(0)
    expect(snapshot.complaintRatePpm).toBe(0)
    expect(snapshot.failed).toBe(3)
  })

  it('[unit] handles perfect delivery with zero bounces', () => {
    const snapshot = computeReputationSnapshot({
      queued: 0,
      sent: 1000,
      bounced: 0,
      complained: 0,
      failed: 0,
    })
    expect(snapshot.sent).toBe(1000)
    expect(snapshot.bounceRatePpm).toBe(0)
    expect(snapshot.complaintRatePpm).toBe(0)
  })
})
