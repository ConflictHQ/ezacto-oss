import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import {
  StaffPaymentError,
  validPaymentMonth,
  type AcceptContractorReview,
  type ContractorAcceptance,
  type ContractorReviewStore,
  type AllocatePayment,
  type ApplyAdvanceCredit,
} from '@ezacto/core'
type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>
type Stored = Omit<ContractorAcceptance, 'state' | 'allocation_ids' | 'credit_application_ids'> & {
  command_json: string
  allocations_json: string
  credits_json: string
}
const decode = (row: Stored): ContractorAcceptance => {
  const { command_json, allocations_json, credits_json, ...record } = row
  void command_json
  return {
    ...record,
    state: 'completed',
    allocation_ids: (JSON.parse(allocations_json) as AllocatePayment[]).map((a) => a.id),
    credit_application_ids: (JSON.parse(credits_json) as ApplyAdvanceCredit[]).map((a) => a.id),
  }
}
const selection = sql`id,user_id,month,currency,review_version,reason,actor_id,recorded_at,command_json,allocations_json,credits_json`
const invalid = (message: string): never => {
  throw new StaffPaymentError('invalid', message)
}
const conflict = (): never => {
  throw new StaffPaymentError(
    'conflict',
    'The contractor review or its records changed. Reload and review before confirming again.',
  )
}
export const createContractorAcceptanceStore = (
  database: Database,
  review: ContractorReviewStore['review'],
) => {
  const existing = async (id: string) =>
    (
      await database.all<Stored>(
        sql`SELECT ${selection} FROM contractor_acceptances WHERE id=${id}`,
      )
    )[0]
  return {
    async acceptances(month: string): Promise<ContractorAcceptance[]> {
      if (!validPaymentMonth(month)) invalid('Choose a valid work month.')
      return (
        await database.all<Stored>(
          sql`SELECT ${selection} FROM contractor_acceptances WHERE month=${month} ORDER BY recorded_at,id`,
        )
      ).map(decode)
    },
    async accept(
      command: AcceptContractorReview,
      actor: number,
      request: string,
      now: string,
    ): Promise<ContractorAcceptance> {
      if (
        !/^[a-zA-Z0-9._-]{1,60}$/u.test(command.id) ||
        !validPaymentMonth(command.month) ||
        !Number.isSafeInteger(command.user_id) ||
        command.user_id <= 0 ||
        !/^[A-Z]{3}$/u.test(command.currency) ||
        !/^[0-9a-f]{64}$/u.test(command.review_version) ||
        !/^\[\d+,\d+,\d+\]$/u.test(command.source_revision) ||
        typeof command.apply_allocations !== 'boolean' ||
        typeof command.apply_credits !== 'boolean' ||
        (!command.apply_allocations && !command.apply_credits) ||
        typeof command.reason !== 'string' ||
        !command.reason.trim() ||
        command.reason.length > 2000
      )
        invalid(
          'Choose a reviewed contractor/currency, changes to confirm and an explanation of up to 2,000 characters.',
        )
      const encoded = JSON.stringify(command)
      const replay = (row: Stored | undefined) => {
        if (!row) return null
        if (row.command_json !== encoded || row.actor_id !== actor) conflict()
        return decode(row)
      }
      const prior = replay(await existing(command.id))
      if (prior) return prior
      const snapshot = await review(command.month, now)
      // A matching caller may commit while this review is loading. Replay its
      // exact actor/intent before the resulting changed snapshot can reject it.
      const reviewedReplay = replay(await existing(command.id))
      if (reviewedReplay) return reviewedReplay
      const person = snapshot.people.find((p) => p.user_id === command.user_id)
      const balance = person?.currencies.find((c) => c.currency === command.currency)
      if (!person || !balance) invalid('Choose a contractor and currency in this review.')
      if (
        !snapshot.completed ||
        !person!.active ||
        balance!.proposal_blocked ||
        person!.review_version !== command.review_version ||
        person!.source_revision !== command.source_revision
      )
        conflict()
      const reason = command.reason.trim()
      const allocations: AllocatePayment[] = command.apply_allocations
        ? balance!.allocation_proposals.map((proposal, index) => ({
            id: `${command.id}.a.${index}`,
            payment_kind: proposal.payment_kind,
            payment_id: proposal.payment_id,
            user_id: command.user_id,
            month: command.month,
            scope: 'month',
            project_id: null,
            entry_id: null,
            amount_cents: proposal.amount_cents,
            seconds: null,
            reason,
          }))
        : []
      const credits: ApplyAdvanceCredit[] = command.apply_credits
        ? balance!.credit_proposals.map((proposal, index) => ({
            id: `${command.id}.c.${index}`,
            advance_item_id: proposal.advance_item_id,
            user_id: command.user_id,
            currency: command.currency,
            month: command.month,
            amount_cents: proposal.amount_cents,
            scope: 'month',
            project_id: null,
            entry_id: null,
            reason,
          }))
        : []
      if (allocations.length + credits.length === 0)
        invalid('No selected changes remain to confirm. Reload the review.')
      if (allocations.length + credits.length > 500)
        invalid('This review has too many changes. Confirm them in smaller sections.')
      try {
        // One statement. Existing ledger triggers enforce every monetary rule;
        // a late stale-source/capacity failure rolls back the whole acceptance.
        await database.run(sql`INSERT INTO contractor_acceptances(id,user_id,month,currency,review_version,source_revision,command_json,
          allocations_json,credits_json,reason,actor_id,recorded_at,request_id)
          VALUES(${command.id},${command.user_id},${command.month},${command.currency},${command.review_version},${command.source_revision},${encoded},
            ${JSON.stringify(allocations)},${JSON.stringify(credits)},${reason},${actor},${now},${request})`)
      } catch (error) {
        const raced = replay(await existing(command.id))
        if (raced) return raced
        let cause: unknown = error
        for (let depth = 0; depth < 6 && cause instanceof Error && cause.cause; depth++)
          cause = cause.cause
        if (
          /contractor reconciliation|allocation [a-z]|advance [a-z]|reserved|UNIQUE constraint|CHECK constraint|FOREIGN KEY constraint/u.test(
            String(cause),
          )
        )
          conflict()

        throw error
      }
      const recorded = await existing(command.id)
      if (!recorded) throw new Error('Contractor acceptance was not recorded.')
      return decode(recorded)
    },
  }
}
