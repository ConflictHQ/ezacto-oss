/** @vitest-environment happy-dom */
import { describe, expect, it, vi } from 'vitest'
import { renderAppleDisconnect, renderAppShell } from '../src/index.js'
import { authenticationError, browserApi, mountShell, renderBrowserShell } from './support/shell-harness.js'

describe('Apple web sign-in presentation', () => {
  it('shows configured Apple sign-in and discloses demo credential custody without claiming account creation', () => {
    document.body.innerHTML = renderAppShell({ environment: 'demo', release: 'test', demo: true, signInProviders: ['apple'] }).replace(/<script[^>]*>.*?<\/script>/gs, '').replace(/<link[^>]*>/g, '')
    const link = document.querySelector<HTMLAnchorElement>('[data-oidc-provider="apple"]')!
    expect(link.getAttribute('href')).toBe('/auth/apple/start')
    expect(link.textContent).toBe('Continue with Apple')
    expect(link.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/png;base64,/)
    expect(document.querySelector('.apple-authorization-note')?.textContent).toContain('does not create a workspace account')
    expect(document.querySelector('.apple-authorization-note')?.textContent).toContain('securely retains your Apple authorization')
    expect(document.querySelector('.apple-authorization-note')?.textContent).toContain('iPhone app and other Ezacto sites')
  })

  it('does not advertise an unconfigured Apple provider', () => {
    const html = renderAppShell({ environment: 'test', release: 'test' })
    expect(html).not.toContain('data-oidc-provider="apple"')
    expect(html).not.toContain('href="/auth/apple/disconnect"')
  })

  it('requires explicit acknowledgement and explains grouped impact on the disconnect page', () => {
    document.body.innerHTML = renderAppleDisconnect({ connected: true, unavailable: false }).replace(/<link[^>]*>/g, '')
    const form = document.querySelector<HTMLFormElement>('form')!
    expect(form.getAttribute('action')).toBe('/auth/apple/disconnect')
    expect(form.method).toBe('post')
    const confirm = form.querySelector<HTMLInputElement>('input[name="confirm"]')!
    expect(confirm.required).toBe(true)
    expect(confirm.checked).toBe(false)
    expect(confirm.value).toBe('disconnect')
    expect(document.body.textContent).toContain('iPhone app and other Ezacto sites')
    expect(document.body.textContent).toContain('records are not deleted')
  })

  it('offers reauthorization when the independent browser recovery handle is missing', () => {
    document.body.innerHTML = renderAppleDisconnect({ connected: false, unavailable: false }).replace(/<link[^>]*>/g, '')
    expect(document.querySelector('form')?.getAttribute('method')).toBe('get')
    expect(document.querySelector('[data-oidc-provider="apple"]')?.getAttribute('href')).toBe('/auth/apple/start?intent=disconnect')
    expect(document.body.textContent).toContain('does not create a workspace account or sign you in')
  })

  it('shows completed disconnect without offering another authorization immediately', () => {
    document.body.innerHTML = renderAppleDisconnect({ connected: false, unavailable: false, disconnected: true }).replace(/<link[^>]*>/g, '')
    expect(document.body.textContent).toContain('Apple authorization has been disconnected')
    expect(document.querySelector('form')).toBeNull()
  })

  it.each(['cancelled', 'private_email', '<img src=x onerror=alert(1)>'])('renders only safe result messages and removes the callback flag: %s', async result => {
    renderBrowserShell()
    globalThis.history.replaceState(null, '', '/?apple_sign_in=' + encodeURIComponent(result))
    await mountShell({ ...browserApi(), whoami: vi.fn(async () => { throw authenticationError(401, 'authentication_required') }) })
    const text = document.querySelector('[data-apple-sign-in-result]')?.textContent
    expect(text).toBe(result === 'cancelled' ? 'Apple sign-in was cancelled. You can try again.' : result === 'private_email' ? 'This private Apple email is not linked to your workspace. Use your existing sign-in method or ask an administrator for help.' : '')
    expect(globalThis.location.search).toBe('')
    expect(document.querySelector('[data-apple-sign-in-result] img')).toBeNull()
  })
})
