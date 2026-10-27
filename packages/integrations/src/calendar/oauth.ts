import {
  CalendarAuthorizationError,
  CalendarConnectionError,
  validateCalendarGrant,
  type CalendarOAuthGrant,
  type CalendarProvider,
  type CalendarSource,
  type CalendarSourceFactory,
} from '@ezacto/core'

export interface CalendarOAuthClient {
  readonly provider: CalendarProvider
  authorizationUrl(input: { state: string; challenge: string; redirectUri: string }): string
  exchange(input: {
    code: string
    verifier: string
    redirectUri: string
    signal?: AbortSignal
    retainRejectedGrant(grant: CalendarOAuthGrant): Promise<void>
  }): Promise<CalendarOAuthGrant>
  refresh(
    grant: CalendarOAuthGrant,
    retainRejectedGrant: (grant: CalendarOAuthGrant) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<CalendarOAuthGrant>
  revoke(grant: CalendarOAuthGrant, signal?: AbortSignal): Promise<'revoked' | 'manual_required'>
}
export interface CalendarOAuthClientOptions {
  clientId: string
  clientSecret: string
  tenant?: string
  fetch?: typeof globalThis.fetch
  now?: () => Date
}
const googleScope = 'https://www.googleapis.com/auth/calendar.readonly'
const microsoftScope = 'https://graph.microsoft.com/Calendars.Read'
const invalid = (): never => {
  throw new CalendarConnectionError('invalid')
}
const credential = (value: unknown, maximum = 16384): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum && !/\p{Cc}/u.test(value)
const allowedScopes = (provider: CalendarProvider, scopes: readonly string[]) => {
  const normalized = scopes.map((scope) => scope.toLowerCase())
  const read = provider === 'google' ? googleScope.toLowerCase() : 'calendars.read'
  const canonical = normalized.map((scope) =>
    scope.replace(/^https:\/\/graph\.microsoft\.com\//, ''),
  )
  if (
    !canonical.includes(read) ||
    canonical.some(
      (scope) => scope !== read && !(provider === 'microsoft' && scope === 'offline_access'),
    )
  )
    throw new CalendarAuthorizationError()
}
const bodyJson = async (response: Response): Promise<Record<string, unknown>> => {
  const maximum = 65536
  if (Number(response.headers.get('content-length')) > maximum) {
    await response.body?.cancel()
    return invalid()
  }
  const reader = response.body?.getReader()
  if (!reader) return invalid()
  const parts: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > maximum) {
        await reader.cancel()
        return invalid()
      }
      parts.push(chunk.value)
    }
    const bytes = new Uint8Array(length)
    let at = 0
    for (const part of parts) {
      bytes.set(part, at)
      at += part.byteLength
    }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
    return value as Record<string, unknown>
  } catch {
    return invalid()
  } finally {
    reader.releaseLock()
  }
}

/** Dedicated calendar grants only; no sign-in grant, directory scope or arbitrary endpoint. */
export const createCalendarOAuthClient = (
  provider: CalendarProvider,
  options: CalendarOAuthClientOptions,
): CalendarOAuthClient => {
  if (!credential(options.clientId, 1024) || !credential(options.clientSecret, 4096))
    return invalid()
  const tenant = options.tenant ?? 'common'
  if (
    provider === 'microsoft' &&
    !/^(common|organizations|consumers|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/.test(
      tenant,
    )
  )
    return invalid()
  const authorize =
    provider === 'google'
      ? 'https://accounts.google.com/o/oauth2/v2/auth'
      : `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`
  const token =
    provider === 'google'
      ? 'https://oauth2.googleapis.com/token'
      : `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`
  const scopes = provider === 'google' ? [googleScope] : [microsoftScope, 'offline_access']
  const now = options.now ?? (() => new Date())
  const request = async (url: string, body: URLSearchParams, signal?: AbortSignal) => {
    try {
      return await (options.fetch ?? globalThis.fetch)(url, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body,
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
          : AbortSignal.timeout(20000),
      })
    } catch {
      throw new CalendarConnectionError('unavailable')
    }
  }
  const obtain = async (
    body: URLSearchParams,
    retainRejectedGrant: (grant: CalendarOAuthGrant) => Promise<void>,
    previous?: CalendarOAuthGrant,
    signal?: AbortSignal,
  ) => {
    body.set('client_id', options.clientId)
    body.set('client_secret', options.clientSecret)
    const response = await request(token, body, signal)
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel()
      throw new CalendarConnectionError('unavailable')
    }
    if (!response.ok) {
      const status = response.status
      const error: Record<string, unknown> = await bodyJson(response).catch(() => ({}))
      if (
        status === 401 ||
        status === 403 ||
        (status === 400 && (error.error === 'invalid_grant' || error.error === 'invalid_client'))
      )
        throw new CalendarAuthorizationError()
      throw new CalendarConnectionError('unavailable')
    }
    const value = await bodyJson(response)
    const refreshToken = value.refresh_token ?? previous?.refreshToken
    const cleanupToken = credential(refreshToken)
      ? refreshToken
      : credential(value.access_token)
        ? value.access_token
        : null
    try {
      if (
        !credential(value.access_token) ||
        !credential(refreshToken) ||
        typeof value.token_type !== 'string' ||
        value.token_type.toLowerCase() !== 'bearer' ||
        typeof value.expires_in !== 'number' ||
        !Number.isSafeInteger(value.expires_in) ||
        value.expires_in < 1 ||
        value.expires_in > 86400
      )
        return invalid()
      const granted =
        value.scope === undefined
          ? (previous?.scopes ?? scopes)
          : typeof value.scope === 'string' && value.scope.length <= 8192
            ? value.scope.split(/\s+/).filter(Boolean)
            : invalid()
      allowedScopes(provider, granted)
      return validateCalendarGrant({
        accessToken: value.access_token,
        refreshToken,
        expiresAt: new Date(now().getTime() + value.expires_in * 1000).toISOString(),
        scopes: granted,
      })
    } catch (error) {
      if (cleanupToken) {
        await retainRejectedGrant({ refreshToken: cleanupToken, scopes: [] })
        throw new CalendarAuthorizationError()
      }
      throw error
    }
  }
  return {
    provider,
    authorizationUrl(input) {
      const url = new URL(authorize)
      url.search = new URLSearchParams({
        client_id: options.clientId,
        redirect_uri: input.redirectUri,
        response_type: 'code',
        scope: scopes.join(' '),
        state: input.state,
        code_challenge: input.challenge,
        code_challenge_method: 'S256',
        ...(provider === 'google'
          ? { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false' }
          : { response_mode: 'query', prompt: 'select_account' }),
      }).toString()
      return url.href
    },
    exchange: (input) =>
      obtain(
        new URLSearchParams({
          grant_type: 'authorization_code',
          code: input.code,
          code_verifier: input.verifier,
          redirect_uri: input.redirectUri,
        }),
        input.retainRejectedGrant,
        undefined,
        input.signal,
      ),
    refresh: (grant, retainRejectedGrant, signal) => {
      allowedScopes(provider, grant.scopes)
      return obtain(
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: grant.refreshToken,
          ...(provider === 'microsoft' ? { scope: scopes.join(' ') } : {}),
        }),
        retainRejectedGrant,
        grant,
        signal,
      )
    },
    async revoke(grant, signal) {
      // Microsoft has no app-scoped token-revoke endpoint under Calendars.Read.
      // Do not silently request directory-write authority or end every session.
      if (provider === 'microsoft') return 'manual_required'
      const response = await request(
        'https://oauth2.googleapis.com/revoke',
        new URLSearchParams({ token: grant.refreshToken }),
        signal,
      )
      if (response.ok) {
        await response.body?.cancel()
        return 'revoked'
      }
      if (response.status === 400 && (await bodyJson(response)).error === 'invalid_token')
        return 'revoked'
      await response.body?.cancel().catch(() => undefined)
      throw new CalendarConnectionError('unavailable')
    },
  }
}

export const createCalendarOAuthSourceFactory =
  (
    client: CalendarOAuthClient,
    source: (options: { getAccessToken(signal?: AbortSignal): Promise<string> }) => CalendarSource,
    now: () => Date = () => new Date(),
  ): CalendarSourceFactory =>
  async (context) => {
    let grant = validateCalendarGrant(context.grant)
    allowedScopes(client.provider, grant.scopes)
    let refreshing: Promise<string> | null = null
    return source({
      async getAccessToken(signal) {
        signal?.throwIfAborted()
        if (
          grant.accessToken &&
          grant.expiresAt &&
          Date.parse(grant.expiresAt) > now().getTime() + 60000
        )
          return grant.accessToken
        refreshing ??= (async () => {
          if (!context.retainRejectedGrant) throw new CalendarConnectionError('unavailable')
          const next = await client.refresh(grant, context.retainRejectedGrant, signal)
          await context.rotateGrant(next)
          grant = next
          return next.accessToken!
        })().finally(() => {
          refreshing = null
        })
        return refreshing
      },
    })
  }
