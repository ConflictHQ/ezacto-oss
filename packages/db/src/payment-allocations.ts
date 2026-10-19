// Provenance: ezacto-pvt #899 (parent #891). Allocation of payments to earnings.
// The triggers in migration 0126 are the invariants; this store resolves a
// command against the confirmed actuals review, gives friendly errors before the
// write, and builds the reconciliation report. It never writes to the register.
import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import {
  StaffPaymentError,
  allocationHoursCents,
  trackedAmountCents,
  validPaymentMonth,
  validateAllocatePayment,
  type AllocatePayment,
  type PaymentActualEntry,
  type PaymentAllocation,
  type PaymentAllocationEntry,
  type PaymentAllocationPerson,
  type PaymentAllocationPreview,
  type PaymentAllocationProject,
  type PaymentAllocationReport,
  type PaymentAllocationState,
  type StaffPaymentStore,
  type UnallocatedPayment,
} from '@ezacto/core'

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>
type LedgerRow = Omit<PaymentAllocation, 'state'> & { state: PaymentAllocationState }

const earnedCents = (entry: Pick<PaymentActualEntry, 'selected_seconds' | 'cost_rate_cents'>) =>
  entry.selected_seconds === 0 || entry.cost_rate_cents === null
    ? 0
    : trackedAmountCents(entry.selected_seconds, entry.cost_rate_cents)

const causes = (error: unknown): string[] => {
  const found: string[] = []
  for (let current = error, depth = 0; current !== undefined && depth < 5; depth++) {
    found.push(String(current))
    current = current instanceof Error ? current.cause : undefined
  }
  return found
}
const allocationFailure = (error: unknown): StaffPaymentError | null => {
  const text = causes(error).join(' ')
  if (/UNIQUE constraint/u.test(text)) return new StaffPaymentError('conflict', 'This allocation was already recorded.')
  const rule = /allocation [^'\n]*|reverse the payment allocations[^'\n]*|payment allocation history[^'\n]*/u.exec(text)
  return rule ? new StaffPaymentError('conflict', `${rule[0]}. Reload and review again.`) : null
}

export const createPaymentAllocationStore = (
  database: Database,
): Required<
  Pick<StaffPaymentStore, 'previewAllocation' | 'allocatePayment' | 'reverseAllocation' | 'allocationReport'>
> => {
  const ledger = async (where: ReturnType<typeof sql>): Promise<LedgerRow[]> =>
    database.all<LedgerRow>(
      sql`SELECT id,payment_kind,payment_id,user_id,month,currency,scope,project_id,project_name,entry_id,seconds,rate_cents,
        amount_cents,state,reason,actor_id,recorded_at FROM staff_payment_allocation_ledger WHERE ${where} ORDER BY recorded_at,id`,
    )
  const review = async (user: number, month: string): Promise<PaymentActualEntry[] | null> => {
    const row = (
      await database.all<{ entries_json: string }>(
        sql`SELECT entries_json FROM staff_payment_actuals WHERE user_id=${user} AND month=${month} ORDER BY expected_version DESC LIMIT 1`,
      )
    )[0]
    return row ? (JSON.parse(row.entries_json) as PaymentActualEntry[]) : null
  }
  const payments = async (user: number, month: string) => {
    const [events, items] = await Promise.all([
      database.all<{ id: string; amount_cents: number; currency: string }>(sql`
        SELECT e.id,json_extract(e.command_json,'$.amount_cents') AS amount_cents,json_extract(e.command_json,'$.currency') AS currency
        FROM staff_payment_effective_events e WHERE e.user_id=${user} AND e.month=${month} AND e.kind='payment' AND e.id NOT LIKE 'run-payment:%'
          AND NOT EXISTS(SELECT 1 FROM staff_payment_events v WHERE v.kind='void' AND json_extract(v.command_json,'$.payment_id')=e.id)
        ORDER BY e.version`),
      database.all<{ id: string; amount_cents: number; currency: string; state: string }>(sql`
        SELECT id,amount_cents,currency,state FROM payment_run_items WHERE user_id=${user} AND month=${month}
          AND state IN ('queued','creating','funding','processing','attention','paid') ORDER BY updated_at,id`),
    ])
    return [
      ...events.map((e) => ({ kind: 'event' as const, id: e.id, amount_cents: e.amount_cents, currency: e.currency, state: 'applied' as const })),
      ...items.map((i) => ({
        kind: 'run_item' as const,
        id: i.id,
        amount_cents: i.amount_cents,
        currency: i.currency,
        state: i.state === 'paid' ? ('applied' as const) : ('reserved' as const),
      })),
    ]
  }
  const live = (rows: LedgerRow[]) => rows.filter((r) => r.state === 'applied' || r.state === 'reserved')
  const sum = (rows: LedgerRow[], pick: (r: LedgerRow) => number | null = (r) => r.amount_cents) =>
    rows.reduce((total, r) => total + (pick(r) ?? 0), 0)

  const resolve = async (command: AllocatePayment) => {
    validateAllocatePayment(command)
    const payment = (await payments(command.user_id, command.month)).find(
      (p) => p.kind === command.payment_kind && p.id === command.payment_id,
    )
    if (!payment)
      throw new StaffPaymentError(
        'not_found',
        'Choose a recorded or scheduled payment for this person and month that has not been voided, failed or cancelled.',
      )
    const [balance] = await database.all<{ amount_cents: number | null; currency: string | null }>(
      sql`SELECT amount_cents,currency FROM staff_payment_balances WHERE user_id=${command.user_id} AND month=${command.month}`,
    )
    if (!balance || balance.amount_cents === null || balance.currency !== payment.currency)
      throw new StaffPaymentError('conflict', 'The payment currency must match the earnings for the month.')
    const own = live(await ledger(sql`user_id=${command.user_id} AND month=${command.month}`))
    const paymentAllocated = sum(
      own.filter((r) => r.payment_kind === payment.kind && r.payment_id === payment.id),
    )
    let earning = balance.amount_cents
    let earningAllocated = sum(own)
    let remainingSeconds: number | null = null
    let rate: number | null = null
    let entry: PaymentActualEntry | undefined
    let projectName: string | null = null
    let snapshot: Record<string, unknown> | null = null
    let capacity = balance.amount_cents - sum(own)
    if (command.scope !== 'month') {
      const entries = await review(command.user_id, command.month)
      if (!entries)
        throw new StaffPaymentError('conflict', 'Confirm the actuals review before allocating to a project or entry.')
      const inProject = entries.filter((e) => e.project_id === command.project_id)
      if (inProject.length === 0)
        throw new StaffPaymentError('invalid', 'This project has no reviewed hours in the month.')
      projectName = inProject[0]!.project_name
      earning = inProject.reduce((total, e) => total + earnedCents(e), 0)
      earningAllocated = sum(own.filter((r) => r.project_id === command.project_id))
      capacity = Math.min(capacity, earning - earningAllocated)
      snapshot = { project_name: projectName }
      if (command.scope === 'entry') {
        entry = inProject.find((e) => e.entry_id === command.entry_id)
        if (!entry || entry.selected_seconds <= 0)
          throw new StaffPaymentError('invalid', 'Choose a time entry with reviewed hours.')
        if (entry.cost_rate_cents === null)
          throw new StaffPaymentError('invalid', 'Resolve the missing cost rate before allocating this entry.')
        rate = entry.cost_rate_cents
        const mine = own.filter((r) => r.entry_id === entry!.entry_id)
        earning = earnedCents(entry)
        earningAllocated = sum(mine)
        remainingSeconds = entry.selected_seconds - sum(mine, (r) => r.seconds)
        capacity = Math.min(capacity, earning - earningAllocated)
        snapshot = { ...snapshot, entry_id: entry.entry_id, spent_date: entry.spent_date, rounded_seconds: entry.rounded_seconds, selected_seconds: entry.selected_seconds, cost_rate_cents: rate }
      }
    }
    let seconds = command.seconds
    if (seconds !== null && remainingSeconds! < seconds)
      throw new StaffPaymentError('conflict', 'These hours exceed the hours of the entry not yet allocated.')
    const amount =
      command.amount_cents ??
      allocationHoursCents(seconds!, rate!, remainingSeconds!, Math.max(0, earning - earningAllocated))
    if (amount <= 0) throw new StaffPaymentError('conflict', 'Nothing remains to allocate for these hours.')
    if (amount > payment.amount_cents - paymentAllocated)
      throw new StaffPaymentError('conflict', 'This allocation exceeds the unallocated part of the payment.')
    if (amount > capacity)
      throw new StaffPaymentError('conflict', 'This allocation exceeds what remains of the earnings.')
    if (command.scope !== 'entry') seconds = null
    const preview: PaymentAllocationPreview = {
      scope: command.scope,
      currency: payment.currency,
      seconds,
      rate_cents: rate,
      amount_cents: amount,
      payment_cents: payment.amount_cents,
      payment_allocated_cents: paymentAllocated,
      payment_remaining_cents: payment.amount_cents - paymentAllocated,
      earning_cents: earning,
      earning_allocated_cents: earningAllocated,
      earning_remaining_cents: Math.max(0, capacity),
      earning_remaining_seconds: remainingSeconds,
    }
    return { preview, payment, projectName, snapshot, rate, amount, seconds }
  }

  const replayOf = async (id: string) =>
    (
      await database.all<{ command_json: string; actor_id: number }>(
        sql`SELECT command_json,actor_id FROM staff_payment_allocations WHERE id=${id}`,
      )
    )[0]

  return {
    previewAllocation: async (command) => (await resolve(command)).preview,
    allocatePayment: async (command, actor, request, now) => {
      const encoded = JSON.stringify(command)
      const replay = await replayOf(command.id)
      const check = (found: typeof replay) => {
        if (found?.command_json === encoded && found.actor_id === actor) return true
        if (found) throw new StaffPaymentError('conflict', 'This allocation identifier was already used. Reload and review again.')
        return false
      }
      if (check(replay)) return
      const plan = await resolve(command)
      try {
        const inserted = await database.all<{ id: string }>(sql`
          INSERT INTO staff_payment_allocations(id,payment_kind,payment_id,user_id,month,currency,scope,project_id,project_name,entry_id,
            seconds,rate_cents,amount_cents,snapshot_json,command_json,reason,actor_id,recorded_at,request_id)
          VALUES(${command.id},${command.payment_kind},${command.payment_id},${command.user_id},${command.month},${plan.payment.currency},
            ${command.scope},${command.project_id},${plan.projectName},${command.entry_id},${plan.seconds},${plan.rate},${plan.amount},
            ${plan.snapshot === null ? null : JSON.stringify(plan.snapshot)},${encoded},${command.reason.trim()},${actor},${now},${request})
          RETURNING id`)
        if (inserted.length === 0) throw new StaffPaymentError('conflict', 'This allocation was not recorded. Reload and review again.')
      } catch (error) {
        if (error instanceof StaffPaymentError) throw error
        if (check(await replayOf(command.id))) return
        throw allocationFailure(error) ?? error
      }
    },
    reverseAllocation: async (command, actor, request, now) => {
      if (
        !/^[a-zA-Z0-9._-]{1,100}$/u.test(command.id) ||
        !/^[a-zA-Z0-9._-]{1,100}$/u.test(command.allocation_id) ||
        command.reason.trim().length === 0 ||
        command.reason.length > 2000
      )
        throw new StaffPaymentError('invalid', 'Choose an allocation and explain the reversal.')
      const [existing] = await database.all<{ allocation_id: string; reason: string; actor_id: number }>(
        sql`SELECT allocation_id,reason,actor_id FROM staff_payment_allocation_reversals WHERE id=${command.id}`,
      )
      if (existing) {
        if (existing.allocation_id === command.allocation_id && existing.reason === command.reason.trim() && existing.actor_id === actor) return
        throw new StaffPaymentError('conflict', 'This reversal identifier was already used. Reload and review again.')
      }
      if ((await ledger(sql`id=${command.allocation_id}`)).length === 0)
        throw new StaffPaymentError('not_found', 'Choose an existing allocation.')
      try {
        await database.all(sql`INSERT INTO staff_payment_allocation_reversals(id,allocation_id,reason,actor_id,recorded_at,request_id)
          VALUES(${command.id},${command.allocation_id},${command.reason.trim()},${actor},${now},${request}) RETURNING id`)
      } catch (error) {
        if (/UNIQUE constraint/u.test(causes(error).join(' ')))
          throw new StaffPaymentError('conflict', 'This allocation was already reversed.')
        throw allocationFailure(error) ?? error
      }
    },
    allocationReport: async (month): Promise<PaymentAllocationReport> => {
      if (!validPaymentMonth(month)) throw new StaffPaymentError('invalid', 'Choose a valid month.')
      const [balances, rows, reserved] = await Promise.all([
        database.all<{ user_id: number; name: string; amount_cents: number | null; currency: string | null; paid_cents: number }>(sql`
          SELECT b.user_id,u.first_name||' '||u.last_name AS name,b.amount_cents,b.currency,b.paid_cents
          FROM staff_payment_balances b JOIN users u ON u.id=b.user_id WHERE b.month=${month} ORDER BY u.first_name,u.id`),
        ledger(sql`month=${month}`),
        database.all<{ user_id: number; cents: number }>(sql`
          SELECT user_id,COALESCE(SUM(amount_cents),0) AS cents FROM payment_run_items WHERE month=${month}
            AND state IN ('queued','creating','funding','processing','attention') GROUP BY user_id`),
      ])
      const reservedBy = new Map(reserved.map((r) => [r.user_id, r.cents]))
      const people: PaymentAllocationPerson[] = []
      for (const balance of balances) {
        const own = rows.filter((r) => r.user_id === balance.user_id)
        const active = live(own)
        const entries = (await review(balance.user_id, month)) ?? []
        const current = new Map(
          (
            entries.length === 0
              ? []
              : await database.all<{ id: number; project_id: number; rounded_seconds: number; cost_rate_cents: number | null }>(sql`
                  SELECT id,project_id,rounded_seconds,cost_rate_cents FROM time_entries WHERE user_id=${balance.user_id}
                    AND spent_date BETWEEN ${month + '-01'} AND ${month + '-31'}`)
          ).map((t) => [t.id, t]),
        )
        const projects = new Map<number, PaymentAllocationProject>()
        for (const e of entries.filter((x) => x.selected_seconds > 0)) {
          const mine = active.filter((r) => r.entry_id === e.entry_id)
          const applied = sum(mine.filter((r) => r.state === 'applied'))
          const held = sum(mine.filter((r) => r.state === 'reserved'))
          const source = current.get(e.entry_id)
          const earned = earnedCents(e)
          const row: PaymentAllocationEntry = {
            entry_id: e.entry_id,
            spent_date: e.spent_date,
            selected_seconds: e.selected_seconds,
            rate_cents: e.cost_rate_cents,
            earned_cents: earned,
            applied_cents: applied,
            reserved_cents: held,
            applied_seconds: sum(mine.filter((r) => r.state === 'applied'), (r) => r.seconds),
            reserved_seconds: sum(mine.filter((r) => r.state === 'reserved'), (r) => r.seconds),
            remaining_cents: earned - applied - held,
            remaining_seconds: e.selected_seconds - sum(mine, (r) => r.seconds),
            source_changed:
              !source ||
              source.project_id !== e.project_id ||
              source.rounded_seconds !== e.rounded_seconds ||
              source.cost_rate_cents !== e.cost_rate_cents,
            over_allocated: applied + held > earned,
          }
          const project = projects.get(e.project_id) ?? {
            project_id: e.project_id,
            project_name: e.project_name,
            earned_cents: 0,
            applied_cents: 0,
            reserved_cents: 0,
            remaining_cents: 0,
            entries: [],
          }
          project.entries.push(row)
          project.earned_cents += earned
          projects.set(e.project_id, project)
        }
        for (const project of projects.values()) {
          const mine = active.filter((r) => r.project_id === project.project_id)
          project.applied_cents = sum(mine.filter((r) => r.state === 'applied'))
          project.reserved_cents = sum(mine.filter((r) => r.state === 'reserved'))
          project.remaining_cents = project.earned_cents - project.applied_cents - project.reserved_cents
        }
        const held = reservedBy.get(balance.user_id) ?? 0
        const earned = balance.amount_cents ?? 0
        const unallocated: UnallocatedPayment[] = (await payments(balance.user_id, month)).flatMap((p) => {
          const allocated = sum(active.filter((r) => r.payment_kind === p.kind && r.payment_id === p.id))
          return allocated >= p.amount_cents
            ? []
            : [{ payment_kind: p.kind, payment_id: p.id, amount_cents: p.amount_cents, allocated_cents: allocated, unallocated_cents: p.amount_cents - allocated, state: p.state }]
        })
        people.push({
          user_id: balance.user_id,
          name: balance.name,
          currency: balance.currency,
          earned_cents: earned,
          paid_cents: balance.paid_cents,
          reserved_cents: held,
          allocated_applied_cents: sum(active.filter((r) => r.state === 'applied')),
          allocated_reserved_cents: sum(active.filter((r) => r.state === 'reserved')),
          remaining_cents: earned - balance.paid_cents - held,
          projects: [...projects.values()],
          unallocated_payments: unallocated,
          allocations: own,
        })
      }
      return { month, people }
    },
  }
}
