/** @vitest-environment happy-dom */
import { describe, expect, it, vi } from 'vitest'
import { wireDeelSelfPayout, type DeelSelfPayoutApi } from '../src/shell/payout-deel-self.js'

const mount = () => {
  document.body.innerHTML = `
    <section data-settings-payout-deel hidden>
      <p data-settings-payout-deel-summary></p>
      <button type="button" data-settings-payout-deel-remove hidden>Remove</button>
      <form data-settings-payout-deel-form hidden><input name="email" type="email"></form>
      <p data-settings-payout-deel-result></p>
    </section>`
  return document.querySelector<HTMLElement>('[data-settings-payout-deel]')!
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const api = (accounts: { id: number; provider: string; external_id: string }[], deelOn = true) => ({
  listPayoutProviders: vi.fn(async () => ({
    data: [{ provider: 'deel' as const, enabled: deelOn }, { provider: 'wise' as const, enabled: true }],
  })),
  listPayoutAccounts: vi.fn(async () => ({ data: accounts })),
  linkPayoutAccount: vi.fn(async () => ({})),
  detachPayoutAccount: vi.fn(async () => {}),
}) satisfies DeelSelfPayoutApi

describe('personal Deel destination (issue 1152)', () => {
  it('[unit] asks for the Deel email when Deel is on and none is set, and saves it', async () => {
    const root = mount()
    const client = api([])
    wireDeelSelfPayout(root, client, 7)
    await flush()

    expect(root.hidden).toBe(false)
    const form = root.querySelector<HTMLFormElement>('[data-settings-payout-deel-form]')!
    expect(form.hidden).toBe(false)
    ;(form.elements.namedItem('email') as HTMLInputElement).value = 'ana@example.com'
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    await flush()
    expect(client.linkPayoutAccount).toHaveBeenCalledWith({
      id: 7,
      body: { provider: 'deel', external_id: 'ana@example.com' },
      signal: expect.any(AbortSignal),
    })
  })

  it('[unit] shows the saved Deel email with a way to remove it', async () => {
    const root = mount()
    const client = api([{ id: 31, provider: 'deel', external_id: 'ana@example.com' }])
    wireDeelSelfPayout(root, client, 7)
    await flush()
    expect(root.querySelector('[data-settings-payout-deel-summary]')?.textContent).toContain('ana@example.com')
    root.querySelector<HTMLButtonElement>('[data-settings-payout-deel-remove]')!.click()
    await flush()
    expect(client.detachPayoutAccount).toHaveBeenCalledWith({ id: 31, signal: expect.any(AbortSignal) })
  })

  it('[unit] stays hidden when an administrator has turned Deel off', async () => {
    const root = mount()
    wireDeelSelfPayout(root, api([], false), 7)
    await flush()
    expect(root.hidden).toBe(true)
  })
})


it('serializes saves and ignores an aborted session response', async () => {
  const root = mount()
  const session = new AbortController()
  let complete!: () => void
  const client = { ...api([]), linkPayoutAccount: vi.fn(() => new Promise<void>(resolve => { complete = resolve })) }
  wireDeelSelfPayout(root, client, 7, session.signal)
  await flush()
  const form = root.querySelector<HTMLFormElement>('form')!
  const input = form.elements.namedItem('email') as HTMLInputElement
  const result = root.querySelector('[data-settings-payout-deel-result]')!
  input.value = 'ana@example.com'
  form.dispatchEvent(new Event('submit', { cancelable: true }))
  form.dispatchEvent(new Event('submit', { cancelable: true }))
  expect(client.linkPayoutAccount).toHaveBeenCalledTimes(1)
  expect(input.disabled).toBe(true)
  expect(result.getAttribute('aria-busy')).toBe('true')
  session.abort()
  result.textContent = 'New session'
  complete()
  await flush()
  expect(result.textContent).toBe('New session')
  expect(client.listPayoutAccounts).toHaveBeenCalledTimes(1)
})
