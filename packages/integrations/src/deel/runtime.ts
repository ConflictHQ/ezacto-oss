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
  type TransferLogRecord,
  type TransferTimeEntry,
} from './time-sync.js'

/**
 * Running the Deel time sync on a schedule (issue 103).
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
 *   here enforces the third.
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
  fetch: (request: Request) => Promise<Response>
  now: () => Date
}

export type DeelSyncRunResult =
  | { status: 'unconfigured'; reason: string }
  | { status: 'busy' }
  | {
      status: 'completed' | 'failed'
      runId: number
      timesheetsSubmitted: number
      entriesTransferred: number
      failed: readonly FailedSubmission[]
      reconciliation: DeelReconciliationReport | null
      error: string | null
    }

export interface DeelSyncRuntime {
  status(): { configured: boolean; reason: string | null }
  run(): Promise<DeelSyncRunResult>
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

  return {
    status: () => ({ configured: problem === null, reason: problem }),

    reconcile: async () => {
      if (client === null) return { status: 'unconfigured', reason: problem ?? '' }
      const found = await contractMatches(client)
      return reconcileTransferLog({
        logged: await options.source.logged(),
        matches: found.matches,
      })
    },

    run: async () => {
      if (client === null) return { status: 'unconfigured', reason: problem ?? '' }
      const startedAt = options.now()
      const runId = await options.source.beginRun(startedAt.toISOString())
      if (runId === null) return { status: 'busy' }

      let timesheetsSubmitted = 0
      let entriesTransferred = 0
      const failed: FailedSubmission[] = []
      let reconciliation: DeelReconciliationReport | null = null
      let error: string | null = null
      let detail: Record<string, unknown>
      try {
        const window = { from: startDate, to: dayBefore(startedAt) }
        const found = await contractMatches(client)
        const plan = planTimeTransfer({
          entries: window.to < window.from ? [] : await options.source.entries(window),
          matches: found.matches,
          log: await options.source.log(window),
        })
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
          window,
          alreadyTransferred: plan.alreadyTransferred.length,
          conflicts: plan.conflicts,
          unsyncable: plan.unsyncable,
          unmatched: found.unmatched,
          failed,
          reconciliation,
        }
      } catch (caught) {
        // The message of a DeelApiError carries a status and nothing else, and
        // nothing in this path holds the token, so this is safe to persist.
        error = caught instanceof Error ? caught.message : String(caught)
        detail = { error, failed }
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
    },
  }
}
