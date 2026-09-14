/** @vitest-environment happy-dom */

import { describe, expect, it, vi } from 'vitest'
import type { ApiToken, TwoFactorStatus } from '@conflict-hq/ezacto-client'
import {
  EzactoApiError,
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

/**
 * API tokens, on the page that is yours (issue 485).
 *
 * The endpoints shipped and no control reached them, so issuing a token was a
 * terminal job. They are scoped to the acting user by the routes themselves.
 */
describe('your API tokens in your own settings', () => {
  const token = (overrides: Partial<ApiToken> = {}): ApiToken => ({
    id: 5,
    name: 'Laptop CLI',
    scopes: ['time_entries:read'] as ApiToken['scopes'],
    token_hint: 'ez_live_…9f2c',
    created_at: '2026-09-13T12:00:00.000Z',
    last_used_at: null,
    expires_at: null,
    revoked_at: null,
    ...overrides,
  })

  const tokenApi = (overrides: Record<string, unknown> = {}) => ({
    ...browserApi(),
    listApiTokens: vi.fn(async () => [token()]),
    createApiToken: vi.fn(async () => ({ ...token({ id: 6 }), token: 'ez_live_secret_value' })),
    revokeApiToken: vi.fn(async () => undefined),
    ...overrides,
  })

  const form = (): HTMLFormElement =>
    document.querySelector<HTMLFormElement>('[data-settings-token-form]')!

  it('[security] lists the hint and never the token itself', async () => {
    // The value is stored hashed. A screen that could print it again would
    // mean it was recoverable, which is the property the hash exists to deny.
    renderBrowserShell({ view: 'settings-user' })
    await mountShell(tokenApi())

    const table = document.querySelector<HTMLElement>('[data-settings-tokens-table]')!
    await vi.waitFor(() => expect(table.hidden).toBe(false))
    expect(table.textContent).toContain('ez_live_…9f2c')
    expect(table.textContent).toContain('Laptop CLI')
    // Never used is said, not left blank: an empty cell reads as a loading bug,
    // and an unused token is the one worth revoking.
    expect(table.textContent).toContain('Never')
  })

  it('[security] shows a new token once, and says that is the only time', async () => {
    renderBrowserShell({ view: 'settings-user' })
    const createApiToken = vi.fn(async () => ({
      ...token({ id: 6 }),
      token: 'ez_live_secret_value',
    }))
    await mountShell(tokenApi({ createApiToken }))

    await vi.waitFor(() =>
      expect(document.querySelector<HTMLElement>('[data-settings-tokens]')!.hidden).toBe(false),
    )
    ;(form().elements.namedItem('name') as HTMLInputElement).value = 'Laptop CLI'
    const scope = form().querySelector<HTMLInputElement>('input[value="time_entries:read"]')!
    scope.checked = true
    form().dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() => expect(createApiToken).toHaveBeenCalledTimes(1))
    const issued = document.querySelector<HTMLElement>('[data-settings-token-issued]')!
    await vi.waitFor(() => expect(issued.hidden).toBe(false))
    expect(issued.textContent).toContain('ez_live_secret_value')
    expect(issued.textContent).toContain('only time')
  })

  it('refuses to ask for a token with no scopes rather than letting the server say no', async () => {
    renderBrowserShell({ view: 'settings-user' })
    const createApiToken = vi.fn()
    await mountShell(tokenApi({ createApiToken }))

    await vi.waitFor(() => expect(form().hidden).toBe(false))
    ;(form().elements.namedItem('name') as HTMLInputElement).value = 'Nameless scope set'
    form().dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))

    expect(createApiToken).not.toHaveBeenCalled()
    expect(
      document.querySelector<HTMLElement>('[data-settings-token-result]')!.textContent,
    ).toContain('at least one scope')
  })

  it('[security] says which limit was hit when a profile cannot grant a scope', async () => {
    // "The token could not be issued" would send somebody to check their
    // spelling for a permission they do not have.
    renderBrowserShell({ view: 'settings-user' })
    await mountShell(
      tokenApi({
        createApiToken: vi.fn(async () => {
          throw new EzactoApiError(403, { error: { code: 'profile_forbidden' } }, null)
        }),
      }),
    )

    await vi.waitFor(() => expect(form().hidden).toBe(false))
    ;(form().elements.namedItem('name') as HTMLInputElement).value = 'Too much'
    form().querySelector<HTMLInputElement>('input[value="reports:read"]')!.checked = true
    form().dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() =>
      expect(
        document.querySelector<HTMLElement>('[data-settings-token-result]')!.textContent,
      ).toContain('cannot grant'),
    )
    expect(document.querySelector<HTMLElement>('[data-settings-token-issued]')!.hidden).toBe(true)
  })

  it('leaves a revoked token off the list rather than showing it as live', async () => {
    renderBrowserShell({ view: 'settings-user' })
    await mountShell(
      tokenApi({
        listApiTokens: vi.fn(async () => [
          token({ revoked_at: '2026-09-13T13:00:00.000Z' }),
        ]),
      }),
    )

    await vi.waitFor(() =>
      expect(
        document.querySelector<HTMLElement>('[data-settings-tokens-status]')!.textContent,
      ).toContain('no API tokens'),
    )
    expect(document.querySelector<HTMLElement>('[data-settings-tokens-table]')!.hidden).toBe(true)
  })

  it('stays out of the way in a build without the token endpoints', async () => {
    renderBrowserShell({ view: 'settings-user' })
    await mountShell(browserApi())

    expect(document.querySelector<HTMLElement>('[data-settings-tokens]')!.hidden).toBe(true)
  })
})

/**
 * Two-step sign-in (issue 485).
 *
 * An instance can require a second factor and nothing in the app could set one
 * up, so enrolment was a terminal job for exactly the people least likely to
 * have one open.
 */
describe('two-step sign-in in your own settings', () => {
  const status = (overrides: Partial<TwoFactorStatus> = {}): TwoFactorStatus => ({
    enrolled: false,
    pending_confirmation: false,
    recovery_codes_remaining: 0,
    ...overrides,
  })

  const twoFactorApi = (overrides: Record<string, unknown> = {}) => ({
    ...browserApi(),
    getTwoFactorStatus: vi.fn(async () => status()),
    beginTwoFactorEnrolment: vi.fn(async () => ({
      secret: 'JBSWY3DPEHPK3PXP',
      otpauth_uri: 'otpauth://totp/ezacto:someone@example.test?secret=JBSWY3DPEHPK3PXP',
      recovery_codes: ['aaaa-1111', 'bbbb-2222'],
    })),
    confirmTwoFactorEnrolment: vi.fn(async () =>
      status({ enrolled: true, recovery_codes_remaining: 2 }),
    ),
    disableTwoFactor: vi.fn(async () => status()),
    ...overrides,
  })

  const panel = (): HTMLElement => document.querySelector<HTMLElement>('[data-settings-2fa]')!
  const enrolment = (): HTMLElement =>
    document.querySelector<HTMLElement>('[data-settings-2fa-enrolment]')!

  it('shows the key and the recovery codes once the setup is started', async () => {
    renderBrowserShell({ view: 'settings-user' })
    await mountShell(twoFactorApi())

    await vi.waitFor(() => expect(panel().hidden).toBe(false))
    document.querySelector<HTMLButtonElement>('[data-settings-2fa-begin]')!.click()

    await vi.waitFor(() => expect(enrolment().hidden).toBe(false))
    expect(enrolment().textContent).toContain('JBSWY3DPEHPK3PXP')
    expect(enrolment().textContent).toContain('aaaa-1111')
    // Shown once, and said so: these are the only way back in once the
    // authenticator is gone.
    expect(enrolment().textContent).toContain('Shown once')
  })

  it('[security] changes nothing about signing in until a code is accepted', async () => {
    // A screen that said "on" before the code was checked would leave somebody
    // believing they were protected by a secret their app never took.
    renderBrowserShell({ view: 'settings-user' })
    const confirmTwoFactorEnrolment = vi.fn(async () => {
      throw new EzactoApiError(422, { error: { code: 'invalid_code' } }, null)
    })
    await mountShell(twoFactorApi({ confirmTwoFactorEnrolment }))

    await vi.waitFor(() => expect(panel().hidden).toBe(false))
    document.querySelector<HTMLButtonElement>('[data-settings-2fa-begin]')!.click()
    await vi.waitFor(() => expect(enrolment().hidden).toBe(false))

    const form = document.querySelector<HTMLFormElement>('[data-settings-2fa-confirm-form]')!
    ;(form.elements.namedItem('code') as HTMLInputElement).value = '000000'
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() =>
      expect(
        document.querySelector<HTMLElement>('[data-settings-2fa-confirm-result]')!.textContent,
      ).toContain('not on yet'),
    )
    expect(panel().textContent).toContain('Off')
  })

  it('[security] clears the secret and the codes the moment it takes effect', async () => {
    // Leaving a one-time reveal on the screen is how it ends up left on the
    // screen.
    renderBrowserShell({ view: 'settings-user' })
    await mountShell(twoFactorApi())

    await vi.waitFor(() => expect(panel().hidden).toBe(false))
    document.querySelector<HTMLButtonElement>('[data-settings-2fa-begin]')!.click()
    await vi.waitFor(() => expect(enrolment().hidden).toBe(false))

    const form = document.querySelector<HTMLFormElement>('[data-settings-2fa-confirm-form]')!
    ;(form.elements.namedItem('code') as HTMLInputElement).value = '123456'
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() => expect(enrolment().hidden).toBe(true))
    expect(enrolment().textContent).not.toContain('JBSWY3DPEHPK3PXP')
    expect(enrolment().textContent).not.toContain('aaaa-1111')
    expect(panel().textContent).toContain('On')
  })

  it('[security] needs a current code to turn it off', async () => {
    renderBrowserShell({ view: 'settings-user' })
    const disableTwoFactor = vi.fn(async () => status())
    await mountShell(
      twoFactorApi({
        getTwoFactorStatus: vi.fn(async () =>
          status({ enrolled: true, recovery_codes_remaining: 5 }),
        ),
        disableTwoFactor,
      }),
    )

    const form = document.querySelector<HTMLFormElement>('[data-settings-2fa-disable-form]')!
    await vi.waitFor(() => expect(form.hidden).toBe(false))
    // Empty is refused here rather than at the server, so a borrowed session
    // cannot turn it off by submitting nothing.
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    expect(disableTwoFactor).not.toHaveBeenCalled()

    ;(form.elements.namedItem('code') as HTMLInputElement).value = '123456'
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(disableTwoFactor).toHaveBeenCalledWith('123456'))
  })

  it('says an unfinished setup has to start again rather than offering to resume', async () => {
    // The secret was a one-time reveal and is not readable back, so resuming is
    // not a thing this can honestly offer.
    renderBrowserShell({ view: 'settings-user' })
    await mountShell(
      twoFactorApi({
        getTwoFactorStatus: vi.fn(async () => status({ pending_confirmation: true })),
      }),
    )

    await vi.waitFor(() =>
      expect(
        document.querySelector<HTMLElement>('[data-settings-2fa-status]')!.textContent,
      ).toContain('never finished'),
    )
    expect(
      document.querySelector<HTMLButtonElement>('[data-settings-2fa-begin]')!.textContent,
    ).toBe('Start again')
  })

  it('[security] warns before the recovery codes run out, not after', async () => {
    renderBrowserShell({ view: 'settings-user' })
    await mountShell(
      twoFactorApi({
        getTwoFactorStatus: vi.fn(async () =>
          status({ enrolled: true, recovery_codes_remaining: 1 }),
        ),
      }),
    )

    await vi.waitFor(() =>
      expect(
        document.querySelector<HTMLElement>('[data-settings-2fa-status]')!.textContent,
      ).toContain('Few recovery codes left'),
    )
  })

  it('stays out of the way in a build without the two-factor endpoints', async () => {
    renderBrowserShell({ view: 'settings-user' })
    await mountShell(browserApi())

    expect(panel().hidden).toBe(true)
  })
})
