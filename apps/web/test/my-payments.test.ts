/** @vitest-environment happy-dom */

import { describe, expect, it, vi } from 'vitest'
import { EzactoApiError } from '@conflict-hq/ezacto-client'
import type { MyPayments } from '@ezacto/core'
import { createMyPaymentsController } from '../src/my-payments/browser.js'
import { myPaymentsHours, myPaymentsMoney } from '../src/my-payments/model.js'
import { renderMyPaymentsPage } from '../src/my-payments/render.js'

const recorded: MyPayments = {
  month: '2026-08',
  hours_seconds: 16_200,
  status: 'partial',
  owed: { amount_cents: 10_000, currency: 'USD' },
  paid_cents: 4_000,
  balance_cents: 6_000,
  payments: [{ amount_cents: 4_000, currency: 'USD', paid_on: '2026-09-10' }],
  upcoming: [{ amount_cents: 5_000, currency: 'USD', scheduled_on: '2026-10-19', status: 'scheduled' }],
}
const unrecorded: MyPayments = {
  month: '2026-09',
  hours_seconds: 1_800,
  status: 'pending_review',
  owed: null,
  paid_cents: 0,
  balance_cents: null,
  payments: [],
  upcoming: [],
}

const mount = (view = 'my-payments'): void => {
  document.body.innerHTML = renderMyPaymentsPage(view)
}
const text = (selector: string): string => document.querySelector<HTMLElement>(selector)?.textContent ?? ''

describe('my payments model (issue 100)', () => {
  it('[unit] reads hours and money exactly', () => {
    expect(myPaymentsHours(16_200)).toBe('4h 30m')
    expect(myPaymentsHours(0)).toBe('0h 00m')
    expect(myPaymentsMoney(10_005, 'EUR')).toBe('EUR 100.05')
    expect(myPaymentsMoney(123_456_789, 'USD')).toBe('USD 1,234,567.89')
  })
})

describe('my payments screen (issue 100)', () => {
  it('[browser] draws the recorded obligation, receipts and upcoming payments, and offers nothing to edit', async () => {
    mount()
    const getMyPayments = vi.fn<(month: string) => Promise<{ data: MyPayments }>>(async () => ({ data: recorded }))
    await createMyPaymentsController({ getMyPayments }).activate(new AbortController().signal)
    const summary = text('[data-my-payments-summary]')
    expect(summary).toContain('4h 30m')
    expect(summary).toContain('Partially paid')
    expect(summary).toContain('USD 100.00')
    expect(summary).toContain('USD 60.00')
    expect(text('[data-my-payments-receipts]')).toContain('2026-09-10')
    expect(text('[data-my-payments-upcoming]')).toContain('Scheduled')
    expect(text('[data-my-payments-upcoming]')).toContain('USD 50.00')
    expect(document.querySelector('[data-my-payments-page] form, [data-my-payments-page] textarea')).toBeNull()
    expect(document.querySelector<HTMLElement>('[data-my-payments-content]')!.hidden).toBe(false)
    expect(getMyPayments.mock.calls[0]![0]).toMatch(/^\d{4}-\d{2}$/)
  })

  it('[browser #852] sorts upcoming payments by a header, amounts by size', async () => {
    mount()
    const data: MyPayments = {
      ...recorded,
      upcoming: [
        { amount_cents: 5_000, currency: 'USD', scheduled_on: '2026-10-19', status: 'scheduled' },
        { amount_cents: 20_000, currency: 'USD', scheduled_on: '2026-11-02', status: 'scheduled' },
        { amount_cents: 900, currency: 'USD', scheduled_on: '2026-09-30', status: 'scheduled' },
      ],
    }
    await createMyPaymentsController({ getMyPayments: async () => ({ data }) }).activate(new AbortController().signal)
    const amounts = (): string[] =>
      [...document.querySelectorAll('[data-my-payments-upcoming] tbody tr[data-row] td[data-column="amount"]')].map(
        (cell) => cell.textContent ?? '',
      )
    const header = (): HTMLButtonElement =>
      document.querySelector<HTMLButtonElement>('[data-my-payments-upcoming] thead button[data-sort-column="amount"]')!
    expect(amounts()).toEqual(['USD 9.00', 'USD 50.00', 'USD 200.00'])
    // Ascending reads 9 before 50 before 200, which is size, not text.
    header().click()
    expect(amounts()).toEqual(['USD 9.00', 'USD 50.00', 'USD 200.00'])
    header().click()
    expect(amounts()).toEqual(['USD 200.00', 'USD 50.00', 'USD 9.00'])
  })

  it('[browser] shows hours and pending review, never an amount, before an obligation is recorded', async () => {
    mount()
    await createMyPaymentsController({ getMyPayments: async () => ({ data: unrecorded }) }).activate(new AbortController().signal)
    const summary = text('[data-my-payments-summary]')
    expect(summary).toContain('Pending review')
    expect(summary).toContain('Not yet recorded')
    expect(summary).not.toMatch(/USD|Paid|Balance/)
    expect(text('[data-my-payments-upcoming]')).toContain('No payments are scheduled.')
  })

  it('[browser] explains the two refusals and draws no figures', async () => {
    for (const [code, words] of [
      ['own_money_disabled', 'Your organization has not enabled this view.'],
      ['not_a_payee', 'No payments are recorded for you.'],
    ] as const) {
      mount()
      const getMyPayments = vi.fn().mockRejectedValue(new EzactoApiError(403, { error: { code } }, 'req'))
      await createMyPaymentsController({ getMyPayments }).activate(new AbortController().signal)
      expect(text('[data-my-payments-status]')).toBe(words)
      expect(document.querySelector<HTMLElement>('[data-my-payments-content]')!.hidden).toBe(true)
    }
  })

  it('[browser] clears drawn pay figures when the session ends', async () => {
    mount()
    const session = new AbortController()
    await createMyPaymentsController({ getMyPayments: async () => ({ data: recorded }) }).activate(session.signal)
    expect(text('[data-my-payments-summary]')).toContain('USD 100.00')
    session.abort()
    expect(text('[data-my-payments-summary]')).toBe('')
    expect(text('[data-my-payments-receipts]')).toBe('')
    expect(text('[data-my-payments-upcoming]')).toBe('')
    expect(document.querySelector<HTMLElement>('[data-my-payments-content]')!.hidden).toBe(true)
  })

  it('[browser] stays dormant on any other page', async () => {
    mount('team-list')
    const getMyPayments = vi.fn(async () => ({ data: recorded }))
    await createMyPaymentsController({ getMyPayments }).activate(new AbortController().signal)
    expect(getMyPayments).not.toHaveBeenCalled()
  })
})


describe('own payment request ordering', () => {
  it('clears a previous month while loading and ignores an older failure', async () => {
    mount()
    const pending = Promise.withResolvers<{ data: MyPayments }>()
    const getMyPayments = vi.fn().mockResolvedValueOnce({ data: recorded })
      .mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ data: unrecorded })
    await createMyPaymentsController({ getMyPayments }).activate(new AbortController().signal)
    const month = document.querySelector<HTMLInputElement>('[data-my-payments-month]')!
    month.value = '2026-07'
    month.dispatchEvent(new Event('change'))
    expect(text('[data-my-payments-summary]')).toBe('')
    expect(document.querySelector<HTMLElement>('[data-my-payments-content]')!.hidden).toBe(true)
    month.value = '2026-09'
    month.dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(text('[data-my-payments-summary]')).toContain('Pending review'))
    pending.reject(new EzactoApiError(503, {}, 'old'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(text('[data-my-payments-summary]')).toContain('Pending review')
    expect(text('[data-my-payments-status]')).toBe('')
  })

  it('keeps the newest refresh when earlier responses arrive last for the same month', async () => {
    mount()
    const pending = Promise.withResolvers<{ data: MyPayments }>()
    const getMyPayments = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ data: recorded })
    const first = createMyPaymentsController({ getMyPayments }).activate(new AbortController().signal)
    document.querySelector<HTMLButtonElement>('[data-my-payments-refresh]')!.click()
    await vi.waitFor(() => expect(text('[data-my-payments-summary]')).toContain('USD 100.00'))
    pending.resolve({ data: unrecorded })
    await first
    expect(text('[data-my-payments-summary]')).toContain('USD 100.00')
    expect(text('[data-my-payments-summary]')).not.toContain('Pending review')
  })
})
