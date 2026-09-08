import { describe, expect, it } from 'vitest'
import {
  cloudflareAccessConfig,
  configuredSignInProviders,
  githubProvider,
  oidcProvider,
  type WorkerEnv,
} from '../src/app.js'

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
    // Prod no longer carries a literal, so it is the deploy-time value that
    // answers -- and an attacker-supplied APP_BASE_URL still cannot move it.
    expect(
      oidcProvider(
        'google',
        environment({
          ...credentials,
          ENVIRONMENT: 'prod',
          OIDC_REDIRECT_ORIGIN: 'https://time.acme.test',
        }),
      )?.redirectOrigin,
    ).toBe('https://time.acme.test')
  })

  it('[unit] refuses to serve OIDC in prod with no declared redirect origin', () => {
    // The old code fell back to a constant. A fallback here is the bug: a prod
    // install with this unset would otherwise send its authorization codes to
    // whichever host the constant happened to name.
    expect(() =>
      oidcProvider(
        'google',
        environment({
          OIDC_GOOGLE_CLIENT_ID: 'client-id',
          OIDC_GOOGLE_CLIENT_SECRET: 'client-secret',
          APP_BASE_URL: 'https://attacker.example',
          ENVIRONMENT: 'prod',
        }),
      ),
    ).toThrow(/OIDC_REDIRECT_ORIGIN is required in prod/)
  })

  it('[unit] refuses a redirect origin that is not one', () => {
    // Userinfo is the trick worth naming: `https://good.example@evil.example`
    // reads as the trusted host to a person and resolves to the attacker's to a
    // browser. Normalising it would be worse than refusing it.
    for (const value of [
      'https://good.example@evil.example',
      'http://time.acme.test',
      'https://time.acme.test/callback',
      'https://time.acme.test/?next=evil',
      'not-a-url',
    ]) {
      expect(() =>
        oidcProvider(
          'google',
          environment({
            OIDC_GOOGLE_CLIENT_ID: 'client-id',
            OIDC_GOOGLE_CLIENT_SECRET: 'client-secret',
            ENVIRONMENT: 'prod',
            OIDC_REDIRECT_ORIGIN: value,
          }),
        ),
      ).toThrow(/OIDC_REDIRECT_ORIGIN/)
    }
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

describe('Worker GitHub provider registry', () => {
  it('[security] exposes no provider when the GitHub credential pair is absent', () => {
    expect(githubProvider(environment())).toBeNull()
  })

  it('[security] rejects a partial GitHub configuration', () => {
    expect(() =>
      githubProvider(environment({ GITHUB_CLIENT_ID: 'gh-client-id' })),
    ).toThrow(/configured together/)
    expect(() =>
      githubProvider(environment({ GITHUB_CLIENT_SECRET: 'gh-client-secret' })),
    ).toThrow(/configured together/)
  })

  it('[security] advertises GitHub only for a complete, valid runtime configuration', () => {
    expect(configuredSignInProviders(environment())).toEqual([])
    expect(
      configuredSignInProviders(
        environment({
          APP_BASE_URL: 'https://local-tunnel.example',
          GITHUB_CLIENT_ID: 'gh-client-id',
          GITHUB_CLIENT_SECRET: 'gh-client-secret',
        }),
      ),
    ).toEqual(['github'])
  })

  it('[unit] advertises both Google and GitHub when both are fully configured', () => {
    expect(
      configuredSignInProviders(
        environment({
          APP_BASE_URL: 'https://local-tunnel.example',
          OIDC_GOOGLE_CLIENT_ID: 'client-id',
          OIDC_GOOGLE_CLIENT_SECRET: 'client-secret',
          GITHUB_CLIENT_ID: 'gh-client-id',
          GITHUB_CLIENT_SECRET: 'gh-client-secret',
        }),
      ),
    ).toEqual(['google', 'github'])
  })

  it('[acceptance] pins separate live callback origins independent of the request host', () => {
    const credentials = {
      GITHUB_CLIENT_ID: 'gh-client-id',
      GITHUB_CLIENT_SECRET: 'gh-client-secret',
      APP_BASE_URL: 'https://attacker.example',
    }
    expect(
      githubProvider(environment({ ...credentials, ENVIRONMENT: 'dev' }))
        ?.redirectOrigin,
    ).toBe('https://ezacto.io')
    expect(
      githubProvider(
        environment({
          ...credentials,
          ENVIRONMENT: 'prod',
          OIDC_REDIRECT_ORIGIN: 'https://time.acme.test',
        }),
      )?.redirectOrigin,
    ).toBe('https://time.acme.test')
  })
})

describe('Worker Cloudflare Access provider registry', () => {
  const access = {
    ACCESS_TEAM_DOMAIN: 'https://ezacto-test.cloudflareaccess.com',
    ACCESS_POLICY_AUD: 'a'.repeat(64),
  }

  it('[unit] remains optional and accepts only a complete fixed provider pair', () => {
    expect(cloudflareAccessConfig(environment())).toBeNull()
    expect(cloudflareAccessConfig(environment(access))).toEqual({
      teamDomain: access.ACCESS_TEAM_DOMAIN,
      audience: access.ACCESS_POLICY_AUD,
    })
  })

  it.each([
    { ACCESS_TEAM_DOMAIN: access.ACCESS_TEAM_DOMAIN },
    { ACCESS_POLICY_AUD: access.ACCESS_POLICY_AUD },
    {
      ...access,
      ACCESS_TEAM_DOMAIN: 'http://ezacto-test.cloudflareaccess.com',
    },
    { ...access, ACCESS_TEAM_DOMAIN: 'https://attacker.example' },
    { ...access, ACCESS_TEAM_DOMAIN: `${access.ACCESS_TEAM_DOMAIN}/` },
  ])(
    '[security] rejects partial or malformed Access configuration %#',
    (values) => {
      expect(() => cloudflareAccessConfig(environment(values))).toThrow()
    },
  )

  it('[security] does not advertise edge Access as an application redirect provider', () => {
    expect(configuredSignInProviders(environment(access))).toEqual([])
  })
})
