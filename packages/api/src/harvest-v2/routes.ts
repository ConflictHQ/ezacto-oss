import {
  canViewMoneyField,
  GeneralResourceError,
  type GeneralResourceKind,
  type GeneralResourceRecord,
  type GeneralResourceRepository,
} from '@ezacto/core'
import type { Context, Hono } from 'hono'
import type { ApiContext, UserPrincipal } from '../context.js'
import { ApiError } from '../errors.js'
import { requireResourceRead, teamViewer, visibleGeneralRecord } from '../general-resources.js'
import { notFound, resourceId } from '../resources/support.js'
import { harvestPage, harvestPageWindow } from './pagination.js'
import { parseHarvestListQuery, type HarvestListResource } from './params.js'
import {
  serializeHarvestClient,
  serializeHarvestProject,
  serializeHarvestTask,
  serializeHarvestUser,
} from './serializers.js'

export interface HarvestV2RouteOptions {
  repository: GeneralResourceRepository
  /** Users and roles belong to the Team module; absent means it is on. */
  isTeamModuleEnabled?(): Promise<boolean>
  clock?: () => string
}

type Viewer = Readonly<UserPrincipal>

/** Rows the viewer may read, rendered as Harvest objects. */
type Renderer = (
  records: readonly GeneralResourceRecord[],
  viewer: Viewer,
) => Promise<readonly unknown[]>

const roleBatch = 200

export const installHarvestV2Routes = <Bindings extends object>(
  harvest: Hono<ApiContext<Bindings>>,
  options: HarvestV2RouteOptions,
): void => {
  const { repository } = options
  const clock = options.clock ?? (() => new Date().toISOString())

  const visible = (
    kind: GeneralResourceKind,
    records: readonly GeneralResourceRecord[],
    viewer: Viewer,
  ): GeneralResourceRecord[] => records.map((record) => visibleGeneralRecord(kind, record, viewer))

  const roleNamesByUser = async (viewer: Viewer): Promise<Map<number, string[]>> => {
    const names = new Map<number, string[]>()
    for (let offset = 0; ; offset += roleBatch) {
      const roles = await repository.listOffset(
        'roles',
        {},
        { offset, take: roleBatch },
        teamViewer(viewer),
      )
      for (const role of roles) {
        const userIds = Array.isArray(role.userIds) ? role.userIds : []
        for (const userId of userIds) {
          const list = names.get(Number(userId)) ?? []
          list.push(String(role.name))
          names.set(Number(userId), list)
        }
      }
      if (roles.length < roleBatch) return names
    }
  }

  const renderers: Readonly<Record<HarvestListResource, Renderer>> = {
    clients: async (records, viewer) =>
      visible('clients', records, viewer).map(serializeHarvestClient),
    tasks: async (records, viewer) => visible('tasks', records, viewer).map(serializeHarvestTask),
    projects: async (records, viewer) => {
      const clients = new Map(
        (
          await repository.getMany(
            'clients',
            records.map((record) => Number(record.clientId)),
            teamViewer(viewer),
          )
        ).map((client) => [client.id, client]),
      )
      return visible('projects', records, viewer).map((project) => {
        const client = clients.get(Number(project.clientId))
        // A project the viewer reads always names a client they read too; a
        // missing one is a broken reference, which is a server fault.
        if (client === undefined)
          throw new Error(
            `Harvest shim: client ${project.clientId} is missing for project ${project.id}`,
          )
        return serializeHarvestProject(project, visibleGeneralRecord('clients', client, viewer))
      })
    },
    users: async (records, viewer) => {
      const ids = records.map((record) => record.id)
      const onDate = clock().slice(0, 10)
      const [roleNames, billable, cost] = await Promise.all([
        roleNamesByUser(viewer),
        repository.currentRates(
          'billable',
          ids.filter((id) => canViewMoneyField(viewer, 'billable_rate', id)),
          onDate,
        ),
        repository.currentRates(
          'cost',
          ids.filter((id) => canViewMoneyField(viewer, 'cost_rate', id)),
          onDate,
        ),
      ])
      return visible('users', records, viewer).map((user) =>
        serializeHarvestUser(user, {
          roleNames: roleNames.get(user.id) ?? [],
          defaultHourlyRateCents: billable.get(user.id) ?? null,
          costRateCents: cost.get(user.id) ?? null,
        }),
      )
    },
  }

  const guard = async (
    context: Context<ApiContext<Bindings>>,
    resource: HarvestListResource,
  ): Promise<Viewer> => {
    const viewer = requireResourceRead(context, resource)
    if (
      resource === 'users' &&
      options.isTeamModuleEnabled !== undefined &&
      !(await options.isTeamModuleEnabled())
    ) {
      throw new ApiError({
        status: 403,
        code: 'module_disabled',
        message: 'The Team module is not enabled for this organization.',
      })
    }
    return viewer
  }

  const translate = (error: unknown, label: string): never => {
    if (error instanceof GeneralResourceError && error.code === 'not_found') throw notFound(label)
    throw error
  }

  const install = (resource: HarvestListResource): void => {
    harvest.get(`/${resource}`, async (context) => {
      const viewer = await guard(context, resource)
      const query = parseHarvestListQuery(resource, new URL(context.req.url).searchParams)
      const scope = teamViewer(viewer)
      const [total, records] = await Promise.all([
        repository.count(resource, query.filters, scope),
        repository.listOffset(resource, query.filters, harvestPageWindow(query.page), scope),
      ])
      const rows = await renderers[resource](records, viewer)
      return context.json(
        harvestPage(resource, rows, total, query.page, `/harvest/v2/${resource}`, query.echo),
      )
    })
    harvest.get(`/${resource}/:id`, async (context) => {
      const viewer = await guard(context, resource)
      const label = resource.slice(0, -1)
      const id = resourceId(context.req.param('id'), label)
      try {
        const record = await repository.get(resource, id, teamViewer(viewer))
        return context.json((await renderers[resource]([record], viewer))[0])
      } catch (error) {
        return translate(error, label)
      }
    })
  }

  // The caller's own user, ahead of /users/:id so "me" is not read as an id.
  harvest.get('/users/me', async (context) => {
    const viewer = await guard(context, 'users')
    try {
      const record = await repository.get('users', viewer.userId, teamViewer(viewer))
      return context.json((await renderers.users([record], viewer))[0])
    } catch (error) {
      return translate(error, 'user')
    }
  })
  for (const resource of ['clients', 'projects', 'tasks', 'users'] as const) install(resource)
}
