export class PasswordDerivationOverloadedError extends Error {
  constructor() {
    super('password derivation capacity is temporarily unavailable')
    this.name = 'PasswordDerivationOverloadedError'
  }
}

interface QueuedDerivation {
  resolve(release: () => void): void
  timeout: ReturnType<typeof setTimeout>
}

export interface PasswordDerivationLimiterOptions {
  concurrency: number
  maxQueue: number
  queueTimeoutMs: number
}

/**
 * Isolate-local admission control for memory-hard password derivations. Worker
 * isolates share one memory limit across concurrent requests, so the KDF's
 * per-call `maxmem` cannot protect the aggregate process on its own.
 */
export class PasswordDerivationLimiter {
  readonly #concurrency: number
  readonly #maxQueue: number
  readonly #queueTimeoutMs: number
  #active = 0
  readonly #queue: QueuedDerivation[] = []

  constructor({
    concurrency,
    maxQueue,
    queueTimeoutMs,
  }: PasswordDerivationLimiterOptions) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new RangeError('password derivation concurrency must be positive')
    }
    if (!Number.isSafeInteger(maxQueue) || maxQueue < 0) {
      throw new RangeError(
        'password derivation queue limit must be non-negative',
      )
    }
    if (!Number.isSafeInteger(queueTimeoutMs) || queueTimeoutMs < 1) {
      throw new RangeError('password derivation queue timeout must be positive')
    }
    this.#concurrency = concurrency
    this.#maxQueue = maxQueue
    this.#queueTimeoutMs = queueTimeoutMs
  }

  async run<T>(derive: () => Promise<T>): Promise<T> {
    const release = await this.#acquire()
    try {
      return await derive()
    } finally {
      release()
    }
  }

  #acquire(): Promise<() => void> {
    if (this.#active < this.#concurrency) {
      this.#active += 1
      return Promise.resolve(this.#release())
    }
    if (this.#queue.length >= this.#maxQueue) {
      return Promise.reject(new PasswordDerivationOverloadedError())
    }

    return new Promise<() => void>((resolve, reject) => {
      const queued: QueuedDerivation = {
        resolve,
        timeout: setTimeout(() => {
          const index = this.#queue.indexOf(queued)
          if (index === -1) return
          this.#queue.splice(index, 1)
          reject(new PasswordDerivationOverloadedError())
        }, this.#queueTimeoutMs),
      }
      this.#queue.push(queued)
    })
  }

  #release(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.#queue.shift()
      if (next === undefined) {
        this.#active -= 1
        return
      }
      clearTimeout(next.timeout)
      next.resolve(this.#release())
    }
  }
}
