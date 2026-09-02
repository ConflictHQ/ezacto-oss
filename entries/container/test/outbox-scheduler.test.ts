import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OutboxDrainSummary, OutboxService } from '@ezacto/db'
import { ContainerOutboxScheduler } from '../src/outbox-scheduler.js'

const summary: OutboxDrainSummary = {
  examined: 0,
  delivered: 0,
  retried: 0,
  failed: 0,
  contention: 0,
}

afterEach(() => {
  vi.useRealTimers()
})

describe('container outbox scheduler', () => {
  it('[unit] starts immediately, follows a deterministic interval, and never overlaps drains', async () => {
    vi.useFakeTimers()
    let release!: () => void
    const blocked = new Promise<OutboxDrainSummary>((resolve) => {
      release = () => resolve(summary)
    })
    const drain = vi.fn().mockReturnValueOnce(blocked).mockResolvedValue(summary)
    const scheduler = new ContainerOutboxScheduler(
      { drain } as unknown as OutboxService,
      { intervalMs: 100 },
    )

    scheduler.start()
    expect(drain).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(300)
    expect(drain).toHaveBeenCalledTimes(1)

    release()
    await blocked
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(100)
    expect(drain).toHaveBeenCalledTimes(2)
    await scheduler.close()
  })

  it('[unit] coalesces explicit calls and reports only safe error names', async () => {
    let reject!: (error: Error) => void
    const blocked = new Promise<OutboxDrainSummary>((_resolve, rejectPromise) => {
      reject = rejectPromise
    })
    const reportError = vi.fn()
    const scheduler = new ContainerOutboxScheduler(
      { drain: vi.fn(() => blocked) } as unknown as OutboxService,
      { intervalMs: 100, reportError },
    )
    scheduler.start()
    expect(scheduler.drain()).toBe(scheduler.drain())
    reject(new Error('secret database detail'))
    await expect(blocked).rejects.toThrow('secret database detail')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reportError).toHaveBeenCalledWith('Error')
    expect(reportError).not.toHaveBeenCalledWith(expect.stringContaining('secret'))
    await scheduler.close()
  })
})
