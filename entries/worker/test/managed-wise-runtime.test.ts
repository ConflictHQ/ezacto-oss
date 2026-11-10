import { expect, it, vi } from 'vitest'
import { createWorker } from '../src/index.js'
import { createRuntimeServices } from '../src/runtime.js'
import type { WorkerEnv } from '../src/app.js'
import type { WorkerManagedWise } from '../src/managed-providers.js'
import { fixture, calls, data, key } from '../../../packages/db/test/support/managed-wise-fixture.js'

it('[integration #1237] the actual Worker uses tenant Wise reads and suppresses all foreign deployment payment/feed credentials', async () => {
  const instant = new Date().toISOString()
  const tenants = [await fixture('d1', 'WORKER_A', '111', instant), await fixture('d1', 'WORKER_B', '222', instant)]
  const scopes = new WeakMap<object, (typeof tenants)[number]>()
  for (const tenant of tenants) { data(await tenant.configure()); scopes.set(tenant.binding!, tenant) }
  const compose = vi.fn(async ({ scope, database }: Parameters<WorkerManagedWise['compose']>[0]) => {
    const tenant = scopes.get(scope)
    if (!tenant) throw new Error('Unknown trusted tenant scope')
    return { ...(await tenant.runtime(database)), webhook: { receiveWebhook: vi.fn(async () => ({ accepted: true })) } }
  })
  const port: WorkerManagedWise = { configured: scope => scopes.get(scope)?.isEnabled() === true, compose }
  const worker = createWorker({ managedWise: port })
  const context = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext
  for (const tenant of tenants) {
    const env: WorkerEnv = { DB: tenant.binding!, ENVIRONMENT: 'test', RELEASE: 'a'.repeat(40),
      API_CURSOR_SIGNING_KEY: key(3), APP_BASE_URL: 'https://owned.example',
      WISE_TOKEN: 'PRIVATE_FOREIGN_DEPLOYMENT', WISE_PROFILE_ID: '999',
      WISE_WEBHOOK_PUBLIC_KEY: 'PRIVATE_FOREIGN_WEBHOOK', WISE_MODE: 'full',
      WISE_BANK_FEED_TOKEN: 'PRIVATE_FOREIGN_BANK_FEED', WISE_BANK_FEED_PROFILE_ID: '999',
      WISE_BANK_FEED_BALANCE_ID: '999', WISE_BANK_FEED_CURRENCY: 'USD',
    }
    const before = calls.length
    const response = await worker.fetch!(new Request('https://owned.example/api/v1/integrations/wise', {
      headers: { cookie: `__Host-ezacto_session=${tenant.admin.token}` },
    }) as Request<unknown, IncomingRequestCfProperties>, env, context)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ data: { configured: true, connection: { profile_id: tenant.profileId } } })
    expect(calls.slice(before).every(call => call.profile === tenant.profileId && call.method === 'GET')).toBe(true)
    const services = await createRuntimeServices(env, { managedWise: port })
    expect(services.wiseWebhook).toBeUndefined()
    await expect(services.paymentRuns!.preview({} as never, 2, 'owned-read', instant)).rejects.toThrow('Wise is not configured for this instance.')
    expect(await services.bankFeeds!.status()).toContainEqual(expect.objectContaining({ provider: 'wise', configured: false }))
    const absent = { configured: () => true, compose: vi.fn(async () => null) }
    const unavailable = await createRuntimeServices(env, { managedWise: absent })
    expect(unavailable.wise).toBeUndefined()
    await expect(unavailable.paymentRuns!.preview({} as never, 2, 'owned-absent', instant)).rejects.toThrow('Wise is not configured for this instance.')
    for (const extra of [{ DEMO_MODE: 'true', ENVIRONMENT: 'dev' }, { ACCOUNTING_ENABLED: 'false' }]) {
      const count = compose.mock.calls.length, exchanges = calls.length
      expect((await createRuntimeServices({ ...env, ...extra }, { managedWise: port })).wise).toBeUndefined()
      expect(compose.mock.calls.length).toBe(count)
      expect(calls).toHaveLength(exchanges)
    }
    tenant.disable()
    const count = calls.length
    expect((await createRuntimeServices(env, { managedWise: port })).wise).toBeUndefined()
    expect(calls).toHaveLength(count)
  }
})
