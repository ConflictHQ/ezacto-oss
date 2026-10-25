import { CsvBrowserPlannerError, assertCsvExporterZone } from '../src/csv-browser-errors.js'
import { expect, it } from 'vitest'
import { parseCsv } from '../src/csv-contract.js'
import { parseMapping, canonicalMapping } from '../src/csv-mapping.js'
import {
  parseBrowserMapping,
  csvSourceEntityKeys,
  assertBrowserMappingSources,
} from '../src/csv-browser-mapping.js'
import { resolveCsvPlan, type CsvDestinationSnapshot } from '../src/csv-planner.js'
const parsed = parseCsv(
  new TextEncoder().encode(
    'date,person_email,client,project,task,hours\n2026-09-01,person@fixture.invalid,Source,Project,General,1\n',
  ),
)
const keys = csvSourceEntityKeys(parsed.rows[0]!)
const snapshot: CsvDestinationSnapshot = {
  organization: { currency: 'EUR', time_entry_mode: 'duration' },
  stored: null,
  knownUserIds: [7],
  emails: [],
  clients: [
    { id: 1, name: 'Target', is_active: 1, currency: 'EUR' },
    { id: 2, name: 'Target', is_active: 1, currency: 'EUR' },
  ],
  projects: [
    { id: 11, client_id: 1, name: 'Project', is_active: 1 },
    { id: 22, client_id: 2, name: 'Project', is_active: 1 },
  ],
  tasks: [
    { id: 1, name: 'General', is_active: 1, billable_by_default: 1 },
    { id: 2, name: 'General', is_active: 1, billable_by_default: 1 },
  ],
  userAssignments: [],
  taskAssignments: [],
  submissions: [],
  importedKeys: [],
  lockedDates: [],
}
const mappingText = () =>
  JSON.stringify({
    destinationIds: {
      people: { [keys.people]: 7 },
      clients: { [keys.clients]: 2 },
      projects: { [keys.projects]: 22 },
      tasks: { [keys.tasks]: 2 },
    },
  })
it('[#1180] selects exact existing IDs among ambiguous names without changing CLI mapping interpretation', () => {
  const mapping = parseBrowserMapping(mappingText())
  const plan = resolveCsvPlan(parsed, snapshot, {
    sourceId: 'owned',
    mapping,
    destinationIds: mapping.destinationIds,
  })
  expect(plan.report.entries).toMatchObject({ new: 1, rejected: 0 })
  expect(plan.items[0]).toMatchObject({
    person: { id: 7 },
    client: { id: 2 },
    project: { id: 22 },
    task: { id: 2 },
  })
  expect(plan.report.clients.new + plan.report.projects.new + plan.report.tasks.new).toBe(0)
  expect(() => parseMapping(mappingText())).toThrow()
  expect(canonicalMapping(mapping).sha256).not.toBe(
    canonicalMapping(parseBrowserMapping('{}')).sha256,
  )
})
it('[#1180] rejects a selected project under a different client and nonexistent IDs without creating replacements', () => {
  const mapping = parseBrowserMapping(mappingText())
  mapping.destinationIds!.projects[keys.projects] = 11
  const wrongParent = resolveCsvPlan(parsed, snapshot, {
    sourceId: 'owned',
    mapping,
    destinationIds: mapping.destinationIds,
  })
  expect(wrongParent.report.entries.rejected).toBe(1)
  expect(wrongParent.report.rejected.some((issue) => issue.code === 'project_not_found')).toBe(true)
  expect(wrongParent.report.projects.new).toBe(0)
  mapping.destinationIds!.people[keys.people] = 999
  const absent = resolveCsvPlan(parsed, snapshot, {
    sourceId: 'owned',
    mapping,
    destinationIds: mapping.destinationIds,
  })
  expect(absent.report.rejected.some((issue) => issue.code === 'person_not_found')).toBe(true)
})
it('[#1180] keeps parent-scoped General task choices distinct and refuses unknown source keys', () => {
  expect(csvSourceEntityKeys({ ...parsed.rows[0]!, client: 'Other' }).tasks).not.toBe(keys.tasks)
  const mapping = parseBrowserMapping(mappingText())
  mapping.destinationIds!.tasks['f'.repeat(64)] = 1
  expect(() => assertBrowserMappingSources(mapping, parsed.rows)).toThrow('mapping_source_unknown')
})
it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '2'])(
  '[#1180] refuses invalid explicit IDs: %j',
  (id) => {
    expect(() =>
      parseBrowserMapping(JSON.stringify({ destinationIds: { clients: { [keys.clients]: id } } })),
    ).toThrow('mapping_invalid')
  },
)

it('[#1180] exposes typed static input refusals without echoing private mapping or zone text',()=>{
  for(const operation of [()=>parseBrowserMapping('{"PRIVATE_MAPPING_SENTINEL":'),()=>assertCsvExporterZone('PRIVATE_ZONE_SENTINEL')]) {
    try {operation();throw new Error('expected refusal')} catch(error) {
      expect(error).toBeInstanceOf(CsvBrowserPlannerError)
      expect((error as Error).message).not.toContain('PRIVATE_')
    }
  }
})
