/** @vitest-environment happy-dom */

import { describe, expect, it, vi } from 'vitest'
import {
  browserApi,
  mountShell,
  renderBrowserShell,
} from './support/shell-harness.js'

/**
 * Your own payout destination, on the one page that is yours (issues 421, 543).
 *
 * The same panel exists on the person record, but a member cannot read the team
 * directory at all -- so without this the person who actually has the Wisetag
 * had nowhere to enter it, which is the opposite of asking them to share it.
 */
describe('your payout destination in your own settings', () => {
  const payoutApi = (overrides: Record<string, unknown> = {}) => ({
    ...browserApi(),
    getWisePayoutDestination: vi.fn(async () => ({ configured: true, destination: null })),
    shareWiseProfile: vi.fn(async () => ({ name: 'R. Adeyemi' })),
    removeWisePayoutDestination: vi.fn(async () => undefined),
    ...overrides,
  })

  const form = (): HTMLFormElement =>
    document.querySelector<HTMLFormElement>('[data-settings-payout-form]')!

  const setField = (name: string, value: string): void => {
    ;(form().elements.namedItem(name) as HTMLInputElement).value = value
  }

  it('takes a Wisetag from the person who has it, and shows back whose it is', async () => {
    renderBrowserShell({ view: 'settings-user' })
    const shareWiseProfile = vi.fn<
      (input: {
        readonly userId: number
        readonly identifier: string
        readonly currency: string
      }) => Promise<{ name: string | null }>
    >(async () => ({ name: 'R. Adeyemi' }))
    const api = payoutApi({ shareWiseProfile })
    await mountShell(api)

    await vi.waitFor(() => expect(form().hidden).toBe(false))
    setField('identifier', ' @theirtag ')
    setField('currency', 'usd')
    form().dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() => expect(shareWiseProfile).toHaveBeenCalledTimes(1))
    expect(shareWiseProfile.mock.calls[0]![0]).toEqual({
      userId: 1,
      identifier: '@theirtag',
      currency: 'USD',
    })
    // A mistyped tag that resolves resolves to somebody else, and the name Wise
    // answered with is the only thing that catches it before money moves.
    await vi.waitFor(() =>
      expect(
        document.querySelector<HTMLElement>('[data-settings-payout-result]')!.textContent,
      ).toContain('R. Adeyemi'),
    )
  })

  it('[security] says a destination is set without printing the identifier', async () => {
    renderBrowserShell({ view: 'settings-user' })
    await mountShell(
      payoutApi({
        getWisePayoutDestination: vi.fn(async () => ({
          configured: true,
          destination: {
            kind: 'contact' as const,
            linkedAt: '2026-09-13T12:00:00.000Z',
            verifiedAt: '2026-09-13T12:00:00.000Z',
          },
        })),
      }),
    )

    const current = document.querySelector<HTMLElement>('[data-settings-payout-current]')!
    await vi.waitFor(() => expect(current.hidden).toBe(false))
    const section = document.querySelector<HTMLElement>('[data-settings-payout]')!
    expect(section.textContent).toContain('Wise holds the bank details')
    // The form is gone while one is set: two destinations is two answers to
    // where somebody's money goes.
    expect(form().hidden).toBe(true)
    expect(
      document.querySelector<HTMLElement>('[data-settings-payout-unverified]')!.hidden,
    ).toBe(true)
  })

  it('[money] warns when Wise never confirmed the destination resolves', async () => {
    // Paying against an unverified link is the failure the payout store exists
    // to prevent, and it is invisible unless the screen says it.
    renderBrowserShell({ view: 'settings-user' })
    await mountShell(
      payoutApi({
        getWisePayoutDestination: vi.fn(async () => ({
          configured: true,
          destination: {
            kind: 'contact' as const,
            linkedAt: '2026-09-13T12:00:00.000Z',
            verifiedAt: null,
          },
        })),
      }),
    )

    await vi.waitFor(() =>
      expect(
        document.querySelector<HTMLElement>('[data-settings-payout-unverified]')!.hidden,
      ).toBe(false),
    )
  })

  it('lets them take a wrong one off without finding accounting first', async () => {
    renderBrowserShell({ view: 'settings-user' })
    const removeWisePayoutDestination = vi.fn<(userId: number) => Promise<void>>(
      async () => undefined,
    )
    await mountShell(
      payoutApi({
        removeWisePayoutDestination,
        getWisePayoutDestination: vi.fn(async () => ({
          configured: true,
          destination: {
            kind: 'contact' as const,
            linkedAt: '2026-09-13T12:00:00.000Z',
            verifiedAt: '2026-09-13T12:00:00.000Z',
          },
        })),
      }),
    )

    const remove = document.querySelector<HTMLButtonElement>('[data-settings-payout-remove]')!
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLElement>('[data-settings-payout-current]')!.hidden).toBe(
        false,
      ),
    )
    remove.click()

    await vi.waitFor(() => expect(removeWisePayoutDestination).toHaveBeenCalledTimes(1))
    expect(removeWisePayoutDestination.mock.calls[0]![0]).toBe(1)
  })

  it('sends a mistyped tag back to the field, not to an administrator', async () => {
    renderBrowserShell({ view: 'settings-user' })
    await mountShell(
      payoutApi({
        shareWiseProfile: vi.fn(async () => {
          throw Object.assign(new Error('refused'), {
            status: 422,
            body: { error: { fields: [{ field: 'identifier', code: 'not_discoverable' }] } },
          })
        }),
      }),
    )

    await vi.waitFor(() => expect(form().hidden).toBe(false))
    setField('identifier', '@nobody')
    setField('currency', 'USD')
    form().dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() =>
      expect(
        document.querySelector<HTMLElement>('[data-settings-payout-result]')!.textContent,
      ).toContain('discoverability'),
    )
  })

  it('stays out of the way in a build without the Wise endpoints', async () => {
    renderBrowserShell({ view: 'settings-user' })
    await mountShell(browserApi())

    expect(document.querySelector<HTMLElement>('[data-settings-payout]')!.hidden).toBe(true)
  })
})
