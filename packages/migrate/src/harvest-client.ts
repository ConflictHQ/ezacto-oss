// Single fetch wrapper for the Harvest API. Every outgoing request is built here,
// so a User-Agent (and Authorization, and Harvest-Account-Id when known) is set by
// construction — no call site can accidentally omit it.

const TIMEOUT_MS = 10_000

export interface HarvestClientConfig {
  pat: string
  userAgentEmail: string
  accountId?: string
  baseUrl?: string
}

export interface HarvestApiError extends Error {
  status: number
  fix: string
  body: string
}

const makeApiError = (status: number, body: string): HarvestApiError => {
  let message: string
  let fix: string
  if (status === 401) {
    fix =
      'PAT is invalid or expired — regenerate it in Harvest ID > Developers and update HARVEST_PAT in .dev.vars'
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

const doFetch = async (url: string, headers: Record<string, string>): Promise<Response> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    return await fetch(url, { headers, signal: controller.signal })
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
  const url = `${baseUrl}${path}`
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.pat}`,
    'User-Agent': `ezacto-migrate (${config.userAgentEmail})`,
  }
  if (config.accountId) {
    headers['Harvest-Account-Id'] = config.accountId
  }

  let response: Response
  try {
    response = await doFetch(url, headers)
  } catch {
    // single retry on network failure (E14)
    response = await doFetch(url, headers)
  }

  const body = await response.text()
  if (!response.ok) {
    throw makeApiError(response.status, body)
  }
  return body ? JSON.parse(body) : undefined
}
