import { describe, expect, it, vi } from 'vitest'
import { createApp, type Env } from '../src/app.js'

/**
 * Issue 761, and the defect that reached dev before this test existed.
 *
 * The shell HTML is not a data request, so it is served by an app built with no
 * `RuntimeServices` at all. The sign-in setting was read off those services, so
 * on the Worker it was never read: the card kept offering a Google button while
 * the routes behind it had already started refusing. Everything here is about
 * the services-less app, because that is the one that renders the page.
 */

const env = {
  ENVIRONMENT: 'test',
  RELEASE: 'abc1234def5678',
  OIDC_GOOGLE_CLIENT_ID: 'client-id',
  OIDC_GOOGLE_CLIENT_SECRET: 'client-secret',
  OIDC_REDIRECT_ORIGIN: 'https://app.example.test',
} as unknown as Env

const surface = (
  states: readonly { method: string; enabled: boolean }[] | null,
) => ({ read: vi.fn(async () => states as never) })

const signInCard = async (
  methods: ReturnType<typeof surface> | undefined,
): Promise<string> => {
  const app = createApp(undefined, undefined, undefined, methods)
  const response = await app.request('/', {}, env)
  expect(response.status).toBe(200)
  return response.text()
}

describe('the sign-in card on the services-less path', () => {
  it('[security] drops a provider the operator switched off', async () => {
    const html = await signInCard(
      surface([
        { method: 'password', enabled: true },
        { method: 'google', enabled: false },
      ]),
    )
    expect(html).not.toContain('data-oidc-provider="google"')
    expect(html).toMatch(/data-password-entry>/u)
  })

  it('[security] drops the password form when that is the one switched off', async () => {
    const html = await signInCard(
      surface([
        { method: 'password', enabled: false },
        { method: 'google', enabled: true },
      ]),
    )
    expect(html).toContain('data-oidc-provider="google"')
    expect(html).toMatch(/data-password-entry hidden>/u)
  })

  it('[api] offers everything configured while the setting is untouched', async () => {
    const html = await signInCard(surface([]))
    expect(html).toContain('data-oidc-provider="google"')
    expect(html).toMatch(/data-password-entry>/u)
  })

  it('[security] offers everything configured when the setting cannot be read', async () => {
    // A database that has not reached 0085, or has no binding at all. The
    // routes enforce independently, so offering one method too many is a bad
    // answer where offering none would be a locked door.
    for (const methods of [surface(null), undefined]) {
      const html = await signInCard(methods)
      expect(html).toContain('data-oidc-provider="google"')
      expect(html).toMatch(/data-password-entry>/u)
    }
  })

  it('[unit] reads the setting per render, not once at startup', async () => {
    // The setting changes under a running instance, and the isolate outlives
    // the change.
    const methods = surface([{ method: 'google', enabled: false }])
    const app = createApp(undefined, undefined, undefined, methods)
    await app.request('/', {}, env)
    await app.request('/dashboard', {}, env)
    expect(methods.read).toHaveBeenCalledTimes(2)
  })
})
