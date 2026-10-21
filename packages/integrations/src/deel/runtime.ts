import { DeelClient, type DeelPerson, type DeelTimesheetSink } from './client.js'
import { matchPayrollContracts, type DirectoryPerson } from './matching.js'
import {
  reconcileTransferLog,
  type LoggedTransfer,
  type DeelReconciliationReport,
} from './reconcile.js'
import {
  planTimeTransfer,
  submitTransferPlan,
  type FailedSubmission,
  type TransferConflict,
  type TransferLogRecord,
  type TransferTimeEntry,
  type UnsyncableEntry,
} from './time-sync.js'

/**
 * Running the Deel time sync (issue 103), by hand or on a schedule (#1102).
 *
 * The planner, the matcher and the client existed and nothing called them. This
 * is the seam that does, and it is built to refuse rather than guess:
 *
 * - Nothing runs without BOTH a token and a start date. The start date is not
 *   a convenience. Time through earlier months was paid by other means, and a
 *   first run with no floor would submit every approved entry the system has
 *   ever held for a Deel-paid person.
 * - Only people whose payment provider is Deel, only approved entries, only
 *   whole days that have ended. The source enforces the first two; the window
 *   here enforces the third and the start date floor.
 * - A manual run submits only the entries a preview showed. If the plan has
 *   changed since the preview, nothing is sent.
 * - Each timesheet is written to the transfer log the moment Deel accepts it,
 *   not at the end of the run, so a run that dies partway leaves no accepted
 *   timesheet unrecorded except the one in flight.
 * - One run at a time.
 */
export interface DeelSyncWindow {
  /** Inclusive ISO calendar dates. */
  from: string
  to: string
}

export interface DeelSyncSummary {
  timesheetsSubmitted: number
  entriesTransferred: number
  detail: Record<string, unknown>
}

/** What the runtime needs from storage. `@ezacto/db` implements it. */
export interface DeelSyncSource {
  /** People paid through Deel, with the addresses they can be matched on. */
  directory(): Promise<readonly DirectoryPerson[]>
  /** Approved, stopped, in-window entries of the people `directory` returns. */
  entries(window: DeelSyncWindow): Promise<readonly TransferTimeEntry[]>
  /** Transfer-log rows for the entries `entries` returns. */
  log(window: DeelSyncWindow): Promise<readonly TransferLogRecord[]>
  /** Every transfer-log row with its entry as it stands now. */
  logged(): Promise<readonly LoggedTransfer[]>
  record(record: TransferLogRecord, now: string): Promise<void>
  /** Null when another run holds the lock. */
  beginRun(now: string): Promise<number | null>
  finishRun(
    id: number,
    outcome: 'completed' | 'failed',
    summary: DeelSyncSummary,
    now: string,
  ): Promise<void>
}

/** What the automatic schedule reads. `@ezacto/db` implements it. */
export interface DeelSyncSettingsSource {
  get(): Promise<{ mode: 'manual' | 'automatic'; runTime: string }>
  /** False when today was already claimed or the mode is no longer automatic. */
  claimAutomaticDay(date: string): Promise<boolean>
  /** IANA timezone name of the organization. */
  organizationTimezone(): Promise<string>
}

export interface DeelSyncConfig {
  token?: string | undefined
  /** First day (ISO) whose time may be sent. */
  startDate?: string | undefined
  baseUrl?: string | undefined
}

/** The two calls the runner makes of Deel; tests substitute a fake for it. */
export interface DeelSyncClient extends DeelTimesheetSink {
  listPeople(): Promise<readonly DeelPerson[]>
}

export interface DeelSyncRuntimeOptions {
  config: DeelSyncConfig
  source: DeelSyncSource
  settings: DeelSyncSettingsSource
  fetch: (request: Request) => Promise<Response>
  now: () => Date
}

export interface DeelSyncRunRequest {
  /** Defaults to the start date through the last day that has ended. */
  window?: DeelSyncWindow
  /**
   * The entries a preview showed. The run submits only when the plan holds
   * exactly these entries; otherwise it submits nothing and reports `stale`.
   */
  expectedEntryIds?: readonly number[]
  trigger?: 'manual' | 'automatic'
  /** The administrator who started a manual run. */
  userId?: number | null
}

export interface DeelSyncPreview {
  window: DeelSyncWindow
  /** Entries that would be sent, in planned order. */
  entryIds: readonly number[]
  timesheets: number
  alreadyTransferred: number
  conflicts: readonly TransferConflict[]
  unsyncable: readonly UnsyncableEntry[]
  unmatched: readonly unknown[]
}

export type DeelSyncRunResult =
  | { status: 'unconfigured'; reason: string }
  | { status: 'invalid'; reason: string }
  | { status: 'not_due'; reason: string }
  | { status: 'busy' }
  | { status: 'stale'; runId: number; reason: string }
  | {
      status: 'completed' | 'failed'
      runId: number
      timesheetsSubmitted: number
      entriesTransferred: number
      failed: readonly FailedSubmission[]
      reconciliation: DeelReconciliationReport | null
      error: string | null
    }

export type DeelSyncPreviewResult =
  | { status: 'unconfigured'; reason: string }
  | { status: 'invalid'; reason: string }
  | ({ status: 'ready' } & DeelSyncPreview)

export interface DeelSyncRuntime {
  status(): { configured: boolean; reason: string | null }
  preview(window: DeelSyncWindow): Promise<DeelSyncPreviewResult>
  run(request?: DeelSyncRunRequest): Promise<DeelSyncRunResult>
  /** Runs once a day, at the configured time, when the mode is automatic. */
  runAutomaticIfDue(): Promise<DeelSyncRunResult>
  reconcile(): Promise<DeelReconciliationReport | { status: 'unconfigured'; reason: string }>
}

const isoDate = /^\d{4}-\d{2}-\d{2}$/u

const validDate = (value: string): boolean =>
  isoDate.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value

const configurationProblem = (config: DeelSyncConfig): string | null => {
  if (config.token === undefined || config.token.trim() === '') return 'no Deel token is configured'
  if (config.startDate === undefined || config.startDate.trim() === '') {
    return 'no sync start date is configured'
  }
  if (!validDate(config.startDate.trim())) return 'the sync start date is not an ISO calendar date'
  return null
}

const dayBefore = (instant: Date): string =>
  new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate() - 1))
    .toISOString()
    .slice(0, 10)

/** The window a request names, checked against the start date and the day clock. */
const resolveWindow = (
  window: DeelSyncWindow | undefined,
  startDate: string,
  now: Date,
): DeelSyncWindow | string => {
  const resolved = window ?? { from: startDate, to: dayBefore(now) }
  if (!validDate(resolved.from) || !validDate(resolved.to))
    return 'the window dates are not ISO calendar dates'
  if (resolved.from < startDate) return `the window starts before the sync start date ${startDate}`
  if (resolved.to > dayBefore(now)) return 'the window includes a day that has not ended'
  if (resolved.to < resolved.from) return 'the window ends before it starts'
  return resolved
}

/** The date and `HH:MM` a timezone shows at an instant. Falls back to UTC. */
const localDateTime = (instant: Date, timeZone: string): { date: string; time: string } => {
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }
  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-CA', { ...options, timeZone })
  } catch {
    formatter = new Intl.DateTimeFormat('en-CA', { ...options, timeZone: 'UTC' })
  }
  const part = (type: string): string =>
    formatter.formatToParts(instant).find((entry) => entry.type === type)?.value ?? ''
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    time: `${part('hour')}:${part('minute')}`,
  }
}

const sameIds = (left: readonly number[], right: readonly number[]): boolean => {
  if (left.length !== right.length) return false
  const sortedLeft = [...left].sort((a, b) => a - b)
  const sortedRight = [...right].sort((a, b) => a - b)
  return sortedLeft.every((id, index) => id === sortedRight[index])
}

export const createDeelSyncRuntime = (
  options: DeelSyncRuntimeOptions & { client?: DeelSyncClient },
): DeelSyncRuntime => {
  const problem = configurationProblem(options.config)
  const startDate = options.config.startDate?.trim() ?? ''
  const client: DeelSyncClient | null =
    problem !== null
      ? null
      : (options.client ??
        new DeelClient({
          token: options.config.token as string,
          fetch: options.fetch,
          ...(options.config.baseUrl === undefined ? {} : { baseUrl: options.config.baseUrl }),
        }))

  const contractMatches = async (deel: DeelSyncClient) =>
    matchPayrollContracts({
      people: await options.source.directory(),
      deelPeople: await deel.listPeople(),
    })

  const planWindow = async (
    window: DeelSyncWindow,
    matches: Awaited<ReturnType<typeof contractMatches>>['matches'],
  ) =>
    planTimeTransfer({
      entries: await options.source.entries(window),
      matches,
      log: await options.source.log(window),
    })

  const plannedEntryIds = (plan: Awaited<ReturnType<typeof planWindow>>): number[] =>
    plan.submissions.flatMap((submission) => submission.entries.map((entry) => entry.entryId))

  const preview = async (window: DeelSyncWindow): Promise<DeelSyncPreviewResult> => {
    if (client === null) return { status: 'unconfigured', reason: problem ?? '' }
    const resolved = resolveWindow(window, startDate, options.now())
    if (typeof resolved === 'string') return { status: 'invalid', reason: resolved }
    const found = await contractMatches(client)
    const plan = await planWindow(resolved, found.matches)
    return {
      status: 'ready',
      window: resolved,
      entryIds: plannedEntryIds(plan),
      timesheets: plan.submissions.length,
      alreadyTransferred: plan.alreadyTransferred.length,
      conflicts: plan.conflicts,
      unsyncable: plan.unsyncable,
      unmatched: found.unmatched,
    }
  }

  const run = async (request: DeelSyncRunRequest = {}): Promise<DeelSyncRunResult> => {
    if (client === null) return { status: 'unconfigured', reason: problem ?? '' }
    const startedAt = options.now()
    const resolved = resolveWindow(request.window, startDate, startedAt)
    if (typeof resolved === 'string') return { status: 'invalid', reason: resolved }
    const runId = await options.source.beginRun(startedAt.toISOString())
    if (runId === null) return { status: 'busy' }

    let timesheetsSubmitted = 0
    let entriesTransferred = 0
    const failed: FailedSubmission[] = []
    let reconciliation: DeelReconciliationReport | null = null
    let error: string | null = null
    let stale: string | null = null
    let detail: Record<string, unknown>
    const trigger = {
      trigger: request.trigger ?? 'manual',
      userId: request.userId ?? null,
      window: resolved,
    }
    try {
      const found = await contractMatches(client)
      const plan = await planWindow(resolved, found.matches)
      const planned = plannedEntryIds(plan)
      if (request.expectedEntryIds !== undefined && !sameIds(planned, request.expectedEntryIds)) {
        stale =
          'the entries to send changed since the preview, so nothing was submitted. Preview again before sending.'
        detail = { ...trigger, stale, expected: request.expectedEntryIds, planned }
      } else {
        for (const submission of plan.submissions) {
          const result = await submitTransferPlan({
            plan: { ...plan, submissions: [submission] },
            client,
          })
          failed.push(...result.failed)
          if (result.records.length > 0) timesheetsSubmitted += 1
          for (const record of result.records) {
            await options.source.record(record, options.now().toISOString())
            entriesTransferred += 1
          }
        }
        reconciliation = reconcileTransferLog({
          logged: await options.source.logged(),
          matches: found.matches,
        })
        detail = {
          ...trigger,
          alreadyTransferred: plan.alreadyTransferred.length,
          conflicts: plan.conflicts,
          unsyncable: plan.unsyncable,
          unmatched: found.unmatched,
          failed,
          reconciliation,
        }
      }
    } catch (caught) {
      // The message of a DeelApiError carries a status and nothing else, and
      // nothing in this path holds the token, so this is safe to persist.
      error = caught instanceof Error ? caught.message : String(caught)
      detail = { ...trigger, error, failed }
    }
    if (stale !== null) {
      await options.source.finishRun(
        runId,
        'failed',
        { timesheetsSubmitted: 0, entriesTransferred: 0, detail },
        options.now().toISOString(),
      )
      return { status: 'stale', runId, reason: stale }
    }
    const outcome = error === null && failed.length === 0 ? 'completed' : 'failed'
    await options.source.finishRun(
      runId,
      outcome,
      { timesheetsSubmitted, entriesTransferred, detail },
      options.now().toISOString(),
    )
    return {
      status: outcome,
      runId,
      timesheetsSubmitted,
      entriesTransferred,
      failed,
      reconciliation,
      error,
    }
  }

  return {
    status: () => ({ configured: problem === null, reason: problem }),

    preview,

    run,

    runAutomaticIfDue: async () => {
      if (client === null) return { status: 'unconfigured', reason: problem ?? '' }
      const now = options.now()
      const settings = await options.settings.get()
      if (settings.mode !== 'automatic') return { status: 'not_due', reason: 'the sync is manual' }
      const local = localDateTime(now, await options.settings.organizationTimezone())
      if (local.time < settings.runTime) {
        return { status: 'not_due', reason: `before the configured time ${settings.runTime}` }
      }
      if (!(await options.settings.claimAutomaticDay(local.date))) {
        return { status: 'not_due', reason: 'already ran today' }
      }
      return run({ trigger: 'automatic' })
    },

    reconcile: async () => {
      if (client === null) return { status: 'unconfigured', reason: problem ?? '' }
      const found = await contractMatches(client)
      return reconcileTransferLog({
        logged: await options.source.logged(),
        matches: found.matches,
      })
    },
  }
}
