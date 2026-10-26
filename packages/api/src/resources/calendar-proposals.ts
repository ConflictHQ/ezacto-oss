import {
  CalendarProposalNotFoundError,
  CalendarProposalNotOpenError,
  type CalendarProposalStatus,
  type CalendarProvider,
} from '@ezacto/core'
import type { Hono } from 'hono'
import { requireApiScope } from '../auth.js'
import type { ApiContext } from '../context.js'
import { ApiError, type FieldError } from '../errors.js'
import { cursorPage, type CursorSource } from '../pagination.js'
import {
  assertFields,
  notFound,
  optionalBoolean,
  optionalNullableString,
  queryDate,
  queryEnum,
  readObjectBody,
  requiredPositiveInteger,
  resourceId,
  strictSearchParams,
  translateResourceError,
  unknownFieldErrors,
} from './support.js'
import type {
  ResourceTimeBoundary,
  TimeEntryActor,
  TrackedResourceClock,
} from './tracked-repository.js'

/**
 * Calendar events offered as time (issue 428, slice 1): listed for the signed-in
 * person, accepted into a real time entry or discarded. Provider-free; nothing
 * on these routes reaches a calendar.
 *
 * Everything is the acting person's own. There is no `user_id` to name, and an
 * administrator is no exception: a proposal is somebody's calendar, not their
 * time, so a proposal that is not yours answers exactly as one that does not
 * exist.
 */

export interface CalendarProposalRecord {
  id: number
  provider: CalendarProvider
  calendarId: string
  eventId: string
  occurrence: string
  title: string
  startsAt: string
  endsAt: string
  status: CalendarProposalStatus
  timeEntryId: number | null
  decidedAt: string | null
  sourceChangedAt?: string | null
  sourceCancelledAt?: string | null
  createdAt: string
  updatedAt: string
}

export interface CalendarProposalFilters {
  from?: string
  to?: string
  status?: CalendarProposalStatus
}

export interface AcceptCalendarProposalRequest {
  projectId: number
  taskId: number
  notes?: string | null
  budgeted?: boolean
}

export interface CalendarProposalRepository {
  proposals(userId: number, filters: Readonly<CalendarProposalFilters>): CursorSource<CalendarProposalRecord>
  discard(userId: number, id: number, decidedAt: string): Promise<CalendarProposalRecord>
  accept(
    actor: TimeEntryActor,
    id: number,
    input: Readonly<AcceptCalendarProposalRequest>,
    boundary: ResourceTimeBoundary,
  ): Promise<{ proposal: CalendarProposalRecord; timeEntryId: number }>
}

export interface CalendarProposalRouteOptions {
  repository: CalendarProposalRepository
  clock: TrackedResourceClock
  cursorSigningKey: Uint8Array
}

interface CalendarProposalOutput {
  id: number
  provider: CalendarProvider
  calendar_id: string
  event_id: string
  occurrence: string
  title: string
  starts_at: string
  ends_at: string
  status: CalendarProposalStatus
  time_entry_id: number | null
  decided_at: string | null
  source_changed_at: string | null
  source_cancelled_at: string | null
  created_at: string
  updated_at: string
}

export const serializeCalendarProposal = (
  proposal: Readonly<CalendarProposalRecord>,
): CalendarProposalOutput => ({
  id: proposal.id,
  provider: proposal.provider,
  calendar_id: proposal.calendarId,
  event_id: proposal.eventId,
  occurrence: proposal.occurrence,
  title: proposal.title,
  starts_at: proposal.startsAt,
  ends_at: proposal.endsAt,
  status: proposal.status,
  time_entry_id: proposal.timeEntryId,
  decided_at: proposal.decidedAt,
  source_changed_at: proposal.sourceChangedAt ?? null,
  source_cancelled_at: proposal.sourceCancelledAt ?? null,
  created_at: proposal.createdAt,
  updated_at: proposal.updatedAt,
})

const statuses = ['proposed', 'accepted', 'discarded', 'cancelled'] as const
const listKeys = new Set(['cursor', 'per_page', 'from', 'to', 'status'])
const acceptKeys = new Set(['project_id', 'task_id', 'notes', 'budgeted'])

const listFilters = (url: URL): CalendarProposalFilters => {
  const params = strictSearchParams(url, listKeys)
  const errors: FieldError[] = []
  const from = queryDate(params, 'from', errors)
  const to = queryDate(params, 'to', errors)
  const status = queryEnum(params, 'status', statuses, errors)
  if (from !== undefined && to !== undefined && from > to) {
    errors.push({ field: 'to', code: 'invalid_range', message: 'to must not precede from' })
  }
  assertFields(errors)
  return {
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(status !== undefined ? { status } : {}),
  }
}

const acceptInput = (body: Record<string, unknown>): AcceptCalendarProposalRequest => {
  const errors = unknownFieldErrors(body, acceptKeys)
  const projectId = requiredPositiveInteger(body, 'project_id', errors)
  const taskId = requiredPositiveInteger(body, 'task_id', errors)
  const notes = optionalNullableString(body, 'notes', errors)
  const budgeted = optionalBoolean(body, 'budgeted', errors)
  assertFields(errors)
  return {
    projectId: projectId!,
    taskId: taskId!,
    ...(notes !== undefined ? { notes } : {}),
    ...(budgeted !== undefined ? { budgeted } : {}),
  }
}

/** Proposal-specific failures; everything else is the time-entry path's to explain. */
const translateProposalError = (error: unknown, principal: Parameters<typeof translateResourceError>[2]): never => {
  if (error instanceof CalendarProposalNotFoundError) throw notFound('calendar proposal')
  if (error instanceof CalendarProposalNotOpenError) {
    throw new ApiError({
      status: 409,
      code: error.code,
      message: error.message,
      fields: [{ field: 'status', code: error.status, message: error.message }],
    })
  }
  return translateResourceError(error, 'time entry', principal)
}

const selfLink = (id: number) => `/api/v1/calendar-proposals/${id}`

export const installCalendarProposalRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  options: CalendarProposalRouteOptions,
): void => {
  api.get('/calendar-proposals', async (context) => {
    requireApiScope(context, 'time_entries:read')
    const principal = context.get('principal')
    try {
      const url = new URL(context.req.url)
      const envelope = await cursorPage({
        requestUrl: url,
        source: options.repository.proposals(principal.userId, listFilters(url)),
        viewer: principal,
        serializer: serializeCalendarProposal,
        cursorSigningKey: options.cursorSigningKey,
      })
      return context.json(envelope, 200, { 'cache-control': 'no-store' })
    } catch (error) {
      return translateProposalError(error, principal)
    }
  })

  api.post('/calendar-proposals/:id/accept', async (context) => {
    requireApiScope(context, 'time_entries:write')
    const principal = context.get('principal')
    try {
      const id = resourceId(context.req.param('id'), 'calendar proposal')
      const accepted = await options.repository.accept(
        principal,
        id,
        acceptInput(await readObjectBody(context)),
        options.clock.now(),
      )
      return context.json(
        {
          data: serializeCalendarProposal(accepted.proposal),
          links: { self: selfLink(id) },
        },
        201,
        {
          'cache-control': 'no-store',
          location: `/api/v1/time-entries/${accepted.timeEntryId}`,
        },
      )
    } catch (error) {
      return translateProposalError(error, principal)
    }
  })

  api.post('/calendar-proposals/:id/discard', async (context) => {
    requireApiScope(context, 'time_entries:write')
    const principal = context.get('principal')
    try {
      const id = resourceId(context.req.param('id'), 'calendar proposal')
      const proposal = await options.repository.discard(
        principal.userId,
        id,
        options.clock.now().instant,
      )
      return context.json(
        { data: serializeCalendarProposal(proposal), links: { self: selfLink(id) } },
        200,
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      return translateProposalError(error, principal)
    }
  })
}
