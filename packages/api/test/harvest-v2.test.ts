import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GeneralResourceRecord } from '@ezacto/core'
import { describe, expect, it } from 'vitest'
import {
  harvestPage,
  parseHarvestListQuery,
  serializeHarvestClient,
  serializeHarvestProject,
  serializeHarvestTask,
  serializeHarvestUser,
  type HarvestUserContext,
} from '../src/harvest-v2/index.js'
import { ApiError as NativeApiError } from '../src/errors.js'

const corpusRoot = join(import.meta.dirname, 'fixtures', 'harvest-v2')

const render = (resource: string, input: unknown): unknown => {
  if (resource === 'clients') return serializeHarvestClient(input as GeneralResourceRecord)
  if (resource === 'tasks') return serializeHarvestTask(input as GeneralResourceRecord)
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

const resources = ['clients', 'projects', 'tasks', 'users']
const cases = resources.flatMap((resource) =>
  readdirSync(join(corpusRoot, resource))
    .filter((file) => file.endsWith('.input.json'))
    .map((file) => ({ resource, name: file.replace('.input.json', '') })),
)
const read = (resource: string, name: string, kind: 'input' | 'golden'): string =>
  readFileSync(join(corpusRoot, resource, `${name}.${kind}.json`), 'utf8')

describe('harvest v2 golden corpus', () => {
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
  /^(net_30|time_materials|fixed_fee|non_billable|project|tasks|people|none|project_cost|managers|member|administrator|project_manager|manager|project_creator|estimates_manager|Project|Tasks|People)$/,
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
