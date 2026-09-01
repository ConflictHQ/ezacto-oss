import {
  InProcessEmailQueue,
  processQueuedEmail,
  type EmailLogStore,
  type EmailQueue,
  type HttpEmailProvider,
  type InProcessEmailScheduler,
  type QueuedEmailJob,
} from '@ezacto/mailer'

type Scheduled = {
  timer: ReturnType<typeof setTimeout>
  task: () => Promise<void>
}

/** Tracks the in-process adapter so shutdown drains queued and retry work. */
export class ContainerEmailQueue implements EmailQueue {
  private readonly scheduled = new Set<Scheduled>()
  private readonly active = new Set<Promise<void>>()
  private readonly queue: InProcessEmailQueue
  private readonly shutdown = new AbortController()
  private accepting = true

  constructor(log: EmailLogStore, provider: HttpEmailProvider) {
    const scheduler: InProcessEmailScheduler = (task, delaySeconds) => {
      const scheduled: Scheduled = {
        timer: setTimeout(() => {
          this.scheduled.delete(scheduled)
          this.run(task)
        }, this.accepting ? delaySeconds * 1_000 : 0),
        task,
      }
      scheduled.timer.unref()
      this.scheduled.add(scheduled)
    }
    const shutdownAwareProvider: HttpEmailProvider = {
      name: provider.name,
      send: (message, options) =>
        provider.send(message, {
          ...options,
          signal: AbortSignal.any([options.signal, this.shutdown.signal]),
        }),
    }
    this.queue = new InProcessEmailQueue(
      (job, attempt) =>
        processQueuedEmail(job, attempt, log, shutdownAwareProvider),
      scheduler,
    )
  }

  private run(task: () => Promise<void>): void {
    const pending = task()
      .catch((error: unknown) => {
        const name = error instanceof Error ? error.name : 'UnknownError'
        console.error(`email queue task failed: ${name}`)
      })
      .finally(() => this.active.delete(pending))
    this.active.add(pending)
  }

  async send(job: QueuedEmailJob): Promise<void> {
    if (!this.accepting) throw new Error('email queue is shutting down')
    await this.queue.send(job)
  }

  async close(timeoutMs = 60_000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new RangeError('email queue close timeout must be a positive integer')
    }
    this.accepting = false
    const drain = async (): Promise<void> => {
      while (this.scheduled.size > 0 || this.active.size > 0) {
        for (const scheduled of [...this.scheduled]) {
          clearTimeout(scheduled.timer)
          this.scheduled.delete(scheduled)
          this.run(scheduled.task)
        }
        if (this.active.size > 0) await Promise.all([...this.active])
      }
    }
    let abort: ReturnType<typeof setTimeout> | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        drain(),
        new Promise<never>((_, reject) => {
          abort = setTimeout(
            () => this.shutdown.abort(),
            Math.max(1, timeoutMs - 1_000),
          )
          timeout = setTimeout(
            () => reject(new Error('email queue did not drain before shutdown')),
            timeoutMs,
          )
        }),
      ])
    } finally {
      if (abort !== undefined) clearTimeout(abort)
      if (timeout !== undefined) clearTimeout(timeout)
    }
  }
}
