import { describe, expect, it } from 'vitest'
import {
  estimateIdFromSearch,
  portalConfirmText,
  portalExpiryText,
  portalFailure,
  portalFailureMessage,
  portalRate,
  portalStatusLine,
  portalTotalRows,
  tokenFromFragment,
  type PortalEstimate,
} from '../src/portal-estimates/model.js'

/** Issue 1010, slice 3: what the customer page says and how it reads its own URL. */

const estimate = (overrides: Partial<PortalEstimate> = {}): PortalEstimate => ({
  id: 7,
  number: 'EST-7',
  subject: null,
  currency: 'EUR',
  state: 'sent',
  issue_date: '2026-10-01',
  amount_cents: 108_000,
  sent_at: null,
  accepted_at: null,
  declined_at: null,
  purchase_order: null,
  notes: null,
  tax_rate_ppm: 80_000,
  tax2_rate_ppm: null,
  discount_rate_ppm: 100_000,
  tax_amount_cents: 8_000,
  tax2_amount_cents: 0,
  discount_amount_cents: 10_000,
  line_items: [],
  version: 'a'.repeat(64),
  expires_on: null,
  expired: false,
  answerable: true,
  response: null,
  ...overrides,
})

describe('the sign-in link', () => {
  it('[unit] reads the token from the fragment only', () => {
    expect(tokenFromFragment('#token=abc.def')).toBe('abc.def')
    expect(tokenFromFragment('token=abc')).toBe('abc')
    expect(tokenFromFragment('')).toBeNull()
    expect(tokenFromFragment('#token=')).toBeNull()
    expect(tokenFromFragment('#other=1')).toBeNull()
  })

  it('[unit] takes an estimate id only when it is a plain positive integer', () => {
    expect(estimateIdFromSearch('?estimate=12')).toBe(12)
    for (const bad of ['', '?estimate=0', '?estimate=-1', '?estimate=1.5', '?estimate=abc', '?estimate=1e3']) {
      expect(estimateIdFromSearch(bad), bad).toBeNull()
    }
  })
})

describe('the quote as the customer reads it', () => {
  it('[money] lists discount, taxes and total as stored, and omits what the quote lacks', () => {
    expect(portalTotalRows(estimate())).toEqual([
      { label: 'Discount (10%)', cents: -10_000, strong: false },
      { label: 'Tax (8%)', cents: 8_000, strong: false },
      { label: 'Total', cents: 108_000, strong: true },
    ])
    expect(
      portalTotalRows(
        estimate({ discount_rate_ppm: null, discount_amount_cents: 0, tax_rate_ppm: null, tax_amount_cents: 0 }),
      ),
    ).toEqual([{ label: 'Total', cents: 108_000, strong: true }])
  })

  it('[unit] prints rates as a person reads them', () => {
    expect(portalRate(82_500)).toBe('8.25%')
    expect(portalRate(100_000)).toBe('10%')
    expect(portalRate(null)).toBeNull()
  })

  it('[unit] states what an answer does and does not do', () => {
    expect(portalConfirmText(estimate(), 'accept')).toBe(
      'Accept estimate EST-7 for €1,080.00? This records your answer. Nothing is charged and no invoice is raised.',
    )
    expect(portalStatusLine(estimate())).toContain('nothing is charged and no invoice is raised')
  })

  it('[unit] keeps answered, revising and edited-since apart', () => {
    expect(portalStatusLine(estimate({ answerable: false }))).toContain('being revised')
    const answered = estimate({
      state: 'accepted',
      answerable: false,
      response: {
        decision: 'accept',
        at: '2026-10-18T14:03:00.000Z',
        by: 'Jordan Rivera',
        version: 'a'.repeat(64),
        current: true,
      },
    })
    expect(portalStatusLine(answered)).toBe(
      'Jordan Rivera accepted this estimate on 2026-10-18 14:03 UTC.',
    )
    expect(
      portalStatusLine({ ...answered, response: { ...answered.response!, current: false } }),
    ).toContain('edited since')
    // Staff recorded it on the customer's behalf: no named contact.
    expect(
      portalStatusLine({ ...answered, response: { ...answered.response!, by: null, version: null } }),
    ).toContain('Your organization accepted')
  })
})

describe('expiry', () => {
  it('[unit] says when an unanswered estimate stops being answerable, and that it already has', () => {
    expect(portalExpiryText(estimate())).toBeNull()
    expect(portalExpiryText(estimate({ expires_on: '2026-10-20' }))).toBe(
      '2026-10-20 (open until the end of that day)',
    )
    expect(portalExpiryText(estimate({ expires_on: '2026-10-20', expired: true }))).toBe(
      '2026-10-20 (expired)',
    )
  })

  it('[unit] keeps an expired estimate apart from one being revised', () => {
    const expired = estimate({ expires_on: '2026-10-20', expired: true, answerable: false })
    expect(portalStatusLine(expired)).toContain('expired on 2026-10-20')
    expect(portalStatusLine(expired)).toContain('Ask the sender for a new one')
    expect(portalStatusLine(expired)).not.toContain('being revised')
    expect(portalFailure(410, 'estimate_expired').kind).toBe('expired')
    expect(portalFailureMessage({ kind: 'expired' })).toContain('not recorded')
    // Only the specific refusal: a bare 410 is not taken for an expiry.
    expect(portalFailure(410, null).kind).toBe('failed')
  })
})

describe('refusals', () => {
  it('[unit] maps each server refusal to its own next step', () => {
    expect(portalFailure(401, 'authentication_required').kind).toBe('signed-out')
    expect(portalFailure(404, 'not_found').kind).toBe('not-found')
    expect(portalFailure(409, 'estimate_content_changed').kind).toBe('changed')
    expect(portalFailure(409, 'estimate_needs_resend').kind).toBe('revising')
    expect(portalFailure(409, 'estimate_state_conflict').kind).toBe('answered')
    expect(portalFailure(503, 'service_unavailable').kind).toBe('unavailable')
    expect(portalFailure(500, null).kind).toBe('failed')
    for (const kind of ['signed-out', 'changed', 'revising', 'answered'] as const) {
      expect(portalFailureMessage({ kind })).not.toBe('')
    }
    expect(portalFailureMessage(portalFailure(409, 'estimate_content_changed'))).toContain(
      'not recorded',
    )
  })
})
