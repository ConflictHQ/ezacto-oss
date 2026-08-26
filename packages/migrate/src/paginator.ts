// Cursor pagination, plus the throttle/backoff policy for every request extract
// makes (E14).
//
// The one rule this module exists to enforce: only the FIRST URL of a sweep is
// built here. Every page after it is `body.links.next` used byte-for-byte, per
// the Harvest doc mandate — "always use the pagination URLs provided by the links
// section instead of constructing pagination links yourself" (research §0.4).
// Reconstructing the next URL from a cursor works right up until Harvest changes
// the cursor encoding or moves the collection, and then it silently reads page 1
// forever.

import {
  apiOrigin,
  DEFAULT_BASE_URL,
  harvestFetchUrl,
  isApiOrigin,
  isTransportError,
  type HarvestApiError,
  type HarvestClientConfig,
} from './harvest-client.js'
import { describe } from './response.js'
import { sliceCollection } from './raw-slices.js'
import { RATE_WINDOW_MS } from './rate-limiter.js'
import type { RateLimiter } from './rate-limiter.js'

/** Research §0.4: default and maximum alike. */
export const PER_PAGE = '2000'

/** 429 waits are capped: a Retry-After of 3600 is a bug report, not a nap. */
const MAX_RETRY_AFTER_S = 120
/** Used when a 429 arrives with no readable Retry-After — one full window, rounded up. */
const DEFAULT_RETRY_AFTER_S = 15
const MAX_THROTTLE_ATTEMPTS = 5
const MAX_SERVER_ERROR_ATTEMPTS = 4
/**
 * Never honor a wait shorter than this. `Retry-After: 0` is legal (RFC 9110) and
 * a blank header is common, but a zero-length wait plus a window reset is not
 * backoff — it is a tight loop against a server that has already said stop.
 */
const MIN_RETRY_AFTER_S = 1

export interface PaginateStart {
  /** Resource name, for error messages and logs. */
  resource: string
  /** Path relative to the API host — the only URL this module composes. */
  path: string
  /** Envelope key holding the records. */
  collection: string
  params?: Record<string, string>
  /**
   * Resume a sweep already in progress: the exact `links.next` a previous run
   * recorded in `manifest.resources[*].next_url`, used verbatim as the first
   * request instead of building one from `path`/`params`. Still the doc mandate
   * (research §0.4) — the URL was never constructed here, only replayed from
   * where the last one left off.
   */
  startUrl?: string
}

export interface PaginateDeps {
  limiter: RateLimiter
  sleep: (ms: number) => Promise<void>
  log: (line: string) => void
}

export interface Page {
  /** The URL that produced this page, exactly as requested. */
  url: string
  objects: unknown[]
  /**
   * The wire bytes of each record, cut from the response body (§2.3 "raw means
   * raw"). `objects` stays for anything that needs to *read* a field — ids for a
   * fan-out, `updated_at` for a watermark — but only these strings are written to
   * raw/<resource>.jsonl. Null when the body could not be sliced, which the
   * caller must record rather than silently re-serialise.
   */
  rawObjects: string[] | null
  /** The server's own clock at this response — the only sound watermark source. */
  serverDate: string | null
  /** `links.next` verbatim, or null at the end of the collection. */
  nextUrl: string | null
  totalEntries: number | null
  /** Requests spent on this page, retries included — the real cost, not the page count. */
  requests: number
}

const badPage = (resource: string, url: string, detail: string): Error =>
  new Error(
    `unexpected ${resource} response from ${url} — ${detail}. Refusing to treat this as the last ` +
      'page: a paginated sweep that stops early writes a snapshot that is missing most of the ' +
      'account and still reports success.',
  )

/**
 * `links.next` is a request target chosen by the response body, and every request
 * carries the account's PAT (harvest-client attaches it by construction). Harvest's
 * own links stay on the API host; one that does not is a compromised or proxied
 * response, and following it would hand a full-account token — in cleartext, if the
 * link says `http://` — to whoever named the host. Following links verbatim means
 * not *rebuilding* the URL; it has never meant following it off the API origin.
 */
const offOrigin = (resource: string, url: string, next: string, origin: string): Error =>
  new Error(
    `refusing to follow ${resource} pagination from ${url} to ${next} — "links.next" is not on ` +
      `${origin}. Every request carries the account's Harvest PAT, so a next link on another origin ` +
      'would send it there.',
  )

const asRecord = (raw: unknown, resource: string, url: string): Record<string, unknown> => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw badPage(resource, url, `expected a JSON object, got ${describe(raw)}`)
  }
  return raw as Record<string, unknown>
}

const isApiError = (err: unknown): err is HarvestApiError =>
  err instanceof Error && typeof (err as HarvestApiError).status === 'number'

/**
 * What a failed run actually leaves behind. The rows already on disk are fsynced
 * and the manifest's per-resource cursor was never rewritten ahead of them
 * (§2.4), so a re-run reads that cursor back and continues the interrupted
 * resource from its last page rather than re-sweeping it from page 1 —
 * `manifest.resources[*].next_url` exists for exactly this.
 */
export const RESUME_GUIDANCE =
  'The rows written so far are on disk and manifest.json records where this run stopped. ' +
  're-running extract against the same --snapshot-dir resumes this resource from its last ' +
  'checkpoint instead of re-sweeping it from page 1.'

const exhausted = (resource: string, url: string, attempts: number, why: string): Error =>
  new Error(
    `${resource}: gave up on ${url} after ${attempts} attempts (${why}). ${RESUME_GUIDANCE}`,
  )

/**
 * One request, with the policy the story's AC #2 asks for: honor `Retry-After` on
 * 429, exponential backoff on 5xx, and rethrow anything that a retry cannot fix
 * (401/403/404/422 are answers, not weather).
 *
 * Exported because it is the policy, not a pagination detail: every request extract
 * makes has to go through it, including the one that is not a page (the `/v2/users/me`
 * identity check). A second call site issuing a bare fetch would be outside the
 * budget, outside Retry-After, and outside AC #2.
 */
export const fetchWithPolicy = async (
  url: string,
  resource: string,
  config: HarvestClientConfig,
  deps: PaginateDeps,
): Promise<{ body: unknown; raw: string; serverDate: string | null; requests: number }> => {
  let throttles = 0
  let serverErrors = 0
  let requests = 0
  for (;;) {
    await deps.limiter.acquire()
    requests += 1
    try {
      // transportAttempts: 1 — the backoff below is this call path's retry policy,
      // and the limiter granted exactly one request for this attempt.
      const res = await harvestFetchUrl(url, { ...config, transportAttempts: 1 })
      return { body: res.parsed, raw: res.raw, serverDate: res.serverDate, requests }
    } catch (err) {
      // A connection that dropped or a body that stalled is weather, and the
      // policy has to treat it as such: it carries no `status`, so without this
      // branch it falls straight through to the rethrow below and one blip ends a
      // multi-hour sweep that cannot resume mid-resource.
      if (isTransportError(err)) {
        serverErrors += 1
        if (serverErrors >= MAX_SERVER_ERROR_ATTEMPTS) {
          throw exhausted(resource, url, serverErrors, err.fix)
        }
        const waitMs = 1000 * 2 ** (serverErrors - 1)
        deps.log(`${resource}: ${err.fix} — retrying ${url} in ${waitMs}ms`)
        await deps.sleep(waitMs)
        continue
      }
      if (!isApiError(err)) throw err
      if (err.status === 429) {
        throttles += 1
        if (throttles >= MAX_THROTTLE_ATTEMPTS) {
          throw exhausted(resource, url, throttles, 'Harvest kept throttling the request')
        }
        const seconds = Math.min(
          Math.max(err.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_S, MIN_RETRY_AFTER_S),
          MAX_RETRY_AFTER_S,
        )
        deps.log(
          `${resource}: throttled by Harvest (429), waiting ${seconds}s before retrying ${url}`,
        )
        await deps.sleep(seconds * 1000)
        // Only a wait that actually covers our window means Harvest's has rolled
        // too. Forgetting the window after a one-second nap would hand back a
        // budget nothing has aged out of — a 429 would *raise* our request rate.
        if (seconds * 1000 >= RATE_WINDOW_MS) deps.limiter.reset()
        continue
      }
      if (err.status >= 500) {
        serverErrors += 1
        if (serverErrors >= MAX_SERVER_ERROR_ATTEMPTS) {
          throw exhausted(resource, url, serverErrors, `Harvest kept returning ${err.status}`)
        }
        const waitMs = 1000 * 2 ** (serverErrors - 1)
        deps.log(`${resource}: Harvest returned ${err.status}, retrying ${url} in ${waitMs}ms`)
        await deps.sleep(waitMs)
        continue
      }
      throw err
    }
  }
}

/**
 * Walks a collection from its first page to its last, yielding one page at a time
 * so the caller can append and checkpoint before the next request goes out.
 */
export async function* paginate(
  start: PaginateStart,
  config: HarvestClientConfig,
  deps: PaginateDeps,
): AsyncGenerator<Page> {
  const query = new URLSearchParams({ per_page: PER_PAGE, ...start.params })
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL
  let url: string | null = start.startUrl ?? `${baseUrl}${start.path}?${query.toString()}`

  while (url !== null) {
    const requested: string = url
    const fetched = await fetchWithPolicy(requested, start.resource, config, deps)
    const body = asRecord(fetched.body, start.resource, requested)

    const objects = body[start.collection]
    if (!Array.isArray(objects)) {
      throw badPage(
        start.resource,
        requested,
        `"${start.collection}" is ${describe(objects)}, expected an array of records`,
      )
    }

    // An absent `links` is the failure that costs 90% of an account: treated as
    // "no next page" it looks exactly like a small collection, and the run exits 0.
    const links = body.links
    if (typeof links !== 'object' || links === null || Array.isArray(links)) {
      throw badPage(start.resource, requested, `"links" is ${describe(links)}, expected an object`)
    }
    const next = (links as Record<string, unknown>).next
    if (next !== null && typeof next !== 'string') {
      throw badPage(
        start.resource,
        requested,
        `"links.next" is ${describe(next)}, expected a URL string or null`,
      )
    }

    // Checked before the page is yielded: the caller persists `nextUrl` into
    // manifest.resources[…].next_url, and a resume story that trusted the manifest
    // would follow a poisoned URL long after this run ended.
    if (next !== null && !isApiOrigin(next, config)) {
      throw offOrigin(start.resource, requested, next, apiOrigin(config))
    }

    const totalEntries = body.total_entries
    yield {
      url: requested,
      objects,
      rawObjects: sliceCollection(fetched.raw, start.collection),
      serverDate: fetched.serverDate,
      nextUrl: next,
      totalEntries: typeof totalEntries === 'number' ? totalEntries : null,
      requests: fetched.requests,
    }

    url = next
  }
}
