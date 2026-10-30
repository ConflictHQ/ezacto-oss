/** @vitest-environment happy-dom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createEstimateComposer,
  renderEstimateComposer,
  type EstimateComposerApi,
} from '../src/estimates/composer.js'
import type { EstimateWorkspaceApi } from '../src/estimates/model.js'
import type { Whoami } from '@conflict-hq/ezacto-client'
import type { EstimateTemplate } from '@ezacto/core'
const now = '2026-10-01T09:00:00.000Z'
const template: EstimateTemplate = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Standard',
  version: 3,
  archived: false,
  created_at: now,
  updated_at: now,
  content: {
    subject: 'Quote',
    notes: 'Reusable',
    currency: 'EUR',
    tax_rate_ppm: null,
    tax2_rate_ppm: null,
    discount_rate_ppm: null,
    lines: [
      {
        kind: 'Service',
        description: 'Implementation',
        quantity: 2.5,
        unit_price_cents: 1001,
        taxed: false,
        taxed2: false,
      },
    ],
  },
}
const identity: Whoami = {
  user_id: 1,
  profile: 'accounting',
  manager_grants: [],
  authentication: { kind: 'session' },
}
const by = <T extends HTMLElement>(key: string) => document.querySelector<T>(`[data-quote-${key}]`)!
let owner: AbortController
beforeEach(() => {
  document.body.innerHTML = renderEstimateComposer()
  owner = new AbortController()
})
afterEach(() => {
  owner.abort()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const setup = (overrides: Partial<EstimateComposerApi & EstimateWorkspaceApi> = {}) => {
  const api = {
    listEstimateTemplates: vi.fn<EstimateComposerApi['listEstimateTemplates']>(
      overrides.listEstimateTemplates ?? (async () => ({ data: [template], truncated: false })),
    ),
    createEstimateTemplate: vi.fn<EstimateComposerApi['createEstimateTemplate']>(
      overrides.createEstimateTemplate ?? (async () => template),
    ),
    updateEstimateTemplate: vi.fn<EstimateComposerApi['updateEstimateTemplate']>(
      overrides.updateEstimateTemplate ?? (async () => ({ ...template, version: 4 })),
    ),
    createEstimateDraft: vi.fn<EstimateComposerApi['createEstimateDraft']>(
      overrides.createEstimateDraft ?? (async () => ({ id: 23 })),
    ),
    listEstimateClients: vi.fn<EstimateWorkspaceApi['listEstimateClients']>(
      overrides.listEstimateClients ??
        (async () => ({
          data: [
            { id: 2, name: 'Chosen client', is_active: true, created_at: now, updated_at: now },
          ],
          page: { next_cursor: null },
        })),
    ),
  }
  return { api, composer: createEstimateComposer(api) }
}
const choose = () => {
  by<HTMLSelectElement>('template').value = template.id
  by('template').dispatchEvent(new Event('change'))
}
const submit = () => {
  by<HTMLSelectElement>('client').value = '2'
  by<HTMLInputElement>('number').value = 'NEW-23'
  by<HTMLInputElement>('date').value = '2026-10-01'
  by('form').dispatchEvent(new Event('submit', { cancelable: true }))
}
it('copies quote content with explicit new client/number and uses the same idempotency key on retry', async () => {
  const { api, composer } = setup()
  await composer.activate(identity, owner.signal, () => false)
  by<HTMLSelectElement>('client').value = '2'
  by<HTMLInputElement>('number').value = 'OLD'
  choose()
  expect(by<HTMLSelectElement>('client').value).toBe('')
  expect(by<HTMLInputElement>('number').value).toBe('')
  submit()
  await vi.waitFor(() => expect(api.createEstimateDraft).toHaveBeenCalledOnce())
  expect(api.createEstimateDraft.mock.calls[0]?.[0]).toEqual({
    client_id: 2,
    number: 'NEW-23',
    issue_date: '2026-10-01',
    content: template.content,
    template_id: template.id,
    template_version: 3,
  })
  await vi.waitFor(() => expect(by<HTMLAnchorElement>('created').hidden).toBe(false))
  expect(by<HTMLAnchorElement>('created').getAttribute('href')).toBe(
    '/invoices/estimates?estimate=23',
  )
  submit()
  await vi.waitFor(() => expect(api.createEstimateDraft).toHaveBeenCalledTimes(2))
  expect(api.createEstimateDraft.mock.calls[0]?.[1]).toBe(
    api.createEstimateDraft.mock.calls[1]?.[1],
  )
})
it('saves edits only through the explicit current-version command and archives only after confirmation', async () => {
  const { api, composer } = setup()
  await composer.activate(identity, owner.signal, () => false)
  choose()
  by<HTMLInputElement>('name').value = 'New name'
  by('update').click()
  await vi.waitFor(() => expect(api.updateEstimateTemplate).toHaveBeenCalledOnce())
  expect(api.updateEstimateTemplate.mock.calls[0]?.[1]).toMatchObject({
    expected_version: 3,
    name: 'New name',
  })
  await vi.waitFor(() => expect(by('status').textContent).toContain('Template saved'))
  vi.stubGlobal(
    'confirm',
    vi.fn(() => false),
  )
  by('archive').click()
  expect(api.updateEstimateTemplate).toHaveBeenCalledTimes(1)
})
it('keeps archived content readable and refuses draft creation', async () => {
  const { api, composer } = setup({
    listEstimateTemplates: async () => ({
      data: [{ ...template, archived: true }],
      truncated: false,
    }),
  })
  await composer.activate(identity, owner.signal, () => false)
  choose()
  submit()
  expect(api.createEstimateDraft).not.toHaveBeenCalled()
  expect(by('status').textContent).toContain('active template')
})
it('does not load privileged template content for a member', async () => {
  const { api, composer } = setup()
  await composer.activate({ ...identity, profile: 'member' }, owner.signal, () => false)
  expect(api.listEstimateTemplates).not.toHaveBeenCalled()
  expect(document.querySelector<HTMLElement>('[data-estimate-composer]')!.hidden).toBe(true)
})
it.each(['abort', 'replace', 'same-signal replacement'] as const)(
  'clears private content and refuses late mutation presentation after %s',
  async (mode) => {
    let resolve!: (value: { id: number }) => void
    const create = vi.fn(
      () =>
        new Promise<{ id: number }>((done) => {
          resolve = done
        }),
    )
    const { composer } = setup({ createEstimateDraft: create })
    await composer.activate(identity, owner.signal, () => false)
    choose()
    submit()
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
    if (mode === 'abort') owner.abort()
    else {
      if (mode === 'replace') owner = new AbortController()
      await composer.activate(
        { ...identity, user_id: 9, profile: 'member' },
        owner.signal,
        () => false,
      )
    }
    resolve({ id: 88 })
    await new Promise((done) => setTimeout(done, 0))
    expect(by<HTMLAnchorElement>('created').hidden).toBe(true)
    expect(by('status').textContent).toBe('')
    expect(by('lines').children).toHaveLength(0)
  },
)
