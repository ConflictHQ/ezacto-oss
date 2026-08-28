import { describe, expect, it } from 'vitest'
import { configuredSignInProviders, oidcProvider, type WorkerEnv } from '../src/app.js'

const environment = (
  values: Partial<WorkerEnv> = {},
): WorkerEnv =>
  ({
    ENVIRONMENT: 'test',
    RELEASE: 'oidc-config-test',
    DB: {} as D1Database,
    API_CURSOR_SIGNING_KEY: 'unused',
    ...values,
  })

describe('Worker OIDC provider registry', () => {
  it('[security] exposes no provider when the Google credential pair is absent', () => {
    expect(oidcProvider('google', environment())).toBeNull()
    expect(
      oidcProvider(
        'github',
        environment({
          OIDC_GOOGLE_CLIENT_ID: 'client-id',
          OIDC_GOOGLE_CLIENT_SECRET: 'client-secret',
        }),
      ),
    ).toBeNull()
  })

  it('[security] rejects a partial Google configuration', () => {
    expect(() =>
      oidcProvider(
        'google',
        environment({ OIDC_GOOGLE_CLIENT_ID: 'client-id' }),
      ),
    ).toThrow(/configured together/)
    expect(() =>
      oidcProvider(
        'google',
        environment({ OIDC_GOOGLE_CLIENT_SECRET: 'client-secret' }),
      ),
    ).toThrow(/configured together/)
  })

  it('[security] advertises Google only for a complete, valid runtime configuration', () => {
    expect(configuredSignInProviders(environment())).toEqual([])
    expect(
      configuredSignInProviders(
        environment({
          APP_BASE_URL: 'https://local-tunnel.example',
          OIDC_GOOGLE_CLIENT_ID: 'client-id',
        }),
      ),
    ).toEqual([])
    expect(
      configuredSignInProviders(
        environment({
          OIDC_GOOGLE_CLIENT_ID: 'client-id',
          OIDC_GOOGLE_CLIENT_SECRET: 'client-secret',
        }),
      ),
    ).toEqual([])
    expect(
      configuredSignInProviders(
        environment({
          APP_BASE_URL: 'https://local-tunnel.example',
          OIDC_GOOGLE_CLIENT_ID: 'client-id',
          OIDC_GOOGLE_CLIENT_SECRET: 'client-secret',
        }),
      ),
    ).toEqual(['google'])
  })

  it('[acceptance] pins separate live callback origins independent of the request host', () => {
    const credentials = {
      OIDC_GOOGLE_CLIENT_ID: 'client-id',
      OIDC_GOOGLE_CLIENT_SECRET: 'client-secret',
      APP_BASE_URL: 'https://attacker.example',
    }
    expect(
      oidcProvider('google', environment({ ...credentials, ENVIRONMENT: 'dev' }))
        ?.redirectOrigin,
    ).toBe('https://ezacto.io')
    expect(
      oidcProvider('google', environment({ ...credentials, ENVIRONMENT: 'prod' }))
        ?.redirectOrigin,
    ).toBe('https://app.example.com')
  })

  it('[unit] permits an explicit local/test origin without trusting the request host', () => {
    expect(
      oidcProvider(
        'google',
        environment({
          APP_BASE_URL: 'https://local-tunnel.example',
          OIDC_GOOGLE_CLIENT_ID: 'client-id',
          OIDC_GOOGLE_CLIENT_SECRET: 'client-secret',
        }),
      )?.redirectOrigin,
    ).toBe('https://local-tunnel.example')
  })
})
