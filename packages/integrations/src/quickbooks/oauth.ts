/**
 * Intuit OAuth 2.0, the half behind a "Connect to QuickBooks" button.
 *
 * The transport is injected rather than reached for, like the Deel client
 * beside it: this runs on the Worker and in the container, and its tests must
 * not touch Intuit, where a stray token exchange burns a single-use code and
 * leaves an operator staring at a connect button that already worked once.
 *
 * Nothing here has a default credential, an environment lookup, or a sandbox
 * fallback. The client id, the secret and the redirect URI are all supplied by
 * the caller from deployment configuration.
 */

/**
 * The scope this integration asks for, and deliberately only this one.
 *
 * `com.intuit.quickbooks.accounting` covers customers, invoices and the payments
 * recorded against them -- everything a mirror needs in both directions.
 * `com.intuit.quickbooks.payment` is the card-processing API, which is a
 * different thing: taking a payment ourselves rather than reading one QuickBooks
 * already took. Asking for it "in case" would mean asking every operator to
 * grant card processing to an app that does not process cards.
 *
 * Making a mirrored invoice payable does not need it either -- that is
 * `AllowOnlineACHPayment` on the invoice itself, which rides on this scope and
 * on the company's own QuickBooks Payments account.
 */
export const QUICKBOOKS_ACCOUNTING_SCOPE = 'com.intuit.quickbooks.accounting'

/**
 * Intuit's OAuth endpoints, as published in its discovery document.
 *
 * These are the values the document has carried since it was introduced, kept
 * as the fallback for a deployment that cannot reach it -- Intuit's own guidance
 * is to read the document rather than pin them, and `discoverEndpoints` does.
 */
export const QUICKBOOKS_DEFAULT_ENDPOINTS: QuickBooksOAuthEndpoints = {
  authorizationEndpoint: 'https://appcenter.intuit.com/connect/oauth2',
  tokenEndpoint: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
  revocationEndpoint: 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke',
}

export const QUICKBOOKS_DISCOVERY_URL =
  'https://developer.api.intuit.com/.well-known/openid_configuration'
export const QUICKBOOKS_SANDBOX_DISCOVERY_URL =
  'https://developer.api.intuit.com/.well-known/openid_sandbox_configuration'

export interface QuickBooksOAuthEndpoints {
  readonly authorizationEndpoint: string
  readonly tokenEndpoint: string
  readonly revocationEndpoint: string
}

/** How long a fetched document is trusted before it is read again. */
const DISCOVERY_TTL_MS = 60 * 60 * 1_000

const discovered = new Map<string, { endpoints: QuickBooksOAuthEndpoints; fetchedAt: number }>()

const httpsUrl = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

/**
 * The endpoints Intuit currently publishes for the OAuth flow.
 *
 * Read from the discovery document so a moved endpoint is followed rather than
 * failed against, and cached for an hour per isolate so the token exchange is
 * not two round trips. A document that cannot be fetched, or that omits or
 * malforms an endpoint, yields the published defaults for that endpoint: the
 * document is a convenience for staying current, never a reason to refuse a
 * sign-in that the defaults would have completed.
 */
export const discoverEndpoints = async (input: {
  readonly fetch: (request: Request) => Promise<Response>
  readonly now: Date
  /** `sandbox` reads the sandbox document; anything else the production one. */
  readonly environment?: string | undefined
  readonly discoveryUrl?: string
}): Promise<QuickBooksOAuthEndpoints> => {
  const url =
    input.discoveryUrl ??
    (input.environment?.trim().toLowerCase() === 'sandbox'
      ? QUICKBOOKS_SANDBOX_DISCOVERY_URL
      : QUICKBOOKS_DISCOVERY_URL)
  const cached = discovered.get(url)
  if (cached !== undefined && input.now.getTime() - cached.fetchedAt < DISCOVERY_TTL_MS) {
    return cached.endpoints
  }
  let endpoints = QUICKBOOKS_DEFAULT_ENDPOINTS
  try {
    const response = await input.fetch(
      new Request(url, { method: 'GET', headers: { accept: 'application/json' } }),
    )
    if (response.ok) {
      const body = (await response.json()) as Record<string, unknown>
      endpoints = {
        authorizationEndpoint:
          httpsUrl(body['authorization_endpoint']) ??
          QUICKBOOKS_DEFAULT_ENDPOINTS.authorizationEndpoint,
        tokenEndpoint:
          httpsUrl(body['token_endpoint']) ?? QUICKBOOKS_DEFAULT_ENDPOINTS.tokenEndpoint,
        revocationEndpoint:
          httpsUrl(body['revocation_endpoint']) ??
          QUICKBOOKS_DEFAULT_ENDPOINTS.revocationEndpoint,
      }
    }
  } catch {
    // Unreachable or unparsable: the defaults stand, and the next call after
    // the TTL asks again. Nothing here is worth failing an operator's connect.
  }
  discovered.set(url, { endpoints, fetchedAt: input.now.getTime() })
  return endpoints
}

/** For tests: forget what discovery has cached. */
export const forgetDiscoveredEndpoints = (): void => {
  discovered.clear()
}

/**
 * Intuit's refresh tokens are long-lived but not permanent, and the lifetime is
 * a property of the token rather than of the connection: every refresh returns a
 * new one with a new expiry, and letting the old one lapse means the operator
 * has to press Connect again. Stored so a job can see a connection going stale
 * before a mirror fails on it.
 */
export interface QuickBooksTokens {
  readonly accessToken: string
  readonly refreshToken: string
  /** Absolute, not a duration: a stored `expires_in` is wrong the moment it is read. */
  readonly accessTokenExpiresAt: string
  readonly refreshTokenExpiresAt: string
}

export interface QuickBooksConnectionIdentity {
  /** Intuit's id for the connected QuickBooks company. Every API path carries it. */
  readonly realmId: string
}

export type QuickBooksConnection = QuickBooksTokens & QuickBooksConnectionIdentity

export class QuickBooksOAuthError extends Error {
  readonly status: number | null
  /** Intuit's own code, where it sent one -- `invalid_grant` and friends. */
  readonly code: string | null

  constructor(message: string, status: number | null = null, code: string | null = null) {
    super(message)
    this.name = 'QuickBooksOAuthError'
    this.status = status
    this.code = code
  }
}

export interface AuthorizeUrlInput {
  readonly clientId: string
  readonly redirectUri: string
  /**
   * Opaque, single-use, and checked on the way back. This is the only thing
   * standing between the callback and a forged authorization: without it a
   * third party can walk an administrator through connecting *their* QuickBooks
   * company to this instance.
   */
  readonly state: string
  readonly scopes?: readonly string[]
  /** From `discoverEndpoints`; the published defaults when absent. */
  readonly endpoints?: QuickBooksOAuthEndpoints
}

export const authorizeUrl = (input: Readonly<AuthorizeUrlInput>): string => {
  const scopes = input.scopes ?? [QUICKBOOKS_ACCOUNTING_SCOPE]
  if (scopes.length === 0) throw new QuickBooksOAuthError('at least one scope is required')
  if (input.state.trim() === '') throw new QuickBooksOAuthError('state is required')
  const url = new URL((input.endpoints ?? QUICKBOOKS_DEFAULT_ENDPOINTS).authorizationEndpoint)
  url.searchParams.set('client_id', input.clientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', scopes.join(' '))
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('state', input.state)
  return url.toString()
}

const basicAuthorization = (clientId: string, clientSecret: string): string =>
  `Basic ${btoa(`${clientId}:${clientSecret}`)}`

const tokenBody = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new QuickBooksOAuthError('token response was not an object')
  }
  return value as Record<string, unknown>
}

const text = (body: Record<string, unknown>, field: string): string => {
  const value = body[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new QuickBooksOAuthError(`token response is missing ${field}`)
  }
  return value
}

const seconds = (body: Record<string, unknown>, field: string): number => {
  const value = body[field]
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new QuickBooksOAuthError(`token response is missing ${field}`)
  }
  return value
}

/**
 * Intuit returns lifetimes, and a lifetime is only meaningful beside the instant
 * it was issued. The clock is passed in so a test can state the instant rather
 * than tolerate whatever `Date.now()` said while it ran.
 */
const tokensFrom = (body: Record<string, unknown>, now: Date): QuickBooksTokens => ({
  accessToken: text(body, 'access_token'),
  refreshToken: text(body, 'refresh_token'),
  accessTokenExpiresAt: new Date(
    now.getTime() + seconds(body, 'expires_in') * 1_000,
  ).toISOString(),
  refreshTokenExpiresAt: new Date(
    now.getTime() + seconds(body, 'x_refresh_token_expires_in') * 1_000,
  ).toISOString(),
})

const readError = async (response: Response): Promise<never> => {
  let code: string | null = null
  let description: string | null = null
  try {
    const body = (await response.json()) as Record<string, unknown>
    if (typeof body['error'] === 'string') code = body['error']
    if (typeof body['error_description'] === 'string') {
      description = body['error_description']
    }
  } catch {
    // A non-JSON body from the token endpoint is itself the diagnosis; the
    // status carries what there is to say about it.
  }
  throw new QuickBooksOAuthError(
    `Intuit token request failed with status ${String(response.status)}${
      description === null ? '' : `: ${description}`
    }`,
    response.status,
    code,
  )
}

export interface TokenExchangeInput {
  readonly clientId: string
  readonly clientSecret: string
  readonly redirectUri: string
  readonly code: string
  readonly fetch: (request: Request) => Promise<Response>
  readonly now: Date
  /** From `discoverEndpoints`; the published defaults when absent. */
  readonly endpoints?: QuickBooksOAuthEndpoints
}

/**
 * The authorization code is single use and short-lived. A failure here is
 * terminal for that code -- retrying the same one gets `invalid_grant` -- so
 * callers surface it rather than scheduling a retry.
 */
export const exchangeAuthorizationCode = async (
  input: Readonly<TokenExchangeInput>,
): Promise<QuickBooksTokens> => {
  const response = await input.fetch(
    new Request((input.endpoints ?? QUICKBOOKS_DEFAULT_ENDPOINTS).tokenEndpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: basicAuthorization(input.clientId, input.clientSecret),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: input.redirectUri,
      }).toString(),
    }),
  )
  if (!response.ok) await readError(response)
  return tokensFrom(tokenBody(await response.json()), input.now)
}

export interface TokenRefreshInput {
  readonly clientId: string
  readonly clientSecret: string
  readonly refreshToken: string
  readonly fetch: (request: Request) => Promise<Response>
  readonly now: Date
  /** From `discoverEndpoints`; the published defaults when absent. */
  readonly endpoints?: QuickBooksOAuthEndpoints
}

/**
 * Every refresh returns a *new* refresh token, and the one just used stops
 * working. Callers must store what comes back before the next request goes out,
 * or a crash between the two leaves a connection that cannot be refreshed and
 * cannot be told apart from one an operator revoked.
 */
export const refreshAccessToken = async (
  input: Readonly<TokenRefreshInput>,
): Promise<QuickBooksTokens> => {
  const response = await input.fetch(
    new Request((input.endpoints ?? QUICKBOOKS_DEFAULT_ENDPOINTS).tokenEndpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: basicAuthorization(input.clientId, input.clientSecret),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: input.refreshToken,
      }).toString(),
    }),
  )
  if (!response.ok) await readError(response)
  return tokensFrom(tokenBody(await response.json()), input.now)
}

export interface TokenRevokeInput {
  readonly clientId: string
  readonly clientSecret: string
  /** Either token revokes the whole grant; the refresh token is the durable one. */
  readonly token: string
  readonly fetch: (request: Request) => Promise<Response>
  /** From `discoverEndpoints`; the published defaults when absent. */
  readonly endpoints?: QuickBooksOAuthEndpoints
}

/**
 * Disconnecting tells Intuit, rather than only forgetting locally.
 *
 * A local-only disconnect leaves the grant standing on the operator's Intuit
 * account, where it reads as an app that still has access to their books. That
 * is a false statement about who can see their money.
 */
export const revokeConnection = async (input: Readonly<TokenRevokeInput>): Promise<void> => {
  const response = await input.fetch(
    new Request((input.endpoints ?? QUICKBOOKS_DEFAULT_ENDPOINTS).revocationEndpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: basicAuthorization(input.clientId, input.clientSecret),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token: input.token }),
    }),
  )
  // 200 and 204 both mean revoked. Intuit answers 400 for a token it does not
  // recognise, which is the state the caller wanted anyway.
  if (response.ok || response.status === 400) return
  await readError(response)
}

/**
 * Whether an access token should be refreshed before the next call.
 *
 * The margin is not politeness. A token that expires mid-flight fails a mirror
 * that had already decided what to write, and the retry then has to be safe --
 * which it is, but only because the idempotency work exists. Refreshing early
 * keeps that path rare rather than routine.
 */
export const accessTokenNeedsRefresh = (
  tokens: Pick<QuickBooksTokens, 'accessTokenExpiresAt'>,
  now: Date,
  marginSeconds = 120,
): boolean =>
  new Date(tokens.accessTokenExpiresAt).getTime() - now.getTime() <= marginSeconds * 1_000
