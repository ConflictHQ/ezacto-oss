// Single fetch wrapper for the Harvest API. Every outgoing request is built here,
// so a User-Agent (and Authorization, and Harvest-Account-Id when known) is set by
// construction — no call site can accidentally omit it.

const TIMEOUT_MS = 10_000

/** The Harvest API host, when a caller does not point the client somewhere else. */
export const DEFAULT_BASE_URL = 'https://api.harvestapp.com'

export interface HarvestClientConfig {
  pat: string
  userAgentEmail: string
  accountId?: string
  baseUrl?: string
  /** Per-attempt deadline, headers *and* body. Injectable so tests are fast. */
  timeoutMs?: number
}

export interface HarvestApiError extends Error {
  status: number
  fix: string
  body: string
  /**
   * `Retry-After` in seconds, or null when the header is absent or not an integer.
   * Harvest documents seconds-until-reset only (research §0.2, RFC 2616), so the
   * HTTP-date form is deliberately not parsed — a value we cannot read is null,
   * and the caller falls back to its own default rather than to a wrong wait.
   */
  retryAfterSeconds: number | null
}

export interface HarvestTransportError extends Error {
  fix: string
  attempts: number
  timedOut: boolean
}

/** Seconds from a `Retry-After` header, or null when absent/unparseable. */
const parseRetryAfter = (raw: string | null): number | null => {
  if (raw === null) return null
  const seconds = Number(raw.trim())
  return Number.isInteger(seconds) && seconds >= 0 ? seconds : null
}

const makeApiError = (
  status: number,
  body: string,
  retryAfterSeconds: number | null,
): HarvestApiError => {
  let message: string
  let fix: string
  if (status === 401) {
    fix =
      'PAT is invalid or expired — regenerate it in Harvest ID > Developers and set the new value as ' +
      'HARVEST_PAT (in your environment, or in the nearest .dev.vars file)'
    message = fix
  } else if (status === 400) {
    fix =
      'request was rejected (likely a missing/invalid header) — this is a client bug, not a user config issue'
    message = `${fix}\nraw response: ${body}`
  } else {
    fix = 'Harvest API error'
    message = `${fix}: ${status} ${body}`
  }
  const err = new Error(message) as HarvestApiError
  err.status = status
  err.fix = fix
  err.body = body
  err.retryAfterSeconds = retryAfterSeconds
  return err
}

/**
 * E14 visible failure surface: two silent attempts must not end in a bare
 * `TypeError: fetch failed` (or, worse, no error at all).
 */
const makeTransportError = (
  url: string,
  attempts: number,
  timeoutMs: number,
  timedOut: boolean,
  cause: unknown,
): HarvestTransportError => {
  const fix = timedOut
    ? `Harvest did not complete the response within ${timeoutMs}ms — retry, or check https://www.harveststatus.com`
    : `could not reach Harvest (${cause instanceof Error ? cause.message : String(cause)}) — check your network, or https://www.harveststatus.com`
  const err = new Error(`${url} failed after ${attempts} attempts: ${fix}`) as HarvestTransportError
  err.fix = fix
  err.attempts = attempts
  err.timedOut = timedOut
  return err
}

/** Internal marker: this attempt hit the deadline rather than a network fault. */
class TimeoutSignal extends Error {}

interface Attempt {
  status: number
  ok: boolean
  body: string
  retryAfterSeconds: number | null
}

/**
 * One attempt, with the abort timer covering the *whole* exchange. The body is
 * read here on purpose: a server that sends headers and then stalls the body
 * would otherwise hang forever, because clearing the timer when fetch() resolves
 * leaves the body read undeadlined.
 */
const doFetch = async (
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Attempt> => {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    const response = await fetch(url, { headers, signal: controller.signal })
    const body = await response.text()
    return {
      status: response.status,
      ok: response.ok,
      body,
      retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after')),
    }
  } catch (err) {
    throw timedOut ? new TimeoutSignal() : err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The one origin this client may send the PAT to.
 *
 * Every request built here carries `Authorization: Bearer <pat>`, so a URL is not
 * merely somewhere to read from — it is somewhere the account's full-access token
 * ends up. The origin comparison covers the scheme too: an `http://` URL is a
 * different origin from the `https://` base, and would put the token on the wire
 * in cleartext.
 */
export const apiOrigin = (config: HarvestClientConfig): string =>
  new URL(config.baseUrl ?? DEFAULT_BASE_URL).origin

/** True when `url` is on the origin this config authenticates against. */
export const isApiOrigin = (url: string, config: HarvestClientConfig): boolean => {
  try {
    return new URL(url).origin === apiOrigin(config)
  } catch {
    return false
  }
}

/**
 * Issues a GET against an already-built absolute URL.
 *
 * This is the entry point pagination uses: the doc mandate is to follow the
 * response `links` verbatim (research §0.4), so the paginator must be able to
 * hand a URL back to the client untouched — a path-plus-base signature would
 * force it to take that URL apart and rebuild it, which is exactly the bug the
 * mandate exists to prevent.
 */
export const harvestFetchUrl = async (
  url: string,
  config: HarvestClientConfig,
): Promise<unknown> => {
  // The URL is an argument, and for pagination it is an argument that came out of a
  // response body — while the Authorization header below goes on unconditionally. So
  // the host is checked here, in the one place that attaches the token: a `links.next`
  // naming another host would otherwise hand a full-account PAT to whoever named it.
  if (!isApiOrigin(url, config)) {
    throw new Error(
      `refusing to request ${url}: it is not on ${apiOrigin(config)}, and every request this client ` +
        "makes carries the account's Harvest PAT.",
    )
  }

  const timeoutMs = config.timeoutMs ?? TIMEOUT_MS
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.pat}`,
    'User-Agent': `ezacto-migrate (${config.userAgentEmail})`,
  }
  if (config.accountId) {
    headers['Harvest-Account-Id'] = config.accountId
  }

  let attempt: Attempt
  try {
    attempt = await doFetch(url, headers, timeoutMs)
  } catch {
    // single retry on timeout or network failure (E14)
    try {
      attempt = await doFetch(url, headers, timeoutMs)
    } catch (err) {
      throw makeTransportError(url, 2, timeoutMs, err instanceof TimeoutSignal, err)
    }
  }

  if (!attempt.ok) {
    throw makeApiError(attempt.status, attempt.body, attempt.retryAfterSeconds)
  }
  return attempt.body ? JSON.parse(attempt.body) : undefined
}

/**
 * Issues a GET against the Harvest API (or the id.getharvest.com auth host).
 * `accountId` is required for every endpoint except id.getharvest.com/api/v2/accounts,
 * which needs no account id — pass config.accountId as undefined for that call only.
 */
export const harvestFetch = (path: string, config: HarvestClientConfig): Promise<unknown> =>
  harvestFetchUrl(`${config.baseUrl ?? DEFAULT_BASE_URL}${path}`, config)
