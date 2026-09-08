/**
 * What a retainer screen has to say, derived from what the API actually
 * serves.
 *
 * Two numbers on `/api/v1/retainers` look alike and are not the same thing:
 *
 * - `amount_cents` / `seconds` is the **agreed commitment** — the policy field
 *   the retainer was created with, and what `rollover: 'cap'` caps against.
 * - `balance` is **what remains**, and it is nothing but the sum of the ledger
 *   (`retainer_balances` in the schema: `COALESCE(SUM(entry.amount), 0)`), which
 *   is invariant 10.
 *
 * They are independent. A deposit is not obliged to equal the commitment, so
 * "drawn down" is NOT `commitment - balance`; it is the negative side of the
 * ledger and nothing else. The list has only the two numbers, so it shows only
 * those two; the detail loads `/ledger` and shows the movements that produced
 * the balance.
 *
 * The other constraint is what the cutover leaves behind.
 * `ensureHarvestRetainerStub` materializes each dangling Harvest retainer id as
 * a **money** retainer with `amount_cents = 0`, the linked invoice's client, no
 * project, no period, no rollover, no expiry, `on_exhaustion: 'block'` and an
 * empty ledger; the opening balance only arrives later as one explicit
 * `adjustment` entry from `completeHarvestRetainerBalance`. So after the cutover
 * the common row is a zero commitment with either no movements at all or a
 * single adjustment and no deposit — and this module has to read as the truth
 * in that state rather than as a broken idealised one.
 */

import type { GeneralResource, Retainer, RetainerLedgerEntry } from '@ezacto/client'

export type RetainerStatusFilter = 'ongoing' | 'all'

export interface RetainerCursorPage<Resource> {
  readonly data: readonly Resource[]
  readonly page: { readonly next_cursor: string | null }
}

/**
 * Clients and projects are listed unfiltered on purpose: a retainer outlives
 * the archiving of the client it belongs to, and a row that says "Client #14"
 * because the client is no longer active is worse than no filter at all.
 */
export interface RetainerWorkspaceApi {
  listRetainers(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<RetainerCursorPage<Retainer>>
  getRetainerDetail(id: number, signal?: AbortSignal): Promise<Retainer>
  listRetainerLedger(
    id: number,
    signal?: AbortSignal,
  ): Promise<readonly RetainerLedgerEntry[]>
  listRetainerClients(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<RetainerCursorPage<GeneralResource>>
  listRetainerProjects(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<RetainerCursorPage<GeneralResource>>
}

export interface RetainerLedgerSummary {
  readonly movements: number
  /** Positive: what was put on retainer through an invoice. */
  readonly deposited: number
  /** Positive magnitude, though the entries themselves are negative. */
  readonly drawnDown: number
  /** Positive magnitude, for the same reason. */
  readonly expired: number
  /** Signed net of `reset` and `adjustment`, which may go either way. */
  readonly adjusted: number
  /** The sum of every entry — invariant 10, computed the way the view does. */
  readonly balance: number
}

export interface RetainerMovement {
  readonly entry: RetainerLedgerEntry
  /** The balance after this entry, in the order the ledger is served. */
  readonly balance: number
}

const resourceText = (
  resource: Readonly<GeneralResource> | undefined,
  field: string,
): string | null => {
  if (resource === undefined) return null
  const value = resource[field]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

const resourceNumber = (
  resource: Readonly<GeneralResource> | undefined,
  field: string,
): number | null => {
  if (resource === undefined) return null
  const value = resource[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export const retainerStatusFilterFromUrl = (url: URL): RetainerStatusFilter =>
  url.searchParams.get('status') === 'all' ? 'all' : 'ongoing'

/** `?retainer=` names the open detail; anything unparseable opens the list. */
export const retainerSelectionFromUrl = (url: URL): number | null => {
  const raw = url.searchParams.get('retainer')
  if (raw === null || !/^[1-9][0-9]*$/u.test(raw)) return null
  const id = Number(raw)
  return Number.isSafeInteger(id) ? id : null
}

export const retainerWorkspaceUrl = (
  filter: RetainerStatusFilter,
  selection: number | null = null,
): string => {
  const parameters = new URLSearchParams()
  if (filter === 'all') parameters.set('status', 'all')
  if (selection !== null) parameters.set('retainer', String(selection))
  const query = parameters.toString()
  return query === '' ? '/invoices/retainers' : `/invoices/retainers?${query}`
}

export const retainerMatchesFilter = (
  retainer: Readonly<Retainer>,
  filter: RetainerStatusFilter,
): boolean => filter === 'all' || retainer.state === 'ongoing'

/**
 * A retainer carries no currency of its own, so it reads its client's — the
 * same fallback chain the expense and project screens already use.
 */
export const retainerCurrency = (
  retainer: Readonly<Retainer>,
  clients: readonly GeneralResource[],
): string => {
  const client = clients.find((candidate) => candidate.id === retainer.client_id)
  return resourceText(client, 'currency') ?? 'USD'
}

export const retainerMoney = (cents: number, currency: string): string => {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100)
  } catch {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
      cents / 100,
    )
  }
}

export const retainerHours = (seconds: number): string =>
  `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(seconds / 3_600)} hours`

/**
 * One amount, formatted in the unit it was stored in. The insert trigger keeps
 * an entry's unit equal to its retainer's denomination, so this reads the
 * entry's own unit rather than trusting the parent twice.
 */
export const retainerAmount = (
  amount: number,
  unit: 'cents' | 'seconds',
  currency: string,
): string => (unit === 'cents' ? retainerMoney(amount, currency) : retainerHours(amount))

export const retainerDenominationUnit = (
  retainer: Readonly<Retainer>,
): 'cents' | 'seconds' => (retainer.denomination === 'money' ? 'cents' : 'seconds')

export const retainerBasisLabel = (retainer: Readonly<Retainer>): string =>
  retainer.denomination === 'money' ? 'Money' : 'Hours'

/**
 * The agreed commitment, or null when there is not one to state.
 *
 * Zero counts as "not one to state". A retainer you cannot draw a single cent
 * against is not a commitment of nothing, it is a commitment nobody recorded —
 * and zero is exactly what the Harvest stub carries, because Harvest leaves the
 * retainer dangling and the loader only has the invoice link to work from.
 */
export const retainerCommitment = (retainer: Readonly<Retainer>): number | null => {
  const value = retainer.denomination === 'money' ? retainer.amount_cents : retainer.seconds
  return value === null || value === 0 ? null : value
}

export const retainerCommitmentLabel = (
  retainer: Readonly<Retainer>,
  currency: string,
): string => {
  const commitment = retainerCommitment(retainer)
  return commitment === null
    ? 'Not recorded'
    : retainerAmount(commitment, retainerDenominationUnit(retainer), currency)
}

export const retainerBalanceLabel = (
  retainer: Readonly<Retainer>,
  currency: string,
): string => retainerAmount(retainer.balance, retainerDenominationUnit(retainer), currency)

/**
 * Percent of the commitment still on the retainer, or null when there is no
 * commitment to be a percentage of. `on_exhaustion: 'overflow'` permits a
 * negative balance, so this is not clamped — an overdrawn retainer reads below
 * zero rather than as an honest-looking nothing.
 */
export const retainerRemainingShare = (retainer: Readonly<Retainer>): number | null => {
  const commitment = retainerCommitment(retainer)
  return commitment === null ? null : (retainer.balance / commitment) * 100
}

export const retainerRemainingShareLabel = (retainer: Readonly<Retainer>): string => {
  const share = retainerRemainingShare(retainer)
  return share === null
    ? '—'
    : `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(share)}%`
}

export const retainerClientLabel = (
  retainer: Readonly<Retainer>,
  clients: readonly GeneralResource[],
): string => {
  if (retainer.client_id === null) return 'No client'
  const client = clients.find((candidate) => candidate.id === retainer.client_id)
  return resourceText(client, 'name') ?? `Client #${retainer.client_id}`
}

export const retainerProjectLabel = (
  retainer: Readonly<Retainer>,
  projects: readonly GeneralResource[],
): string => {
  if (retainer.project_id === null) return 'All projects'
  const project = projects.find((candidate) => candidate.id === retainer.project_id)
  return resourceText(project, 'name') ?? `Project #${retainer.project_id}`
}

/**
 * A project-scoped retainer whose project belongs to a different client is a
 * data fault worth surfacing rather than papering over, because the drawdown
 * would bill the wrong client.
 */
export const retainerScopeConflict = (
  retainer: Readonly<Retainer>,
  projects: readonly GeneralResource[],
): boolean => {
  if (retainer.project_id === null || retainer.client_id === null) return false
  const project = projects.find((candidate) => candidate.id === retainer.project_id)
  const owner = resourceNumber(project, 'client_id')
  return owner !== null && owner !== retainer.client_id
}

export const retainerStateLabel = (retainer: Readonly<Retainer>): string =>
  retainer.state === 'ongoing' ? 'Ongoing' : 'Closed'

export const retainerExhaustionLabel = (
  value: Retainer['on_exhaustion'],
): string =>
  value === 'block'
    ? 'Blocks an overdraw'
    : value === 'warn'
      ? 'Warns on an overdraw'
      : 'Allows an overdraw'

export const retainerRolloverLabel = (value: Retainer['rollover']): string =>
  value === null
    ? 'No rollover policy'
    : value === 'carry'
      ? 'Carries the remainder forward'
      : value === 'expire'
        ? 'Expires the remainder at the boundary'
        : 'Caps the carried remainder at the agreed amount'

export const retainerLedgerKindLabel = (
  kind: RetainerLedgerEntry['kind'],
): string =>
  kind === 'deposit'
    ? 'Deposit'
    : kind === 'drawdown'
      ? 'Drawdown'
      : kind === 'expiry'
        ? 'Expiry'
        : kind === 'reset'
          ? 'Reset'
          : 'Adjustment'

/**
 * The hours-retainer rate lock (D20 §4): once `locked_rate_cents` is set, a
 * seconds balance has one money value and it is this one, not today's rate.
 * Absent a lock there is no single rate to value it at, so nothing is claimed.
 */
export const retainerLockedRateValueCents = (
  retainer: Readonly<Retainer>,
  seconds: number,
): number | null =>
  retainer.denomination === 'hours' && retainer.locked_rate_cents !== null
    ? Math.round((seconds * retainer.locked_rate_cents) / 3_600)
    : null

export const retainerLedgerSummary = (
  entries: readonly RetainerLedgerEntry[],
): RetainerLedgerSummary => {
  let deposited = 0
  let drawnDown = 0
  let expired = 0
  let adjusted = 0
  for (const entry of entries) {
    if (entry.kind === 'deposit') deposited += entry.amount
    else if (entry.kind === 'drawdown') drawnDown -= entry.amount
    else if (entry.kind === 'expiry') expired -= entry.amount
    else adjusted += entry.amount
  }
  return {
    movements: entries.length,
    deposited,
    drawnDown,
    expired,
    adjusted,
    balance: deposited - drawnDown - expired + adjusted,
  }
}

/**
 * The running balance, in the order `/ledger` serves (`occurred_on, id`). The
 * last row therefore equals the retainer's own `balance` field, which is what
 * makes the history readable as an account rather than a list of amounts.
 */
export const retainerLedgerHistory = (
  entries: readonly RetainerLedgerEntry[],
): readonly RetainerMovement[] => {
  let balance = 0
  return entries.map((entry) => {
    balance += entry.amount
    return { entry, balance }
  })
}

/**
 * What the screen has to admit about a retainer whose numbers do not tell a
 * whole story — chiefly the shape the cutover produces. Empty when there is
 * nothing to say, so the caller renders no note rather than a reassuring one.
 */
export const retainerLedgerNotes = (
  retainer: Readonly<Retainer>,
  summary: Readonly<RetainerLedgerSummary>,
): readonly string[] => {
  const notes: string[] = []
  if (summary.movements === 0) {
    notes.push(
      'No movements recorded yet, so the balance is zero. A retainer imported from an invoice arrives this way until its opening balance is posted.',
    )
  } else if (summary.deposited === 0) {
    notes.push(
      'No deposit has been posted against an invoice. This balance comes from adjustments, which is the shape an imported opening balance takes.',
    )
  }
  if (retainerCommitment(retainer) === null) {
    notes.push(
      'No agreed amount is recorded on this retainer, so there is nothing to measure the remaining balance against.',
    )
  }
  if (retainer.balance < 0) {
    notes.push('This retainer is overdrawn: more has been drawn down than was put on it.')
  }
  return notes
}
