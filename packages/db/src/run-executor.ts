/**
 * Driving a confirmed run to completion (#62).
 *
 * The store below it holds the rule -- an item that completed is never done
 * again -- and this is the loop that relies on it. Keeping the two apart is
 * what lets the loop be dull: it does not decide what may run, it asks, and the
 * schema is what answers.
 *
 * Deliberately not a queue or a Workflow. Those are how a deployment keeps this
 * alive across a process dying, and both call the same function; what makes a
 * resume safe is the per-item record, not the thing that restarts it. So this
 * is the part that can be tested by killing it.
 */

import type { RunItemRecord, ScheduledActionStore } from './scheduled-actions.js'

/**
 * What an action does with one item.
 *
 * Throwing is how it fails. Returning normally is how it succeeds, and the
 * executor takes that literally: a handler that swallows its own error and
 * returns would have the item recorded as done, which is the one thing this
 * design is protecting.
 */
export type RunItemHandler = (item: RunItemRecord) => Promise<void>

export interface RunExecutionReport {
  runId: number
  /** Items this pass finished. */
  completed: number
  /** Items this pass tried and could not finish, with why. */
  failed: readonly { itemId: number; reason: string }[]
  /** True only where nothing is outstanding afterwards. */
  runCompleted: boolean
}

export interface RunExecutorOptions {
  store: ScheduledActionStore
  handler: RunItemHandler
  now: () => string
  /**
   * Stops the pass early. A Worker has a wall-clock budget, and a pass that
   * ignores it is killed mid-item -- which is survivable by design, but leaves
   * an item to be re-attempted for no reason.
   */
  signal?: AbortSignal
}

const reasonOf = (error: unknown): string =>
  error instanceof Error && error.message.trim() !== ''
    ? error.message.slice(0, 2000)
    : 'the handler failed without saying why'

/**
 * Runs everything outstanding, once each.
 *
 * One pass rather than a retry loop. A handler that failed for a reason that
 * has not changed fails again immediately, and burning the attempt budget
 * inside a single pass turns a transient failure into an exhausted one. The
 * caller decides when to come back.
 */
export const executeRun = async (
  runId: number,
  options: Readonly<RunExecutorOptions>,
): Promise<RunExecutionReport> => {
  const { store, handler } = options
  const failed: { itemId: number; reason: string }[] = []
  let completed = 0

  for (const item of await store.outstanding(runId)) {
    if (options.signal?.aborted === true) break
    // Claimed before the work. A claim that comes back false is an item some
    // other pass already finished -- which is the normal outcome of two workers
    // meeting, not an error.
    if (!(await store.claimItem(item.id, options.now()))) continue
    try {
      await handler(item)
      await store.completeItem(item.id, options.now())
      completed += 1
    } catch (error) {
      const reason = reasonOf(error)
      await store.failItem(item.id, options.now(), reason)
      failed.push({ itemId: item.id, reason })
    }
  }

  // Only where nothing is left. A pass that was cut short by its deadline has
  // not finished the run, and saying it had would leave items nobody did.
  const runCompleted = await store.settleRun(runId, options.now())
  return { runId, completed, failed, runCompleted }
}
