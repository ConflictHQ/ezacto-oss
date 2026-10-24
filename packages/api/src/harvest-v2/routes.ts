import {
  canReviewSubmissions,
  canViewMoneyField,
  GeneralResourceError,
  type GeneralResourceKind,
  type GeneralResourceRecord,
  type GeneralResourceRepository,
} from '@ezacto/core'
import type { Context, Hono } from 'hono'
import { canPrincipalUseApiScope, requireApiScope } from '../auth.js'
import type { ApiContext, UserPrincipal } from '../context.js'
import { ApiError } from '../errors.js'
import { requireResourceRead, teamViewer, visibleGeneralRecord } from '../general-resources.js'
import { authorizeInvoiceFilters, invoiceStateForViewer } from '../resources/invoice-visibility.js'
import { notFound, resourceId, translateResourceError } from '../resources/support.js'
import { assertMayNameUser } from '../resources/time-entries.js'
import type {
  ExpenseFilters,
  ExpenseRecord,
  OrganizationTimeEntrySettings,
  TimeEntryActor,
  TimeEntryFilters,
  TimeEntryRecord,
} from '../resources/tracked-repository.js'
import { harvestPage, harvestPageWindow } from './pagination.js'
import {
  parseHarvestExpenseQuery,
  parseHarvestListQuery,
  parseHarvestTimeEntryQuery,
  type HarvestListResource,
} from './params.js'
import {
  serializeHarvestClient,
  serializeHarvestExpense,
  serializeHarvestProjectAssignment,
  serializeHarvestTimeEntry,
  serializeHarvestProject,
  serializeHarvestTask,
  serializeHarvestUser,
} from './serializers.js'

type Viewer = Readonly<UserPrincipal>

/** What the time_entries routes read besides the general resources: offset-paged, every person the viewer reaches. */
export interface HarvestTimeEntrySource {
  timeEntrySettings(): Promise<OrganizationTimeEntrySettings>
  getTimeEntry(actor: TimeEntryActor, id: number): Promise<TimeEntryRecord>
  countTimeEntries(actor: TimeEntryActor, filters: Readonly<TimeEntryFilters>): Promise<number>
  timeEntriesOffset(
    actor: TimeEntryActor,
    filters: Readonly<TimeEntryFilters>,
    window: Readonly<{ offset: number; take: number }>,
  ): Promise<readonly TimeEntryRecord[]>
  invoiceNumbers(ids: readonly number[]): Promise<ReadonlyMap<number, string>>
}

/** What the expenses routes read besides the general resources: offset-paged, every person the viewer reaches. */
export interface HarvestExpenseSource {
  canReadExpenseUser(viewer: Viewer, userId: number): Promise<boolean>
  getExpense(viewer: Viewer, id: number): Promise<ExpenseRecord>
  /** A null `userId` means everyone the viewer's review scope reaches. */
  countExpenses(
    userId: number | null,
    filters: Readonly<ExpenseFilters>,
    viewer: Viewer,
  ): Promise<number>
  expensesOffset(
    userId: number | null,
    filters: Readonly<ExpenseFilters>,
    viewer: Viewer,
    window: Readonly<{ offset: number; take: number }>,
  ): Promise<readonly ExpenseRecord[]>
  invoiceNumbers(ids: readonly number[]): Promise<ReadonlyMap<number, string>>
}

export interface HarvestV2RouteOptions {
  repository: GeneralResourceRepository
  timeEntries: HarvestTimeEntrySource
  expenses: HarvestExpenseSource
  /** Expenses are a module; absent means it is on. */
  isExpensesModuleEnabled?(): Promise<boolean>
  /** Users and roles belong to the Team module; absent means it is on. */
  isTeamModuleEnabled?(): Promise<boolean>
  clock?: () => string
}

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

  const requireTeamModule = async (): Promise<void> => {
    if (options.isTeamModuleEnabled !== undefined && !(await options.isTeamModuleEnabled())) {
      throw new ApiError({
        status: 403,
        code: 'module_disabled',
        message: 'The Team module is not enabled for this organization.',
      })
    }
  }

  const guard = async (
    context: Context<ApiContext<Bindings>>,
    resource: HarvestListResource,
  ): Promise<Viewer> => {
    const viewer = requireResourceRead(context, resource)
    if (resource === 'users') await requireTeamModule()
    return viewer
  }

  // Rows named by rows the viewer was already allowed to read: fetched without
  // the team scope, and stripped of money with the same rules as the native API.
  const embedded = async (
    kind: GeneralResourceKind,
    ids: readonly number[],
  ): Promise<Map<number, GeneralResourceRecord>> =>
    new Map((await repository.getMany(kind, ids)).map((record) => [record.id, record]))

  const need = (
    map: ReadonlyMap<number, GeneralResourceRecord>,
    id: number,
    label: string,
  ): GeneralResourceRecord => {
    const record = map.get(id)
    if (record === undefined) throw new Error(`Harvest shim: ${label} ${id} is missing`)
    return record
  }

  const renderTimeEntries = async (
    entries: readonly TimeEntryRecord[],
    viewer: Viewer,
  ): Promise<unknown[]> => {
    if (entries.length === 0) return []
    const [settings, users, projects, tasks, userAssignments, taskAssignments] = await Promise.all([
      options.timeEntries.timeEntrySettings(),
      embedded('users', entries.map((entry) => entry.userId)),
      embedded('projects', entries.map((entry) => entry.projectId)),
      embedded('tasks', entries.map((entry) => entry.taskId)),
      embedded('user-assignments', entries.map((entry) => entry.userAssignmentId)),
      embedded('task-assignments', entries.map((entry) => entry.taskAssignmentId)),
    ])
    const clients = await embedded(
      'clients',
      [...projects.values()].map((project) => Number(project.clientId)),
    )
    const mayReadInvoices = canPrincipalUseApiScope(viewer, 'invoices:read')
    const invoiceNumbers = mayReadInvoices
      ? await options.timeEntries.invoiceNumbers(
          entries.flatMap((entry) => (entry.invoiceId === null ? [] : [entry.invoiceId])),
        )
      : new Map<number, string>()
    return entries.map((entry) => {
      const project = need(projects, entry.projectId, 'project')
      const invoiceId = mayReadInvoices ? entry.invoiceId : null
      const number = invoiceId === null ? undefined : invoiceNumbers.get(invoiceId)
      if (invoiceId !== null && number === undefined)
        throw new Error(`Harvest shim: invoice ${invoiceId} is missing for entry ${entry.id}`)
      return serializeHarvestTimeEntry(entry, {
        clock: settings.clock,
        user: need(users, entry.userId, 'user'),
        client: need(clients, Number(project.clientId), 'client'),
        project,
        task: need(tasks, entry.taskId, 'task'),
        userAssignment: visibleGeneralRecord(
          'user-assignments',
          need(userAssignments, entry.userAssignmentId, 'user assignment'),
          viewer,
        ),
        taskAssignment: visibleGeneralRecord(
          'task-assignments',
          need(taskAssignments, entry.taskAssignmentId, 'task assignment'),
          viewer,
        ),
        // The subject is the entry's own user, as in the native serializer.
        billableRateCents: canViewMoneyField(viewer, 'billable_rate', entry.userId)
          ? entry.billableRateCents
          : null,
        costRateCents: canViewMoneyField(viewer, 'cost_rate', entry.userId)
          ? entry.costRateCents
          : null,
        isBilled: mayReadInvoices ? entry.state.isBilled : null,
        lockedReason: invoiceStateForViewer(entry.state, viewer).locked_reason,
        invoice: invoiceId === null ? null : { id: invoiceId, number: number! },
      })
    })
  }

  const requireExpensesModule = async (): Promise<void> => {
    if (options.isExpensesModuleEnabled !== undefined && !(await options.isExpensesModuleEnabled())) {
      throw new ApiError({
        status: 403,
        code: 'module_disabled',
        message: 'The expenses module is not enabled for this organization.',
      })
    }
  }

  const renderExpenses = async (
    records: readonly ExpenseRecord[],
    viewer: Viewer,
  ): Promise<unknown[]> => {
    if (records.length === 0) return []
    const [users, projects, categories] = await Promise.all([
      embedded('users', records.map((record) => record.userId)),
      embedded('projects', records.map((record) => record.projectId)),
      embedded('expense-categories', records.map((record) => record.expenseCategoryId)),
    ])
    const clients = await embedded(
      'clients',
      [...projects.values()].map((project) => Number(project.clientId)),
    )
    // The person's assignment to the project, when there is one: an expense is
    // filed against a project, not against an assignment.
    const assignments = new Map<string, GeneralResourceRecord | null>()
    for (const record of records) {
      const key = `${record.userId}:${record.projectId}`
      if (assignments.has(key)) continue
      const [assignment] = await repository.listOffset(
        'user-assignments',
        { userId: record.userId, projectId: record.projectId },
        { offset: 0, take: 1 },
      )
      assignments.set(key, assignment ?? null)
    }
    const mayReadInvoices = canPrincipalUseApiScope(viewer, 'invoices:read')
    const invoiceNumbers = mayReadInvoices
      ? await options.expenses.invoiceNumbers(
          records.flatMap((record) => (record.invoiceId === null ? [] : [record.invoiceId])),
        )
      : new Map<number, string>()
    return records.map((record) => {
      const project = need(projects, record.projectId, 'project')
      const invoiceId = mayReadInvoices ? record.invoiceId : null
      const number = invoiceId === null ? undefined : invoiceNumbers.get(invoiceId)
      if (invoiceId !== null && number === undefined)
        throw new Error(`Harvest shim: invoice ${invoiceId} is missing for expense ${record.id}`)
      const assignment = assignments.get(`${record.userId}:${record.projectId}`) ?? null
      return serializeHarvestExpense(record, {
        user: need(users, record.userId, 'user'),
        userAssignment:
          assignment === null ? null : visibleGeneralRecord('user-assignments', assignment, viewer),
        project,
        client: need(clients, Number(project.clientId), 'client'),
        expenseCategory: need(categories, record.expenseCategoryId, 'expense category'),
        isBilled: mayReadInvoices ? record.state.isBilled : null,
        lockedReason: invoiceStateForViewer(record.state, viewer).locked_reason,
        invoice: invoiceId === null ? null : { id: invoiceId, number: number! },
      })
    })
  }

  const taskAssignmentsOf = async (
    projectIds: readonly number[],
  ): Promise<Map<number, GeneralResourceRecord[]>> => {
    const byProject = new Map<number, GeneralResourceRecord[]>()
    for (const projectId of new Set(projectIds)) {
      const rows: GeneralResourceRecord[] = []
      for (let offset = 0; ; offset += roleBatch) {
        const batch = await repository.listOffset(
          'task-assignments',
          { projectId },
          { offset, take: roleBatch },
        )
        rows.push(...batch)
        if (batch.length < roleBatch) break
      }
      byProject.set(projectId, rows)
    }
    return byProject
  }

  const renderProjectAssignments = async (
    assignments: readonly GeneralResourceRecord[],
    viewer: Viewer,
  ): Promise<unknown[]> => {
    if (assignments.length === 0) return []
    const projects = await embedded(
      'projects',
      assignments.map((assignment) => Number(assignment.projectId)),
    )
    const [clients, taskAssignments] = await Promise.all([
      embedded('clients', [...projects.values()].map((project) => Number(project.clientId))),
      taskAssignmentsOf(assignments.map((assignment) => Number(assignment.projectId))),
    ])
    const tasks = await embedded(
      'tasks',
      [...taskAssignments.values()].flatMap((rows) => rows.map((row) => Number(row.taskId))),
    )
    return assignments.map((assignment) => {
      const project = need(projects, Number(assignment.projectId), 'project')
      return serializeHarvestProjectAssignment(
        visibleGeneralRecord('user-assignments', assignment, viewer),
        project,
        need(clients, Number(project.clientId), 'client'),
        (taskAssignments.get(project.id) ?? []).map((row) => ({
          assignment: visibleGeneralRecord('task-assignments', row, viewer),
          task: need(tasks, Number(row.taskId), 'task'),
        })),
      )
    })
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

  // "me" or a user id. A person's own assignments are their bootstrap and need
  // only the project scope; anyone else's are Team data, so the Team scope and
  // module apply. Embedded project and client names need the project scope.
  harvest.get('/users/:id/project_assignments', async (context) => {
    requireApiScope(context, 'projects:read')
    const viewer = context.get('principal')
    const raw = context.req.param('id')
    const userId = raw === 'me' ? viewer.userId : resourceId(raw, 'user')
    if (userId !== viewer.userId) {
      requireResourceRead(context, 'user-assignments')
      await requireTeamModule()
    }
    try {
      await repository.get('users', userId, teamViewer(viewer))
    } catch (error) {
      return translate(error, 'user')
    }
    const query = parseHarvestListQuery('project_assignments', new URL(context.req.url).searchParams)
    const filters = { ...query.filters, userId }
    const scope = teamViewer(viewer)
    const [total, records] = await Promise.all([
      repository.count('user-assignments', filters, scope),
      repository.listOffset('user-assignments', filters, harvestPageWindow(query.page), scope),
    ])
    return context.json(
      harvestPage(
        'project_assignments',
        await renderProjectAssignments(records, viewer),
        total,
        query.page,
        `/harvest/v2/users/${raw}/project_assignments`,
        query.echo,
      ),
    )
  })

  harvest.get('/time_entries', async (context) => {
    requireApiScope(context, 'time_entries:read')
    const viewer = context.get('principal')
    const query = parseHarvestTimeEntryQuery(new URL(context.req.url).searchParams)
    authorizeInvoiceFilters(new Map(query.echo), viewer)
    assertMayNameUser(viewer, query.filters.userId)
    const actor = { userId: viewer.userId, profile: viewer.profile }
    const [total, entries] = await Promise.all([
      options.timeEntries.countTimeEntries(actor, query.filters),
      options.timeEntries.timeEntriesOffset(actor, query.filters, harvestPageWindow(query.page)),
    ])
    return context.json(
      harvestPage(
        'time_entries',
        await renderTimeEntries(entries, viewer),
        total,
        query.page,
        '/harvest/v2/time_entries',
        query.echo,
      ),
    )
  })

  harvest.get('/time_entries/:id', async (context) => {
    requireApiScope(context, 'time_entries:read')
    const viewer = context.get('principal')
    const id = resourceId(context.req.param('id'), 'time entry')
    try {
      const entry = await options.timeEntries.getTimeEntry(
        { userId: viewer.userId, profile: viewer.profile },
        id,
      )
      return context.json((await renderTimeEntries([entry], viewer))[0])
    } catch (error) {
      return translateResourceError(error, 'time entry', viewer)
    }
  })

  harvest.get('/expenses', async (context) => {
    requireApiScope(context, 'expenses:read')
    const viewer = context.get('principal')
    await requireExpensesModule()
    const query = parseHarvestExpenseQuery(new URL(context.req.url).searchParams)
    authorizeInvoiceFilters(new Map(query.echo), viewer)
    // As natively: another person's expenses are for those who review
    // submissions, and only within their scope. Unnamed, the list is every
    // person the viewer reaches, which a member's own scope narrows to them.
    if (query.userId !== undefined && query.userId !== viewer.userId) {
      if (!canReviewSubmissions(viewer.profile) || !(await options.expenses.canReadExpenseUser(viewer, query.userId)))
        throw new ApiError({
          status: 403,
          code: 'row_forbidden',
          message: 'Expenses are limited to you and employees assigned to your review scope.',
        })
    }
    const userId = query.userId ?? null
    const [total, records] = await Promise.all([
      options.expenses.countExpenses(userId, query.filters, viewer),
      options.expenses.expensesOffset(userId, query.filters, viewer, harvestPageWindow(query.page)),
    ])
    return context.json(
      harvestPage(
        'expenses',
        await renderExpenses(records, viewer),
        total,
        query.page,
        '/harvest/v2/expenses',
        query.echo,
      ),
    )
  })

  harvest.get('/expenses/:id', async (context) => {
    requireApiScope(context, 'expenses:read')
    const viewer = context.get('principal')
    await requireExpensesModule()
    const id = resourceId(context.req.param('id'), 'expense')
    try {
      const record = await options.expenses.getExpense(viewer, id)
      return context.json((await renderExpenses([record], viewer))[0])
    } catch (error) {
      return translateResourceError(error, 'expense', viewer)
    }
  })
}
