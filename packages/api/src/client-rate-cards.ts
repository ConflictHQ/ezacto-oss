import {
  canViewMoneyField,
  RateCardClientNotFoundError,
  RateCardExistsError,
  RateCardNotFoundError,
  RateCardTaskNotFoundError,
  RateCardVersionOrderError,
  rateCardMaxAmountCents,
  rateCardMaxLines,
  rateCardNameMaxLength,
  type ClientRateCardRecord,
  type EffectiveClientRateCard,
  type RateCardLine,
} from '@ezacto/core'
import type { Hono } from 'hono'
import { requireApiScope } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError, validationError, type FieldError } from './errors.js'
import {
  assertFields,
  isCanonicalDate,
  isJsonObject,
  notFound,
  queryDate,
  queryPositiveInteger,
  readObjectBody,
  strictSearchParams,
  unknownFieldErrors,
} from './resources/support.js'
import type { TrackedResourceClock } from './resources/tracked-repository.js'

/**
 * Client rate cards (issue 34, slice B). A card names the hourly rates a client
 * node bills at for projects billed by people, inherited down the parent chain
 * with the nearest card winning. Billable rates are money: only the profiles
 * that may see billable rates read or write a card, and everyone else is 403.
 * Writing a card never changes an entry, a snapshot or an invoice.
 */

export interface ClientRateCardRepository {
  /** The card attached directly to the client, or null. Throws if the client does not exist. */
  get(clientId: number): Promise<ClientRateCardRecord | null>
  create(clientId: number, input: { name: string }, now: string): Promise<ClientRateCardRecord>
  appendVersion(
    clientId: number,
    input: { startDate: string | null; lines: readonly RateCardLine[] },
    now: string,
  ): Promise<ClientRateCardRecord>
  /** Throws RateCardNotFoundError when no card on the chain prices the task on that date. */
  effective(clientId: number, taskId: number, spentDate: string): Promise<EffectiveClientRateCard>
}

export interface ClientRateCardRouteOptions {
  repository: ClientRateCardRepository
  clock: TrackedResourceClock
}

const serializeCard = (card: Readonly<ClientRateCardRecord>) => ({
  id: card.id,
  client_id: card.clientId,
  name: card.name,
  created_at: card.createdAt,
  versions: card.versions.map((version) => ({
    id: version.id,
    start_date: version.startDate,
    lines: version.lines.map((line) => ({ task_id: line.taskId, amount_cents: line.amountCents })),
    created_at: version.createdAt,
  })),
})

const serializeEffective = (effective: Readonly<EffectiveClientRateCard>) => ({
  client_id: effective.clientId,
  supplied_by_client_id: effective.suppliedByClientId,
  depth: effective.depth,
  card_id: effective.cardId,
  card_name: effective.cardName,
  version_start_date: effective.versionStartDate,
  task_id: effective.taskId,
  amount_cents: effective.amountCents,
})

const parseClientId = (raw: string): number => {
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw notFound('client')
  return Number(raw)
}

/** The scope, then the money rule: a billable rate is not for every profile. */
const authorize = <Bindings extends object>(
  context: Parameters<typeof requireApiScope<Bindings>>[0],
  scope: 'clients:read' | 'clients:write',
): void => {
  requireApiScope(context, scope)
  if (!canViewMoneyField(context.get('principal'), 'billable_rate')) {
    throw new ApiError({
      status: 403,
      code: 'money_forbidden',
      message: 'The acting user profile cannot see or change billable rates.',
    })
  }
}

const cardKeys = new Set(['name'])
const versionKeys = new Set(['start_date', 'lines'])
const lineKeys = new Set(['task_id', 'amount_cents'])
const effectiveKeys = new Set(['task_id', 'spent_date'])

const createInput = (body: Record<string, unknown>): { name: string } => {
  const errors = unknownFieldErrors(body, cardKeys)
  const name = body.name
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > rateCardNameMaxLength) {
    errors.push({
      field: 'name',
      code: 'invalid_name',
      message: `name must be 1 to ${rateCardNameMaxLength} characters`,
    })
  }
  assertFields(errors)
  return { name: name as string }
}

const lineOf = (raw: unknown, index: number, errors: FieldError[]): RateCardLine | undefined => {
  const field = `lines[${index}]`
  if (!isJsonObject(raw)) {
    errors.push({ field, code: 'invalid', message: 'each line must be an object' })
    return undefined
  }
  for (const error of unknownFieldErrors(raw, lineKeys)) {
    errors.push({ ...error, field: `${field}.${error.field}` })
  }
  const taskId = raw.task_id
  let valid = true
  if (taskId !== null && (!Number.isSafeInteger(taskId) || (taskId as number) < 1)) {
    errors.push({
      field: `${field}.task_id`,
      code: 'invalid_integer',
      message: 'task_id must be a positive integer, or null for the card default',
    })
    valid = false
  }
  const amount = raw.amount_cents
  if (
    !Number.isSafeInteger(amount) ||
    (amount as number) < 0 ||
    (amount as number) > rateCardMaxAmountCents
  ) {
    errors.push({
      field: `${field}.amount_cents`,
      code: 'invalid_integer',
      message: `amount_cents must be a whole number of cents from 0 to ${rateCardMaxAmountCents}`,
    })
    valid = false
  }
  return valid ? { taskId: taskId as number | null, amountCents: amount as number } : undefined
}

const versionInput = (
  body: Record<string, unknown>,
): { startDate: string | null; lines: RateCardLine[] } => {
  const errors = unknownFieldErrors(body, versionKeys)
  const startDate = body.start_date
  if (
    startDate !== null &&
    (typeof startDate !== 'string' || !isCanonicalDate(startDate))
  ) {
    errors.push({
      field: 'start_date',
      code: 'invalid_date',
      message: 'start_date must be a real canonical YYYY-MM-DD date, or null for all prior dates',
    })
  }
  const lines: RateCardLine[] = []
  if (!Array.isArray(body.lines) || body.lines.length > rateCardMaxLines) {
    errors.push({
      field: 'lines',
      code: 'invalid',
      message: `lines must be an array of at most ${rateCardMaxLines} lines; an empty array retires the card`,
    })
  } else {
    const seen = new Set<number | null>()
    for (const [index, raw] of body.lines.entries()) {
      const line = lineOf(raw, index, errors)
      if (line === undefined) continue
      if (seen.has(line.taskId)) {
        errors.push({
          field: `lines[${index}].task_id`,
          code: 'duplicate',
          message: 'a task appears once per version',
        })
        continue
      }
      seen.add(line.taskId)
      lines.push(line)
    }
  }
  assertFields(errors)
  return { startDate: startDate as string | null, lines }
}

const translate = (error: unknown): never => {
  if (error instanceof RateCardClientNotFoundError) throw notFound('client')
  if (error instanceof RateCardNotFoundError) throw notFound('rate card')
  if (error instanceof RateCardExistsError || error instanceof RateCardVersionOrderError) {
    throw new ApiError({ status: 409, code: error.code, message: error.message })
  }
  if (error instanceof RateCardTaskNotFoundError) {
    throw validationError([
      { field: 'lines', code: error.code, message: error.message },
    ])
  }
  throw error
}

const headers = { 'cache-control': 'no-store' } as const

export const installClientRateCardRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  options: ClientRateCardRouteOptions,
): void => {
  const cardPath = (clientId: number): string => `/api/v1/clients/${clientId}/rate-card`

  api.get('/clients/:id/rate-card', async (context) => {
    authorize(context, 'clients:read')
    try {
      const clientId = parseClientId(context.req.param('id'))
      const card = await options.repository.get(clientId)
      if (card === null) throw new RateCardNotFoundError()
      return context.json({ data: serializeCard(card), links: { self: cardPath(clientId) } }, 200, headers)
    } catch (error) {
      return translate(error)
    }
  })

  api.post('/clients/:id/rate-card', async (context) => {
    authorize(context, 'clients:write')
    try {
      const clientId = parseClientId(context.req.param('id'))
      const card = await options.repository.create(
        clientId,
        createInput(await readObjectBody(context)),
        options.clock.now().instant,
      )
      return context.json(
        { data: serializeCard(card), links: { self: cardPath(clientId) } },
        201,
        { ...headers, location: cardPath(clientId) },
      )
    } catch (error) {
      return translate(error)
    }
  })

  api.post('/clients/:id/rate-card/versions', async (context) => {
    authorize(context, 'clients:write')
    try {
      const clientId = parseClientId(context.req.param('id'))
      const card = await options.repository.appendVersion(
        clientId,
        versionInput(await readObjectBody(context)),
        options.clock.now().instant,
      )
      return context.json(
        { data: serializeCard(card), links: { self: cardPath(clientId) } },
        201,
        { ...headers, location: cardPath(clientId) },
      )
    } catch (error) {
      return translate(error)
    }
  })

  api.get('/clients/:id/effective-rate-card', async (context) => {
    authorize(context, 'clients:read')
    try {
      const clientId = parseClientId(context.req.param('id'))
      const params = strictSearchParams(new URL(context.req.url), effectiveKeys)
      const errors: FieldError[] = []
      const taskId = queryPositiveInteger(params, 'task_id', errors)
      const spentDate = queryDate(params, 'spent_date', errors)
      if (taskId === undefined && errors.every((error) => error.field !== 'task_id')) {
        errors.push({ field: 'task_id', code: 'required', message: 'task_id is required' })
      }
      assertFields(errors)
      const effective = await options.repository.effective(
        clientId,
        taskId!,
        spentDate ?? options.clock.now().date,
      )
      return context.json(
        {
          data: serializeEffective(effective),
          links: { self: `/api/v1/clients/${clientId}/effective-rate-card` },
        },
        200,
        headers,
      )
    } catch (error) {
      return translate(error)
    }
  })
}
