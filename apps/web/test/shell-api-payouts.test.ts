import { describe, expect, it, vi } from 'vitest'
import { createShellApi } from '../src/shell/model.js'

// The team page's payout panel calls these by name. The shell builds that
// object method by method, so a method left out here is silently absent in the
// browser: the panel hides rather than failing. This pins the list.
const teamPayoutMethods = [
  'getWisePayoutDestination',
  'shareWiseProfile',
  'removeWisePayoutDestination',
  'listPayoutProviders',
  'listPayoutAccounts',
  'linkPayoutAccount',
  'detachPayoutAccount',
  'setPayoutProviderEnabled',
] as const

describe('shell API adapter for the team payout panel (issue 1152)', () => {
  it('[unit] exposes every payout method the team page calls', () => {
    const api = createShellApi({} as never) as unknown as Record<string, unknown>
    for (const name of teamPayoutMethods) {
      expect(typeof api[name], name).toBe('function')
    }
  })

  it('[unit] forwards provider and account calls to the client', async () => {
    const client = {
      listPayoutProviders: vi.fn(async () => ({ data: [{ provider: 'deel', enabled: true }] })),
      listPayoutAccounts: vi.fn(async () => ({ data: [] })),
      linkPayoutAccount: vi.fn(async () => ({ data: {} })),
      detachPayoutAccount: vi.fn(async () => undefined),
      setPayoutProviderEnabled: vi.fn(async () => undefined),
    }
    const api = createShellApi(client as never) as unknown as Record<string, (args: unknown) => Promise<unknown>>
    const signal = new AbortController().signal

    expect(await api['listPayoutProviders']!({ signal })).toEqual({ data: [{ provider: 'deel', enabled: true }] })
    await api['listPayoutAccounts']!({ id: 7, signal })
    await api['linkPayoutAccount']!({ id: 7, body: { provider: 'deel', external_id: 'a@example.test' }, signal })
    await api['detachPayoutAccount']!({ id: 31, signal })
    await api['setPayoutProviderEnabled']!({ provider: 'wise', body: { enabled: false }, signal })

    expect(client.listPayoutAccounts).toHaveBeenCalledWith({ id: 7, signal })
    expect(client.linkPayoutAccount).toHaveBeenCalledWith({
      id: 7,
      body: { provider: 'deel', external_id: 'a@example.test' },
      signal,
    })
    expect(client.detachPayoutAccount).toHaveBeenCalledWith({ id: 31, signal })
    expect(client.setPayoutProviderEnabled).toHaveBeenCalledWith({
      provider: 'wise',
      body: { enabled: false },
      signal,
    })
  })
})
