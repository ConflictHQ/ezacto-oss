/**
 * Every request the shell makes, sent again where that cannot do harm (issue
 * 953).
 *
 * A dropped connection, a busy instance and an answer lost on its way back all
 * used to end the same way: an error, and a person clicking again. For a read
 * that is only slow. For a write it is how one entry becomes two: the first
 * attempt can commit before its answer is lost, and the click sends a second,
 * unrelated request.
 *
 * So every write carries an `Idempotency-Key`, made once and kept for all of
 * that write's attempts. An instance that honours the key says so with
 * `Idempotency-Key-Lifetime` on its responses (issue 952). It stores each answer
 * with its write and hands the same answer back to a retry rather than running
 * the write twice. An instance that has not said so is never sent a write again
 * after a dropped connection or a 5xx, because that write may already have
 * committed. It gets one only after an answer that says nothing was done: 408,
 * 429, or a 503 that names a time to come back.
 */

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key'
export const KEY_LIFETIME_HEADER = 'Idempotency-Key-Lifetime'
export const REPLAYED_HEADER = 'Idempotent-Replayed'

/** One send and three more, then the answer stands. */
export const MAX_ATTEMPTS = 4
const BASE_DELAY_MS = 500
const MAX_DELAY_MS = 8_000
/**
 * A `Retry-After` longer than this ends the attempts rather than holding a
 * screen for it: half a minute is already longer than anyone watches a button.
 */
const MAX_RETRY_AFTER_MS = 30_000

const writeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** Which origins have said they keep a write's answer under its key. */
export interface KeySupport {
  honours(origin: string): boolean
  /** Reads what one response says about its origin. */
  learn(origin: string, response: Response): void
}

/**
 * Learned from the answers themselves, so nothing is asked up front. The first
 * reads a page makes (who is signed in, the week) settle it before any write.
 *
 * Any response that carries the header proves it. A success that does not
 * carry it disproves it, because that is an instance from before issue 952, or
 * one rolled back to it. Anything else proves nothing either way: a proxy's 502
 * or a router's own refusal carries no header from the instance behind it.
 */
export const createKeySupport = (): KeySupport => {
  const honouring = new Set<string>()
  return {
    honours: (origin) => honouring.has(origin),
    learn: (origin, response) => {
      const lifetime = Number(response.headers.get(KEY_LIFETIME_HEADER) ?? Number.NaN)
      if (Number.isSafeInteger(lifetime) && lifetime > 0) honouring.add(origin)
      else if (response.status >= 200 && response.status < 300) honouring.delete(origin)
    },
  }
}

/** The writes a page has sent and not yet seen settled. */
export interface PendingWrites {
  /** Sent and not answered for good: what leaving the page would cut off. */
  readonly unsent: number
  /** Failed at least once and waiting to be sent again. */
  readonly retrying: number
  subscribe(listener: () => void): () => void
}

/** One write's place in the count, from its first send to its last answer. */
export interface PendingWrite {
  /** It failed once and will be sent again. */
  retrying(): void
  /** Answered for good, or given up on. */
  settle(): void
}

export interface PendingWriteTracker extends PendingWrites {
  begin(): PendingWrite
}

export const createPendingWrites = (): PendingWriteTracker => {
  let unsent = 0
  let retrying = 0
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const listener of listeners) listener()
  }
  return {
    get unsent() {
      return unsent
    },
    get retrying() {
      return retrying
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    begin() {
      let state: 'sent' | 'retrying' | 'settled' = 'sent'
      unsent += 1
      notify()
      return {
        retrying() {
          if (state !== 'sent') return
          state = 'retrying'
          retrying += 1
          notify()
        },
        settle() {
          if (state === 'settled') return
          if (state === 'retrying') retrying -= 1
          state = 'settled'
          unsent -= 1
          notify()
        },
      }
    },
  }
}

/**
 * A write whose connection dropped before anything answered it.
 *
 * It may have been saved. Saying "Failed to fetch" invites the click that saves
 * it a second time; this says what is actually known.
 */
export class UnconfirmedWriteError extends Error {
  constructor(cause: unknown) {
    super(
      'The connection dropped before the change was confirmed. Reload to check whether it was saved before trying again.',
      { cause },
    )
    this.name = 'UnconfirmedWriteError'
  }
}

export interface RetryingFetchOptions {
  /** What each attempt is sent with. Defaults to the page's own `fetch`, looked up at call time. */
  readonly fetch?: typeof globalThis.fetch
  readonly support?: KeySupport
  readonly pending?: PendingWriteTracker
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  /** In [0, 1). The jitter's source. */
  readonly random?: () => number
  readonly newKey?: () => string
  readonly now?: () => number
}

const sleepUnlessAborted = (milliseconds: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason)
      return
    }
    const abort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    signal?.addEventListener('abort', abort, { once: true })
  })

const retryableStatus = (status: number): boolean =>
  status === 408 || status === 429 || (status >= 500 && status <= 599)

/**
 * Full jitter: anywhere between nothing and the doubling ceiling, so clients
 * refused together do not come back together.
 */
const backoff = (attemptsMade: number, random: () => number): number =>
  random() * Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attemptsMade - 1))

/** `Retry-After` as delta-seconds or an HTTP-date, in milliseconds from now. */
export const retryAfterMilliseconds = (value: string | null, now: number): number | null => {
  if (value === null) return null
  const trimmed = value.trim()
  if (/^\d+$/u.test(trimmed)) return Number(trimmed) * 1_000
  const at = Date.parse(trimmed)
  return Number.isNaN(at) ? null : Math.max(0, at - now)
}

/**
 * The origin a request goes to. The shell's own calls are relative; anything
 * that cannot be placed is its own bucket, which nothing has vouched for.
 */
const originOf = (address: string): string => {
  try {
    return new URL(address, globalThis.location?.href).origin
  } catch {
    return ''
  }
}

// Password recovery uses one-time credentials and can trigger mail. The API's
// general idempotency advertisement does not promise replay for these routes.
const isPasswordRecovery = (address: string): boolean => {
  try {
    const path = new URL(address, globalThis.location?.href).pathname
    return path === '/auth/password/forgot' || path === '/auth/password/reset'
  } catch {
    return false
  }
}

/**
 * A multipart body is encoded once, here, rather than by each attempt. Every
 * encoding picks a fresh boundary, so the bytes of a second attempt would not
 * be the bytes of the first, and an instance comparing a retry with the request
 * its key first carried would refuse it as a different request.
 */
const encodeOnce = async (
  body: FormData,
  headers: Headers,
): Promise<ArrayBuffer> => {
  const encoded = new Response(body)
  const contentType = encoded.headers.get('content-type')
  if (contentType !== null) headers.set('content-type', contentType)
  return encoded.arrayBuffer()
}

/**
 * A `fetch` that retries what it safely can. The generated client takes it as
 * its `fetch`, and a direct call uses it as it would `globalThis.fetch`.
 *
 * - A write is POST, PUT, PATCH or DELETE. It gets one `Idempotency-Key` for all
 *   of its attempts, unless the caller already set one (the command ids).
 * - At most four attempts. Between them is a full-jitter backoff (base 500 ms,
 *   ceiling 8 s), after any `Retry-After` the answer names.
 * - Retried: a dropped connection, 408, 429 and 5xx. Answered at once: every
 *   other status, and an answer the instance says is a replay of the original.
 * - A write is retried after any of those only where its origin honours keys;
 *   elsewhere only after 408, 429, or a 503 with `Retry-After`.
 * - The caller's abort stops it at once, mid-wait included.
 * - Password reset requests and confirmations are sent once, regardless of
 *   origin support: their one-time credentials and mail are outside that promise.
 */
export const createRetryingFetch = (
  options: RetryingFetchOptions = {},
): typeof globalThis.fetch => {
  const send: typeof globalThis.fetch =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const support = options.support ?? createKeySupport()
  const pending = options.pending ?? createPendingWrites()
  const sleep = options.sleep ?? sleepUnlessAborted
  const random = options.random ?? Math.random
  const newKey = options.newKey ?? (() => globalThis.crypto.randomUUID())
  const now = options.now ?? Date.now

  return async (input, init) => {
    // The shell sends an address and an init. A whole Request is handled too,
    // and sent as it is on each attempt.
    const request = typeof input === 'string' || input instanceof URL ? null : input
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase()
    const write = writeMethods.has(method)
    const signal = init?.signal ?? request?.signal ?? undefined
    const address = request?.url ?? String(input)
    const origin = originOf(address)
    // A stream can be read once, so a body that is one -- including the body a
    // Request carries -- is sent once. Anything else can be sent again as it is.
    const replayable =
      !(write && isPasswordRecovery(address)) &&
      !(init?.body instanceof ReadableStream) && (request === null || request.body === null)

    let attemptInit = init
    if (write) {
      const headers = new Headers(request?.headers)
      new Headers(init?.headers).forEach((value, name) => headers.set(name, value))
      if (!headers.has(IDEMPOTENCY_KEY_HEADER)) headers.set(IDEMPOTENCY_KEY_HEADER, newKey())
      attemptInit = { ...init, headers }
      if (init?.body instanceof FormData) {
        attemptInit = { ...attemptInit, body: await encodeOnce(init.body, headers) }
      }
    }

    const tracked = write ? pending.begin() : null
    try {
      for (let attempt = 1; ; attempt += 1) {
        signal?.throwIfAborted()
        let response: Response
        try {
          response = await send(input, attemptInit)
        } catch (error) {
          // The caller's own abort, never a reason to try again.
          if (signal?.aborted === true) throw error
          const again =
            replayable && attempt < MAX_ATTEMPTS && (!write || support.honours(origin))
          if (!again) throw write ? new UnconfirmedWriteError(error) : error
          tracked?.retrying()
          await sleep(backoff(attempt, random), signal)
          continue
        }
        support.learn(origin, response)
        if (
          response.headers.get(REPLAYED_HEADER) === 'true' ||
          !retryableStatus(response.status)
        ) {
          return response
        }
        const wait = retryAfterMilliseconds(response.headers.get('retry-after'), now())
        const refused =
          response.status === 408 ||
          response.status === 429 ||
          (response.status === 503 && wait !== null)
        const again =
          replayable &&
          attempt < MAX_ATTEMPTS &&
          (!write || support.honours(origin) || refused) &&
          (wait === null || wait <= MAX_RETRY_AFTER_MS)
        if (!again) return response
        tracked?.retrying()
        // Let the connection go without waiting on it: a body that is one
        // branch of a tee does not finish cancelling until the other branch
        // does, which may be never.
        void response.body?.cancel().catch(() => undefined)
        await sleep((wait ?? 0) + backoff(attempt, random), signal)
      }
    } finally {
      tracked?.settle()
    }
  }
}

/** What this page has learned about its own instance. */
export const shellKeySupport = createKeySupport()

/** The writes this page has in flight, for the status line and the unload guard. */
export const shellPendingWrites = createPendingWrites()

/** The one fetch every request the shell makes goes through. */
export const shellFetch = createRetryingFetch({
  support: shellKeySupport,
  pending: shellPendingWrites,
})
