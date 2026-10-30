import type { PaymentActualEntry } from './payment-actuals.js'
import { trackedAmountCents } from './reports.js'

/**
 * Issue 902, slice 1: the read model that proposes contractor earnings for a
 * work month from captured actuals. It only derives; nothing here writes,
 * schedules, confirms or sends.
 */
export type ReconciliationExceptionCode = 'missing_rate' | 'changed_source'
export type EarningsProposalStatus = 'new' | 'converged' | 'differs' | 'attention'
export interface ReconciliationException {
  code: ReconciliationExceptionCode
  entry_ids: number[]
}
export interface ReconciliationPerson {
  user_id: number
  name: string
  /** Current captured entries; selected_seconds is ignored. */
  entries: PaymentActualEntry[]
  /** Entries of the latest confirmed review, or null when none exists. */
  confirmed: { amount_cents: number; entries: PaymentActualEntry[] } | null
}
export interface ProposedEarnings {
  user_id: number
  name: string
  proposed_cents: number
  confirmed_cents: number | null
  status: EarningsProposalStatus
  exceptions: ReconciliationException[]
}
export interface PaymentReconciliation {
  month: string
  currency: string
  completed: boolean
  people: ProposedEarnings[]
}

const sourceChanged = (a: PaymentActualEntry, b: PaymentActualEntry): boolean =>
  a.project_id !== b.project_id ||
  a.spent_date !== b.spent_date ||
  a.rounded_seconds !== b.rounded_seconds ||
  a.cost_rate_cents !== b.cost_rate_cents

export const proposeEarnings = (person: ReconciliationPerson): ProposedEarnings => {
  let proposed = 0
  const missing: number[] = []
  for (const entry of person.entries) {
    if (entry.rounded_seconds === 0) continue
    if (entry.cost_rate_cents === null) missing.push(entry.entry_id)
    else proposed += trackedAmountCents(entry.rounded_seconds, entry.cost_rate_cents)
  }
  const changed: number[] = []
  if (person.confirmed) {
    const current = new Map(person.entries.map((e) => [e.entry_id, e]))
    const captured = new Map(person.confirmed.entries.map((e) => [e.entry_id, e]))
    for (const [id, entry] of captured) {
      const now = current.get(id)
      if (!now || sourceChanged(entry, now)) changed.push(id)
    }
    for (const id of current.keys()) if (!captured.has(id)) changed.push(id)
  }
  const exceptions: ReconciliationException[] = []
  if (missing.length) exceptions.push({ code: 'missing_rate', entry_ids: missing })
  if (changed.length)
    exceptions.push({ code: 'changed_source', entry_ids: changed.sort((a, b) => a - b) })
  const confirmed_cents = person.confirmed?.amount_cents ?? null
  const status: EarningsProposalStatus = exceptions.length
    ? 'attention'
    : confirmed_cents === null
      ? 'new'
      : confirmed_cents === proposed
        ? 'converged'
        : 'differs'
  return {
    user_id: person.user_id,
    name: person.name,
    proposed_cents: proposed,
    confirmed_cents,
    status,
    exceptions,
  }
}

export const reconcileEarnings = (
  month: string,
  currency: string,
  completed: boolean,
  people: readonly ReconciliationPerson[],
): PaymentReconciliation => ({
  month,
  currency,
  completed,
  people: people.map(proposeEarnings),
})
