import { describe, expect, it, vi } from 'vitest'
import {
  PasswordDerivationLimiter,
  PasswordDerivationOverloadedError,
} from '../src/password-kdf-limiter.js'

describe('password derivation admission control', () => {
  it('[security] never exceeds the configured aggregate KDF concurrency', async () => {
    const limiter = new PasswordDerivationLimiter({
      concurrency: 2,
      maxQueue: 2,
      queueTimeoutMs: 1_000,
    })
    const release: Array<() => void> = []
    let active = 0
    let peak = 0
    const derive = () =>
      limiter.run(async () => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise<void>((resolve) => release.push(resolve))
        active -= 1
      })

    const admitted = [derive(), derive(), derive(), derive()]
    const rejected = derive()
    await expect(rejected).rejects.toBeInstanceOf(
      PasswordDerivationOverloadedError,
    )
    await vi.waitFor(() => expect(active).toBe(2))
    release.shift()!()
    await vi.waitFor(() => expect(release).toHaveLength(2))
    release.shift()!()
    await vi.waitFor(() => expect(release).toHaveLength(2))
    release.splice(0).forEach((resolve) => resolve())

    await expect(Promise.all(admitted)).resolves.toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ])
    expect(peak).toBe(2)
  })

  it('[security] times out queued work instead of waiting without bound', async () => {
    const limiter = new PasswordDerivationLimiter({
      concurrency: 1,
      maxQueue: 1,
      queueTimeoutMs: 5,
    })
    let release!: () => void
    const active = limiter.run(
      () => new Promise<void>((resolve) => (release = resolve)),
    )
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))

    await expect(limiter.run(async () => undefined)).rejects.toBeInstanceOf(
      PasswordDerivationOverloadedError,
    )
    release()
    await active
  })
})
