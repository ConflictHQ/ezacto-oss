import {
  DeelStageError,
  type DeelStageAuthority,
  type DeelStageSelection,
  type DeelStageCommand,
  type DeelStageResult,
  type DeelStagePreview,
} from '@ezacto/core'
export {
  DeelStageError,
  type DeelStageAuthority,
  type DeelStageSelection,
  type DeelStageCommand,
  type DeelStageResult,
  type DeelStagePreview,
} from '@ezacto/core'
import { DeelApiError, DeelClient, type DeelPerson, type DeelTimesheetSink } from './client.js'
import { matchPayrollContracts, type DirectoryPerson } from './matching.js'
import {
  planTimeTransfer,
  type PlannedSubmission,
  type TransferLogRecord,
  type TransferTimeEntry,
} from './time-sync.js'

export interface DeelStageSnapshot {
  directory: readonly DirectoryPerson[]
  entries: readonly TransferTimeEntry[]
  log: readonly TransferLogRecord[]
  unresolved: readonly number[]
  /** Canonical native source facts, used only by the write fence; never returned. */
  sourceFacts: string
  contracts?: readonly { userId: number; contractId: string }[]
}
export interface DeelStageStore {
  snapshot(
    authority: DeelStageAuthority,
    selection: DeelStageSelection,
    now: string,
  ): Promise<DeelStageSnapshot>
  lookup(
    authority: DeelStageAuthority,
    command: DeelStageCommand,
    now: string,
  ): Promise<DeelStageResult | null>
  begin(
    authority: DeelStageAuthority,
    command: DeelStageCommand,
    snapshot: DeelStageSnapshot,
    now: string,
  ): Promise<number | null>
  claim(
    authority: DeelStageAuthority,
    runId: number,
    command: DeelStageCommand,
    snapshot: DeelStageSnapshot,
    submission: PlannedSubmission,
    now: string,
  ): Promise<boolean>
  record(
    runId: number,
    submission: PlannedSubmission,
    timesheetId: string,
    now: string,
  ): Promise<void>
  release(submission: PlannedSubmission): Promise<void>
  finish(runId: number, result: DeelStageResult, now: string): Promise<void>
}
const canonicalSelection = (
  selection: DeelStageSelection,
  startDate: string,
  now: Date,
): DeelStageSelection => {
  const validDate = (x: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(x) &&
    Number.isFinite(Date.parse(x)) &&
    new Date(x).toISOString().slice(0, 10) === x
  const yesterday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1),
  )
    .toISOString()
    .slice(0, 10)
  if (
    !validDate(selection.from) ||
    !validDate(selection.to) ||
    selection.from < startDate ||
    selection.to > yesterday ||
    selection.from > selection.to ||
    Date.parse(selection.to) - Date.parse(selection.from) >= 366 * 86400000 ||
    selection.userIds.length < 1 ||
    selection.userIds.length > 100 ||
    selection.userIds.some((id) => !Number.isSafeInteger(id) || id < 1) ||
    new Set(selection.userIds).size !== selection.userIds.length
  )
    throw new DeelStageError('invalid')
  return {
    from: selection.from,
    to: selection.to,
    userIds: [...selection.userIds].sort((a, b) => a - b),
  }
}
const digest = async (value: unknown) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('')
export const createDeelStagingRuntime = (options: {
  token?: string | undefined
  startDate?: string | undefined
  store: DeelStageStore
  fetch: (request: Request) => Promise<Response>
  now: () => Date
  client?: { listPeople(): Promise<readonly DeelPerson[]> } & DeelTimesheetSink
  reportError?: (error: Error) => void | Promise<void>
}) => {
  const report = (error: unknown) => {
    try {
      void Promise.resolve(
        options.reportError?.(error instanceof Error ? error : new Error('Deel staging failed')),
      ).catch(() => undefined)
    } catch {
      /* Reporting must not change staging or its retained outcome. */
    }
  }
  const configured = Boolean(
    options.token?.trim() &&
    options.startDate &&
    /^\d{4}-\d{2}-\d{2}$/.test(options.startDate) &&
    Number.isFinite(Date.parse(options.startDate)) &&
    new Date(options.startDate).toISOString().slice(0, 10) === options.startDate,
  )
  const client =
    options.client ??
    (configured ? new DeelClient({ token: options.token!, fetch: options.fetch }) : null)
  const readSnapshot = async (authority: DeelStageAuthority, selection: DeelStageSelection) => {
    const snapshot = await options.store.snapshot(authority, selection, options.now().toISOString())
    if (
      snapshot.entries.length > 1000 ||
      snapshot.entries.some((entry) => !Number.isSafeInteger(entry.roundedSeconds)) ||
      !Number.isSafeInteger(
        snapshot.entries.reduce((total, entry) => total + Math.abs(entry.roundedSeconds), 0),
      )
    )
      throw new DeelStageError('invalid')
    return snapshot
  }
  const prepare = async (authority: DeelStageAuthority, input: DeelStageSelection) => {
    if (!configured || !client) throw new DeelStageError('unconfigured')
    const selection = canonicalSelection(input, options.startDate!, options.now())
    await readSnapshot(authority, selection)
    let remote: readonly DeelPerson[]
    try {
      remote = await client.listPeople()
    } catch (error) {
      report(error)
      throw new DeelStageError('provider_unavailable')
    }
    // A provider read may outlive the acting session or its local authority.
    // Re-read native scope before disclosing any preview or accepting a command.
    const snapshot = await readSnapshot(authority, selection)
    const matched = matchPayrollContracts({ people: snapshot.directory, deelPeople: remote })
    const plan = planTimeTransfer({
      entries: snapshot.entries,
      matches: matched.matches,
      log: snapshot.log,
    })
    const entryById = new Map(snapshot.entries.map((entry) => [entry.id, entry]))
    const zeroDurationEntryIds = plan.unsyncable
      .filter(
        (entry) =>
          entry.reason === 'non_positive_seconds' &&
          entryById.get(entry.entryId)?.roundedSeconds === 0,
      )
      .map((entry) => entry.entryId)
    const zeroDuration = new Set(zeroDurationEntryIds)
    const open = new Set(snapshot.unresolved)
    const fingerprint = await digest([
      selection,
      snapshot.sourceFacts,
      matched.matches,
      plan.alreadyTransferred,
      plan.conflicts,
      plan.unsyncable,
      snapshot.unresolved,
    ])
    const preview: DeelStagePreview = {
      status: 'ready',
      selection,
      fingerprint,
      entryIds: plan.submissions.flatMap((x) => x.entries.map((e) => e.entryId)),
      seconds: plan.submissions.reduce((n, x) => n + x.roundedSeconds, 0),
      timesheets: plan.submissions.length,
      alreadyStaged: plan.alreadyTransferred.length,
      alreadyStagedEntryIds: plan.alreadyTransferred.map((entry) => entry.entryId),
      people: selection.userIds.map((userId) => ({
        userId,
        contractId: matched.matches.find((x) => x.userId === userId)?.contractId ?? null,
        seconds: plan.submissions
          .filter((x) => x.userId === userId)
          .reduce((n, x) => n + x.roundedSeconds, 0),
        entries: plan.submissions
          .filter((x) => x.userId === userId)
          .reduce((n, x) => n + x.entries.length, 0),
      })),
      conflicts: plan.conflicts.map((x) => x.entryId),
      unsyncable: plan.unsyncable
        .filter((entry) => !zeroDuration.has(entry.entryId))
        .map((x) => x.entryId),
      zeroDurationEntryIds,
      unmatched: matched.unmatched,
      unresolved: plan.submissions.flatMap((x) =>
        x.entries.filter((e) => open.has(e.entryId)).map((e) => e.entryId),
      ),
    }
    return {
      selection,
      snapshot: {
        ...snapshot,
        contracts: matched.matches.map((x) => ({ userId: x.userId, contractId: x.contractId })),
      },
      plan,
      preview,
      zeroDurationEntryIds,
    }
  }
  return {
    configured,
    bounds: () => {
      if (!configured) return null
      const now = options.now()
      return {
        from: options.startDate!,
        to: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1))
          .toISOString()
          .slice(0, 10),
      }
    },
    preview: async (authority: DeelStageAuthority, selection: DeelStageSelection) =>
      (await prepare(authority, selection)).preview,
    lookup: (authority: DeelStageAuthority, command: DeelStageCommand) =>
      options.store.lookup(authority, command, options.now().toISOString()),
    stage: async (
      authority: DeelStageAuthority,
      request: DeelStageCommand,
    ): Promise<DeelStageResult> => {
      if (
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
          request.id,
        ) ||
        !/^[a-f0-9]{64}$/.test(request.fingerprint)
      )
        throw new DeelStageError('invalid')
      const selection = canonicalSelection(
          request,
          options.startDate ?? '9999-01-01',
          options.now(),
        ),
        command = { ...selection, id: request.id, fingerprint: request.fingerprint }
      const existing = await options.store.lookup(authority, command, options.now().toISOString())
      if (existing) return existing
      const prepared = await prepare(authority, selection)
      if (prepared.preview.fingerprint !== command.fingerprint) throw new DeelStageError('stale')
      if (
        prepared.preview.conflicts.length ||
        prepared.plan.unsyncable.some(
          (entry) => !prepared.zeroDurationEntryIds.includes(entry.entryId),
        ) ||
        prepared.preview.unmatched.length ||
        prepared.preview.unresolved.length
      )
        throw new DeelStageError('stale')
      const runId = await options.store.begin(
        authority,
        command,
        prepared.snapshot,
        options.now().toISOString(),
      )
      const result: DeelStageResult = {
        status: runId === null ? 'busy' : 'staged',
        commandId: command.id,
        runId,
        timesheetsStaged: 0,
        entriesStaged: 0,
        alreadyStaged: prepared.preview.alreadyStaged,
        unresolved: [],
        code: null,
      }
      if (runId === null)
        return (
          (await options.store.lookup(authority, command, options.now().toISOString())) ?? result
        )
      for (const submission of prepared.plan.submissions) {
        // Provider identities can change while a multi-person review is staged.
        // Re-read before the native claim; never reuse another person's contract.
        let latestMatch: ReturnType<typeof matchPayrollContracts>
        try {
          latestMatch = matchPayrollContracts({
            people: prepared.snapshot.directory,
            deelPeople: await client!.listPeople(),
          })
        } catch (error) {
          result.status = 'attention'
          result.code = 'provider_review_unavailable'
          report(error)
          break
        }
        if (
          latestMatch.matches.find((x) => x.userId === submission.userId)?.contractId !==
          submission.contractId
        ) {
          result.status = 'stale'
          result.code = 'contract_changed'
          break
        }
        let claimed: boolean
        try {
          claimed = await options.store.claim(
            authority,
            runId,
            command,
            prepared.snapshot,
            submission,
            options.now().toISOString(),
          )
        } catch (error) {
          result.status = 'attention'
          result.code = 'source_or_authority_changed'
          await options.store.finish(runId, result, options.now().toISOString())
          throw error
        }
        if (!claimed) {
          result.status = 'stale'
          result.code = 'source_changed'
          break
        }
        let timesheetId: string
        try {
          timesheetId = (
            await client!.createTimesheet({
              contractId: submission.contractId,
              spentDate: submission.spentDate,
              quantityHours: submission.quantityHours,
              description: `ezacto approved time ${submission.spentDate}`,
            })
          ).timesheetId
        } catch (error) {
          const definite =
            error instanceof DeelApiError && [400, 401, 403, 404, 422].includes(error.status)
          let releaseFailed = false
          if (definite) {
            try {
              await options.store.release(submission)
            } catch (releaseError) {
              releaseFailed = true
              report(releaseError)
            }
          }
          if (!definite || releaseFailed)
            result.unresolved = submission.entries.map((x) => x.entryId)
          result.status = 'attention'
          result.code = definite
            ? releaseFailed
              ? 'provider_rejected_reconciliation_required'
              : 'provider_rejected'
            : 'provider_outcome_unknown'
          report(error)
          break
        }
        try {
          await options.store.record(runId, submission, timesheetId, options.now().toISOString())
          result.timesheetsStaged++
          result.entriesStaged += submission.entries.length
        } catch (error) {
          result.status = 'attention'
          result.code = 'accepted_receipt_unrecorded'
          result.unresolved = submission.entries.map((x) => x.entryId)
          report(error)
          break
        }
      }
      await options.store.finish(runId, result, options.now().toISOString())
      return (await options.store.lookup(authority, command, options.now().toISOString())) ?? result
    },
  }
}
