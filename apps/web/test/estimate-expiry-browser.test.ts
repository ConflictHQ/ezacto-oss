/** @vitest-environment happy-dom */

import { EzactoApiError, type Estimate, type Whoami } from '@conflict-hq/ezacto-client'
import { describe, expect, it, vi } from 'vitest'
import { createEstimateWorkspaceController } from '../src/estimates/browser.js'
import {
  estimateExpiryEditable,
  estimateExpiryMessage,
  estimateExpiryText,
  type EstimateWorkspaceApi,
} from '../src/estimates/model.js'
import { renderEstimatesPage } from '../src/estimates/render.js'

/**
 * Issue 1010, expiry: staff see when an estimate stops being answerable and
 * where that day came from, and can set, move or clear it. Only the estimates
 * pane is mounted, not the shell, which keeps this file cheap.
 */

const estimate = (overrides: Partial<Estimate> = {}): Estimate =>
  ({
    id: 7,
    client_id: 3,
    number: 'EST-7',
    subject: null,
    purchase_order: null,
    currency: 'USD',
    state: 'sent',
    version: 4,
    issue_date: '2026-10-01',
    amount_cents: 108_000,
    expires_on: null,
    effective_expires_on: null,
    line_items: [],
    ...overrides,
  }) as unknown as Estimate

const identity = (profile: string): Whoami =>
  ({
    user_id: 1,
    profile,
    manager_grants: [],
    authentication: { kind: 'session' },
  }) as unknown as Whoami

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const q = <E extends Element>(selector: string): E => {
  const found = document.querySelector<E>(selector)
  if (found === null) throw new Error(`missing ${selector}`)
  return found
}

const open = async (
  shown: Estimate,
  setEstimateExpiry?: EstimateWorkspaceApi['setEstimateExpiry'],
  profile = 'administrator',
): Promise<void> => {
  document.documentElement.dataset.appView = 'invoice-estimates'
  document.body.innerHTML = renderEstimatesPage('invoice-estimates')
  window.history.replaceState({}, '', '/invoices/estimates?estimate=7')
  const controller = createEstimateWorkspaceController({
    listEstimates: () => Promise.resolve({ data: [shown], page: { next_cursor: null } }),
    getEstimate: () => Promise.resolve(shown),
    listEstimateMessages: () => Promise.resolve([]),
    listEstimateClients: () => Promise.resolve({ data: [], page: { next_cursor: null } }),
    ...(setEstimateExpiry === undefined ? {} : { setEstimateExpiry }),
  })
  await controller.activate(identity(profile), new AbortController().signal, () => false)
  await settle()
}

describe('what staff are told about an estimate expiry', () => {
  it('[unit] says where the day came from, and that none is set', () => {
    expect(estimateExpiryText(estimate({ state: 'draft' }))).toContain('No expiry set')
    expect(estimateExpiryText(estimate())).toContain('No expiry')
    expect(
      estimateExpiryText(estimate({ expires_on: '2026-10-20', effective_expires_on: '2026-10-20' })),
    ).toBe('Open until the end of 2026-10-20, as set on this estimate.')
    expect(estimateExpiryText(estimate({ effective_expires_on: '2026-10-08' }))).toBe(
      "Open until the end of 2026-10-08, from the organization's default validity after it was sent.",
    )
  })

  it('[unit] offers the form only while the estimate can still expire', () => {
    expect(estimateExpiryEditable(estimate({ state: 'draft' }))).toBe(true)
    expect(estimateExpiryEditable(estimate({ state: 'sent' }))).toBe(true)
    expect(estimateExpiryEditable(estimate({ state: 'accepted' }))).toBe(false)
    expect(estimateExpiryEditable(estimate({ state: 'declined' }))).toBe(false)
  })

  it('[unit] keeps a stale version, an answered estimate and anything else apart', () => {
    const refusal = (code: string) => ({ body: { error: { code, message: 'server words' } } })
    expect(estimateExpiryMessage(refusal('estimate_version_conflict'))).toContain('Reload it')
    expect(estimateExpiryMessage(refusal('estimate_state_conflict'))).toContain('answered')
    expect(estimateExpiryMessage(refusal('other'))).toBe('server words')
    expect(estimateExpiryMessage(new Error('offline'))).toBe('offline')
  })
})

describe('the estimate screen sets the expiry', () => {
  it('does not repaint a different screen when a delayed expiry save finishes', async () => {
    let finish!: (value: Estimate) => void
    const setEstimateExpiry = vi.fn(() => new Promise<Estimate>(resolve => { finish = resolve }))
    await open(estimate(), setEstimateExpiry)
    q<HTMLInputElement>('[data-estimate-expiry-date]').value = '2026-10-20'
    q<HTMLFormElement>('[data-estimate-expiry-form]').requestSubmit()
    expect(q('[data-estimate-expiry-result]').getAttribute('aria-busy')).toBe('true')
    q<HTMLFormElement>('[data-estimate-expiry-form]').dispatchEvent(new SubmitEvent('submit', { cancelable: true }))
    expect(setEstimateExpiry).toHaveBeenCalledTimes(1)
    q<HTMLAnchorElement>('[data-estimate-back]').click()
    finish(estimate({ expires_on: '2026-10-20' }))
    await settle()
    expect(q('[data-estimate-expiry-result]').textContent).not.toBe('Expiry saved.')
    expect(q('[data-estimate-expiry-result]').getAttribute('aria-busy')).toBe('false')
  })

  it('[unit] shows the expiry and saves a new day against the version it read', async () => {
    const saved = estimate({
      version: 5,
      expires_on: '2026-10-20',
      effective_expires_on: '2026-10-20',
    })
    const setEstimateExpiry = vi.fn(() => Promise.resolve(saved))
    await open(estimate(), setEstimateExpiry)
    expect(q('[data-estimate-expiry]').textContent).toContain('No expiry')
    const form = q<HTMLFormElement>('[data-estimate-expiry-form]')
    expect(form.hidden).toBe(false)
    expect(q<HTMLElement>('[data-estimate-expiry-clear]').hidden).toBe(true)

    q<HTMLInputElement>('[data-estimate-expiry-date]').value = '2026-10-20'
    form.requestSubmit()
    await settle()
    expect(setEstimateExpiry).toHaveBeenCalledWith(
      7,
      { expected_version: 4, expires_on: '2026-10-20' },
      expect.any(AbortSignal),
    )
    expect(q('[data-estimate-expiry]').textContent).toBe(
      'Open until the end of 2026-10-20, as set on this estimate.',
    )
    expect(q('[data-estimate-expiry-result]').textContent).toBe('Expiry saved.')
    expect(q<HTMLInputElement>('[data-estimate-expiry-date]').value).toBe('2026-10-20')
    expect(q<HTMLElement>('[data-estimate-expiry-clear]').hidden).toBe(false)
  })

  it('[unit] clears a set expiry to fall back to the default', async () => {
    const cleared = estimate({ version: 6, effective_expires_on: '2026-10-08' })
    const setEstimateExpiry = vi.fn(() => Promise.resolve(cleared))
    await open(
      estimate({ expires_on: '2026-10-20', effective_expires_on: '2026-10-20' }),
      setEstimateExpiry,
    )
    q<HTMLButtonElement>('[data-estimate-expiry-clear]').click()
    await settle()
    expect(setEstimateExpiry).toHaveBeenCalledWith(
      7,
      { expected_version: 4, expires_on: null },
      expect.any(AbortSignal),
    )
    expect(q('[data-estimate-expiry-result]').textContent).toBe('Expiry cleared.')
    expect(q('[data-estimate-expiry]').textContent).toContain("organization's default")
    expect(q<HTMLInputElement>('[data-estimate-expiry-date]').value).toBe('')
  })

  it('[unit] asks for a day rather than saving a blank one', async () => {
    const setEstimateExpiry = vi.fn(() => Promise.resolve(estimate()))
    await open(estimate(), setEstimateExpiry)
    q<HTMLFormElement>('[data-estimate-expiry-form]').requestSubmit()
    await settle()
    expect(setEstimateExpiry).not.toHaveBeenCalled()
    expect(q('[data-estimate-expiry-result]').textContent).toBe('Choose a day, or use the default.')
  })

  it('[unit] says so when the estimate changed since it was loaded', async () => {
    const setEstimateExpiry = vi.fn(() =>
      Promise.reject(
        new EzactoApiError(
          409,
          { error: { code: 'estimate_version_conflict', message: 'x' } } as never,
          'conflict',
        ),
      ),
    )
    await open(estimate(), setEstimateExpiry)
    q<HTMLInputElement>('[data-estimate-expiry-date]').value = '2026-10-20'
    q<HTMLFormElement>('[data-estimate-expiry-form]').requestSubmit()
    await settle()
    expect(q('[data-estimate-expiry-result]').textContent).toContain('Reload it')
    expect(q<HTMLButtonElement>('[data-estimate-expiry-save]').disabled).toBe(false)
  })

  it('[unit] shows the expiry but offers no form to someone who cannot write, to an answered estimate or without the call', async () => {
    const setEstimateExpiry = vi.fn(() => Promise.resolve(estimate()))
    const shown = estimate({ expires_on: '2026-10-20', effective_expires_on: '2026-10-20' })
    await open(shown, setEstimateExpiry, 'member')
    expect(q('[data-estimate-expiry]').textContent).toContain('2026-10-20')
    expect(q<HTMLElement>('[data-estimate-expiry-form]').hidden).toBe(true)

    await open({ ...shown, state: 'accepted' }, setEstimateExpiry)
    expect(q('[data-estimate-expiry]').textContent).toContain('2026-10-20')
    expect(q<HTMLElement>('[data-estimate-expiry-form]').hidden).toBe(true)

    await open(shown)
    expect(q<HTMLElement>('[data-estimate-expiry-form]').hidden).toBe(true)
  })
})
