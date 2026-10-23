/** @vitest-environment happy-dom */
import { describe, expect, it, vi } from 'vitest'
import { createPayoutProvidersPanel, type PayoutProvidersApi } from '../src/team/payout-providers-browser.js'

const mount = () => {
  document.body.innerHTML = `
    <div data-team-panel="payout">
      <fieldset data-team-payout-providers hidden>
        <input type="checkbox" data-team-provider-toggle="wise">
        <input type="checkbox" data-team-provider-toggle="deel">
        <p data-team-provider-result></p>
      </fieldset>
      <section data-team-payout-deel hidden>
        <p data-team-payout-deel-summary></p>
        <button type="button" data-team-payout-deel-remove hidden>Remove</button>
        <form data-team-payout-deel-form hidden>
          <input name="email" type="email">
          <p data-team-payout-deel-result></p>
        </form>
      </section>
    </div>`
  return document.querySelector<HTMLElement>('[data-team-panel="payout"]')!
}

const api = (overrides: Partial<PayoutProvidersApi> = {}): Required<PayoutProvidersApi> => ({
  listPayoutProviders: vi.fn(async () => ({
    data: [
      { provider: 'deel' as const, enabled: true },
      { provider: 'wise' as const, enabled: true },
    ],
  })),
  listPayoutAccounts: vi.fn(async () => ({ data: [] })),
  linkPayoutAccount: vi.fn(async () => ({})),
  detachPayoutAccount: vi.fn(async () => {}),
  setPayoutProviderEnabled: vi.fn(async () => {}),
  ...overrides,
})

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('payout providers panel (issue 1152)', () => {
  it('[unit] shows the Deel form when no Deel destination is set, and saves the email as typed', async () => {
    const root = mount()
    const client = api()
    const panel = createPayoutProvidersPanel(root, client)

    expect(await panel.load(7, new AbortController().signal, false)).toEqual({ wise: true })
    const form = root.querySelector<HTMLFormElement>('[data-team-payout-deel-form]')!
    expect(form.hidden).toBe(false)
    ;(form.elements.namedItem('email') as HTMLInputElement).value = ' ana@example.com '
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    await flush()

    expect(client.linkPayoutAccount).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7, body: { provider: 'deel', external_id: 'ana@example.com' } }),
    )
  })

  it('[unit] shows the linked Deel destination with a way to remove it', async () => {
    const root = mount()
    const client = api({
      listPayoutAccounts: vi.fn(async () => ({
        data: [{ id: 31, provider: 'deel', external_id: 'ana@example.com' }],
      })),
    })
    await createPayoutProvidersPanel(root, client).load(7, new AbortController().signal, false)

    expect(root.querySelector('[data-team-payout-deel-summary]')?.textContent).toContain('ana@example.com')
    expect(root.querySelector<HTMLFormElement>('[data-team-payout-deel-form]')?.hidden).toBe(true)
    root.querySelector<HTMLButtonElement>('[data-team-payout-deel-remove]')!.click()
    await flush()
    expect(client.detachPayoutAccount).toHaveBeenCalledWith(expect.objectContaining({ id: 31 }))
  })

  it('[unit] hides Deel when an administrator has turned it off, and lets an administrator switch providers', async () => {
    const root = mount()
    const client = api({
      listPayoutProviders: vi.fn(async () => ({
        data: [
          { provider: 'deel' as const, enabled: false },
          { provider: 'wise' as const, enabled: true },
        ],
      })),
    })
    const panel = createPayoutProvidersPanel(root, client)
    expect(await panel.load(7, new AbortController().signal, true)).toEqual({ wise: true })
    expect(root.querySelector<HTMLElement>('[data-team-payout-deel]')?.hidden).toBe(true)
    expect(root.querySelector<HTMLElement>('[data-team-payout-providers]')?.hidden).toBe(false)

    const wise = root.querySelector<HTMLInputElement>('[data-team-provider-toggle="wise"]')!
    wise.checked = false
    wise.dispatchEvent(new Event('change'))
    await flush()
    expect(client.setPayoutProviderEnabled).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'wise', body: { enabled: false } }),
    )
  })
})
