// Single fetch wrapper for the Harvest API. Every outgoing request is built here,
// so a User-Agent (and Authorization, and Harvest-Account-Id when known) is set by
// construction — no call site can accidentally omit it.

const TIMEOUT_MS = 10_000

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
}

export interface HarvestTransportError extends Error {
  fix: string
  attempts: number
  timedOut: boolean
}

const makeApiError = (status: number, body: string): HarvestApiError => {
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
    return { status: response.status, ok: response.ok, body }
  } catch (err) {
    throw timedOut ? new TimeoutSignal() : err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Issues a GET against the Harvest API (or the id.getharvest.com auth host).
 * `accountId` is required for every endpoint except id.getharvest.com/api/v2/accounts,
 * which needs no account id — pass config.accountId as undefined for that call only.
 */
export const harvestFetch = async (path: string, config: HarvestClientConfig): Promise<unknown> => {
  const baseUrl = config.baseUrl ?? 'https://api.harvestapp.com'
  const timeoutMs = config.timeoutMs ?? TIMEOUT_MS
  const url = `${baseUrl}${path}`
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
    throw makeApiError(attempt.status, attempt.body)
  }
  return attempt.body ? JSON.parse(attempt.body) : undefined
}
