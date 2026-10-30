/** @vitest-environment happy-dom */

import { describe, expect, it, vi } from 'vitest'
import type { TwoFactorStatus } from '@conflict-hq/ezacto-client'
import {
  EzactoApiError,
  authenticationError,
  browserApi,
  mountShell,
  renderBrowserShell,
  submitSignIn,
  submitTwoFactorCode,
  type ShellApi,
} from './support/shell-harness.js'

/**
 * Issue 770, slice C: the emailed second factor in the app. The server decides
 * who is offered it; these tests pin that the screens say what the server said
 * and nothing more.
 */
const status = (overrides: Partial<TwoFactorStatus> = {}): TwoFactorStatus => ({
  enrolled: false,
  email_enabled: false,
  pending_confirmation: false,
  recovery_codes_remaining: 0,
  ...overrides,
})

describe('emailed code in your own settings', () => {
  const settingsApi = (overrides: Record<string, unknown> = {}) => ({
    ...browserApi(),
    getTwoFactorStatus: vi.fn(async () => status()),
    enableTwoFactorEmail: vi.fn(async () => status({ email_enabled: true })),
    disableTwoFactorEmail: vi.fn(async () => status()),
    ...overrides,
  })
  const block = () => document.querySelector<HTMLElement>('[data-settings-2fa-email]')!
  const on = () => document.querySelector<HTMLButtonElement>('[data-settings-2fa-email-on]')!
  const off = () => document.querySelector<HTMLButtonElement>('[data-settings-2fa-email-off]')!
  const result = () =>
    document.querySelector<HTMLElement>('[data-settings-2fa-email-result]')!.textContent

  it('turns the factor on and then offers to turn it off', async () => {
    renderBrowserShell({ view: 'settings-user' })
    const api = settingsApi()
    await mountShell(api)
    await vi.waitFor(() => expect(on().hidden).toBe(false))
    expect(off().hidden).toBe(true)

    on().click()
    await vi.waitFor(() => expect(api.enableTwoFactorEmail).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(off().hidden).toBe(false))
    expect(on().hidden).toBe(true)
    expect(document.querySelector('[data-settings-2fa-facts]')!.textContent).toContain(
      'Emailed code',
    )
  })

  it('turns it off without asking for a code, since the server asks for none', async () => {
    renderBrowserShell({ view: 'settings-user' })
    const api = settingsApi({
      getTwoFactorStatus: vi.fn(async () => status({ email_enabled: true })),
    })
    await mountShell(api)
    await vi.waitFor(() => expect(off().hidden).toBe(false))

    off().click()
    await vi.waitFor(() => expect(api.disableTwoFactorEmail).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(on().hidden).toBe(false))
  })

  it('says the trade-off and the exclusions where the choice is made', async () => {
    renderBrowserShell({ view: 'settings-user' })
    await mountShell(settingsApi())
    await vi.waitFor(() => expect(block().hidden).toBe(false))
    const text = block().textContent!
    expect(text).toContain('never contains a link')
    expect(text).toContain('weaker than an authenticator app')
    expect(text).toContain('emailed link')
  })

  it('says to verify an address first when the server refuses for that', async () => {
    renderBrowserShell({ view: 'settings-user' })
    await mountShell(
      settingsApi({
        enableTwoFactorEmail: vi.fn(async () => {
          throw new EzactoApiError(409, { error: { code: 'verified_email_required' } }, null)
        }),
      }),
    )
    await vi.waitFor(() => expect(on().hidden).toBe(false))
    on().click()
    await vi.waitFor(() => expect(result()).toContain('Verify your email address'))
    expect(on().hidden).toBe(false)
  })

  it('stays out of the way in a build without the route', async () => {
    renderBrowserShell({ view: 'settings-user' })
    await mountShell({ ...browserApi(), getTwoFactorStatus: vi.fn(async () => status()) })
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLElement>('[data-settings-2fa]')!.hidden).toBe(false),
    )
    expect(block().hidden).toBe(true)
  })
})

describe('emailed code at sign-in', () => {
  const challenge = (methods: readonly ('totp' | 'email')[]) => ({
    status: 'two_factor_required' as const,
    challenge: 'C'.repeat(43),
    expires_at: '2026-10-18T12:05:00.000Z',
    methods,
  })
  const form = () => document.querySelector<HTMLFormElement>('[data-two-factor-form]')!
  const sendButton = () =>
    document.querySelector<HTMLButtonElement>('[data-two-factor-email]')!
  const hint = () => document.querySelector<HTMLElement>('[data-two-factor-hint]')!.textContent
  const message = () =>
    document.querySelector<HTMLElement>('[data-two-factor-result]')!.textContent

  const open = async (api: Record<string, unknown>) => {
    renderBrowserShell()
    await mountShell({ ...browserApi(), ...api } as unknown as ShellApi)
    submitSignIn('ada@example.test', 'correct horse battery staple')
    await vi.waitFor(() => expect(form().hidden).toBe(false))
  }

  it('offers "email me a code" to a person who also has an authenticator, and sends nothing yet', async () => {
    const sendTwoFactorEmailCode = vi.fn()
    await open({ signIn: vi.fn(async () => challenge(['totp', 'email'])), sendTwoFactorEmailCode })
    expect(sendButton().hidden).toBe(false)
    expect(sendButton().textContent).toBe('Email me a code')
    expect(hint()).toContain('authenticator')
    expect(sendTwoFactorEmailCode).not.toHaveBeenCalled()
  })

  it('tells an email-only person the code is already on its way', async () => {
    await open({ signIn: vi.fn(async () => challenge(['email'])) })
    expect(hint()).toContain('We emailed')
    expect(hint()).not.toContain('authenticator')
    expect(sendButton().textContent).toBe('Send a new code')
  })

  it('offers nothing about email to an authenticator-only person', async () => {
    await open({ signIn: vi.fn(async () => challenge(['totp'])) })
    expect(sendButton().hidden).toBe(true)
    expect(hint()).toContain('authenticator app')
  })

  it('[security] uses the new challenge after a code is mailed, because the old one died', async () => {
    const fresh = { ...challenge(['totp', 'email']), challenge: 'D'.repeat(43) }
    const sendTwoFactorEmailCode = vi.fn(async () => fresh)
    const completeTwoFactorChallenge = vi.fn(async () => undefined)
    await open({
      signIn: vi.fn(async () => challenge(['totp', 'email'])),
      sendTwoFactorEmailCode,
      completeTwoFactorChallenge,
    })

    sendButton().click()
    await vi.waitFor(() =>
      expect(sendTwoFactorEmailCode).toHaveBeenCalledWith(
        { challenge: 'C'.repeat(43) },
        expect.any(AbortSignal),
      ),
    )
    await vi.waitFor(() => expect(message()).toContain('Code sent'))
    expect(sendButton().textContent).toBe('Send a new code')

    submitTwoFactorCode('654321')
    await vi.waitFor(() =>
      expect(completeTwoFactorChallenge).toHaveBeenCalledWith(
        { code: '654321', challenge: 'D'.repeat(43) },
        expect.any(AbortSignal),
      ),
    )
  })

  it('asks the person to wait when the server rate limits the mail', async () => {
    await open({
      signIn: vi.fn(async () => challenge(['totp', 'email'])),
      sendTwoFactorEmailCode: vi.fn(async () => {
        throw authenticationError(429, 'rate_limit_exceeded')
      }),
    })
    sendButton().click()
    await vi.waitFor(() => expect(message()).toContain('Wait a minute'))
    expect(form().hidden).toBe(false)
    expect(sendButton().disabled).toBe(false)
  })

  it('returns to the password when the challenge died before the mail was asked for', async () => {
    await open({
      signIn: vi.fn(async () => challenge(['totp', 'email'])),
      sendTwoFactorEmailCode: vi.fn(async () => {
        throw authenticationError(401, 'two_factor_challenge_invalid')
      }),
    })
    sendButton().click()
    await vi.waitFor(() => expect(form().hidden).toBe(true))
    expect(
      document.querySelector<HTMLElement>('[data-sign-in-result]')!.textContent,
    ).toContain('expired')
  })

  it('[security] never offers the mail on a challenge that names no methods', async () => {
    // The magic-link landing names none, and the server refuses the mail there
    // by design; the screen does not tempt it.
    await open({ signIn: vi.fn(async () => ({ ...challenge([]), methods: undefined })) })
    expect(sendButton().hidden).toBe(true)
  })
})
