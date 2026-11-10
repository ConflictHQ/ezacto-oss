import { safeDeelFailure } from './failure.js'
import type { DeelTimesheetSink } from './client.js'
import type { ContractMatch } from './matching.js'

/**
 * The transfer log is the whole safety story of this sync. Deel has no
 * idempotency key on timesheet creation, so a second run that recomputed the
 * same hours would create a second timesheet and pay them twice. Every entry
 * that reaches Deel is written down with a fingerprint of exactly what was
 * sent, and the planner refuses to send an entry that is already in the log.
 */
export interface TransferLogRecord {
  entryId: number
  fingerprint: string
  timesheetId: string
}

export interface TransferTimeEntry {
  id: number
  userId: number
  spentDate: string
  roundedSeconds: number
}

export interface PlannedEntry {
  entryId: number
  fingerprint: string
}

export interface PlannedSubmission {
  contractId: string
  userId: number
  spentDate: string
  roundedSeconds: number
  quantityHours: number
  entries: readonly PlannedEntry[]
}

export interface TransferConflict {
  entryId: number
  timesheetId: string
  transferredFingerprint: string
  currentFingerprint: string
}

export type UnsyncableReason = 'no_contract_match' | 'non_positive_seconds'

export interface UnsyncableEntry {
  entryId: number
  userId: number
  reason: UnsyncableReason
}

export interface TransferPlan {
  submissions: readonly PlannedSubmission[]
  alreadyTransferred: readonly { entryId: number; timesheetId: string }[]
  conflicts: readonly TransferConflict[]
  unsyncable: readonly UnsyncableEntry[]
}

/**
 * What was sent, not when it was sent: contract, day, and duration. An entry
 * whose hours or date were edited after transfer no longer matches its logged
 * fingerprint, which is how an amendment surfaces as something a person has to
 * decide about rather than as a silent second payment.
 */
export const timeEntryFingerprint = (input: {
  contractId: string
  spentDate: string
  roundedSeconds: number
}): string => `${input.contractId}:${input.spentDate}:${input.roundedSeconds}`

/**
 * Deel takes hours as a decimal. Four places is the finest figure worth
 * carrying: the residual is under two tenths of a second per person-day, which
 * cannot move a cent at any rate this system supports, and the arithmetic stays
 * on integers so the half-hour cases land exactly.
 */
const quantityHours = (roundedSeconds: number): number =>
  Number((BigInt(roundedSeconds) * 10_000n + 1_800n) / 3_600n) / 10_000

export const planTimeTransfer = (input: {
  entries: readonly TransferTimeEntry[]
  matches: readonly ContractMatch[]
  log: readonly TransferLogRecord[]
}): TransferPlan => {
  const contractByUser = new Map(input.matches.map((match) => [match.userId, match.contractId]))
  const logByEntry = new Map(input.log.map((row) => [row.entryId, row]))
  const seen = new Set<number>()

  const groups = new Map<string, PlannedSubmission & { entries: PlannedEntry[] }>()
  const alreadyTransferred: { entryId: number; timesheetId: string }[] = []
  const conflicts: TransferConflict[] = []
  const unsyncable: UnsyncableEntry[] = []

  for (const entry of input.entries) {
    if (seen.has(entry.id)) throw new RangeError(`time entry id ${entry.id} appears twice`)
    seen.add(entry.id)

    const contractId = contractByUser.get(entry.userId)
    if (contractId === undefined) {
      unsyncable.push({ entryId: entry.id, userId: entry.userId, reason: 'no_contract_match' })
      continue
    }
    // A Harvest-style correction offsets an earlier entry and cannot be posted
    // to Deel as negative hours. It is reported so the run's totals are
    // visibly incomplete instead of quietly overstated.
    if (entry.roundedSeconds <= 0) {
      unsyncable.push({ entryId: entry.id, userId: entry.userId, reason: 'non_positive_seconds' })
      continue
    }

    const fingerprint = timeEntryFingerprint({
      contractId,
      spentDate: entry.spentDate,
      roundedSeconds: entry.roundedSeconds,
    })
    const transferred = logByEntry.get(entry.id)
    if (transferred !== undefined) {
      if (transferred.fingerprint === fingerprint) {
        alreadyTransferred.push({ entryId: entry.id, timesheetId: transferred.timesheetId })
      } else {
        conflicts.push({
          entryId: entry.id,
          timesheetId: transferred.timesheetId,
          transferredFingerprint: transferred.fingerprint,
          currentFingerprint: fingerprint,
        })
      }
      continue
    }

    const key = `${entry.spentDate}\u0000${contractId}`
    const group = groups.get(key)
    if (group === undefined) {
      groups.set(key, {
        contractId,
        userId: entry.userId,
        spentDate: entry.spentDate,
        roundedSeconds: entry.roundedSeconds,
        quantityHours: 0,
        entries: [{ entryId: entry.id, fingerprint }],
      })
    } else {
      group.roundedSeconds += entry.roundedSeconds
      group.entries.push({ entryId: entry.id, fingerprint })
    }
  }

  // Oldest day first, so a run that dies halfway leaves a contiguous tail to
  // pick up rather than a scatter of transferred days.
  const submissions = [...groups.values()]
    .sort((left, right) =>
      left.spentDate === right.spentDate
        ? left.contractId.localeCompare(right.contractId)
        : left.spentDate.localeCompare(right.spentDate),
    )
    .map((group) => ({
      ...group,
      quantityHours: quantityHours(group.roundedSeconds),
      entries: [...group.entries].sort((left, right) => left.entryId - right.entryId),
    }))

  return { submissions, alreadyTransferred, conflicts, unsyncable }
}

export interface FailedSubmission {
  contractId: string
  spentDate: string
  entryIds: readonly number[]
  reason: string
}

export interface TransferResult {
  records: readonly TransferLogRecord[]
  failed: readonly FailedSubmission[]
}

const defaultDescription = (submission: PlannedSubmission): string =>
  `ezacto time sync ${submission.spentDate}`

/**
 * Submits a plan one timesheet at a time and reports what Deel took. A
 * submission that failed writes no log record, so the next run retries it —
 * which is safe when the request was rejected and needs a human when it is not
 * clear whether it landed. That is why the failure is reported with the entries
 * it covered rather than swallowed as a retryable blip.
 */
export const submitTransferPlan = async (input: {
  plan: TransferPlan
  client: DeelTimesheetSink
  describe?: (submission: PlannedSubmission) => string
}): Promise<TransferResult> => {
  const describe = input.describe ?? defaultDescription
  const records: TransferLogRecord[] = []
  const failed: FailedSubmission[] = []
  for (const submission of input.plan.submissions) {
    try {
      const receipt = await input.client.createTimesheet({
        contractId: submission.contractId,
        spentDate: submission.spentDate,
        quantityHours: submission.quantityHours,
        description: describe(submission),
      })
      for (const entry of submission.entries) {
        records.push({
          entryId: entry.entryId,
          fingerprint: entry.fingerprint,
          timesheetId: receipt.timesheetId,
        })
      }
    } catch (error) {
      failed.push({
        contractId: submission.contractId,
        spentDate: submission.spentDate,
        entryIds: submission.entries.map((entry) => entry.entryId),
        reason: safeDeelFailure(error),
      })
    }
  }
  return { records, failed }
}
