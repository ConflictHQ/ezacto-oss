/** @vitest-environment happy-dom */
import { describe, expect, it, vi } from 'vitest'
import { createPayoutProviderSwitches } from '../src/module-settings/payout-provider-switches.js'

const mount = () => {
  document.body.innerHTML = `
    <fieldset data-settings-payout-providers>
      <input type="checkbox" data-settings-provider-toggle="wise">
      <input type="checkbox" data-settings-provider-toggle="deel">
      <p data-settings-provider-result></p>
    </fieldset>`
  return document.querySelector<HTMLElement>('[data-settings-payout-providers]')!
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('company payout provider switches (#1152)', () => {
  it('[unit] shows which providers are on, and sends a change', async () => {
    const root = mount()
    const api = {
      listPayoutProviders: vi.fn(async () => ({
        data: [
          { provider: 'deel' as const, enabled: true },
          { provider: 'wise' as const, enabled: false },
        ],
      })),
      setPayoutProviderEnabled: vi.fn(async () => {}),
    }
    await createPayoutProviderSwitches(root, api).load(new AbortController().signal)

    const wise = root.querySelector<HTMLInputElement>('[data-settings-provider-toggle="wise"]')!
    const deel = root.querySelector<HTMLInputElement>('[data-settings-provider-toggle="deel"]')!
    expect(wise.checked).toBe(false)
    expect(deel.checked).toBe(true)

    wise.checked = true
    wise.dispatchEvent(new Event('change'))
    await flush()
    expect(api.setPayoutProviderEnabled).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'wise', body: { enabled: true } }),
    )
    expect(root.querySelector('[data-settings-provider-result]')?.textContent).toContain('Wise is now on')
  })

  it('[unit] puts a switch back when the server refuses the change', async () => {
    const root = mount()
    const api = {
      listPayoutProviders: vi.fn(async () => ({ data: [{ provider: 'deel' as const, enabled: true }] })),
      setPayoutProviderEnabled: vi.fn(async () => {
        throw new Error('refused')
      }),
    }
    await createPayoutProviderSwitches(root, api).load(new AbortController().signal)
    const deel = root.querySelector<HTMLInputElement>('[data-settings-provider-toggle="deel"]')!
    deel.checked = false
    deel.dispatchEvent(new Event('change'))
    await flush()
    expect(deel.checked).toBe(true)
  })
})
