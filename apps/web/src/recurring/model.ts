/**
 * What the recurring-invoices screen has to say, derived from what the API
 * actually serves.
 *
 * A recurring definition is a standing instruction, and the two questions a
 * person opens the screen with are "when does this bill next" and "what will it
 * bill for". Both are answerable from `/api/v1/recurring-invoices` alone, so the
 * list answers them and the detail exists to show the amount configuration in
 * full rather than to fetch anything the list was missing.
 *
 * The third question -- "can I make it bill now" -- is the one the screen
 * exists for. `POST /recurring-invoices/:id/generations` answers it, and
 * answers it in four distinguishable ways: issued, not due yet, already
 * generated for this period, or no engine on this deployment. Collapsing those
 * into one failure is what makes an operator think a definition is broken when
 * it is merely early, so `recurringGenerationOutcome` keeps them apart.
 *
 * Nothing here reaches for a currency of its own. A definition carries none;
 * it reads its client's, the same fallback chain the retainer screen uses.
 */

import type { GeneralResource, RecurringInvoice } from '@ezacto/client'

export interface RecurringCursorPage<Resource> {
  readonly data: readonly Resource[]
  readonly page: { readonly next_cursor: string | null }
}

export interface RecurringWorkspaceApi {
  listRecurringInvoices(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<RecurringCursorPage<RecurringInvoice>>
  getRecurringInvoice(id: number, signal?: AbortSignal): Promise<RecurringInvoice>
  /**
   * Issues the invoice the definition is due for. Rejects with the API error;
   * `recurringGenerationOutcome` is what turns that into something to read.
   */
  generateRecurringInvoice(
    id: number,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<{ invoice: { id: number }; generation: { period: string; next_issue_on: string } }>
  /**
   * Unfiltered, like the retainer screen's: a definition outlives the
   * archiving of the client it bills, and a row reading "Client #14" because a
   * filter dropped the client is a worse answer than a longer list.
   */
  listRecurringClients(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<RecurringCursorPage<GeneralResource>>
  listRecurringProjects(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<RecurringCursorPage<GeneralResource>>
}

export type RecurringDueState = 'overdue' | 'due' | 'scheduled'

const resourceText = (
  resource: Readonly<GeneralResource> | undefined,
  field: string,
): string | null => {
  if (resource === undefined) return null
  const value = resource[field]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** `?definition=` names the open one; anything unparseable opens the list. */
export const recurringSelectionFromUrl = (url: URL): number | null => {
  const raw = url.searchParams.get('definition')
  if (raw === null || !/^[1-9][0-9]*$/u.test(raw)) return null
  const id = Number(raw)
  return Number.isSafeInteger(id) ? id : null
}

export const recurringWorkspaceUrl = (selection: number | null = null): string =>
  selection === null
    ? '/invoices/recurring'
    : `/invoices/recurring?definition=${selection}`

/**
 * The 1st, the 2nd, the 31st. Ordinals rather than "day 1", because a cadence
 * is read aloud when someone is deciding whether it is the one they meant.
 */
export const recurringDayLabel = (dayOfMonth: number): string => {
  const tens = dayOfMonth % 100
  const suffix =
    tens >= 11 && tens <= 13
      ? 'th'
      : (['th', 'st', 'nd', 'rd'][dayOfMonth % 10] ?? 'th')
  return `${dayOfMonth}${suffix}`
}

export const recurringCadenceLabel = (
  definition: Readonly<Pick<RecurringInvoice, 'every_n_months' | 'day_of_month'>>,
): string => {
  const day = recurringDayLabel(definition.day_of_month)
  if (definition.every_n_months === 1) return `Every month on the ${day}`
  if (definition.every_n_months === 3) return `Every quarter on the ${day}`
  if (definition.every_n_months === 12) return `Every year on the ${day}`
  return `Every ${definition.every_n_months} months on the ${day}`
}

/**
 * Overdue is not an error state. A definition whose date has passed is simply
 * one nobody has issued yet, and the screen exists to let them -- so the word
 * has to read as an invitation rather than an alarm.
 */
export const recurringDueState = (
  definition: Readonly<Pick<RecurringInvoice, 'next_issue_on'>>,
  today: string,
): RecurringDueState => {
  const next = definition.next_issue_on.slice(0, 10)
  const at = today.slice(0, 10)
  if (next < at) return 'overdue'
  if (next === at) return 'due'
  return 'scheduled'
}

export const recurringDueLabel = (state: RecurringDueState): string =>
  state === 'overdue' ? 'Past due' : state === 'due' ? 'Due today' : 'Scheduled'

/** Only a fixed-lines definition has a total before it runs. */
export const recurringFixedTotalCents = (
  definition: Readonly<Pick<RecurringInvoice, 'amount_config'>>,
): number | null => {
  const config = definition.amount_config
  if (config.type !== 'fixed_lines') return null
  return config.line_items.reduce(
    (total, line) => total + Math.round(line.quantity * line.unit_price_cents),
    0,
  )
}

const summaryWords = (summary: string): string =>
  summary === 'detailed' ? 'in detail' : `by ${summary}`

/**
 * What the definition will bill for, said in one line.
 *
 * A `line_items_import` definition has no amount until it runs -- it bills
 * whatever is uninvoiced on its projects when the day comes -- so saying "—"
 * would be truthful and useless. Saying what it will sweep is the useful truth.
 */
export const recurringBasisLabel = (
  definition: Readonly<Pick<RecurringInvoice, 'amount_config'>>,
): string => {
  const config = definition.amount_config
  if (config.type === 'fixed_lines') {
    const count = config.line_items.length
    return count === 1 ? '1 fixed line' : `${count} fixed lines`
  }
  const projects =
    config.project_ids.length === 1 ? '1 project' : `${config.project_ids.length} projects`
  const parts: string[] = []
  if ('time' in config && config.time !== undefined) {
    parts.push(`time ${summaryWords(config.time.summary_type)}`)
  }
  if ('expenses' in config && config.expenses !== undefined) {
    parts.push(`expenses ${summaryWords(config.expenses.summary_type)}`)
  }
  return `Uninvoiced ${parts.join(' and ')} on ${projects}`
}

export const recurringMoney = (cents: number, currency: string): string => {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100)
  } catch {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
      cents / 100,
    )
  }
}

export const recurringCurrency = (
  definition: Readonly<Pick<RecurringInvoice, 'client_id'>>,
  clients: readonly GeneralResource[],
): string => {
  const client = clients.find((candidate) => candidate.id === definition.client_id)
  return resourceText(client, 'currency') ?? 'USD'
}

export const recurringClientLabel = (
  definition: Readonly<Pick<RecurringInvoice, 'client_id'>>,
  clients: readonly GeneralResource[],
): string => {
  const client = clients.find((candidate) => candidate.id === definition.client_id)
  return resourceText(client, 'name') ?? `Client #${definition.client_id}`
}

export const recurringProjectLabel = (
  projectId: number,
  projects: readonly GeneralResource[],
): string => {
  const project = projects.find((candidate) => candidate.id === projectId)
  return resourceText(project, 'name') ?? `Project #${projectId}`
}

/**
 * What a definition will raise, or why that cannot be said yet.
 *
 * A fixed-lines total is exact and shown as money. An import definition's
 * amount is not knowable until the sweep runs, and printing a zero would be a
 * lie with a currency symbol on it.
 */
export const recurringAmountLabel = (
  definition: Readonly<Pick<RecurringInvoice, 'amount_config'>>,
  currency: string,
): string => {
  const total = recurringFixedTotalCents(definition)
  return total === null ? 'Set when it runs' : recurringMoney(total, currency)
}

export interface RecurringGenerationOutcome {
  readonly kind: 'issued' | 'not_due' | 'already_generated' | 'unavailable' | 'error'
  readonly message: string
}

const apiErrorCode = (error: unknown): { code: string | null; message: string | null } => {
  if (typeof error !== 'object' || error === null) return { code: null, message: null }
  const body = Reflect.get(error, 'body')
  if (typeof body !== 'object' || body === null) return { code: null, message: null }
  const detail = Reflect.get(body, 'error')
  if (typeof detail !== 'object' || detail === null) return { code: null, message: null }
  const code = Reflect.get(detail, 'code')
  const message = Reflect.get(detail, 'message')
  return {
    code: typeof code === 'string' ? code : null,
    message: typeof message === 'string' && message.trim() !== '' ? message.trim() : null,
  }
}

/**
 * Four answers, kept apart.
 *
 * "Not due yet" and "already generated" are both 409 and both mean the
 * definition is working exactly as instructed; showing either as a failure is
 * how an operator ends up editing something that was never wrong. The server's
 * own message carries the date, which is the actionable part, so it is
 * preferred over anything written here.
 *
 * A 503 is the deployment having no recurring engine wired -- not a missing
 * definition, which is what a 404 would have led someone to look for.
 */
export const recurringGenerationOutcome = (
  error: unknown,
): RecurringGenerationOutcome => {
  const status = typeof error === 'object' && error !== null ? Reflect.get(error, 'status') : null
  const { code, message } = apiErrorCode(error)
  if (code === 'not_due') {
    return { kind: 'not_due', message: message ?? 'This definition is not due yet.' }
  }
  if (code === 'already_generated') {
    return {
      kind: 'already_generated',
      message: message ?? 'This period has already been issued.',
    }
  }
  if (status === 503) {
    return {
      kind: 'unavailable',
      message: 'This deployment cannot issue recurring invoices. Nothing has changed.',
    }
  }
  if (status === 404) {
    return { kind: 'error', message: 'That recurring definition no longer exists.' }
  }
  if (status === 401) {
    return { kind: 'error', message: 'Your session ended. Sign in again to continue.' }
  }
  if (status === 403) {
    return { kind: 'error', message: 'You do not have access to recurring invoices.' }
  }
  return {
    kind: 'error',
    message: message ?? 'The invoice could not be issued.',
  }
}

export const recurringIssuedMessage = (generation: {
  readonly period: string
  readonly next_issue_on: string
}): string =>
  `Issued for ${generation.period}. Next on ${generation.next_issue_on}.`

/**
 * Soonest obligation first. Someone opening this screen is looking for what
 * needs doing, and what is past due sorts to the top by the same rule that
 * puts tomorrow above next month -- no separate overdue bucket needed.
 */
export const recurringListOrder = (
  definitions: readonly RecurringInvoice[],
): readonly RecurringInvoice[] =>
  [...definitions].sort((left, right) => {
    const byDate = left.next_issue_on.localeCompare(right.next_issue_on)
    return byDate === 0 ? left.id - right.id : byDate
  })

export const recurringMatchesSearch = (
  definition: Readonly<RecurringInvoice>,
  clients: readonly GeneralResource[],
  query: string,
): boolean => {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  return [
    definition.subject_template,
    recurringClientLabel(definition, clients),
    String(definition.id),
  ]
    .join(' ')
    .toLowerCase()
    .includes(needle)
}
