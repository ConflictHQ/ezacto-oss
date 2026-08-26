// AC #2, first half. The budget assertion is made on a *sliding* window, checked
// at every grant — which is why the limiter is a sliding window and not the token
// bucket the story sketches. A bucket that starts full passes a "6.7/s sustained"
// check and still puts ~200 requests into the first 15 s.

import { describe, expect, it } from 'vitest'
import { createRateLimiter, RATE_LIMIT, RATE_WINDOW_MS } from '../src/rate-limiter.js'

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
