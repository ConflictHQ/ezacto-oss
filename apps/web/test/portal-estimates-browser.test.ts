/** @vitest-environment happy-dom */

import { describe, expect, it, vi } from 'vitest'
import { mountPortalEstimates } from '../src/portal-estimates/browser.js'
import type { PortalEstimate, PortalEstimateSummary } from '../src/portal-estimates/model.js'
import { renderPortalEstimatesPage } from '../src/portal-estimates/render.js'

/**
 * Issue 1010, slice 3: the page a contact answers an estimate on. The routes it
 * calls are the portal routes `packages/api` serves; here they are a scripted
 * fetch, so what is pinned is what the page asks and what it does with the
 * answer.
 */

const versionOne = 'a'.repeat(64)
const versionTwo = 'b'.repeat(64)

const summary: PortalEstimateSummary = {
  id: 7,
  number: 'EST-7',
  subject: 'Site rebuild',
  currency: 'USD',
  state: 'sent',
  issue_date: '2026-10-01',
  amount_cents: 108_000,
  sent_at: '2026-10-02T09:00:00.000Z',
  accepted_at: null,
  declined_at: null,
}

const estimate = (overrides: Partial<PortalEstimate> = {}): PortalEstimate => ({
  ...summary,
  purchase_order: 'PO-9',
  notes: 'Valid for the scope listed.',
  tax_rate_ppm: 80_000,
  tax2_rate_ppm: null,
  discount_rate_ppm: null,
  tax_amount_cents: 8_000,
  tax2_amount_cents: 0,
  discount_amount_cents: 0,
  line_items: [
    {
      position: 1,
      kind: 'Service',
      description: 'Design',
      quantity: 10,
      unit_price_cents: 10_000,
      amount_cents: 100_000,
      taxed: true,
      taxed2: false,
    },
  ],
  version: versionOne,
  expires_on: null,
  expired: false,
  answerable: true,
  response: null,
  ...overrides,
})

interface Call {
  readonly path: string
  readonly method: string
  readonly body: unknown
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const refusal = (status: number, code: string): Response =>
  json(status, { error: { code, message: code } })

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const events: string[] = []

const mount = async (
  routes: (call: Call) => Response | Promise<Response>,
  options: { search?: string; hash?: string } = {},
) => {
  // The body only: the head's stylesheet and script are the server's to load.
  document.body.innerHTML =
    /<body>([\s\S]*)<\/body>/u.exec(renderPortalEstimatesPage({ brand: 'Acme Time' }))?.[1] ?? ''
  const calls: Call[] = []
  const location = {
    hash: options.hash ?? '',
    search: options.search ?? '',
    pathname: '/portal/estimate-review',
  }
  events.length = 0
  const replaceState = vi.fn(() => {
    events.push('replaceState')
  })
  const pushState = vi.fn((_state: unknown, _title: string, url?: string | URL | null) => {
    if (typeof url === 'string') location.search = url.startsWith('?') ? url : ''
  })
  await mountPortalEstimates({
    fetch: (input, init) => {
      const call: Call = {
        path: input,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      }
      calls.push(call)
      events.push(input)
      return Promise.resolve(routes(call))
    },
    location,
    history: { replaceState, pushState },
  })
  await settle()
  return { calls, location, replaceState, pushState }
}

const q = <E extends Element>(selector: string): E => {
  const found = document.querySelector<E>(selector)
  if (found === null) throw new Error(`missing ${selector}`)
  return found
}

const text = (selector: string): string => q(selector).textContent ?? ''

describe('the customer estimate page', () => {
  it('[unit] spends the sign-in token from the fragment and removes it from the address bar first', async () => {
    const order: string[] = []
    const harness = await mount(
      (call) => {
        order.push(call.path)
        if (call.path.startsWith('/portal/verify')) {
          return json(200, { data: { status: 'authenticated', contact_id: 1, client_id: 2 } })
        }
        return json(200, { data: { estimates: [summary] } })
      },
      { hash: '#token=abc.def' },
    )
    expect(harness.replaceState).toHaveBeenCalledWith(null, '', '/portal/estimate-review')
    // Out of the address bar before the first request goes anywhere.
    expect(events[0]).toBe('replaceState')
    expect(order).toEqual(['/portal/verify', '/portal/estimates'])
    expect(harness.calls[0]).toMatchObject({method:'POST',body:{token:'abc.def'}})
    expect(harness.calls.every(call=>!call.path.includes('abc.def'))).toBe(true)
    expect(text('[data-portal-list]')).toContain('EST-7')
    expect(text('[data-portal-status]')).toBe('1 to review.')
  })

  it('[unit] says a spent or expired link is spent, and draws nothing', async () => {
    await mount(() => refusal(401, 'invalid_magic_link'), { hash: '#token=old' })
    expect(text('[data-portal-status]')).toContain('expired or was already used')
    expect(q<HTMLElement>('[data-portal-list-view]').hidden).toBe(true)
    expect(q<HTMLElement>('[data-portal-detail-view]').hidden).toBe(true)
  })

  it('[unit] shows the quote: lines, currency, tax and total', async () => {
    await mount(() => json(200, { data: estimate() }), { search: '?estimate=7' })
    expect(text('[data-portal-heading]')).toBe('Estimate EST-7')
    expect(text('[data-portal-facts]')).toContain('Site rebuild')
    expect(text('[data-portal-facts]')).toContain('PO-9')
    expect(text('[data-portal-lines]')).toContain('Design')
    expect(text('[data-portal-lines]')).toContain('$1,000.00')
    expect(text('[data-portal-totals]')).toContain('Tax (8%)')
    expect(text('[data-portal-totals]')).toContain('$80.00')
    expect(text('[data-portal-totals]')).toContain('$1,080.00')
    expect(text('[data-portal-notes]')).toBe('Valid for the scope listed.')
    expect(q<HTMLElement>('[data-portal-actions]').hidden).toBe(false)
  })

  it('[unit] needs an explicit confirm, and records one answer for a double click', async () => {
    let answered = false
    const harness = await mount(
      (call) => {
        if (call.method === 'POST') {
          answered = true
          return json(200, {
            data: estimate({
              state: 'accepted',
              answerable: false,
              response: {
                decision: 'accept',
                at: '2026-10-18T14:03:00.000Z',
                by: 'Jordan Rivera',
                version: versionOne,
                current: true,
              },
            }),
            replayed: false,
          })
        }
        return json(200, { data: estimate() })
      },
      { search: '?estimate=7' },
    )
    q<HTMLButtonElement>('[data-portal-accept]').click()
    expect(harness.calls.filter((call) => call.method === 'POST')).toHaveLength(0)
    expect(q<HTMLElement>('[data-portal-confirm]').hidden).toBe(false)
    expect(text('[data-portal-confirm-text]')).toContain('Nothing is charged and no invoice is raised')

    const yes = q<HTMLButtonElement>('[data-portal-confirm-yes]')
    yes.click()
    yes.click()
    await settle()
    const posts = harness.calls.filter((call) => call.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(posts[0]).toEqual({
      path: '/portal/estimates/7/response',
      method: 'POST',
      body: { decision: 'accept', version: versionOne },
    })
    expect(answered).toBe(true)
    expect(text('[data-portal-status]')).toBe('Your acceptance was recorded.')
    expect(text('[data-portal-answer-line]')).toContain('Jordan Rivera accepted this estimate')
    expect(q<HTMLElement>('[data-portal-actions]').hidden).toBe(true)
  })

  it('[unit] cancelling the confirm records nothing', async () => {
    const harness = await mount(() => json(200, { data: estimate() }), { search: '?estimate=7' })
    q<HTMLButtonElement>('[data-portal-decline]').click()
    q<HTMLButtonElement>('[data-portal-confirm-no]').click()
    expect(q<HTMLElement>('[data-portal-confirm]').hidden).toBe(true)
    expect(harness.calls.filter((call) => call.method === 'POST')).toHaveLength(0)
  })

  it('[unit] a quote edited under an open tab refuses the old answer and shows the new version', async () => {
    let reads = 0
    const harness = await mount(
      (call) => {
        if (call.method === 'POST') return refusal(409, 'estimate_content_changed')
        reads += 1
        return json(200, {
          data: reads === 1 ? estimate() : estimate({ version: versionTwo, amount_cents: 120_000 }),
        })
      },
      { search: '?estimate=7' },
    )
    q<HTMLButtonElement>('[data-portal-accept]').click()
    q<HTMLButtonElement>('[data-portal-confirm-yes]').click()
    await settle()
    expect(text('[data-portal-status]')).toContain('This quote changed after you opened it')
    expect(text('[data-portal-status]')).toContain('your answer was not recorded')
    expect(text('[data-portal-totals]')).toContain('$1,200.00')
    // The next answer quotes the version now on screen, never the old one.
    q<HTMLButtonElement>('[data-portal-decline]').click()
    harness.calls.length = 0
    q<HTMLButtonElement>('[data-portal-confirm-yes]').click()
    await settle()
    expect(harness.calls[0]?.body).toEqual({ decision: 'decline', version: versionTwo })
  })

  it('[unit] offers no answer while the estimate is being revised', async () => {
    await mount(() => json(200, { data: estimate({ answerable: false }) }), {
      search: '?estimate=7',
    })
    expect(q<HTMLElement>('[data-portal-actions]').hidden).toBe(true)
    expect(text('[data-portal-answer-line]')).toContain('being revised')
  })

  it('[unit] shows when the estimate expires while it can still be answered', async () => {
    await mount(() => json(200, { data: estimate({ expires_on: '2026-10-20' }) }), {
      search: '?estimate=7',
    })
    expect(text('[data-portal-facts]')).toContain('Expires')
    expect(text('[data-portal-facts]')).toContain('2026-10-20 (open until the end of that day)')
    expect(q<HTMLElement>('[data-portal-actions]').hidden).toBe(false)
  })

  it('[unit] offers no answer once expired and says who to ask', async () => {
    await mount(
      () =>
        json(200, {
          data: estimate({ expires_on: '2026-10-20', expired: true, answerable: false }),
        }),
      { search: '?estimate=7' },
    )
    expect(q<HTMLElement>('[data-portal-actions]').hidden).toBe(true)
    expect(text('[data-portal-facts]')).toContain('2026-10-20 (expired)')
    expect(text('[data-portal-answer-line]')).toContain('expired on 2026-10-20')
    expect(text('[data-portal-answer-line]')).toContain('Ask the sender for a new one')
  })

  it('[unit] an answer refused as expired is not recorded, and the page shows the expiry', async () => {
    let reads = 0
    const harness = await mount(
      (call) => {
        if (call.method === 'POST') return refusal(410, 'estimate_expired')
        reads += 1
        return json(200, {
          data:
            reads === 1
              ? estimate({ expires_on: '2026-10-20' })
              : estimate({ expires_on: '2026-10-20', expired: true, answerable: false }),
        })
      },
      { search: '?estimate=7' },
    )
    q<HTMLButtonElement>('[data-portal-accept]').click()
    q<HTMLButtonElement>('[data-portal-confirm-yes]').click()
    await settle()
    expect(harness.calls.filter((call) => call.method === 'POST')).toHaveLength(1)
    expect(text('[data-portal-status]')).toContain('has expired')
    expect(text('[data-portal-status]')).toContain('not recorded')
    expect(q<HTMLElement>('[data-portal-actions]').hidden).toBe(true)
  })

  it('[unit] clears what it drew when the session ends mid-visit', async () => {
    await mount(
      (call) =>
        call.method === 'POST' ? refusal(401, 'authentication_required') : json(200, { data: estimate() }),
      { search: '?estimate=7' },
    )
    q<HTMLButtonElement>('[data-portal-accept]').click()
    q<HTMLButtonElement>('[data-portal-confirm-yes]').click()
    await settle()
    expect(text('[data-portal-status]')).toContain('expired or was already used')
    expect(q<HTMLElement>('[data-portal-detail-view]').hidden).toBe(true)
    expect(text('[data-portal-lines]')).toBe('')
    expect(text('[data-portal-facts]')).toBe('')
  })

  it('[unit] ships no analytics, sets no storage and keeps the referrer home', () => {
    const page = renderPortalEstimatesPage({ brand: 'Acme Time' })
    expect(page).toContain('name="referrer" content="no-referrer"')
    expect(page).not.toMatch(/googletagmanager|analytics|clarity|hubspot/iu)
    expect(page).toContain('<html lang="en"')
    expect(page).toContain('aria-live="polite"')
  })
})


it('[unit #1010] offers a new contact sign-in link and submits an address once without a URL credential', async () => {
  let deliver!: (response: Response) => void
  const harness = await mount((call) =>
    call.path === '/portal/magic-link'
      ? new Promise<Response>((resolve) => {
          deliver = resolve
        })
      : refusal(401, 'authentication_required'),
  )
  expect(q<HTMLElement>('[data-portal-sign-in]').hidden).toBe(false)
  const email = q<HTMLInputElement>('[data-portal-email]')
  email.value = 'contact@example.com'
  const form = q<HTMLFormElement>('[data-portal-sign-in-form]')
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  expect(harness.calls.filter((call) => call.path === '/portal/magic-link')).toEqual([
    { path: '/portal/magic-link', method: 'POST', body: { email: 'contact@example.com' } },
  ])
  expect(q<HTMLButtonElement>('[data-portal-request-link]').disabled).toBe(true)
  deliver(json(202, { data: { status: 'magic_link_sent' } }))
  await settle()
  expect(text('[data-portal-status]')).toContain('If this address belongs to a client contact')
  expect(email.value).toBe('')
  expect(q<HTMLButtonElement>('[data-portal-request-link]').disabled).toBe(false)
  expect(harness.calls.every((call) => !call.path.includes('@'))).toBe(true)
})

it('[unit #1010] keeps sign-in retry available when delivery cannot be requested', async () => {
  await mount((call) =>
    refusal(call.path === '/portal/magic-link' ? 503 : 401, 'mailer_unavailable'),
  )
  q<HTMLInputElement>('[data-portal-email]').value = 'contact@example.com'
  q<HTMLFormElement>('[data-portal-sign-in-form]').dispatchEvent(
    new Event('submit', { bubbles: true, cancelable: true }),
  )
  await settle()
  expect(text('[data-portal-status]')).toContain('could not be requested')
  expect(q<HTMLButtonElement>('[data-portal-request-link]').disabled).toBe(false)
})
