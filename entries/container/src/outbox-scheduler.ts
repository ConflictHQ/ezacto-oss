import type { OutboxDrainSummary, OutboxService } from '@ezacto/db'

export const CONTAINER_OUTBOX_POLL_INTERVAL_MS = 15_000

export interface ContainerOutboxSchedulerOptions {
  intervalMs?: number
  reportError?: (name: string) => void
}

export class ContainerOutboxScheduler {
  readonly #service: OutboxService
  readonly #intervalMs: number
  readonly #reportError: (name: string) => void
  #timer: ReturnType<typeof setInterval> | undefined
  #active: Promise<OutboxDrainSummary> | undefined
  #closed = false

  constructor(
    service: OutboxService,
    options: ContainerOutboxSchedulerOptions = {},
  ) {
    const intervalMs = options.intervalMs ?? CONTAINER_OUTBOX_POLL_INTERVAL_MS
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 300_000) {
      throw new RangeError('container outbox interval must be between 100 and 300000 milliseconds')
    }
    this.#service = service
    this.#intervalMs = intervalMs
    this.#reportError =
      options.reportError ??
      ((name) => console.error(`ezacto outbox drain failed: ${name}`))
  }

  start(): void {
    if (this.#closed || this.#timer !== undefined) return
    this.#timer = setInterval(() => this.#runScheduled(), this.#intervalMs)
    this.#timer.unref()
    this.#runScheduled()
  }

  drain(): Promise<OutboxDrainSummary> {
    if (this.#closed) {
      return Promise.reject(new Error('container outbox scheduler is closed'))
    }
    if (this.#active !== undefined) return this.#active
    const active = this.#service.drain()
    this.#active = active
    void active.then(
      () => {
        if (this.#active === active) this.#active = undefined
      },
      () => {
        if (this.#active === active) this.#active = undefined
      },
    )
    return active
  }

  async close(timeoutMs = 5_000): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    if (this.#timer !== undefined) clearInterval(this.#timer)
    this.#timer = undefined
    const active = this.#active
    if (active === undefined) return
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
      throw new RangeError('container outbox close timeout must be between 1 and 300000 milliseconds')
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        active,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('container outbox drain did not stop before shutdown')),
            timeoutMs,
          )
          timer.unref()
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  #runScheduled(): void {
    void this.drain().catch((error: unknown) => {
      const name = error instanceof Error ? error.name : 'UnknownError'
      this.#reportError(name)
    })
  }
}
