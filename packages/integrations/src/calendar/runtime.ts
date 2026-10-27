import {
  CalendarConnectionError,
  type CalendarConnectionStore,
  type CalendarOAuthStore,
  type CalendarProvider,
  type CalendarSourceFactory,
} from '@ezacto/core'
import { createCalendarSyncService } from '../calendar-sync.js'
import { createCalendarAuthorizationService } from './authorization.js'
import {
  createCalendarOAuthClient,
  createCalendarOAuthSourceFactory,
  type CalendarOAuthClient,
} from './oauth.js'
import { createGoogleCalendarSource, createMicrosoftCalendarSource } from './sources.js'

export interface CalendarEnvironment {
  GOOGLE_CALENDAR_CLIENT_ID?: string
  GOOGLE_CALENDAR_CLIENT_SECRET?: string
  MICROSOFT_CALENDAR_CLIENT_ID?: string
  MICROSOFT_CALENDAR_CLIENT_SECRET?: string
  MICROSOFT_CALENDAR_TENANT?: string
}
export const createConfiguredCalendarServices = async (options: {
  store: CalendarConnectionStore
  oauthStore: CalendarOAuthStore
  deploymentKey: Uint8Array
  environment: CalendarEnvironment
  appOrigin?: string
  sourceOverrides?: Readonly<Partial<Record<CalendarProvider, CalendarSourceFactory>>>
  fetch?: typeof globalThis.fetch
  now?: () => Date
}) => {
  const clients: Partial<Record<CalendarProvider, CalendarOAuthClient>> = {}
  const sources: Partial<Record<CalendarProvider, CalendarSourceFactory>> = {}
  for (const provider of ['google', 'microsoft'] as const) {
    const id =
      provider === 'google'
        ? options.environment.GOOGLE_CALENDAR_CLIENT_ID
        : options.environment.MICROSOFT_CALENDAR_CLIENT_ID
    const secret =
      provider === 'google'
        ? options.environment.GOOGLE_CALENDAR_CLIENT_SECRET
        : options.environment.MICROSOFT_CALENDAR_CLIENT_SECRET
    if (!id && !secret) continue
    if (!id || !secret || !options.appOrigin) throw new CalendarConnectionError('invalid')
    const client = createCalendarOAuthClient(provider, {
      clientId: id,
      clientSecret: secret,
      ...(provider === 'microsoft' && options.environment.MICROSOFT_CALENDAR_TENANT
        ? { tenant: options.environment.MICROSOFT_CALENDAR_TENANT }
        : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.now ? { now: options.now } : {}),
    })
    clients[provider] = client
    sources[provider] = createCalendarOAuthSourceFactory(
      client,
      (token) =>
        (provider === 'google' ? createGoogleCalendarSource : createMicrosoftCalendarSource)({
          ...token,
          ...(options.fetch ? { fetch: options.fetch } : {}),
        }),
      options.now,
    )
  }
  const sync = await createCalendarSyncService({
    store: options.store,
    deploymentKey: options.deploymentKey,
    sources: { ...sources, ...options.sourceOverrides },
    ...(options.now ? { now: options.now } : {}),
  })
  const authorization = await createCalendarAuthorizationService({
    store: options.oauthStore,
    connections: options.store,
    sync,
    clients,
    deploymentKey: options.deploymentKey,
    appOrigin:
      Object.keys(clients).length > 0 ? options.appOrigin! : 'https://unconfigured.invalid',
    ...(options.now ? { now: options.now } : {}),
  })
  return { sync, authorization, maintenance: authorization }
}
