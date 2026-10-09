import { describe, expect, it } from 'vitest'
import { appleWebConfiguration, createRuntimeAppleWeb } from '../src/apple-web.js'
import { configuredSignInProviders, createApp, type AppEnv } from '../src/app.js'
import type { AppleWebCustodyStore } from '@ezacto/core'

const env = (demo = false): AppEnv => ({ ENVIRONMENT: demo ? 'demo' : 'prod', RELEASE: 'test',
  APP_BASE_URL: demo ? 'https://ezacto.io' : 'https://app.example.com', ...(demo ? { DEMO_MODE: 'true' } : {}),
  APPLE_WEB_ENABLED: 'true', APPLE_WEB_SERVICES_ID: 'com.ezacto.web',
  APPLE_WEB_CAPABILITY_KEYS: JSON.stringify({ k1: 'A'.repeat(43) }), APPLE_WEB_ACTIVE_KEY_ID: 'k1', APPLE_WEB_ROUTING_SECRET: 'A'.repeat(43),
})
describe('Apple web deployment configuration', () => {
  it.each([false, true])('accepts only the complete approved deployment: demo=%s', demo => {
    const config = env(demo)
    expect(appleWebConfiguration(config)?.site).toBe(demo ? 'demo' : 'team')
    expect(appleWebConfiguration(config)?.servicesId).toBe('com.ezacto.web')
    expect(configuredSignInProviders(config)).toContain('apple')
  })
  it.each([
    { APP_BASE_URL: 'https://attacker.example' }, { APP_BASE_URL: 'https://time.conflict.com' },
    { APP_BASE_URL: 'https://app.example.com/path' }, { APPLE_WEB_SERVICES_ID: 'com.ezacto.app' },
    { APPLE_WEB_SERVICES_ID: 'com.ezacto.web.demo' }, { APPLE_WEB_ACTIVE_KEY_ID: 'missing' },
    { APPLE_WEB_CAPABILITY_KEYS: '{broken' }, { APPLE_WEB_ROUTING_SECRET: '' },
    { DEMO_MODE: 'true', ENVIRONMENT: 'demo' },
  ])('fails closed with incorrect or partial configuration: %j', patch => {
    const config = { ...env(), ...patch }
    expect(appleWebConfiguration(config)).toBeNull()
    expect(configuredSignInProviders(config)).not.toContain('apple')
  })
  it('does not make the production demo flag an accountless team bypass', () => {
    expect(appleWebConfiguration({ ...env(true), ENVIRONMENT: 'prod' })).toBeNull()
  })
  it('renders the configured provider on the public Worker shell without eagerly opening the database', async () => {
    const config = env()
    const response = await createApp().request('https://app.example.com/', {}, config)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('data-oidc-provider="apple"')
  })
  it('hides new sign-in while retaining valid custody configuration for cleanup', () => {
    const config = { ...env(), APPLE_WEB_ENABLED: 'false' }
    expect(appleWebConfiguration(config)).not.toBeNull()
    expect(configuredSignInProviders(config)).not.toContain('apple')
  })
  it('keeps cleanup status available when the encryption configuration is unavailable', async () => {
    const calls: string[] = []
    const store = {
      begin: async () => { calls.push('capture') },
      obligations: async () => [{ id: 'known-connection' }],
      manual: async () => { calls.push('manual') },
      status: async () => 'manual_required' as const,
    } as unknown as AppleWebCustodyStore
    const runtime = createRuntimeAppleWeb({ ...env(), APPLE_WEB_CAPABILITY_KEYS: '' }, store)
    expect(runtime.appleWebLifecycle).toBeUndefined()
    await runtime.appleWebCleanup.begin(1, 'deletion-request')
    expect(calls).toEqual(['capture'])
    await runtime.appleWebCleanup.perform('deletion-request')
    expect(calls).toEqual(['capture', 'manual'])
    expect(await runtime.appleWebCleanup.status('deletion-request')).toBe('manual_required')
  })
})
