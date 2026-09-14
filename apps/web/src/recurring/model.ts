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

import type {
  GeneralResource,
  RecurringAmountConfig,
  RecurringFixedLine,
  RecurringInvoice,
  RecurringInvoiceInput,
} from '@conflict-hq/ezacto-client'
import { invoiceIdentityCanWrite } from '../invoices/model.js'
import { parseDurationSeconds } from '../shell/model.js'

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
  /**
   * Creating and replacing take the whole definition, because `PATCH` on this
   * resource is a replace: the API parser requires every field and the store
   * writes every column. So the editor loads the definition it is changing and
   * sends it back entire -- there is no partial save to be had here, and
   * pretending otherwise is how a notes template disappears on a day-of-month
   * edit.
   */
  createRecurringInvoice(
    input: RecurringInvoiceInput,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<RecurringInvoice>
  updateRecurringInvoice(
    id: number,
    input: RecurringInvoiceInput,
    signal?: AbortSignal,
  ): Promise<RecurringInvoice>
  deleteRecurringInvoice(id: number, signal?: AbortSignal): Promise<void>
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

/**
 * The editor's own vocabulary: every field a string, exactly as a form element
 * hands it over.
 *
 * Nothing here is typed as a number, because a form has no numbers -- it has
 * text that may or may not be one, and an empty box is a different answer from
 * a zero. Parsing happens once, in `recurringDefinitionInput`, so the one place
 * that can reject a value is the one place that produces the request.
 */
export interface RecurringLineFormValues {
  readonly kind: string
  readonly description: string
  readonly quantity: string
  readonly unitPriceCents: string
  readonly taxed: boolean
  readonly taxed2: boolean
  readonly projectId: string
  readonly through: string
  readonly installments: string
}

export type RecurringAmountType = 'fixed_lines' | 'line_items_import'

export interface RecurringDefinitionFormValues {
  readonly clientId: string
  readonly subjectTemplate: string
  readonly notesTemplate: string
  readonly everyNMonths: string
  readonly dayOfMonth: string
  readonly nextIssueOn: string
  readonly retainerId: string
  readonly amountType: RecurringAmountType
  readonly lines: readonly RecurringLineFormValues[]
  /**
   * The projects an import sweeps. Not the same thing as `claimsProjectIds`
   * below, and the difference is the whole of #484: this one prices the time it
   * finds, and that one refuses to.
   */
  readonly projectIds: readonly string[]
  /**
   * The projects a flat amount covers (#484).
   *
   * Empty is an ordinary fixed invoice, which ignores tracked time. Non-empty
   * makes it a banded engagement: the amount stays flat and these projects'
   * hours are claimed by it, so they stop reading as uninvoiced and cannot be
   * billed twice.
   */
  readonly claimsProjectIds: readonly string[]
  /**
   * How much of the period the band takes, and in which unit (#707).
   *
   * `all` is the #484 behaviour. `ceiling` covers the oldest hours up to
   * `claimCeiling` -- read as a duration or as cents of billable value at list,
   * depending on `claimCeilingUnit` -- and leaves the overflow to be invoiced
   * as ordinary time and materials.
   */
  readonly claimMode: 'all' | 'ceiling'
  readonly claimCeilingUnit: 'time' | 'money'
  readonly claimCeiling: string
  /**
   * Whether the band absorbs every tracked hour on those projects or only the
   * billable ones (#708). Under a fixed amount the client bought the period, so
   * a firm that logs internal work against the client's project wants it
   * counted against what the band paid for.
   */
  readonly claimScope: 'billable' | 'tracked'
  readonly importTime: boolean
  readonly timeSummary: string
  readonly importExpenses: boolean
  readonly expenseSummary: string
}

/**
 * Only the profiles that may write invoices may write the instructions that
 * raise them. Borrowed from the invoice screen rather than restated: it is one
 * authority -- `invoices:write` -- and two copies of it would drift.
 */
export const recurringIdentityCanWrite = invoiceIdentityCanWrite

const centsLimit = 9_000_000_000_000

/**
 * A real day on the calendar, not merely ten characters shaped like one.
 *
 * `2026-02-31` passes every pattern and is not a date, and a line that expires
 * on a day the calendar does not have never expires. The trigger from 0044
 * makes the same distinction with `date()`; making it here too is what turns a
 * server abort into a sentence beside the field that caused it.
 */
const isCalendarDate = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
  new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value

const wholeNumber = (raw: string, label: string): number => {
  const value = raw.trim()
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`${label} must be a whole number.`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} is too large.`)
  return parsed
}

const wholeNumberAbove = (raw: string, label: string): number => {
  const parsed = wholeNumber(raw, label)
  if (parsed < 1) throw new Error(`${label} must be 1 or more.`)
  return parsed
}

const signedCents = (raw: string, label: string): number => {
  const value = raw.trim()
  // Signed on purpose. A discount or a credit line is a negative unit price,
  // and it is exactly those lines that carry `through` and `installments`;
  // `assertRecurringAmountConfig` bounds the magnitude and not the sign.
  if (!/^-?(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`${label} must be a whole number of cents.`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || Math.abs(parsed) > centsLimit) {
    throw new Error(`${label} is too large.`)
  }
  return parsed
}

const fixedLine = (
  values: Readonly<RecurringLineFormValues>,
  position: number,
): RecurringFixedLine => {
  const where = `Line ${position + 1}`
  const kind = values.kind.trim()
  if (kind === '') throw new Error(`${where} needs a kind.`)
  const description = values.description.trim()
  const quantity = Number(values.quantity.trim())
  if (
    values.quantity.trim() === '' ||
    !Number.isFinite(quantity) ||
    quantity <= 0 ||
    quantity > Number.MAX_SAFE_INTEGER
  ) {
    throw new Error(`${where} needs a quantity greater than zero.`)
  }
  const through = values.through.trim()
  if (through !== '' && !isCalendarDate(through)) {
    throw new Error(`${where} has a through date that is not a day on the calendar.`)
  }
  const installments = values.installments.trim()
  if (installments !== '' && through === '') {
    // Counting "2 of 4" counts backwards from the end, so a total with no end
    // has nothing to count back from. The TypeScript assertion and the trigger
    // both refuse it; saying so here is what names the field responsible.
    throw new Error(`${where} needs a through date before it can count installments.`)
  }
  const projectId = values.projectId.trim()
  return {
    kind,
    // An empty box means the line has no description of its own, which is null
    // in storage. Sending "" instead would put a blank line on the invoice.
    description: description === '' ? null : description,
    quantity,
    unit_price_cents: signedCents(values.unitPriceCents, `${where} unit price`),
    taxed: values.taxed,
    taxed2: values.taxed2,
    project_id: projectId === '' ? null : wholeNumberAbove(projectId, `${where} project`),
    // Omitted rather than sent as null when unset. `assertExactKeys` permits the
    // key and the trigger tolerates a JSON null, so either would store; a config
    // carrying only the keys it means is the one the loader script wrote and the
    // one already in storage, and it stays identical across a save that changed
    // nothing else.
    ...(through === '' ? {} : { through }),
    ...(installments === ''
      ? {}
      : { installments: wholeNumberAbove(installments, `${where} installments`) }),
  }
}

const summaryType = <Allowed extends string>(
  raw: string,
  allowed: readonly Allowed[],
  label: string,
): Allowed => {
  const found = allowed.find((candidate) => candidate === raw)
  if (found === undefined) throw new Error(`Choose how ${label} are summarised.`)
  return found
}

const importConfig = (
  values: Readonly<RecurringDefinitionFormValues>,
): RecurringAmountConfig => {
  const projectIds = values.projectIds.map((raw, index) =>
    wholeNumberAbove(raw, `Project ${index + 1}`),
  )
  if (projectIds.length === 0) throw new Error('Choose at least one project to sweep.')
  if (new Set(projectIds).size !== projectIds.length) {
    throw new Error('A project can only be swept once.')
  }
  const time = values.importTime
    ? {
        summary_type: summaryType(
          values.timeSummary,
          ['project', 'task', 'people', 'detailed'] as const,
          'hours',
        ),
      }
    : null
  const expenses = values.importExpenses
    ? {
        summary_type: summaryType(
          values.expenseSummary,
          ['project', 'category', 'people', 'detailed'] as const,
          'expenses',
        ),
      }
    : null
  // Three separate literals rather than one object assembled from spreads,
  // because the contract's union has `time` and `expenses` as required keys of
  // three different variants. Written this way, "at least one of them" is
  // something the compiler checks rather than something a comment claims.
  if (time !== null && expenses !== null) {
    return {
      schema_version: 1,
      type: 'line_items_import',
      project_ids: projectIds,
      time,
      expenses,
    }
  }
  if (time !== null) {
    return { schema_version: 1, type: 'line_items_import', project_ids: projectIds, time }
  }
  if (expenses !== null) {
    return { schema_version: 1, type: 'line_items_import', project_ids: projectIds, expenses }
  }
  throw new Error('A sweep must bill uninvoiced time, uninvoiced expenses, or both.')
}

/**
 * The form, turned into the request body -- or an `Error` carrying the sentence
 * the person editing needs to read.
 *
 * Every rule restated here is one `assertRecurringAmountConfig` and the trigger
 * from 0044 already enforce, and the duplication is deliberate: the server
 * stays the authority, but its 422 says "amount config is invalid" without
 * saying which line, and the trigger's abort says less than that.
 */
export const recurringDefinitionInput = (
  values: Readonly<RecurringDefinitionFormValues>,
): RecurringInvoiceInput => {
  const subjectTemplate = values.subjectTemplate.trim()
  if (subjectTemplate === '') throw new Error('Enter a subject for the invoices this raises.')
  const dayOfMonth = wholeNumber(values.dayOfMonth, 'Day of month')
  if (dayOfMonth < 1 || dayOfMonth > 31) {
    throw new Error('Day of month must be from 1 through 31.')
  }
  const nextIssueOn = values.nextIssueOn.trim()
  if (!isCalendarDate(nextIssueOn)) {
    throw new Error('Next issue date must be a day on the calendar.')
  }
  const retainerId = values.retainerId.trim()
  const amountConfig =
    values.amountType === 'fixed_lines'
      ? ((): RecurringAmountConfig => {
          if (values.lines.length === 0) {
            throw new Error('A fixed definition needs at least one line.')
          }
          return {
            schema_version: 1,
            type: 'fixed_lines',
            line_items: values.lines.map(fixedLine),
          }
        })()
      : importConfig(values)
  return {
    client_id: wholeNumberAbove(values.clientId, 'Client'),
    subject_template: subjectTemplate,
    notes_template: values.notesTemplate,
    every_n_months: wholeNumberAbove(values.everyNMonths, 'Months between issues'),
    day_of_month: dayOfMonth,
    next_issue_on: nextIssueOn,
    amount_config: amountConfig,
    can_draw_from_retainer_id:
      retainerId === '' ? null : wholeNumberAbove(retainerId, 'Retainer'),
    // Null rather than an empty array: the two would be different spellings of
    // "not a banded engagement", and the API refuses the empty one rather than
    // quietly accepting a third state.
    claims_project_ids:
      values.claimsProjectIds.length === 0
        ? null
        : values.claimsProjectIds.map((id) => wholeNumberAbove(id, 'Covers the time on')),
    ...claimCeilingBody(values),
  }
}

/**
 * The ceiling, in whichever unit the operator chose (#707).
 *
 * A band that claims nothing is not a band, so its ceiling is dropped rather
 * than sent: the API refuses a ceiling on a definition that claims no projects,
 * and a stale number left in a hidden box is not something the operator asked
 * for.
 */
const claimCeilingBody = (
  values: Readonly<RecurringDefinitionFormValues>,
): {
  claim_mode: 'all' | 'ceiling'
  claim_ceiling_seconds: number | null
  claim_ceiling_cents: number | null
  claim_scope: 'billable' | 'tracked'
} => {
  // A band that claims nothing carries none of these settings: the API refuses
  // them on a definition with no projects, and a stale value left in a hidden
  // box is not something the operator asked for.
  const scope = values.claimsProjectIds.length === 0 ? 'billable' : values.claimScope
  if (values.claimsProjectIds.length === 0 || values.claimMode === 'all') {
    return {
      claim_mode: 'all',
      claim_ceiling_seconds: null,
      claim_ceiling_cents: null,
      claim_scope: scope,
    }
  }
  return values.claimCeilingUnit === 'money'
    ? {
        claim_mode: 'ceiling',
        claim_ceiling_seconds: null,
        claim_ceiling_cents: wholeNumberAbove(values.claimCeiling, 'Claims up to'),
        claim_scope: scope,
      }
    : {
        claim_mode: 'ceiling',
        claim_ceiling_seconds: parseDurationSeconds(values.claimCeiling),
        claim_ceiling_cents: null,
        claim_scope: scope,
      }
}

/**
 * Seconds back into something `parseDurationSeconds` reads again.
 *
 * Whole hours are the common case and read as "400h". Anything left over comes
 * back as decimal minutes rather than being rounded away, so a value stored by
 * some other caller survives being opened in this form and saved again.
 */
export const recurringDurationInput = (seconds: number): string => {
  const hours = Math.floor(seconds / 3_600)
  const minutes = (seconds - hours * 3_600) / 60
  const trimmed = Number.isInteger(minutes)
    ? String(minutes)
    : minutes.toFixed(6).replace(/0+$/u, '').replace(/\.$/u, '')
  if (minutes === 0) return `${hours}h`
  return hours === 0 ? `${trimmed}m` : `${hours}h${trimmed}m`
}

export const recurringBlankLine = (): RecurringLineFormValues => ({
  kind: 'Service',
  description: '',
  quantity: '1',
  unitPriceCents: '',
  taxed: false,
  taxed2: false,
  projectId: '',
  through: '',
  installments: '',
})

/**
 * A new definition, seeded with the answers that are right more often than not:
 * monthly, on the first, one line to fill in. `nextIssueOn` is left empty
 * because the browser's today is the only clock this form has and a date it
 * guesses wrong is a date nobody re-reads.
 */
export const recurringBlankFormValues = (): RecurringDefinitionFormValues => ({
  clientId: '',
  subjectTemplate: '',
  notesTemplate: '',
  everyNMonths: '1',
  dayOfMonth: '1',
  nextIssueOn: '',
  retainerId: '',
  amountType: 'fixed_lines',
  lines: [recurringBlankLine()],
  projectIds: [],
  claimsProjectIds: [],
  claimMode: 'all',
  claimCeilingUnit: 'time',
  claimCeiling: '',
  claimScope: 'billable',
  importTime: true,
  timeSummary: 'project',
  importExpenses: false,
  expenseSummary: 'category',
})

/**
 * The stored definition, read back into the form.
 *
 * PATCH on this resource is a replace, so the editor has to hold every field a
 * definition has, including the ones the open tab is not showing. A sweep whose
 * day of month is being corrected must not come back as an empty fixed
 * definition, which is what a form seeded only from the visible tab would send.
 */
export const recurringFormValuesFromDefinition = (
  definition: Readonly<RecurringInvoice>,
): RecurringDefinitionFormValues => {
  const blank = recurringBlankFormValues()
  const config = definition.amount_config
  const shared = {
    clientId: String(definition.client_id),
    subjectTemplate: definition.subject_template,
    notesTemplate: definition.notes_template,
    everyNMonths: String(definition.every_n_months),
    dayOfMonth: String(definition.day_of_month),
    nextIssueOn: definition.next_issue_on.slice(0, 10),
    retainerId:
      definition.can_draw_from_retainer_id === null
        ? ''
        : String(definition.can_draw_from_retainer_id),
    // PATCH replaces the whole definition, so an editor that dropped this would
    // silently un-band an engagement whose day of month somebody corrected.
    claimsProjectIds: (definition.claims_project_ids ?? []).map(String),
    claimMode: definition.claim_mode === 'ceiling' ? ('ceiling' as const) : ('all' as const),
    claimCeilingUnit:
      definition.claim_ceiling_cents === null ? ('time' as const) : ('money' as const),
    claimCeiling:
      definition.claim_ceiling_cents !== null
        ? String(definition.claim_ceiling_cents)
        : definition.claim_ceiling_seconds === null
          ? ''
          : recurringDurationInput(definition.claim_ceiling_seconds),
    claimScope: definition.claim_scope === 'tracked' ? ('tracked' as const) : ('billable' as const),
  }
  if (config.type === 'fixed_lines') {
    return {
      ...blank,
      ...shared,
      amountType: 'fixed_lines',
      lines: config.line_items.map((line) => ({
        kind: line.kind,
        description: line.description ?? '',
        quantity: String(line.quantity),
        unitPriceCents: String(line.unit_price_cents),
        taxed: line.taxed,
        taxed2: line.taxed2,
        projectId: line.project_id === null ? '' : String(line.project_id),
        // Both keys are optional in storage, so both are absent on every line
        // written before 0041 and 0044. An empty box is what "this line does
        // not stop" and "this line does not count itself" look like.
        through: line.through ?? '',
        installments:
          line.installments === null || line.installments === undefined
            ? ''
            : String(line.installments),
      })),
    }
  }
  const time = 'time' in config ? config.time : undefined
  const expenses = 'expenses' in config ? config.expenses : undefined
  return {
    ...blank,
    ...shared,
    amountType: 'line_items_import',
    // An import definition has no fixed lines. Seeding one blank rather than
    // none means switching the tab to Fixed lands on the same footing the
    // create form starts from, instead of on a config that cannot be saved.
    lines: [recurringBlankLine()],
    projectIds: config.project_ids.map(String),
    importTime: time !== undefined,
    timeSummary: time?.summary_type ?? blank.timeSummary,
    importExpenses: expenses !== undefined,
    expenseSummary: expenses?.summary_type ?? blank.expenseSummary,
  }
}
