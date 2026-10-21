/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EzactoApiError,
  type ClientRateCard,
  type GeneralResource,
  type Whoami,
} from '@conflict-hq/ezacto-client'
import {
  createClientRateCardController,
  type ClientRateCardApi,
  type RateCardContext,
} from '../src/clients/rate-card-browser.js'
import { renderClientRateCard } from '../src/clients/rate-card-render.js'

const resource = (id: number, name: string): GeneralResource => ({
  id,
  name,
  created_at: '2026-10-21T12:00:00.000Z',
  updated_at: '2026-10-21T12:00:00.000Z',
})
const missing = () => new EzactoApiError(404, { error: { code: 'not_found' } }, 'fixture')
const empty: ClientRateCard = {
  id: 10,
  client_id: 3,
  name: 'Engineering',
  created_at: '2026-10-21T12:00:00.000Z',
  versions: [],
}
const existing: ClientRateCard = {
  ...empty,
  versions: [
    {
      id: 1,
      start_date: '2026-09-01',
      lines: [{ task_id: null, amount_cents: 12345 }],
      created_at: empty.created_at,
    },
  ],
}
const query = <T extends Element>(selector: string): T => document.querySelector<T>(selector)!
const input = (name: string): HTMLInputElement => query(`[data-rate-card-version] [name="${name}"]`)
const submit = (selector: string): void => {
  query<HTMLFormElement>(selector).dispatchEvent(
    new Event('submit', { bubbles: true, cancelable: true }),
  )
}
const identity = (profile: Whoami['profile'] = 'administrator', grants: string[] = []): Whoami =>
  ({ user_id: 7, profile, manager_grants: grants, authentication: { kind: 'session' } }) as Whoami
const context = (who = identity(), abort = new AbortController()): RateCardContext => ({
  identity: who,
  signal: abort.signal,
  client: { ...resource(3, 'Leaf'), currency: 'USD', is_active: true },
  clients: [resource(1, 'Worked-for root'), resource(3, 'Leaf'), resource(4, 'Bill-to only')],
  failed: (_error, paint) => paint(),
})
const fixture = (card: ClientRateCard | null = null) => {
  const api = {
    getClientRateCard: vi.fn(async () => {
      if (!card) throw missing()
      return card
    }),
    createClientRateCard: vi.fn(async (_id: number, name: string) => ({ ...empty, name })),
    createClientRateCardVersion: vi.fn(
      async (
        _id: number,
        body: {
          start_date: string | null
          lines: Array<{ task_id: number | null; amount_cents: number }>
        },
      ) => ({ ...empty, versions: [{ id: 2, ...body, created_at: empty.created_at }] }),
    ),
    listRateCardTasks: vi.fn(async () => ({
      data: [resource(7, 'Development')],
      page: { next_cursor: null },
    })),
    getClientEffectiveRateCard: vi.fn(async () => ({
      client_id: 3,
      supplied_by_client_id: 1,
      depth: 2,
      card_id: 2,
      card_name: 'Parent rates',
      version_start_date: null,
      task_id: null,
      amount_cents: 9000,
    })),
  }
  return api
}
beforeEach(() => {
  document.body.innerHTML = renderClientRateCard()
})

describe('client rate card editor #34', () => {
  it('uses the shared money permission and clears the section for a new unprivileged identity', async () => {
    for (const who of [identity('member'), identity('people_admin'), identity('project_manager')]) {
      const api = fixture()
      await createClientRateCardController(api).activate(context(who))
      expect(api.getClientRateCard).not.toHaveBeenCalled()
      expect(query<HTMLElement>('[data-client-rate-card]').hidden).toBe(true)
    }
    for (const who of [
      identity('accounting'),
      identity('executive_manager'),
      identity('administrator'),
      identity('project_manager', ['billable_rates_manager']),
    ]) {
      const api = fixture()
      const controller = createClientRateCardController(api)
      await controller.activate(context(who))
      expect(api.getClientRateCard).toHaveBeenCalledWith(3, expect.any(AbortSignal))
      expect(query<HTMLElement>('[data-rate-card-create]').hidden).toBe(false)
      await controller.activate(context(identity('member')))
      expect(query<HTMLElement>('[data-client-rate-card]').hidden).toBe(true)
      expect(query('[data-rate-card-history]').textContent).toBe('')
    }
  })

  it('creates a named card and publishes exact default/task rates without changing existing entries', async () => {
    const api = fixture()
    await createClientRateCardController(api).activate(context())
    query<HTMLInputElement>('[data-rate-card-create] [name="name"]').value = 'Leaf rates'
    submit('[data-rate-card-create]')
    await vi.waitFor(() =>
      expect(query<HTMLElement>('[data-rate-card-version]').hidden).toBe(false),
    )
    expect(api.createClientRateCard).toHaveBeenCalledWith(3, 'Leaf rates', expect.any(AbortSignal))
    query<HTMLInputElement>('[data-rate-card-amount]').value = '150.25'
    query<HTMLButtonElement>('[data-rate-card-add]').click()
    const rows = document.querySelectorAll<HTMLElement>('[data-rate-card-line]')
    rows[1]!.querySelector<HTMLSelectElement>('select')!.value = '7'
    rows[1]!.querySelector<HTMLInputElement>('input')!.value = '200.01'
    submit('[data-rate-card-version]')
    await vi.waitFor(() => expect(api.createClientRateCardVersion).toHaveBeenCalledTimes(1))
    expect(api.createClientRateCardVersion).toHaveBeenCalledWith(
      3,
      {
        start_date: null,
        lines: [
          { task_id: null, amount_cents: 15025 },
          { task_id: 7, amount_cents: 20001 },
        ],
      },
      expect.any(AbortSignal),
    )
    await vi.waitFor(() =>
      expect(query('[data-rate-card-history]').textContent).toContain('$150.25'),
    )
    expect(query('[data-rate-card-history]').textContent).toContain('Development')
    expect(query('[data-rate-card-status]').textContent).toContain(
      'Existing hours and invoices are unchanged',
    )
  })

  it('rejects duplicate tasks, fractional cents and invalid dates before writing; retirement is explicit', async () => {
    const api = fixture(existing)
    await createClientRateCardController(api).activate(context())
    submit('[data-rate-card-version]')
    expect(api.createClientRateCardVersion).not.toHaveBeenCalled()
    input('start_date').value = '2026-08-01'
    submit('[data-rate-card-version]')
    expect(api.createClientRateCardVersion).not.toHaveBeenCalled()
    input('start_date').value = '2026-10-21'
    query<HTMLInputElement>('[data-rate-card-amount]').value = '12.345'
    submit('[data-rate-card-version]')
    expect(query('[data-rate-card-status]').textContent).toContain('two decimals')
    query<HTMLInputElement>('[data-rate-card-amount]').value = '12.34'
    query<HTMLButtonElement>('[data-rate-card-add]').click()
    query<HTMLInputElement>('[data-rate-card-line]:last-child input').value = '1.00'
    submit('[data-rate-card-version]')
    expect(query('[data-rate-card-status]').textContent).toContain('only once')
    expect(api.createClientRateCardVersion).not.toHaveBeenCalled()
    input('retire').checked = true
    input('retire').dispatchEvent(new Event('change'))
    submit('[data-rate-card-version]')
    await vi.waitFor(() => expect(api.createClientRateCardVersion).toHaveBeenCalledTimes(1))
    expect(api.createClientRateCardVersion).toHaveBeenCalledWith(
      3,
      { start_date: '2026-10-21', lines: [] },
      expect.any(AbortSignal),
    )
    await vi.waitFor(() =>
      expect(query('[data-rate-card-history]').textContent).toContain('Retired'),
    )
  })

  it('previews the authoritative inherited card with the worked-for source and dated task', async () => {
    const api = fixture()
    await createClientRateCardController(api).activate(context())
    query<HTMLInputElement>('[data-rate-card-preview] [name="spent_date"]').value = '2026-10-01'
    submit('[data-rate-card-preview]')
    await vi.waitFor(() =>
      expect(query('[data-rate-card-preview-result]').textContent).toContain(
        'Worked-for root (inherited)',
      ),
    )
    expect(api.getClientEffectiveRateCard).toHaveBeenCalledWith(
      3,
      7,
      '2026-10-01',
      expect.any(AbortSignal),
    )
    expect(query('[data-rate-card-preview-result]').textContent).toContain('$90.00')
    expect(query('[data-rate-card-preview-result]').textContent).not.toContain('Bill-to only')
  })

  it('clears a dated preview when its inputs change and ignores the old response', async () => {
    const api = fixture()
    const pending =
      Promise.withResolvers<Awaited<ReturnType<typeof api.getClientEffectiveRateCard>>>()
    api.getClientEffectiveRateCard.mockImplementation(() => pending.promise)
    await createClientRateCardController(api).activate(context())
    submit('[data-rate-card-preview]')
    expect(api.getClientEffectiveRateCard).toHaveBeenCalledTimes(1)
    const date = query<HTMLInputElement>('[data-rate-card-preview] [name="spent_date"]')
    date.value = '2026-12-01'
    date.dispatchEvent(new Event('input', { bubbles: true }))
    pending.resolve(await fixture().getClientEffectiveRateCard())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(query('[data-rate-card-preview-result]').textContent).toBe('')
  })

  it('ignores a late load after sign-out or a lower-privileged session switch', async () => {
    const pending = Promise.withResolvers<ClientRateCard>()
    const api: ClientRateCardApi = { ...fixture(), getClientRateCard: () => pending.promise }
    const controller = createClientRateCardController(api)
    const abort = new AbortController()
    const first = controller.activate(context(identity(), abort))
    await vi.waitFor(() =>
      expect(query('[data-rate-card-status]').textContent).toContain('Loading'),
    )
    abort.abort()
    await controller.activate(context(identity('member')))
    pending.resolve(existing)
    await first
    expect(query<HTMLElement>('[data-client-rate-card]').hidden).toBe(true)
    expect(query('[data-rate-card-history]').textContent).toBe('')
  })

  it('prevents duplicate writes and keeps late write failures out of the next session', async () => {
    const pending = Promise.withResolvers<ClientRateCard>()
    const api = fixture(existing)
    api.createClientRateCardVersion.mockImplementation(() => pending.promise)
    const controller = createClientRateCardController(api)
    const active = context()
    active.failed = vi.fn()
    await controller.activate(active)
    input('start_date').value = '2026-10-21'
    submit('[data-rate-card-version]')
    submit('[data-rate-card-version]')
    expect(api.createClientRateCardVersion).toHaveBeenCalledTimes(1)
    await controller.activate(context(identity('member')))
    pending.reject(new EzactoApiError(401, {}, 'old-session'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(active.failed).not.toHaveBeenCalled()
    expect(query('[data-rate-card-status]').textContent).toBe('')
  })
})
