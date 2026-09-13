/**
 * Connecting a contractor's own Wise account (issue 543).
 *
 * The shape matters more than the vendor. A payout method belongs to the
 * *person*, not the organisation: a contractor authorises their own Wise
 * account, ezacto stores the reference Wise gives back, and payouts go there.
 * Deel (#103) is the same seam with a different implementation behind it, which
 * is why this lives beside the QuickBooks OAuth rather than inventing a second
 * pattern -- the difference between "Wise support" and "one payout seam with
 * two implementations" is whether the third one is cheap.
 *
 * What this is deliberately not: #101, the BankFeed seam, is Mercury and Wise
 * reconciling money *arriving* from clients. Same vendor, opposite direction.
 * A reader who confuses them will wire a payout to an inbound matcher.
 *
 * Wise separates sandbox from live by hostname, so the environment is a base
 * URL rather than a flag threaded through every call.
 */

export type WiseEnvironment = 'sandbox' | 'live'

const HOSTS: Record<WiseEnvironment, { api: string; authorize: string }> = {
  sandbox: {
    api: 'https://api.sandbox.transferwise.tech',
    authorize: 'https://sandbox.transferwise.tech/oauth/authorize',
  },
  live: {
    api: 'https://api.wise.com',
    authorize: 'https://wise.com/oauth/authorize',
  },
}

export class WiseOAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WiseOAuthError'
  }
}

export interface WiseTokens {
  readonly accessToken: string
  readonly refreshToken: string
  /** Absolute, not a duration: a duration is only meaningful beside the moment it was issued. */
  readonly expiresAt: string
}

export interface WiseAuthorizeUrlInput {
  readonly clientId: string
  readonly redirectUri: string
  /**
   * Opaque, single-use, and checked on the way back. Without it a third party
   * can walk a contractor through connecting *their* Wise account, and the
   * payouts that follow go to a stranger. This is the whole authorisation.
   */
  readonly state: string
  readonly environment: WiseEnvironment
}

export const wiseAuthorizeUrl = (input: Readonly<WiseAuthorizeUrlInput>): string => {
  if (input.state.trim() === '') throw new WiseOAuthError('state is required')
  if (input.clientId.trim() === '') throw new WiseOAuthError('clientId is required')
  const url = new URL(HOSTS[input.environment].authorize)
  url.searchParams.set('client_id', input.clientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('state', input.state)
  return url.toString()
}

const asObject = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WiseOAuthError('token response was not an object')
  }
  return value as Record<string, unknown>
}

const text = (body: Record<string, unknown>, field: string): string => {
  const value = body[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WiseOAuthError(`token response is missing ${field}`)
  }
  return value
}

const expiry = (body: Record<string, unknown>, now: () => Date): string => {
  const value = body.expires_in
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new WiseOAuthError('token response is missing expires_in')
  }
  return new Date(now().getTime() + value * 1000).toISOString()
}

export interface WiseTokenExchangeInput {
  readonly clientId: string
  readonly clientSecret: string
  readonly redirectUri: string
  readonly code: string
  readonly environment: WiseEnvironment
  readonly fetchImplementation?: typeof fetch
  readonly now?: () => Date
}

/**
 * Wise authenticates the token endpoint with HTTP Basic on the client
 * credentials, like QuickBooks. The secret never travels in the body, so it
 * cannot end up in a query log that captured a form post.
 */
const basic = (clientId: string, clientSecret: string): string =>
  `Basic ${btoa(`${clientId}:${clientSecret}`)}`

export const exchangeWiseAuthorizationCode = async (
  input: Readonly<WiseTokenExchangeInput>,
): Promise<WiseTokens> => {
  const now = input.now ?? (() => new Date())
  const call = input.fetchImplementation ?? fetch
  const response = await call(`${HOSTS[input.environment].api}/oauth/token`, {
    method: 'POST',
    headers: {
      authorization: basic(input.clientId, input.clientSecret),
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
    }).toString(),
  })
  if (!response.ok) {
    throw new WiseOAuthError(`Wise refused the authorization code (${String(response.status)})`)
  }
  const body = asObject(await response.json())
  return {
    accessToken: text(body, 'access_token'),
    refreshToken: text(body, 'refresh_token'),
    expiresAt: expiry(body, now),
  }
}

export interface WiseTokenRefreshInput {
  readonly clientId: string
  readonly clientSecret: string
  readonly refreshToken: string
  readonly environment: WiseEnvironment
  readonly fetchImplementation?: typeof fetch
  readonly now?: () => Date
}

export const refreshWiseAccessToken = async (
  input: Readonly<WiseTokenRefreshInput>,
): Promise<WiseTokens> => {
  const now = input.now ?? (() => new Date())
  const call = input.fetchImplementation ?? fetch
  const response = await call(`${HOSTS[input.environment].api}/oauth/token`, {
    method: 'POST',
    headers: {
      authorization: basic(input.clientId, input.clientSecret),
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
    }).toString(),
  })
  if (!response.ok) {
    throw new WiseOAuthError(`Wise refused the refresh token (${String(response.status)})`)
  }
  const body = asObject(await response.json())
  return {
    accessToken: text(body, 'access_token'),
    // Wise rotates the refresh token. Keeping the old one would work until it
    // silently stopped, which is the worst moment to discover it.
    refreshToken: text(body, 'refresh_token'),
    expiresAt: expiry(body, now),
  }
}

export interface WiseProfile {
  /** Wise's own identifier for the account holder. This is what gets stored. */
  readonly id: string
  readonly type: 'personal' | 'business'
  readonly fullName: string | null
}

/**
 * Who the person that just authorised actually is.
 *
 * The point of the whole flow: a payout must resolve to an identifier the
 * provider gave us, never to a name or an address we matched on. #421 exists
 * because matching on an address is a guess whose failure mode is paying the
 * wrong person.
 */
/**
 * Quotes every `id` in a body before it is parsed.
 *
 * `JSON.parse` rounds an integer past 2^53 to the nearest double, and it does
 * so before a reviver or any later `String(...)` can see the original digits.
 * So reading the id "as a string" off the parsed object stringifies a number
 * that is already the wrong one: the quoting has to happen on the text or not
 * at all.
 *
 * Wise's own ids are comfortably inside the safe range today, which is exactly
 * why this is worth doing now rather than after one is not -- a rounded profile
 * id addresses somebody else's account, and nothing about that failure looks
 * like a parsing bug when it happens.
 */
const quoteIds = (body: string): string => body.replace(/"id"\s*:\s*(-?\d+)/gu, '"id":"$1"')

export const fetchWiseProfiles = async (
  input: Readonly<{
    accessToken: string
    environment: WiseEnvironment
    fetchImplementation?: typeof fetch
  }>,
): Promise<readonly WiseProfile[]> => {
  const call = input.fetchImplementation ?? fetch
  const response = await call(`${HOSTS[input.environment].api}/v2/profiles`, {
    headers: { authorization: `Bearer ${input.accessToken}`, accept: 'application/json' },
  })
  if (!response.ok) {
    throw new WiseOAuthError(`Wise refused the profile request (${String(response.status)})`)
  }
  const body = JSON.parse(quoteIds(await response.text())) as unknown
  if (!Array.isArray(body)) throw new WiseOAuthError('profile response was not an array')
  return body.map((entry) => {
    const profile = asObject(entry)
    const id = profile.id
    if (typeof id !== 'number' && typeof id !== 'string') {
      throw new WiseOAuthError('a Wise profile carried no id')
    }
    const type = profile.type
    return {
      id: String(id),
      type: type === 'business' ? 'business' : 'personal',
      fullName:
        typeof profile.fullName === 'string'
          ? profile.fullName
          : typeof profile.name === 'string'
            ? profile.name
            : null,
    }
  })
}

export const wiseApiBase = (environment: WiseEnvironment): string => HOSTS[environment].api
