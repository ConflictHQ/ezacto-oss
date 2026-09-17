import { describe, expect, it, vi } from 'vitest'
import { createScheduledReconciliation } from '../src/bill/reconcile-schedule.js'

describe('scheduled BILL reconciliation (issue 834)', () => {
  it('[unit] runs the reconciliation and hands back what it recorded', async () => {
    const reconcile = vi.fn(async () => 3)
    const run = createScheduledReconciliation({ reconcile, report: vi.fn() })
    expect(await run()).toBe(3)
    expect(reconcile).toHaveBeenCalledTimes(1)
  })

  it('[reliability] a BILL failure is reported and swallowed, so the outbox still drains', async () => {
    const failure = new Error('BILL refused /v3/login (401)')
    const report = vi.fn()
    const run = createScheduledReconciliation({
      reconcile: async () => {
        throw failure
      },
      report,
    })
    await expect(run()).resolves.toBe(0)
    expect(report).toHaveBeenCalledWith(failure)
  })

  it('[unit] with a cadence, the container poll runs it once an hour, not every fifteen seconds', async () => {
    let clock = 1_000_000
    const reconcile = vi.fn(async () => 1)
    const run = createScheduledReconciliation({
      reconcile,
      everyMs: 3_600_000,
      now: () => clock,
      report: vi.fn(),
    })
    expect(await run()).toBe(1)
    clock += 15_000
    expect(await run()).toBe(0)
    clock += 3_600_000 - 15_000 - 1
    expect(await run()).toBe(0)
    clock += 1
    expect(await run()).toBe(1)
    expect(reconcile).toHaveBeenCalledTimes(2)
  })

  it('[reliability] a failed run still counts toward the cadence, so an outage is not retried on every tick', async () => {
    let clock = 0
    const reconcile = vi.fn(async () => {
      throw new Error('down')
    })
    const run = createScheduledReconciliation({
      reconcile,
      everyMs: 3_600_000,
      now: () => clock,
      report: vi.fn(),
    })
    await run()
    clock += 15_000
    await run()
    expect(reconcile).toHaveBeenCalledTimes(1)
  })
})
