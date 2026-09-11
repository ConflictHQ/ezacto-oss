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

const AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2'
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer'
const REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke'

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
}

export const authorizeUrl = (input: Readonly<AuthorizeUrlInput>): string => {
  const scopes = input.scopes ?? [QUICKBOOKS_ACCOUNTING_SCOPE]
  if (scopes.length === 0) throw new QuickBooksOAuthError('at least one scope is required')
  if (input.state.trim() === '') throw new QuickBooksOAuthError('state is required')
  const url = new URL(AUTHORIZE_URL)
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
    new Request(TOKEN_URL, {
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
    new Request(TOKEN_URL, {
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
    new Request(REVOKE_URL, {
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
