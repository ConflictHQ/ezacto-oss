/** @vitest-environment happy-dom */

import type { Estimate, EstimateMessage, Whoami } from '@conflict-hq/ezacto-client'
import { describe, expect, it } from 'vitest'
import { createEstimateWorkspaceController } from '../src/estimates/browser.js'
import { renderEstimatesPage } from '../src/estimates/render.js'

/**
 * Issue 1010, slice 2: the internal estimate screen shows who answered, when,
 * and the version they answered. Only the estimates pane is mounted, not the
 * shell, which keeps this file cheap.
 */

const timestamp = '2026-10-18T14:03:00.000Z'
const hash = 'c0ffee00'.repeat(8)

const estimate = (state: Estimate['state']): Estimate =>
  ({
    id: 7,
    client_id: 3,
    number: 'EST-7',
    subject: null,
    purchase_order: null,
    currency: 'USD',
    state,
    version: 4,
    issue_date: '2026-10-01',
    amount_cents: 108_000,
    line_items: [],
  }) as unknown as Estimate

const message = (overrides: Partial<EstimateMessage>): EstimateMessage =>
  ({
    id: 1,
    estimate_id: 7,
    sent_by: 'Sam Staff',
    event_type: 'send',
    contact_id: null,
    content_hash: null,
    estimate_version: null,
    created_at: '2026-10-02T09:00:00.000Z',
    ...overrides,
  }) as unknown as EstimateMessage

const identity = {
  user_id: 1,
  profile: 'administrator',
  manager_grants: [],
  authentication: { kind: 'session' },
} as unknown as Whoami

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const open = async (
  state: Estimate['state'],
  messages: () => Promise<readonly EstimateMessage[]>,
): Promise<string> => {
  document.documentElement.dataset.appView = 'invoice-estimates'
  document.body.innerHTML = renderEstimatesPage('invoice-estimates')
  window.history.replaceState({}, '', '/invoices/estimates?estimate=7')
  const controller = createEstimateWorkspaceController({
    listEstimates: () =>
      Promise.resolve({ data: [estimate(state)], page: { next_cursor: null } }),
    getEstimate: () => Promise.resolve(estimate(state)),
    listEstimateMessages: messages,
    listEstimateClients: () => Promise.resolve({ data: [], page: { next_cursor: null } }),
  })
  await controller.activate(identity, new AbortController().signal, () => false)
  await settle()
  return document.querySelector('[data-estimate-response]')?.textContent ?? ''
}

describe('the estimate screen shows the customer response', () => {
  it('[unit] names the contact, the time and the quote version', async () => {
    const shown = await open('accepted', () =>
      Promise.resolve([
        message({}),
        message({
          id: 2,
          event_type: 'accept',
          sent_by: 'Jordan Rivera',
          contact_id: 9,
          content_hash: hash,
          estimate_version: 3,
          created_at: timestamp,
        }),
      ]),
    )
    expect(shown).toBe('Accepted by Jordan Rivera on 2026-10-18 14:03 UTC, quote version c0ffee00.')
  })

  it('[unit] says nothing was recorded for an estimate nobody has answered, without asking the API', async () => {
    let asked = false
    const shown = await open('sent', () => {
      asked = true
      return Promise.resolve([])
    })
    expect(shown).toBe('No response recorded.')
    expect(asked).toBe(false)
  })

  it('[unit] a failed lookup is a line of text, not a failed screen', async () => {
    const shown = await open('declined', () => Promise.reject(new Error('offline')))
    expect(shown).toBe('The response on file could not be loaded.')
    expect(document.querySelector<HTMLElement>('[data-estimate-detail-body]')?.hidden).toBe(false)
  })
})
