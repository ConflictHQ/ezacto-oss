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
  /**
   * HTTP attempts per call when the transport fails outright. Two by default, so a
   * caller with no retry policy of its own still survives a dropped connection
   * (E14). `fetchWithPolicy` sets it to 1: it does its own backoff, and every
   * attempt it makes is one the rate limiter granted — a second, ungranted request
   * inside one grant would put the account over a budget the limiter believes it
   * is holding.
   */
  transportAttempts?: number
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

/**
 * A connection that never opened or a body that never finished — weather, not an
 * answer. It carries no `status`, so the retry policy has to recognise it by
 * shape or it falls through to the rethrow and a blip kills a multi-hour run.
 */
export const isTransportError = (err: unknown): err is HarvestTransportError =>
  err instanceof Error && 'timedOut' in err && 'attempts' in err

/**
 * Seconds from a `Retry-After` header, or null when absent/unparseable.
 *
 * The blank check is not defensive noise: `Number('')` and `Number('   ')` are
 * both `0`, so an empty header — which a CDN error page, a load balancer, or a
 * proxy emitting `retry-after: ${undefined}` will hand us — would otherwise read
 * as "come back immediately" and be indistinguishable from a header we could
 * actually parse. Null is the honest answer; the caller then falls back to its
 * own default rather than to a wrong wait.
 */
const parseRetryAfter = (raw: string | null): number | null => {
  if (raw === null) return null
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const seconds = Number(trimmed)
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
    ? `Harvest did not complete the response within ${timeoutMs}ms — raise it with ` +
      `--request-timeout <seconds>, or check https://www.harveststatus.com`
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
  /** `Location` off a 3xx, so the refusal can name where it was being sent. */
  location: string | null
  retryAfterSeconds: number | null
}

/**
 * One attempt, with the abort timer covering the *whole* exchange. The body is
 * read here on purpose: a server that sends headers and then stalls the body
 * would otherwise hang forever, because clearing the timer when fetch() resolves
 * leaves the body read undeadlined.
 *
 * `redirect: 'manual'` because the default is `follow`, and following happens
 * inside fetch() — after the origin allow-list has already passed on the URL we
 * handed in. The caller turns the 3xx into a refusal; see harvestFetchUrl.
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
    const response = await fetch(url, { headers, redirect: 'manual', signal: controller.signal })
    const body = await response.text()
    return {
      status: response.status,
      ok: response.ok,
      body,
      location: response.headers.get('location'),
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
 * A 3xx is the allow-list's blind spot, so it is refused rather than followed.
 *
 * `isApiOrigin` — here and on `links.next` in the paginator — inspects the URL
 * before the request goes out. A redirect moves the request *after* that check,
 * inside fetch(), to any host the response names: RFC1918, 169.254.169.254, a
 * port on localhost. What comes back would then be appended to
 * raw/<resource>.jsonl verbatim and counted in the manifest as Harvest's own
 * answer. The Fetch spec strips `Authorization` cross-origin, but that is one
 * client's behaviour and nothing here rests on it; `Harvest-Account-Id` and the
 * operator's email in the User-Agent are sent either way.
 */
const makeRedirectError = (
  url: string,
  config: HarvestClientConfig,
  attempt: Attempt,
): HarvestApiError => {
  const fix =
    'the Harvest API does not redirect — check the base URL, and any proxy or TLS interception ' +
    'between this machine and the API'
  const err = new Error(
    `refusing to follow the ${attempt.status} redirect from ${url} to ` +
      `${attempt.location ?? '(no Location header)'}: it leaves ${apiOrigin(config)}, which is ` +
      'the only origin this client may send the account id, the operator email and the PAT to — ' +
      `and whatever answered would be written into the snapshot as Harvest's own reply. ${fix}.`,
  ) as HarvestApiError
  err.status = attempt.status
  err.fix = fix
  err.body = attempt.body
  err.retryAfterSeconds = attempt.retryAfterSeconds
  return err
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

  const attempts = Math.max(config.transportAttempts ?? 2, 1)
  let attempt: Attempt | undefined
  for (let n = 1; n <= attempts; n += 1) {
    try {
      attempt = await doFetch(url, headers, timeoutMs)
      break
    } catch (err) {
      if (n === attempts) {
        throw makeTransportError(url, attempts, timeoutMs, err instanceof TimeoutSignal, err)
      }
    }
  }
  /* c8 ignore next */
  if (attempt === undefined) throw new Error('unreachable: no attempt and no error')

  // Before the generic !ok branch: a 3xx is not an answer about the account, it is
  // the request being pointed somewhere the allow-list above never saw.
  if (attempt.status >= 300 && attempt.status < 400) {
    throw makeRedirectError(url, config, attempt)
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
