// The rate budget for the general Harvest endpoints: 100 requests / 15 s
// (research §0.2). Steps 1–13 of the extract order all draw on this one budget;
// the reports budget (100 / 15 min) belongs to `verify`, which is the sole
// consumer of /v2/reports/* (migration-spec §2.2).
//
// This is a strict *sliding* window, not the token bucket the story sketches, and
// the difference is the whole point. A bucket that starts full grants 100 requests
// instantly and then refills, so a 15 s window straddling the burst can contain up
// to ~200 requests — over budget, by construction, exactly once per run and exactly
// when the account is largest. The sliding form degenerates to the same ~6.7 req/s
// sustained rate §2.2 asks for, and "never exceeds the budget" is a property you
// can assert on every grant rather than a hope about the steady state.
//
// Callers are sequential (extract walks one resource at a time), so acquire() does
// not guard against interleaved callers; making it concurrency-safe would mean
// reserving a slot before awaiting, which is complexity nothing here needs.

/** General-endpoint budget, research §0.2. */
export const RATE_LIMIT = 100
export const RATE_WINDOW_MS = 15_000

export interface RateLimiter {
  /** Resolves once a request may be issued, sleeping if the window is full. */
  acquire: () => Promise<void>
  /**
   * Forgets the window. Called after a 429 penalty sleep: `Retry-After` means
   * Harvest's own window has already rolled, so holding our record of it against
   * the next request would stall for a budget nobody is spending.
   */
  reset: () => void
  /** Requests granted so far — the cost record extract reports at the end. */
  readonly granted: number
}

export interface RateLimiterOptions {
  limit?: number
  windowMs?: number
  /** Injected so tests run on a fake clock and finish in real milliseconds. */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export const createRateLimiter = (options: RateLimiterOptions = {}): RateLimiter => {
  const limit = options.limit ?? RATE_LIMIT
  const windowMs = options.windowMs ?? RATE_WINDOW_MS
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  /** Grant timestamps still inside the window, oldest first. */
  const window: number[] = []
  let granted = 0

  return {
    async acquire(): Promise<void> {
      for (;;) {
        const at = now()
        while (window.length > 0 && at - window[0] >= windowMs) window.shift()
        if (window.length < limit) {
          window.push(at)
          granted += 1
          return
        }
        // Full: the oldest grant is what has to age out before this one may go.
        // Never sleep 0 — a clock that has not moved would spin.
        await sleep(Math.max(windowMs - (at - window[0]), 1))
      }
    },
    reset(): void {
      window.length = 0
    },
    get granted(): number {
      return granted
    },
  }
}
