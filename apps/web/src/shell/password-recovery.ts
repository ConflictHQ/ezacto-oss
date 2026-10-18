import { EzactoApiError } from '@conflict-hq/ezacto-client'
import { PASSWORD_MIN_CODE_POINTS, PASSWORD_MAX_CODE_POINTS, validatePassword } from '@ezacto/core'
import type { ShellApi } from './model.js'
import { isDemoDeployment } from '../demo.js'

/** Consume both new fragment links and already-delivered query links exactly once. */
export const takePasswordResetLink = (): { token: string | null } | null => {
  const url = new URL(globalThis.location.href)
  const fragment = new URLSearchParams(url.hash.slice(1))
  const queryReset = url.searchParams.getAll('auth').includes('password-reset')
  const fragmentReset = fragment.getAll('auth').includes('password-reset')
  if (!queryReset && !fragmentReset) return null
  const source = fragmentReset ? fragment : url.searchParams
  const tokens = source.getAll('token')
  const token = queryReset && fragmentReset ? null :
    source.getAll('auth').length === 1 && tokens.length === 1 && /^[A-Za-z0-9_-]{20,1024}$/.test(tokens[0]!) ? tokens[0]! : null
  url.searchParams.delete('auth'); url.searchParams.delete('token')
  if (fragmentReset) { fragment.delete('auth'); fragment.delete('token'); url.hash = fragment.toString() }
  globalThis.history.replaceState(null, '', url)
  return { token }
}

export const mountPasswordRecovery = (options: {
  api: Pick<ShellApi, 'requestPasswordReset' | 'resetPassword'>
  enter(): void
  leave(message?: string): void
}) => {
  const get = <T extends HTMLElement>(selector: string): T => {
    const element = document.querySelector<T>(selector)
    if (!element) throw new Error(`Missing password recovery element: ${selector}`)
    return element
  }
  const forgot = get<HTMLButtonElement>('[data-password-forgot]')
  const request = get<HTMLFormElement>('[data-password-request-form]')
  const reset = get<HTMLFormElement>('[data-password-reset-form]')
  const email = get<HTMLInputElement>('#ez-password-request-email')
  const password = get<HTMLInputElement>('#ez-password-reset-password')
  const confirmation = get<HTMLInputElement>('#ez-password-reset-confirm')
  const signIn = get<HTMLFormElement>('[data-sign-in-form]')
  const factor = get<HTMLFormElement>('[data-two-factor-form]')
  const requestResult = get<HTMLElement>('[data-password-request-result]')
  const resetResult = get<HTMLElement>('[data-password-reset-result]')
  const notice = get<HTMLElement>('[data-password-recovery-notice]')
  const available = () => !isDemoDeployment() && !get<HTMLElement>('[data-password-entry]').hidden &&
    options.api.requestPasswordReset !== undefined && options.api.resetPassword !== undefined
  forgot.hidden = !available()
  let token: string | null = null
  let busy = false
  let generation = 0
  let controller = new AbortController()
  const clearSecrets = () => { password.value = ''; confirmation.value = '' }
  const pending = (value: boolean) => {
    busy = value
    for (const form of [request, reset]) {
      form.setAttribute('aria-busy', String(value))
      for (const button of form.querySelectorAll<HTMLButtonElement>('button')) button.disabled = value
    }
    if (token === null) reset.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled = true
  }
  const clear = () => {
    generation += 1; controller.abort(); controller = new AbortController()
    token = null; clearSecrets(); pending(false)
    request.hidden = true; reset.hidden = true
    requestResult.textContent = ''; resetResult.textContent = ''
    notice.hidden = true; notice.textContent = ''
  }
  const show = (form: HTMLFormElement) => {
    signIn.hidden = true; factor.hidden = true
    request.hidden = form !== request; reset.hidden = form !== reset
    form.querySelector<HTMLInputElement>('input')?.focus()
  }
  const open = (link?: { token: string | null }) => {
    if (busy) return
    const address = get<HTMLInputElement>('#ez-sign-in-email').value
    options.enter() // invalidates pending shell loads and clears any cached identity
    clear()
    if (!available()) {
      options.leave()
      notice.textContent = isDemoDeployment() ? 'Password recovery is not available on the public demo.' :
        'Password recovery is unavailable for this workspace. Contact your administrator.'
      notice.hidden = false
      return
    }
    if (link) {
      token = link.token; pending(false); show(reset)
      if (!token) resetResult.textContent = 'This reset link is invalid. Request a new one.'
    } else { email.value = address; show(request) }
  }
  forgot.addEventListener('click', () => open())
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-password-recovery-back]')) {
    button.addEventListener('click', () => { if (!busy) { clear(); options.leave() } })
  }
  get<HTMLButtonElement>('[data-password-recovery-restart]').addEventListener('click', () => open())

  request.addEventListener('submit', event => {
    event.preventDefault()
    if (busy || request.hidden || !available()) return
    const address = email.value.trim()
    if (!address || !email.checkValidity()) { requestResult.textContent = 'Enter a valid email address.'; return }
    const current = generation
    pending(true); requestResult.textContent = 'Requesting a reset link…'
    void options.api.requestPasswordReset!(address, controller.signal).then(() => {
      if (current !== generation) return
      requestResult.textContent = 'If this account can reset its password, a reset link will arrive by email. Check your inbox and spam folder.'
    }).catch((error: unknown) => {
      if (current !== generation) return
      requestResult.textContent = error instanceof EzactoApiError && error.status === 429 ?
        'Too many requests. Wait before trying again.' : 'The reset link could not be requested. Try again later or contact your administrator.'
    }).finally(() => { if (current === generation) pending(false) })
  })
  reset.addEventListener('submit', event => {
    event.preventDefault()
    if (busy || reset.hidden || token === null || !available()) return
    try {
      validatePassword(password.value)
      if (password.value !== confirmation.value) throw new Error('confirmation mismatch')
    } catch {
      resetResult.textContent = `Use ${PASSWORD_MIN_CODE_POINTS}–${PASSWORD_MAX_CODE_POINTS.toLocaleString('en-US')} characters and enter the same password in both fields.`
      return
    }
    const current = generation
    const input = { token, password: password.value }
    clearSecrets(); pending(true); resetResult.textContent = 'Resetting your password…'
    void options.api.resetPassword!(input, controller.signal).then(() => {
      if (current !== generation) return
      clear(); options.leave('Password reset. Sign in with your new password.')
    }).catch((error: unknown) => {
      if (current !== generation) return
      if (error instanceof EzactoApiError && error.status === 401) {
        token = null; resetResult.textContent = 'This reset link is invalid, expired or already used. Sign in with your new password if the reset completed, or request a new link.'
      } else if (error instanceof EzactoApiError && error.status === 429) {
        resetResult.textContent = 'Too many attempts. Wait before trying again.'
      } else if (error instanceof EzactoApiError && error.status === 400) {
        resetResult.textContent = 'Check the password requirements and try again.'
      } else {
        token = null
        resetResult.textContent = 'We could not confirm the reset. Try signing in with your new password, or request a new reset link.'
      }
    }).finally(() => { input.password = ''; if (current === generation) pending(false) })
  })
  return { clear, open }
}
