// AC #2, first half. The budget assertion is made on a *sliding* window, checked
// at every grant — which is why the limiter is a sliding window and not the token
// bucket the story sketches. A bucket that starts full passes a "6.7/s sustained"
// check and still puts ~200 requests into the first 15 s.

import { describe, expect, it } from 'vitest'
import { createRateLimiter, minElapsedMs, RATE_LIMIT, RATE_WINDOW_MS } from '../src/rate-limiter.js'

/** A clock that only moves when the limiter sleeps: no real time passes. */
const fakeClock = (): { now: () => number; sleep: (ms: number) => Promise<void> } => {
  let t = 0
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms
      return Promise.resolve()
    },
  }
}

describe('createRateLimiter', () => {
  it('[unit] never exceeds the budget in a simulated burst', async () => {
    const clock = fakeClock()
    const limiter = createRateLimiter({ now: clock.now, sleep: clock.sleep })
    const grants: number[] = []

    const realStart = Date.now()
    for (let i = 0; i < 250; i += 1) {
      await limiter.acquire()
      grants.push(clock.now())
    }

    // The property, at every grant: no 15 000 ms window ever holds more than 100.
    for (const at of grants) {
      const inWindow = grants.filter((g) => g > at - RATE_WINDOW_MS && g <= at)
      expect(
        inWindow.length,
        `window ending at ${at}ms held ${inWindow.length} grants`,
      ).toBeLessThanOrEqual(RATE_LIMIT)
    }

    expect(limiter.granted).toBe(250)
    // 250 requests cannot be cheaper than 2.5 windows at 100 per window.
    expect(clock.now()).toBeGreaterThanOrEqual(22_500)
    // …and none of that is wall-clock time.
    expect(Date.now() - realStart).toBeLessThan(2_000)
  })

  it('[unit] spends the first window immediately, then paces at the budget', async () => {
    const clock = fakeClock()
    const limiter = createRateLimiter({ now: clock.now, sleep: clock.sleep })

    for (let i = 0; i < RATE_LIMIT; i += 1) await limiter.acquire()
    expect(clock.now()).toBe(0)

    await limiter.acquire()
    expect(clock.now()).toBe(RATE_WINDOW_MS)
  })

  it('[unit] reset() forgets the window, because a 429 means Harvest already rolled its own', async () => {
    const clock = fakeClock()
    const limiter = createRateLimiter({ now: clock.now, sleep: clock.sleep })

    for (let i = 0; i < RATE_LIMIT; i += 1) await limiter.acquire()
    // The penalty sleep Retry-After asked for, then a reset.
    await clock.sleep(3_000)
    limiter.reset()

    await limiter.acquire()
    // No further wait: the window we were holding against ourselves is gone.
    expect(clock.now()).toBe(3_000)
    expect(limiter.granted).toBe(RATE_LIMIT + 1)
  })
})

/**
 * The budget property a whole-run measurement can honestly assert. The live [api]
 * extract test used to assert an *average* — `requests / elapsed <= 6.7 req/s` —
 * which no correctly-paced run can satisfy, because the window starts empty and
 * the first RATE_LIMIT grants are spent at once by design (the test above requires
 * exactly that). The two tests here pin both halves: the floor holds, and the
 * average does not.
 */
describe('minElapsedMs', () => {
  it('[unit] is a floor the limiter cannot beat, at every run size', async () => {
    for (const n of [0, 1, 50, 100, 101, 140, 250, 1000]) {
      const clock = fakeClock()
      const limiter = createRateLimiter({ now: clock.now, sleep: clock.sleep })
      for (let i = 0; i < n; i += 1) await limiter.acquire()
      expect(clock.now(), `${n} grants`).toBeGreaterThanOrEqual(minElapsedMs(n))
    }
  })

  // migration-spec §2.2 sizes a mid-sized account's sweep at ~140 requests.
  it('[unit] a correctly-paced run of that size still averages above the sustained budget', async () => {
    const clock = fakeClock()
    const limiter = createRateLimiter({ now: clock.now, sleep: clock.sleep })
    const REQUESTS = 140
    const LATENCY_MS = 80

    for (let i = 0; i < REQUESTS; i += 1) {
      await limiter.acquire()
      await clock.sleep(LATENCY_MS) // the request itself
    }

    expect(clock.now()).toBeGreaterThanOrEqual(minElapsedMs(REQUESTS))
    // …and the assertion the live test used to make fails on this very run.
    const sustained = RATE_LIMIT / (RATE_WINDOW_MS / 1000)
    expect(REQUESTS / (clock.now() / 1000)).toBeGreaterThan(sustained)
  })
})
