import { describe, expect, it } from 'vitest'
import { estimateResponseSummary, estimateResponseText } from '../src/estimates/model.js'

/** Issue 1010, slice 2: who answered an estimate, when, and which version. */

const message = (overrides: Record<string, unknown>) => ({
  id: 1,
  event_type: 'send' as const,
  sent_by: 'Sam Staff',
  created_at: '2026-10-01T09:00:00.000Z',
  contact_id: null,
  content_hash: null,
  ...overrides,
})

const hash = 'abcdef0123456789'.repeat(4)

describe('the response on file', () => {
  it('[unit] names the contact, the time and the version they answered', () => {
    const summary = estimateResponseSummary('accepted', [
      message({}),
      message({
        id: 2,
        event_type: 'accept',
        sent_by: 'Jordan Rivera',
        created_at: '2026-10-18T14:03:00.000Z',
        contact_id: 9,
        content_hash: hash,
      }),
    ])
    expect(summary).toEqual({
      decision: 'accept',
      source: 'customer',
      by: 'Jordan Rivera',
      at: '2026-10-18T14:03:00.000Z',
      version: 'abcdef01',
    })
    expect(estimateResponseText(summary)).toBe(
      'Accepted by Jordan Rivera on 2026-10-18 14:03 UTC, quote version abcdef01.',
    )
  })

  it('[unit] says plainly when staff recorded it on the customer behalf', () => {
    const summary = estimateResponseSummary('declined', [
      message({ id: 2, event_type: 'decline', sent_by: 'Sam Staff', created_at: '2026-10-05T10:30:00.000Z' }),
    ])
    expect(summary?.source).toBe('staff')
    expect(estimateResponseText(summary)).toBe('Declined, recorded by Sam Staff on 2026-10-05 10:30 UTC.')
  })

  it('[unit] shows only the answer behind the current state', () => {
    const answered = [
      message({ id: 2, event_type: 'accept', created_at: '2026-10-02T00:00:00.000Z', contact_id: 9, content_hash: hash }),
      message({ id: 3, event_type: 're-open', created_at: '2026-10-03T00:00:00.000Z' }),
    ]
    // Re-opened: the estimate is sent again, and yesterday's answer is history.
    expect(estimateResponseSummary('sent', answered)).toBeNull()
    // Re-opened and then declined: the decline is the one on file, not the accept.
    const later = [
      ...answered,
      message({ id: 4, event_type: 'decline', created_at: '2026-10-04T00:00:00.000Z', contact_id: 9, content_hash: hash }),
    ]
    expect(estimateResponseSummary('declined', later)?.decision).toBe('decline')
    // A state with no matching answer is not invented.
    expect(estimateResponseSummary('accepted', [message({})])).toBeNull()
    expect(estimateResponseText(null)).toBe('No response recorded.')
  })
})
