/** @vitest-environment happy-dom */
import { beforeEach, expect, it, vi } from 'vitest'
import type {
  ContractorReview,
  ContractorCurrencyReview,
  StaffPaymentReport,
  ContractorAcceptance,
} from '@ezacto/core'
import { renderStaffPayments } from '../src/staff-payments/render.js'
import {
  createContractorReviewController,
  type ContractorReviewApi,
} from '../src/staff-payments/reconciliation-browser.js'
import { createStaffPaymentsController } from '../src/staff-payments/browser.js'
const currency = (code = 'USD'): ContractorCurrencyReview => ({
  currency: code,
  recorded_earnings_cents: 10000,
  proposed_earnings_cents: 10000,
  paid_cents: 4000,
  reserved_cents: 1000,
  available_to_pay_cents: 5000,
  available_credit_cents: 2000,
  proposed_credit_cents: 2000,
  remaining_after_credit_cents: 3000,
  invoices: [],
  advances: [],
  allocations: [],
  allocation_proposals: [],
  credit_proposals: [
    { advance_item_id: 'advance', amount_cents: 2000, scope: 'month' },
  ],
  items: [
    {
      id: 'item',
      run_id: 'run',
      run_name: 'September',
      purpose: 'earnings',
      amount_cents: 1000,
      state: 'failed',
      phase: 'failed',
      failure: 'Destination unavailable',
      attempts: 1,
    },
  ],
  proposal_blocked: false,
  flags: ['earnings_override'],
})
const review = (): ContractorReview => ({
  month: '2026-09',
  completed: true,
  version: 'fixture',
  credit_period: { from: '2026-09-01', to: '2026-10-01' },
  people: [
    {
      user_id: 2,
      name: 'Contractor <safe>',
      active: true,
      ledger_version: 1,
      settled_through: null,
      ledger_events: [],
      phase: 'failed',
      latest_review: {
        id: 'review',
        user_id: 2,
        currency: 'USD',
        amount_cents: 10000,
        expected_version: 0,
        actor_id: 1,
        note: 'Reviewed selected work',
        recorded_at: '2026-10-01',
      },
      earnings: null,
      entries: [
        {
          entry_id: 1,
          project_id: 1,
          project_name: 'Project',
          spent_date: '2026-09-01',
          rounded_seconds: 3600,
          selected_seconds: 1800,
          cost_rate_cents: 10000,
        },
      ],
      currencies: [
        currency(),
        {
          ...currency('EUR'),
          available_to_pay_cents: null,
          remaining_after_credit_cents: null,
          proposed_credit_cents: 0,
          proposal_blocked: true,
          flags: [
            'currency_mismatch',
            'advance_requires_target_review',
            'missing_rate',
          ],
        },
      ],
    },
  ],
})
const ledger = (month = '2026-09'): StaffPaymentReport => ({
  month,
  as_of: '2026-10-01',
  rows: [],
  provider_settings: { default_provider: 'wise', version: 0, events: [] },
})
const load = () =>
  document
    .querySelector<HTMLButtonElement>('[data-contractor-review-load]')!
    .click()
const content = () =>
  document.querySelector<HTMLElement>('[data-contractor-review-content]')!
beforeEach(() => {
  document.body.innerHTML = renderStaffPayments('staff-payments')
  localStorage.clear()
})
const mount = (
  get = vi.fn(async () => review()),
  extra: ContractorReviewApi = {},
) => {
  const navigate = vi.fn(),
    active = new AbortController()
  const controller = createContractorReviewController(
    document.body,
    { getContractorReview: get, ...extra },
    (e) => (e as Error).message,
    navigate,
  )
  controller.activate(active.signal)
  controller.ledger(ledger(), active.signal)
  return { controller, active, get, navigate }
}
it('distinguishes balances, currencies, unrecorded credit and evidence without writes', async () => {
  const { get, navigate } = mount()
  load()
  await vi.waitFor(() => expect(content().textContent).toContain('projection'))
  expect(get).toHaveBeenCalledWith('2026-09', expect.any(AbortSignal))
  const rows = content().querySelectorAll('tbody tr')
  expect(rows).toHaveLength(2)
  expect(rows[0]!.textContent).toContain('USD 50.00')
  expect(rows[0]!.textContent).toContain('USD 30.00')
  expect(rows[1]!.textContent).toContain('Needs review')
  for (const text of [
    'Reviewed selected work',
    'Destination unavailable',
    'choose its target explicitly',
    'Some hours have no cost rate',
  ])
    expect(content().textContent).toContain(text)
  expect(content().querySelector('safe')).toBeNull()
  expect(content().textContent).not.toContain('[object')
  expect(content().querySelectorAll('.money').length).toBeGreaterThan(10)
  ;[...content().querySelectorAll('button')]
    .find((button) => button.textContent === 'Review advance credit')!
    .click()
  expect(navigate).toHaveBeenCalledWith('advances')
})
it('discards delayed responses after month changes and clears private data on abort', async () => {
  let resolve!: (value: ContractorReview) => void
  const { controller, active } = mount(
    vi.fn(
      () =>
        new Promise<ContractorReview>((r) => {
          resolve = r
        }),
    ),
  )
  load()
  controller.ledger(ledger('2026-08'), active.signal)
  resolve(review())
  await Promise.resolve()
  await Promise.resolve()
  expect(content().textContent).toBe('')
  active.abort()
  expect(
    document.querySelector<HTMLButtonElement>('[data-contractor-review-load]')!
      .disabled,
  ).toBe(true)
})
it('clears prior figures before refresh and displays errors without stale evidence', async () => {
  const get = vi.fn(async () => review()),
    { active } = mount(get)
  load()
  await vi.waitFor(() => expect(content().textContent).toContain('projection'))
  get.mockRejectedValueOnce(new Error('Source changed; reload'))
  load()
  expect(content().textContent).toBe('')
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain('Source changed; reload'),
  )
  active.abort()
  expect(
    document.querySelector('[data-contractor-review-status]')!.textContent,
  ).toBe('')
})
it('rejects a response for another month', async () => {
  mount(vi.fn(async () => ({ ...review(), month: '2026-08' })))
  load()
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain('The review month changed'),
  )
  expect(content().textContent).toBe('')
})
it('wires the payment controller month and explicit load to the API', async () => {
  const get = vi.fn(async () => review()),
    abort = new AbortController()
  const controller = createStaffPaymentsController({
    getContractorReview: get,
    getStaffPaymentReport: vi.fn(async () => ledger()),
    recordStaffPaymentEvent: vi.fn(),
  })
  await controller.activate({ profile: 'administrator' }, abort.signal)
  load()
  await vi.waitFor(() =>
    expect(get).toHaveBeenCalledWith('2026-09', abort.signal),
  )
  abort.abort()
  expect(content().textContent).toBe('')
})

it('retries an uncertain confirmation with the same immutable intent and reloads durable history', async () => {
  let committed = false
  const record: ContractorAcceptance = {
    id: 'record',
    user_id: 2,
    month: '2026-09',
    currency: 'USD',
    review_version: 'a'.repeat(64),
    reason: 'Reviewed deposits',
    actor_id: 1,
    recorded_at: '2026-10-01',
    allocation_ids: [],
    credit_application_ids: ['credit'],
    state: 'completed',
  }
  const get = vi.fn(async () => {
    const data = review(),
      person = data.people[0]!
    person.source_revision = '[1,2,3]'
    person.review_version = 'a'.repeat(64)
    if (committed) {
      person.currencies[0]!.credit_proposals = []
      person.currencies[0]!.proposed_credit_cents = 0
    }
    return data
  })
  const accept = vi.fn(async () => {
    committed = true
    return record
  })
  accept.mockImplementationOnce(async () => {
    committed = true
    throw new Error('Response lost')
  })
  mount(get, {
    acceptContractorReview: accept,
    getContractorAcceptances: vi.fn(async () => (committed ? [record] : [])),
  })
  load()
  await vi.waitFor(() => expect(content().querySelector('form')).not.toBeNull())
  const form = content().querySelector('form')!,
    reason = form.querySelector('textarea')!
  reason.value = 'Reviewed deposits'
  form.dispatchEvent(new SubmitEvent('submit', { cancelable: true }))
  await vi.waitFor(() =>
    expect(form.querySelector('button')!.textContent).toBe(
      'Retry same confirmation',
    ),
  )
  expect(reason.disabled).toBe(true)
  const first = accept.mock.calls[0]!
  form.dispatchEvent(new SubmitEvent('submit', { cancelable: true }))
  await vi.waitFor(() => expect(accept).toHaveBeenCalledTimes(2))
  expect(accept.mock.calls[1]).toEqual(first)
  await vi.waitFor(() =>
    expect(content().textContent).toContain(
      'Completed reconciliation confirmations',
    ),
  )
  expect(content().querySelector('form')).toBeNull()
  expect(content().textContent).toContain('Reviewed deposits')
})
it('withholds confirmation when the source token is absent or the proposal is blocked', async () => {
  mount(undefined, { acceptContractorReview: vi.fn() })
  load()
  await vi.waitFor(() => expect(content().textContent).toContain('projection'))
  expect(content().querySelector('form')).toBeNull()
})

it('keeps the selected review tab when provider discovery finishes after navigation', async () => {
  let finishDiscovery!: () => void
  const discovery = new Promise<void>((resolve) => { finishDiscovery = resolve })
  const active = new AbortController()
  const controller = createStaffPaymentsController({
    getStaffPaymentReport: vi.fn(async () => ledger()),
    recordStaffPaymentEvent: vi.fn(),
    getContractorReview: vi.fn(async () => review()),
    previewPaymentRun: vi.fn(),
    getDeelStaging: vi.fn(async () => {
      await discovery
      return { data: { configured: false, reason: null, start_date: null, last_complete_date: null } }
    }),
    previewDeelStaging: vi.fn(),
    stageDeelHours: vi.fn(),
    getDeelStageStatus: vi.fn(),
  })
  const activation = controller.activate({ profile: 'administrator' }, active.signal)
  await vi.waitFor(() => expect(document.querySelector<HTMLElement>('[data-staff-payment-content]')!.hidden).toBe(false))
  expect(document.querySelector<HTMLElement>('[data-payment-runs]')!.hidden).toBe(true)
  const tab = document.querySelector<HTMLButtonElement>('[data-payment-tab="reconcile"]')!
  tab.click()
  expect(tab.getAttribute('aria-selected')).toBe('true')
  finishDiscovery()
  await activation
  expect(tab.getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector<HTMLElement>('[data-payment-panel="reconcile"]')!.hidden).toBe(false)
  expect(document.querySelector<HTMLButtonElement>('[data-contractor-review-load]')!.disabled).toBe(false)
  expect(document.querySelector<HTMLElement>('[data-payment-runs]')!.hidden).toBe(true)
  active.abort()
})
