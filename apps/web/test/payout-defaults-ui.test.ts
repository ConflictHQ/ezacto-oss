/** @vitest-environment happy-dom */
import { describe, expect, it, vi } from 'vitest'
import { createPayoutDefaultsPanel } from '../src/team/payout-defaults-browser.js'
import { wirePayoutDefaultSelf } from '../src/shell/payout-default-self.js'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const roster = {
  organization_default: 'wise' as const,
  people: [
    { user_id: 2, name: 'Ana Personal', provider: 'deel' as const, version: 3, set_by: 'person' as const, linked_providers: ['deel' as const, 'wise' as const] },
    { user_id: 3, name: 'Byron Second', provider: null, version: 0, set_by: null, linked_providers: [] },
  ],
}

describe('payment defaults for the team (issue 1152)', () => {
  it('[unit] shows each person with their default, and saves against the version it was read at', async () => {
    document.body.innerHTML = `<section data-team-defaults><table><tbody data-team-defaults-rows></tbody></table><p data-team-defaults-status></p></section>`
    const root = document.querySelector<HTMLElement>('[data-team-defaults]')!
    const api = {
      listPayoutPreferences: vi.fn(async () => ({ data: roster })),
      setPayoutPreference: vi.fn(async () => {}),
    }
    await createPayoutDefaultsPanel(root, api as never).load(new AbortController().signal)

    const rows = root.querySelectorAll('tbody tr')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.textContent).toContain('Ana Personal')
    const select = rows[0]!.querySelector('select')!
    expect(select.value).toBe('deel')
    select.value = 'wise'
    rows[0]!.querySelector('button')!.click()
    await flush()
    expect(api.setPayoutPreference).toHaveBeenCalledWith({ id: 2, provider: 'wise', expectedVersion: 3 })
  })
})

describe('a person chooses their own default (issue 1152)', () => {
  it('[unit] lists the organization default and only the providers they hold, then saves their choice', async () => {
    document.body.innerHTML = `
      <section>
        <form data-settings-payout-default-form hidden>
          <select data-settings-payout-default></select>
          <p data-settings-payout-default-result></p>
        </form>
      </section>`
    const root = document.querySelector<HTMLElement>('section')!
    const api = {
      getPayoutPreference: vi.fn(async () => ({
        data: { user_id: 2, provider: null, effective_provider: 'wise' as const, organization_default: 'wise' as const, version: 0, set_by: null, linked_providers: ['deel' as const] },
      })),
      setPayoutPreference: vi.fn(async () => {}),
    }
    wirePayoutDefaultSelf(root, api as never, 2)
    await flush()

    const form = root.querySelector<HTMLFormElement>('[data-settings-payout-default-form]')!
    const select = root.querySelector<HTMLSelectElement>('[data-settings-payout-default]')!
    expect(form.hidden).toBe(false)
    expect([...select.options].map((option) => option.value)).toEqual(['', 'deel'])
    expect(select.options[0]!.textContent).toContain('Organization default (Wise)')

    select.value = 'deel'
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    await flush()
    expect(api.setPayoutPreference).toHaveBeenCalledWith({ id: 2, provider: 'deel', expectedVersion: 0, signal: expect.any(AbortSignal) })
  })
})

it('keeps a failed preference refresh visible after the write succeeds', async () => {
  document.body.innerHTML = '<section><form data-settings-payout-default-form><select data-settings-payout-default></select><p data-settings-payout-default-result></p></form></section>'
  const root = document.querySelector<HTMLElement>('section')!
  const getPayoutPreference = vi.fn().mockResolvedValueOnce({
    data: { user_id: 2, provider: null, organization_default: 'wise', version: 0, linked_providers: ['deel'] },
  }).mockRejectedValueOnce(new Error('Refresh unavailable'))
  wirePayoutDefaultSelf(root, { getPayoutPreference, setPayoutPreference: vi.fn(async () => {}) } as never, 2)
  await flush()
  root.querySelector<HTMLSelectElement>('select')!.value = 'deel'
  root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
  await flush()
  expect(root.querySelector('[data-settings-payout-default-result]')?.textContent).toContain('could not be refreshed')
  expect(root.querySelector('[data-settings-payout-default-result]')?.textContent).not.toContain('where you will be paid')
})
