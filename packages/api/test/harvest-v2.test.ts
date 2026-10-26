import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GeneralResourceRecord } from '@ezacto/core'
import { describe, expect, it } from 'vitest'
import {
  harvestClockTime,
  harvestPage,
  parseHarvestListQuery,
  parseHarvestTimeEntryQuery,
  serializeHarvestClient,
  serializeHarvestExpense,
  serializeHarvestProject,
  serializeHarvestProjectAssignment,
  serializeHarvestTask,
  serializeHarvestTimeEntry,
  serializeHarvestUser,
  type HarvestExpenseContext,
  type HarvestTimeEntryContext,
  type HarvestUserContext,
} from '../src/harvest-v2/index.js'
import type { ExpenseRecord, TimeEntryRecord } from '../src/resources/tracked-repository.js'
import { ApiError as NativeApiError } from '../src/errors.js'

const corpusRoot = join(import.meta.dirname, 'fixtures', 'harvest-v2')

const render = (resource: string, input: unknown): unknown => {
  if (resource === 'clients') return serializeHarvestClient(input as GeneralResourceRecord)
  if (resource === 'tasks') return serializeHarvestTask(input as GeneralResourceRecord)
  if (resource === 'time_entries') {
    const { entry, context } = input as { entry: TimeEntryRecord; context: HarvestTimeEntryContext }
    return serializeHarvestTimeEntry(entry, context)
  }
  if (resource === 'expenses') {
    const { expense, context } = input as { expense: ExpenseRecord; context: HarvestExpenseContext }
    return serializeHarvestExpense(expense, context)
  }
  if (resource === 'project_assignments') {
    const { assignment, project, client, taskAssignments } = input as {
      assignment: GeneralResourceRecord
      project: GeneralResourceRecord
      client: GeneralResourceRecord
      taskAssignments: Array<{ assignment: GeneralResourceRecord; task: GeneralResourceRecord }>
    }
    return serializeHarvestProjectAssignment(assignment, project, client, taskAssignments)
  }
  if (resource === 'projects') {
    const { project, client } = input as {
      project: GeneralResourceRecord
      client: GeneralResourceRecord
    }
    return serializeHarvestProject(project, client)
  }
  const { user, context } = input as { user: GeneralResourceRecord; context: HarvestUserContext }
  return serializeHarvestUser(user, context)
}

const resources = ['clients', 'projects', 'tasks', 'users', 'time_entries', 'project_assignments', 'expenses']
const cases = resources.flatMap((resource) =>
  readdirSync(join(corpusRoot, resource))
    .filter((file) => file.endsWith('.input.json'))
    .map((file) => ({ resource, name: file.replace('.input.json', '') })),
)
const read = (resource: string, name: string, kind: 'input' | 'golden'): string =>
  readFileSync(join(corpusRoot, resource, `${name}.${kind}.json`), 'utf8')

describe('harvest v2 golden corpus', () => {
  it('retains at least 200 snapshot-derived objects with explicit recorded-subset provenance', () => {
    const provenance = JSON.parse(readFileSync(join(import.meta.dirname, '../../../docs/evidence/16-harvest-corpus-provenance.json'), 'utf8')) as { kind: string; counts: Record<string, number> }
    const recorded = cases.filter(({ name }) => name.startsWith('snapshot-'))
    expect(provenance.kind).toBe('redacted-recorded-subset')
    expect(recorded.length).toBeGreaterThanOrEqual(200)
    for (const [resource, count] of Object.entries(provenance.counts)) {
      expect(recorded.filter((entry) => entry.resource === resource)).toHaveLength(count)
    }
    expect(recorded.some(({ resource }) => resource === 'project_assignments')).toBe(false)
  })

  it('covers every resource in this slice', () => {
    for (const resource of resources)
      expect(cases.filter((entry) => entry.resource === resource).length).toBeGreaterThanOrEqual(3)
  })

  for (const { resource, name } of cases) {
    it(`renders ${resource}/${name} byte for byte`, () => {
      const rendered = JSON.stringify(render(resource, JSON.parse(read(resource, name, 'input'))), null, 2) + '\n'
      expect(rendered).toBe(read(resource, name, 'golden'))
    })
  }
})

// Values the corpus may hold that are structure, not free text.
const structural = [
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{3})?Z)?$/,
  /^[A-Z]{3}$/,
  /^(Etc\/UTC|America\/Costa_Rica)$/,
  /^\d{2}:\d{2}$/,
  /^\d{1,2}:\d{2}(am|pm)$/,
  /^(12h|24h|unsubmitted|submitted|approved|invoiced|Invoiced|This record is locked\.)$/,
  /^\d+$/,
  /^(net_30|time_materials|fixed_fee|non_billable|project|tasks|people|person|none|project_cost|managers|member|administrator|project_manager|manager|project_creator|estimates_manager|Project|Tasks|People)$/,
]
// Values the corpus may hold that are invented text. Anything else fails.
const invented = [
  /^Sample( |-|$)/,
  /^Invented note\.$/,
  /^1 Fixture Way\nSampleville$/,
  /^[a-z]+@example\.test$/,
  /^https:\/\/example\.test\/avatars\/\d+\.png$/,
  /^\+1 555 01\d\d$/,
  /^SMP-\d+$/,
  /^https:\/\/example\.test\/reference$/,
  /^$/,
]

const leaves = (value: unknown): string[] => {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(leaves)
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(leaves)
  return []
}

describe('harvest v2 corpus anonymisation', () => {
  it('holds only invented strings or structural values', () => {
    const offenders: string[] = []
    for (const { resource, name } of cases) {
      for (const kind of ['input', 'golden'] as const) {
        for (const leaf of leaves(JSON.parse(read(resource, name, kind)))) {
          if (![...structural, ...invented].some((pattern) => pattern.test(leaf)))
            offenders.push(`${resource}/${name}.${kind}: ${JSON.stringify(leaf)}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('refuses a string a real snapshot could hold', () => {
    const accepted = (leaf: string): boolean =>
      [...structural, ...invented].some((pattern) => pattern.test(leaf))
    expect(accepted('Globex Corporation')).toBe(false)
    expect(accepted('person@company.com')).toBe(false)
    expect(accepted('Sample Widgets Ltd')).toBe(true)
  })
})

describe('harvest v2 serializer rules', () => {
  const client = JSON.parse(read('clients', 'active-usd', 'input')) as GeneralResourceRecord

  it('never lets a missing required field through as a guess', () => {
    expect(() => serializeHarvestClient({ ...client, currency: null })).toThrow(/currency/)
  })

  it('rounds decimal hours and money to two places', () => {
    const task = serializeHarvestTask({
      id: 1,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      name: 'Sample Rounding',
      billableByDefault: true,
      isDefault: false,
      isActive: true,
      defaultHourlyRateCents: 1,
    })
    expect(task.default_hourly_rate).toBe(0.01)
  })
})

describe('harvest v2 list parameters and pagination', () => {
  it('maps Harvest parameters onto canonical filters', () => {
    const query = parseHarvestListQuery(
      'projects',
      new URLSearchParams('is_active=false&client_id=101&updated_since=2024-03-09T16:45:30Z&page=2&per_page=50'),
    )
    expect(query.filters).toEqual({
      isActive: false,
      clientId: 101,
      updatedSince: '2024-03-09T16:45:30.000Z',
    })
    expect(query.page).toEqual({ page: 2, perPage: 50 })
  })

  it('defaults to page 1 of 2000 and ignores parameters the resource does not take', () => {
    const query = parseHarvestListQuery('clients', new URLSearchParams('client_id=5&unknown=1'))
    expect(query.filters).toEqual({})
    expect(query.page).toEqual({ page: 1, perPage: 2000 })
  })

  it('refuses malformed parameters with field errors', () => {
    let caught: unknown
    try {
      parseHarvestListQuery('tasks', new URLSearchParams('is_active=yes&updated_since=yesterday&page=0&per_page=2001'))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(NativeApiError)
    expect((caught as NativeApiError).status).toBe(422)
    expect((caught as NativeApiError).fields.map(({ field }) => field)).toEqual([
      'is_active',
      'updated_since',
      'page',
      'per_page',
    ])
  })

  it('builds the Harvest page envelope with links that keep the filters', () => {
    const page = harvestPage('clients', [{ id: 1 }], 5, { page: 2, perPage: 2 }, '/harvest/v2/clients', [
      ['is_active', 'true'],
    ])
    expect(JSON.stringify(page, null, 2)).toBe(
      JSON.stringify(
        {
          clients: [{ id: 1 }],
          per_page: 2,
          total_pages: 3,
          total_entries: 5,
          next_page: 3,
          previous_page: 1,
          page: 2,
          links: {
            first: '/harvest/v2/clients?is_active=true&page=1&per_page=2',
            next: '/harvest/v2/clients?is_active=true&page=3&per_page=2',
            previous: '/harvest/v2/clients?is_active=true&page=1&per_page=2',
            last: '/harvest/v2/clients?is_active=true&page=3&per_page=2',
          },
        },
        null,
        2,
      ),
    )
  })

  it('reports an empty collection as one empty page', () => {
    const page = harvestPage('tasks', [], 0, { page: 1, perPage: 2000 }, '/harvest/v2/tasks')
    expect(page.total_pages).toBe(1)
    expect(page.next_page).toBeNull()
    expect(page.previous_page).toBeNull()
    expect(page.links.next).toBeNull()
  })
})

describe('harvest v2 locale time strings', () => {
  it.each([
    ['00:00', '12:00am'],
    ['00:05', '12:05am'],
    ['01:30', '1:30am'],
    ['08:05', '8:05am'],
    ['11:59', '11:59am'],
    ['12:00', '12:00pm'],
    ['12:45', '12:45pm'],
    ['13:00', '1:00pm'],
    ['17:30', '5:30pm'],
    ['23:59', '11:59pm'],
  ])('renders %s as %s on a 12h clock', (canonical, shown) => {
    expect(harvestClockTime(canonical, '12h')).toBe(shown)
  })

  it('keeps the canonical form on a 24h clock', () => {
    for (const time of ['00:00', '08:05', '12:00', '23:59'])
      expect(harvestClockTime(time, '24h')).toBe(time)
  })

  it('leaves an absent time absent and refuses a time it cannot place', () => {
    expect(harvestClockTime(null, '12h')).toBeNull()
    expect(harvestClockTime(null, '24h')).toBeNull()
    for (const bad of ['8:05', '24:00', '12:60', '12:00:00', ''])
      expect(() => harvestClockTime(bad, '12h')).toThrow(/canonical HH:MM/)
  })

  it('shows start and end in the clock of the context, not the entry', () => {
    const input = JSON.parse(read('time_entries', 'start-end-12h-afternoon', 'input')) as {
      entry: TimeEntryRecord
      context: HarvestTimeEntryContext
    }
    const shown = (clock: '12h' | '24h') =>
      serializeHarvestTimeEntry(input.entry, { ...input.context, clock })
    expect([shown('12h').started_time, shown('12h').ended_time]).toEqual(['8:05am', '5:30pm'])
    expect([shown('24h').started_time, shown('24h').ended_time]).toEqual(['08:05', '17:30'])
  })
})

describe('harvest v2 time entry rules', () => {
  const input = (name: string) =>
    JSON.parse(read('time_entries', name, 'input')) as {
      entry: TimeEntryRecord
      context: HarvestTimeEntryContext
    }

  it('renders both entry modes: hours with no clock times, and clock times with the same hours', () => {
    const duration = input('duration-stopped')
    const stopped = serializeHarvestTimeEntry(duration.entry, duration.context)
    expect([stopped.hours, stopped.started_time, stopped.ended_time]).toEqual([1.5, null, null])
    const running = input('duration-running')
    const timer = serializeHarvestTimeEntry(running.entry, running.context)
    expect([timer.is_running, timer.timer_started_at]).toEqual([true, '2024-03-09T16:15:30Z'])
    const open = input('start-end-12h-running')
    const clockRunning = serializeHarvestTimeEntry(open.entry, open.context)
    expect([clockRunning.is_running, clockRunning.started_time, clockRunning.ended_time]).toEqual([
      true,
      '12:15pm',
      null,
    ])
  })

  it('serializes is_closed and approval_status together', () => {
    const approved = input('invoiced-and-approved')
    const rendered = serializeHarvestTimeEntry(approved.entry, approved.context)
    expect([rendered.is_closed, rendered.approval_status, rendered.is_billed]).toEqual([
      true,
      'approved',
      true,
    ])
    expect(rendered.invoice).toEqual({ id: 701, number: 'SMP-0001' })
  })

  it('renders no money the context withholds, and no invoice state', () => {
    const hidden = input('money-and-invoice-hidden')
    const rendered = serializeHarvestTimeEntry(hidden.entry, hidden.context)
    expect([rendered.billable_rate, rendered.cost_rate]).toEqual([null, null])
    expect([rendered.user_assignment.hourly_rate, rendered.task_assignment.hourly_rate]).toEqual([
      null,
      null,
    ])
    expect([rendered.is_billed, rendered.invoice]).toEqual([null, null])
  })

  it('refuses an entry whose embedded rows are not the rows it names a field of', () => {
    const { entry, context } = input('duration-stopped')
    expect(() =>
      serializeHarvestTimeEntry(entry, { ...context, project: { ...context.project, name: null } }),
    ).toThrow(/name is missing/)
  })
})

describe('harvest v2 project assignments', () => {
  it('embeds every task assignment of the project, active or not', () => {
    const rendered = JSON.parse(read('project_assignments', 'manager-with-task-assignments', 'golden')) as {
      is_project_manager: boolean
      task_assignments: Array<{ id: number; is_active: boolean; task: { name: string } }>
    }
    expect(rendered.is_project_manager).toBe(true)
    expect(rendered.task_assignments.map(({ id, is_active }) => [id, is_active])).toEqual([
      [601, true],
      [602, false],
    ])
  })
})

describe('harvest v2 time entry parameters', () => {
  it('maps Harvest parameters onto the canonical time entry filters', () => {
    const query = parseHarvestTimeEntryQuery(
      new URLSearchParams(
        'user_id=4&client_id=1&project_id=2&task_id=3&is_billed=true&is_running=false&approval_status=approved&external_reference_id=x1&updated_since=2024-03-09T16:45:30Z&from=2024-03-01&to=2024-03-31&page=3&per_page=10&other=1',
      ),
    )
    expect(query.filters).toEqual({
      userId: 4,
      clientId: 1,
      projectId: 2,
      taskId: 3,
      isBilled: true,
      isRunning: false,
      approvalStatus: 'approved',
      externalReferenceId: 'x1',
      updatedSince: '2024-03-09T16:45:30.000Z',
      from: '2024-03-01',
      to: '2024-03-31',
    })
    expect(query.page).toEqual({ page: 3, perPage: 10 })
    expect(query.echo.map(([name]) => name)).toEqual([
      'user_id',
      'client_id',
      'project_id',
      'task_id',
      'is_billed',
      'is_running',
      'approval_status',
      'external_reference_id',
      'updated_since',
      'from',
      'to',
    ])
  })

  it('defaults to no filters and the first page of 2000', () => {
    const query = parseHarvestTimeEntryQuery(new URLSearchParams(''))
    expect(query.filters).toEqual({})
    expect(query.page).toEqual({ page: 1, perPage: 2000 })
  })

  it('refuses malformed parameters, impossible dates and a reversed range', () => {
    const fields = (query: string): string[] => {
      try {
        parseHarvestTimeEntryQuery(new URLSearchParams(query))
      } catch (error) {
        return (error as NativeApiError).fields.map(({ field }) => field)
      }
      return []
    }
    expect(
      fields('user_id=0&client_id=x&is_billed=1&approval_status=draft&from=2024-02-30&page=0'),
    ).toEqual(['user_id', 'client_id', 'is_billed', 'approval_status', 'from', 'page'])
    expect(fields('from=2024-03-31&to=2024-03-01')).toEqual(['to'])
    expect(fields('external_reference_id=')).toEqual(['external_reference_id'])
  })
})
