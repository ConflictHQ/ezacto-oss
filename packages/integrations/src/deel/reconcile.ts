import type { ContractMatch } from './matching.js'
import { timeEntryFingerprint, type TransferTimeEntry } from './time-sync.js'

/**
 * A transfer-log row alongside the time entry it was written for, as that entry
 * stands now. `current` is null when the entry no longer exists.
 */
export interface LoggedTransfer {
  entryId: number
  fingerprint: string
  timesheetId: string
  current: TransferTimeEntry | null
}

export interface EditedTransfer {
  entryId: number
  timesheetId: string
  transferredFingerprint: string
  currentFingerprint: string
}

export interface DeelReconciliationReport {
  /** Logged transfers whose entry still says exactly what was sent. */
  confirmed: number
  /** Hours were sent, then the entry changed. Deel holds the old figure. */
  edited: readonly EditedTransfer[]
  /** Hours were sent, then the entry was deleted. */
  removed: readonly { entryId: number; timesheetId: string }[]
  /**
   * The entry exists but its person has no active Deel contract match today, so
   * what it would say now cannot be computed. Reported, never assumed fine.
   */
  unmatched: readonly { entryId: number; timesheetId: string; userId: number }[]
}

/**
 * Checks the transfer log against the books. This local source reconciliation
 * is separate from payment-status.ts, which reads provider timesheet status.
 * Its job is to make a divergence visible:
 * the planner already refuses to send an edited entry a second time, which
 * leaves a person to decide whether Deel's figure needs correcting there.
 */
export const reconcileTransferLog = (input: {
  logged: readonly LoggedTransfer[]
  matches: readonly ContractMatch[]
}): DeelReconciliationReport => {
  const contractByUser = new Map(input.matches.map((match) => [match.userId, match.contractId]))
  let confirmed = 0
  const edited: EditedTransfer[] = []
  const removed: { entryId: number; timesheetId: string }[] = []
  const unmatched: { entryId: number; timesheetId: string; userId: number }[] = []

  for (const row of input.logged) {
    if (row.current === null) {
      removed.push({ entryId: row.entryId, timesheetId: row.timesheetId })
      continue
    }
    const contractId = contractByUser.get(row.current.userId)
    if (contractId === undefined) {
      unmatched.push({
        entryId: row.entryId,
        timesheetId: row.timesheetId,
        userId: row.current.userId,
      })
      continue
    }
    const currentFingerprint = timeEntryFingerprint({
      contractId,
      spentDate: row.current.spentDate,
      roundedSeconds: row.current.roundedSeconds,
    })
    if (currentFingerprint === row.fingerprint) {
      confirmed += 1
    } else {
      edited.push({
        entryId: row.entryId,
        timesheetId: row.timesheetId,
        transferredFingerprint: row.fingerprint,
        currentFingerprint,
      })
    }
  }
  return { confirmed, edited, removed, unmatched }
}
