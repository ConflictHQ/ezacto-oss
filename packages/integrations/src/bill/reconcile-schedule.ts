/**
 * Running the BILL payment reconciliation on a schedule (issue 834).
 *
 * `reconcilePayments` existed from the start and nothing called it, so a
 * client paying at BILL was never noticed here. It is also a walk over every
 * receivable payment BILL holds, so it belongs on an hourly cadence rather
 * than the outbox's own tick: the Worker fires it from an hourly cron, and the
 * container -- which polls its outbox every fifteen seconds -- runs it through
 * the same wrapper with `everyMs` set to an hour.
 *
 * It never throws. A BILL outage is reported and otherwise ignored: the
 * caller drains the outbox next, and a third party being down must not stop
 * our own mail from going out.
 */
export interface ScheduledReconciliationOptions {
  readonly reconcile: () => Promise<number>
  /** At most one run per this many milliseconds; omit to run on every call. */
  readonly everyMs?: number
  readonly now?: () => number
  readonly report: (error: unknown) => void
}

export const createScheduledReconciliation = (
  options: Readonly<ScheduledReconciliationOptions>,
): (() => Promise<number>) => {
  const now = options.now ?? Date.now
  let lastStartedAt: number | null = null
  return async () => {
    const at = now()
    if (
      options.everyMs !== undefined &&
      lastStartedAt !== null &&
      at - lastStartedAt < options.everyMs
    ) {
      return 0
    }
    lastStartedAt = at
    try {
      return await options.reconcile()
    } catch (error) {
      options.report(error)
      return 0
    }
  }
}
