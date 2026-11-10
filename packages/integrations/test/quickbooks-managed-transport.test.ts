import { describe, expect, it, vi } from 'vitest'
import { createQuickBooksRuntime, type QuickBooksRuntimeOptions } from '../src/quickbooks/runtime.js'

const fixture = () => {
  const begin = vi.fn()
  const consume = vi.fn()
  const transport = vi.fn()
  const options = {
    config: { clientId: 'host-app', clientSecret: undefined, appBaseUrl: 'https://tenant.example',
      webhookVerifierToken: undefined, environment: 'sandbox' },
    store: { beginAuthorization: begin, consumeAuthorization: consume },
    source: {}, reconciliation: {}, fetch: vi.fn(), now: () => new Date('2026-01-01T00:00:00Z'),
    managedRefreshExchange: transport,
  } as unknown as QuickBooksRuntimeOptions
  return { begin, consume, transport, options }
}

describe('trusted managed QuickBooks refresh transport', () => {
  it('refuses construction without durable refresh ownership', () => {
    const { options, transport } = fixture()
    expect(() => createQuickBooksRuntime(options)).toThrow('requires durable ownership')
    expect(transport).not.toHaveBeenCalled()
  })

  it('does not fall through to native OAuth or consume a state when the host owns credentials', async () => {
    const { options, begin, consume, transport } = fixture()
    const runtime = createQuickBooksRuntime({ ...options, managedRefresh: {
      status: async () => 'ready', refresh: async () => { throw new Error('unexpected refresh') },
    } })
    expect(runtime.service.configured!()).toBe(true)
    await expect(runtime.service.authorizeUrl({ state: 'state', redirectUri: 'https://tenant.example/callback' })).rejects.toMatchObject({ code: 'provider_unavailable' })
    await expect(runtime.service.beginAuthorization({ state: 'state', userId: 1, redirectUri: 'https://tenant.example/callback' })).rejects.toMatchObject({ code: 'provider_unavailable' })
    await expect(runtime.service.completeAuthorization({ state: 'state', code: 'code', realmId: '123' })).rejects.toMatchObject({ code: 'provider_unavailable' })
    expect(begin).not.toHaveBeenCalled()
    expect(consume).not.toHaveBeenCalled()
    expect(transport).not.toHaveBeenCalled()
  })
})
