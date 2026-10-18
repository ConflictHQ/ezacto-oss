import { assertAppleWebCustodyConfig, createAppleWebLifecycle, type AppleWebCustodyConfig, type AppleWebLifecyclePort } from '@ezacto/api'
import type { AppleWebCleanupPort, AppleWebCustodyStore } from '@ezacto/core'
import type { AppEnv } from './app.js'

export function appleWebConfiguration(env: AppEnv): AppleWebCustodyConfig | null {
  try {
    if (!env.APPLE_WEB_SERVICES_ID || !env.APP_BASE_URL || !env.APPLE_WEB_CAPABILITY_KEYS || !env.APPLE_WEB_ACTIVE_KEY_ID || !env.APPLE_WEB_ROUTING_SECRET) return null
    const keys: unknown = JSON.parse(env.APPLE_WEB_CAPABILITY_KEYS)
    if (typeof keys !== 'object' || keys === null || Array.isArray(keys) || !Object.values(keys).every(value => typeof value === 'string')) return null
    const config: AppleWebCustodyConfig = { site: env.APP_BASE_URL === 'https://ezacto.io' ? 'demo' : 'team',
      servicesId: env.APPLE_WEB_SERVICES_ID, redirectOrigin: env.APP_BASE_URL,
      encryptionKeys: keys as Record<string, string>, activeKeyId: env.APPLE_WEB_ACTIVE_KEY_ID, routingSecret: env.APPLE_WEB_ROUTING_SECRET }
    assertAppleWebCustodyConfig(config)
    if ((config.site === 'demo') !== (env.ENVIRONMENT !== 'prod' && env.DEMO_MODE === 'true')) return null
    return config
  } catch { return null }
}

export function createRuntimeAppleWeb(env: AppEnv, store: AppleWebCustodyStore): {
  appleWebCleanup: AppleWebCleanupPort
  appleWebLifecycle?: AppleWebLifecyclePort
} {
  const config = appleWebConfiguration(env)
  if (config === null) return {
    appleWebCleanup: {
      async begin(userId, requestId) {
        const now = new Date().toISOString()
        await store.begin(userId, requestId, now)
      },
      async perform(requestId: string) {
        const now = new Date().toISOString()
        for (const connection of await store.obligations(requestId)) await store.manual(connection.id, now)
      },
      status: requestId => store.status(requestId),
    },
  }
  const lifecycle = createAppleWebLifecycle({ config, store, signInAllowed: env.APPLE_WEB_ENABLED === 'true' })
  return { appleWebLifecycle: lifecycle, appleWebCleanup: lifecycle }
}
