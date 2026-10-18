import {
  isWorkItemProvider,
  normalizeWorkItemId,
  normalizeWorkItemUrl,
  WorkItemConnectionInactiveError,
  WorkItemConnectionNotFoundError,
  WorkItemLinkExistsError,
  WorkItemLinkNotFoundError,
  WorkItemTargetNotFoundError,
  workItemProviders,
  type WorkItemConnectionStatus,
  type WorkItemProviderId,
} from '@ezacto/core'
import type { Context, Hono } from 'hono'
import { captureRequestActivity, type ActivityRecorder } from './activity-log.js'
import { requireApiScope, requireSessionPrincipal } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError, type FieldError } from './errors.js'
import { cursorPage, type CursorSource } from './pagination.js'
import {
  assertFields,
  notFound,
  optionalPositiveInteger,
  queryNonemptyString,
  queryPositiveInteger,
  readObjectBody,
  requiredPositiveInteger,
  resourceId,
  strictSearchParams,
  unknownFieldErrors,
} from './resources/support.js'

/**
 * Work-item connections and links (issue 1008, slice 1). Provider-free: nothing
 * on these routes reaches an issue tracker.
 *
 * Connecting and disconnecting are for administrators acting in a session, and
 * both are written to the activity log. No route returns a credential, and
 * none accepts one: the credential lives in a deployment secret, and a
 * connection only records that the instance has one to use.
 */

export interface WorkItemConnectionRecord {
  id: number
  provider: WorkItemProviderId
  status: WorkItemConnectionStatus
  ownerUserId: number
  connectedAt: string
  disconnectedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface WorkItemLinkRecord {
  id: number
  connectionId: number
  provider: WorkItemProviderId
  timeEntryId: number | null
  projectId: number | null
  providerItemId: string
  url: string | null
  createdBy: number
  createdAt: string
  updatedAt: string
}

export interface WorkItemActor {
  readonly userId: number
  readonly profile: string
}

export interface WorkItemLinkFilters {
  connectionId?: number
  timeEntryId?: number
  projectId?: number
  providerItemId?: string
}

export interface WorkItemRepository {
  connections(): Promise<readonly WorkItemConnectionRecord[]>
  connect(
    provider: WorkItemProviderId,
    ownerUserId: number,
    now: string,
  ): Promise<WorkItemConnectionRecord>
  disconnect(id: number, now: string): Promise<WorkItemConnectionRecord>
  links(actor: WorkItemActor, filters: Readonly<WorkItemLinkFilters>): CursorSource<WorkItemLinkRecord>
  getLink(actor: WorkItemActor, id: number): Promise<WorkItemLinkRecord>
  createLink(
    actor: WorkItemActor,
    input: {
      connectionId: number
      timeEntryId?: number
      projectId?: number
      providerItemId: string
      url?: string | null
    },
    now: string,
  ): Promise<WorkItemLinkRecord>
  deleteLink(actor: WorkItemActor, id: number): Promise<void>
}

export interface WorkItemRouteOptions {
  repository: WorkItemRepository
  /** Whether this deployment holds the provider's credential. Asked, never read out. */
  credentialConfigured(provider: WorkItemProviderId): boolean
  clock(): string
  cursorSigningKey: Uint8Array
  activity?: ActivityRecorder
}

const serializeConnection = (
  record: Readonly<WorkItemConnectionRecord>,
  configured: boolean,
) => ({
  id: record.id,
  provider: record.provider,
  status: record.status,
  owner_user_id: record.ownerUserId,
  credential_configured: record.status === 'active' && configured,
  connected_at: record.connectedAt,
  disconnected_at: record.disconnectedAt,
  created_at: record.createdAt,
  updated_at: record.updatedAt,
})

export const serializeWorkItemLink = (record: Readonly<WorkItemLinkRecord>) => ({
  id: record.id,
  connection_id: record.connectionId,
  provider: record.provider,
  time_entry_id: record.timeEntryId,
  project_id: record.projectId,
  item_id: record.providerItemId,
  url: record.url,
  created_by: record.createdBy,
  created_at: record.createdAt,
  updated_at: record.updatedAt,
})

const assertAdministrator = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): void => {
  const principal = requireSessionPrincipal(context)
  if (principal.profile !== 'administrator') {
    throw new ApiError({
      status: 403,
      code: 'profile_forbidden',
      message: 'Only administrators can manage work item connections.',
    })
  }
}

const translate = (error: unknown): never => {
  if (error instanceof WorkItemConnectionNotFoundError) throw notFound('work item connection')
  if (error instanceof WorkItemLinkNotFoundError) throw notFound('work item link')
  if (error instanceof WorkItemTargetNotFoundError) {
    throw notFound(error.target === 'time_entry' ? 'time entry' : 'project')
  }
  if (error instanceof WorkItemConnectionInactiveError || error instanceof WorkItemLinkExistsError) {
    throw new ApiError({ status: 409, code: error.code, message: error.message })
  }
  if (error instanceof RangeError) {
    throw new ApiError({
      status: 422,
      code: 'invalid_input',
      message: error.message,
      fields: [{ field: 'item_id', code: 'invalid', message: error.message }],
    })
  }
  throw error
}

const connectKeys = new Set(['provider'])
const linkKeys = new Set(['connection_id', 'time_entry_id', 'project_id', 'item_id', 'url'])
const listKeys = new Set([
  'cursor',
  'per_page',
  'connection_id',
  'time_entry_id',
  'project_id',
  'item_id',
])

const linkFilters = (url: URL): WorkItemLinkFilters => {
  const params = strictSearchParams(url, listKeys)
  const errors: FieldError[] = []
  const connectionId = queryPositiveInteger(params, 'connection_id', errors)
  const timeEntryId = queryPositiveInteger(params, 'time_entry_id', errors)
  const projectId = queryPositiveInteger(params, 'project_id', errors)
  const providerItemId = queryNonemptyString(params, 'item_id', errors)
  assertFields(errors)
  return {
    ...(connectionId !== undefined ? { connectionId } : {}),
    ...(timeEntryId !== undefined ? { timeEntryId } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
    ...(providerItemId !== undefined ? { providerItemId } : {}),
  }
}

export const installWorkItemRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  options: WorkItemRouteOptions,
): void => {
  const noStore = { 'cache-control': 'no-store' }

  api.get('/settings/work-item-connections', async (context) => {
    assertAdministrator(context)
    const connections = await options.repository.connections()
    return context.json(
      {
        data: connections.map((connection) =>
          serializeConnection(connection, options.credentialConfigured(connection.provider)),
        ),
        links: { self: '/api/v1/settings/work-item-connections' },
      },
      200,
      noStore,
    )
  })

  api.post('/settings/work-item-connections', async (context) => {
    assertAdministrator(context)
    const principal = context.get('principal')
    const body = await readObjectBody(context)
    const errors = unknownFieldErrors(body, connectKeys)
    if (!isWorkItemProvider(body.provider)) {
      errors.push({
        field: 'provider',
        code: body.provider === undefined ? 'required' : 'invalid',
        message: `provider must be one of ${Object.keys(workItemProviders).join(', ')}`,
      })
    }
    assertFields(errors)
    const provider = body.provider as WorkItemProviderId
    // A connection without a credential could never be used, and the cure is a
    // deployment secret an administrator here cannot set.
    if (!options.credentialConfigured(provider)) {
      throw new ApiError({
        status: 409,
        code: 'credential_not_configured',
        message: `This deployment has no ${provider} credential configured.`,
      })
    }
    const now = options.clock()
    const connection = await options.repository.connect(provider, principal.userId, now)
    if (options.activity !== undefined) {
      await captureRequestActivity(context, options.activity, {
        eventType: 'work_item_connection.connected',
        subjectId: connection.id,
        occurredAt: now,
        detail: { provider },
      })
    }
    return context.json({ data: serializeConnection(connection, true) }, 201, noStore)
  })

  api.post('/settings/work-item-connections/:id/disconnect', async (context) => {
    assertAdministrator(context)
    const id = resourceId(context.req.param('id'), 'work item connection')
    const now = options.clock()
    try {
      const connection = await options.repository.disconnect(id, now)
      if (options.activity !== undefined) {
        await captureRequestActivity(context, options.activity, {
          eventType: 'work_item_connection.disconnected',
          subjectId: connection.id,
          occurredAt: now,
          detail: { provider: connection.provider },
        })
      }
      return context.json({ data: serializeConnection(connection, false) }, 200, noStore)
    } catch (error) {
      return translate(error)
    }
  })

  api.get('/work-item-links', async (context) => {
    requireApiScope(context, 'time_entries:read')
    const principal = context.get('principal')
    try {
      const url = new URL(context.req.url)
      const envelope = await cursorPage({
        requestUrl: url,
        source: options.repository.links(principal, linkFilters(url)),
        viewer: principal,
        serializer: serializeWorkItemLink,
        cursorSigningKey: options.cursorSigningKey,
      })
      return context.json(envelope, 200, noStore)
    } catch (error) {
      return translate(error)
    }
  })

  api.post('/work-item-links', async (context) => {
    requireApiScope(context, 'time_entries:write')
    const principal = context.get('principal')
    const body = await readObjectBody(context)
    const errors = unknownFieldErrors(body, linkKeys)
    const connectionId = requiredPositiveInteger(body, 'connection_id', errors)
    const timeEntryId = optionalPositiveInteger(body, 'time_entry_id', errors)
    const projectId = optionalPositiveInteger(body, 'project_id', errors)
    if ((body.time_entry_id === undefined) === (body.project_id === undefined)) {
      errors.push({
        field: 'time_entry_id',
        code: 'exactly_one',
        message: 'name exactly one of time_entry_id or project_id',
      })
    }
    let itemId: string | undefined
    if (typeof body.item_id !== 'string') {
      errors.push({
        field: 'item_id',
        code: body.item_id === undefined ? 'required' : 'invalid',
        message: 'item_id must be a string',
      })
    } else {
      try {
        itemId = normalizeWorkItemId(body.item_id)
      } catch (error) {
        errors.push({ field: 'item_id', code: 'invalid', message: (error as Error).message })
      }
    }
    let url: string | null | undefined
    if (body.url !== undefined && body.url !== null) {
      try {
        url = typeof body.url === 'string' ? normalizeWorkItemUrl(body.url) : undefined
        if (url === undefined) throw new RangeError('url must be a string')
      } catch (error) {
        errors.push({ field: 'url', code: 'invalid', message: (error as Error).message })
      }
    }
    assertFields(errors)
    try {
      const link = await options.repository.createLink(
        principal,
        {
          connectionId: connectionId!,
          ...(timeEntryId !== undefined ? { timeEntryId } : {}),
          ...(projectId !== undefined ? { projectId } : {}),
          providerItemId: itemId!,
          ...(url !== undefined ? { url } : {}),
        },
        options.clock(),
      )
      return context.json(
        { data: serializeWorkItemLink(link), links: { self: `/api/v1/work-item-links/${link.id}` } },
        201,
        { ...noStore, location: `/api/v1/work-item-links/${link.id}` },
      )
    } catch (error) {
      return translate(error)
    }
  })

  api.get('/work-item-links/:id', async (context) => {
    requireApiScope(context, 'time_entries:read')
    const principal = context.get('principal')
    const id = resourceId(context.req.param('id'), 'work item link')
    try {
      const link = await options.repository.getLink(principal, id)
      return context.json(
        { data: serializeWorkItemLink(link), links: { self: `/api/v1/work-item-links/${id}` } },
        200,
        noStore,
      )
    } catch (error) {
      return translate(error)
    }
  })

  api.delete('/work-item-links/:id', async (context) => {
    requireApiScope(context, 'time_entries:write')
    const principal = context.get('principal')
    const id = resourceId(context.req.param('id'), 'work item link')
    try {
      await options.repository.deleteLink(principal, id)
    } catch (error) {
      return translate(error)
    }
    return context.body(null, 204, noStore)
  })
}
