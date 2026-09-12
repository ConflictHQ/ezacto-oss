/**
 * A signed-in BILL API session.
 *
 * BILL has no OAuth. There is no authorization code, no consent screen and no
 * token to refresh: you post a username, a password, an organization id and a
 * developer key, and you get a session id back. That is worth stating plainly
 * because it is the whole reason this integration is shaped differently from
 * the QuickBooks mirror -- there, an operator grants access and we never see a
 * credential; here the deployment holds one.
 *
 * What makes that tolerable rather than reckless is that an ezacto instance is
 * one organisation and the operator is the account holder. This is a deployment
 * holding its own credential, the way it already holds an SMTP password. It is
 * still weaker than a grant, and the mitigation is scope: nothing here can move
 * money. Creating and sending an invoice and reading what was received are the
 * whole surface, and BILL puts paying, charging and voiding behind an MFA
 * challenge this code has no way to answer even if it tried.
 *
 * The session expires on IDLE, not on age. BILL's rule is that thirty-five
 * minutes without a call ends it and any call resets the clock, so a long-lived
 * mirror that ticks every few minutes never re-logs in, and one that runs
 * nightly re-logs in every time. Modelling that as "last used" rather than
 * "issued at" is the difference between those two being correct and one of them
 * silently re-authenticating on every call.
 */

export const BILL_SANDBOX_BASE_URL = 'https://gateway.stage.bill.com/connect'
export const BILL_PRODUCTION_BASE_URL = 'https://gateway.prod.bill.com/connect'

/** BILL ends a session after this long without a request. */
export const BILL_SESSION_IDLE_SECONDS = 35 * 60

export class BillAuthError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'BillAuthError'
    this.status = status
  }
}

export interface BillCredentials {
  readonly username: string
  readonly password: string
  /** BILL's organisation id. Begins `008`. */
  readonly companyId: string
  readonly devKey: string
}

export interface BillSession {
  readonly sessionId: string
  /**
   * When this session last carried a request. The expiry is idle-based, so this
   * moves on every call rather than being fixed at login.
   */
  readonly lastUsedAt: string
}

export interface BillLoginOptions {
  readonly credentials: BillCredentials
  readonly fetch: (request: Request) => Promise<Response>
  readonly baseUrl?: string
  /** The instant to stamp the session with; injected so tests own the clock. */
  readonly now: string
}

const requireValue = (value: string, field: string): string => {
  if (value.trim() === '') throw new BillAuthError(0, `${field} is required`)
  return value
}

/**
 * Exchanges credentials for a session id.
 *
 * Every field is checked before the request leaves, because BILL answers a
 * missing organisation id and a wrong password with the same shape of failure,
 * and "your BILL credentials are wrong" sends an operator to reset a password
 * that was never the problem.
 */
export const login = async (options: Readonly<BillLoginOptions>): Promise<BillSession> => {
  const { credentials } = options
  requireValue(credentials.username, 'username')
  requireValue(credentials.password, 'password')
  requireValue(credentials.companyId, 'companyId')
  requireValue(credentials.devKey, 'devKey')

  const response = await options.fetch(
    new Request(`${options.baseUrl ?? BILL_PRODUCTION_BASE_URL}/v3/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      // BILL's wire field is `organizationId`. Ours is `companyId`, because a
      // repo invariant keeps foreign organisation identifiers out of our own
      // seams -- an `organizationId` flowing through ezacto's types would read
      // as multi-tenancy this product does not have. This one line is the
      // translation, and `invariants.test.ts` names this file as the only place
      // allowed to write the vendor's spelling.
      body: JSON.stringify({
        username: credentials.username,
        password: credentials.password,
        organizationId: credentials.companyId,
        devKey: credentials.devKey,
      }),
    }),
  )

  if (!response.ok) {
    // The body may name the field at fault, which is worth passing on -- but it
    // may also echo the credential, so only BILL's own message is carried and
    // never the request.
    let detail = ''
    try {
      const body = (await response.json()) as Record<string, unknown>
      const message = body['message']
      if (typeof message === 'string' && message !== '') detail = `: ${message}`
    } catch {
      // A non-JSON failure body is itself the diagnosis.
    }
    throw new BillAuthError(
      response.status,
      `BILL sign-in failed with status ${String(response.status)}${detail}`,
    )
  }

  const body = (await response.json()) as Record<string, unknown>
  const sessionId = body['sessionId']
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new BillAuthError(response.status, 'BILL sign-in returned no session id')
  }
  return { sessionId, lastUsedAt: options.now }
}

/**
 * Whether a session should be replaced before the next call.
 *
 * The margin exists because the decision and the request are not simultaneous:
 * a session judged live with two seconds left is a session that has expired by
 * the time the request lands, and BILL answers that with an authentication
 * failure rather than a retry hint.
 */
export const sessionIsStale = (
  session: Readonly<BillSession>,
  now: string,
  marginSeconds = 120,
): boolean => {
  const lastUsed = Date.parse(session.lastUsedAt)
  const instant = Date.parse(now)
  if (!Number.isFinite(lastUsed) || !Number.isFinite(instant)) return true
  const idleSeconds = (instant - lastUsed) / 1000
  return idleSeconds >= BILL_SESSION_IDLE_SECONDS - marginSeconds
}

/** The session, moved forward because it has just carried a request. */
export const touchSession = (
  session: Readonly<BillSession>,
  now: string,
): BillSession => ({ sessionId: session.sessionId, lastUsedAt: now })
