/** @vitest-environment happy-dom */
import { beforeEach, expect, it, vi } from 'vitest'
import { browserApi, renderBrowserShell, mountShell, authenticationError, deferred, EzactoApiError, type ShellApi } from './support/shell-harness.js'
import { takePasswordResetLink } from '../src/shell/password-recovery.js'

const token = 'ezacto_reset_abcdefghijklmnop_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi1234567'
const element = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const input = (selector: string, value: string) => { element<HTMLInputElement>(selector).value = value }
const submit = (selector: string) => element<HTMLFormElement>(selector).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
const visible = (selector: string) => !element<HTMLElement>(selector).hidden
const setup = () => ({ ...browserApi(), whoami: vi.fn(async () => { throw authenticationError(401, 'unauthorized') }),
  requestPasswordReset: vi.fn<NonNullable<ShellApi['requestPasswordReset']>>(async () => undefined),
  resetPassword: vi.fn<NonNullable<ShellApi['resetPassword']>>(async () => undefined) })
beforeEach(() => renderBrowserShell())

it.each(['query', 'fragment'])('consumes %s reset links before account loads and removes token from navigation', async kind => {
  window.history.replaceState(null, '', `/${kind === 'query' ? '?' : '#'}auth=password-reset&token=${token}`)
  const api = setup()
  await mountShell(api)
  expect(window.location.href).not.toContain(token)
  expect(window.location.href).not.toContain('password-reset')
  expect(api.whoami).not.toHaveBeenCalled()
  expect(visible('[data-password-reset-form]')).toBe(true)
  expect(visible('[data-sign-in-form]')).toBe(false)
  expect(document.documentElement.dataset['authState']).toBe('signed-out')
  expect(JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)])).not.toContain(token)
})

it('rejects ambiguous and missing tokens while removing them from the URL', () => {
  for (const suffix of [`?auth=password-reset&token=${token}&token=another`, '#auth=password-reset',
    `?auth=password-reset&token=${token}#auth=password-reset&token=${token}`]) {
    window.history.replaceState(null, '', '/' + suffix)
    expect(takePasswordResetLink()).toEqual({ token: null })
    expect(window.location.href).not.toContain(token)
  }
})

it('requests a reset uniformly, avoids double submission and keeps the account signed out', async () => {
  const api = setup(); const pending = deferred<void>()
  api.requestPasswordReset.mockImplementation(() => pending.promise)
  await mountShell(api)
  element<HTMLButtonElement>('[data-password-forgot]').click()
  input('#ez-password-request-email', 'unknown@example.test')
  submit('[data-password-request-form]'); submit('[data-password-request-form]')
  expect(api.requestPasswordReset).toHaveBeenCalledTimes(1)
  expect(api.requestPasswordReset).toHaveBeenCalledWith('unknown@example.test', expect.any(AbortSignal))
  pending.resolve(); await vi.waitFor(() => expect(element('[data-password-request-result]').textContent).toContain('If this account'))
  expect(api.signIn).not.toHaveBeenCalled()
})

it('validates confirmation, submits the consumed token once and clears passwords without auto sign-in', async () => {
  window.history.replaceState(null, '', `/#auth=password-reset&token=${token}`)
  const api = setup(); await mountShell(api)
  input('#ez-password-reset-password', 'a new long password')
  input('#ez-password-reset-confirm', 'different password')
  submit('[data-password-reset-form]')
  expect(api.resetPassword).not.toHaveBeenCalled()
  input('#ez-password-reset-confirm', 'a new long password')
  let sent: unknown
  const pending = deferred<void>()
  api.resetPassword.mockImplementation((...args) => { sent = structuredClone(args[0]); return pending.promise })
  submit('[data-password-reset-form]'); submit('[data-password-reset-form]')
  expect(sent).toEqual({ token, password: 'a new long password' })
  expect(api.resetPassword).toHaveBeenCalledTimes(1)
  expect(element<HTMLInputElement>('#ez-password-reset-password').value).toBe('')
  pending.resolve()
  await vi.waitFor(() => expect(element('[data-sign-in-result]').textContent).toContain('Password reset.'))
  expect(visible('[data-password-reset-form]')).toBe(false)
  expect(visible('[data-sign-in-form]')).toBe(true)
  expect(api.signIn).not.toHaveBeenCalled()
})

it.each([401, 503])('disables reuse after reset failure %s without leaking provider details', async status => {
  window.history.replaceState(null, '', `/#auth=password-reset&token=${token}`)
  const api = setup()
  api.resetPassword.mockRejectedValue(new EzactoApiError(status, { error: { code: 'invalid_auth_token', message: 'private-detail' } }, null))
  await mountShell(api)
  input('#ez-password-reset-password', 'a new long password'); input('#ez-password-reset-confirm', 'a new long password')
  submit('[data-password-reset-form]')
  await vi.waitFor(() => expect(element('[data-password-reset-result]').textContent).toContain(status === 401 ? 'expired or already used' : 'could not confirm'))
  expect(element<HTMLButtonElement>('[data-password-reset-form] [type="submit"]').disabled).toBe(true)
  expect(document.body.textContent).not.toContain('private-detail')
  submit('[data-password-reset-form]'); expect(api.resetPassword).toHaveBeenCalledTimes(1)
  element<HTMLButtonElement>('[data-password-recovery-restart]').click()
  expect(visible('[data-password-request-form]')).toBe(true)
})

it('does not offer recovery when password authentication is disabled', async () => {
  element('[data-password-entry]').hidden = true
  window.history.replaceState(null, '', `/#auth=password-reset&token=${token}`)
  const api = setup(); await mountShell(api)
  expect(element<HTMLButtonElement>('[data-password-forgot]').hidden).toBe(true)
  expect(visible('[data-password-reset-form]')).toBe(false)
  expect(visible('[data-password-recovery-notice]')).toBe(true)
  expect(element('[data-password-recovery-notice]').textContent).toContain('unavailable')
  expect(api.resetPassword).not.toHaveBeenCalled()
})

it('keeps public demo credentials protected and hides the unavailable recovery action', async () => {
  renderBrowserShell({ demo: true })
  const api = setup(); await mountShell(api)
  expect(element<HTMLButtonElement>('[data-password-forgot]').hidden).toBe(true)
  element<HTMLButtonElement>('[data-password-forgot]').click()
  expect(visible('[data-password-request-form]')).toBe(false)
  expect(api.requestPasswordReset).not.toHaveBeenCalled()
})
