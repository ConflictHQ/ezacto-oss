import { expect, it } from 'vitest'
import { parseCsv } from '../src/csv-contract.js'
import { resolveCsvPlan, type CsvDestinationSnapshot } from '../src/csv-planner.js'

it('keeps new projects in distinct clients when valid names contain path separators', () => {
  const parsed = parseCsv(new TextEncoder().encode(
    'date,person_email,client,project,task,hours\n' +
    '2026-10-25,person@fixture.invalid,A/B,C,Design,1\n' +
    '2026-10-25,person@fixture.invalid,A,B/C,Design,2\n',
  ))
  const snapshot: CsvDestinationSnapshot = {
    organization: { time_entry_mode: 'duration', currency: 'USD' }, stored: null,
    emails: [{ email: 'person@fixture.invalid', user_id: 7 }], clients: [], projects: [], tasks: [],
    userAssignments: [], taskAssignments: [], submissions: [], importedKeys: [], lockedDates: [],
  }
  const plan = resolveCsvPlan(parsed, snapshot, { sourceId: 'fixture-source' })
  expect(plan.report.fileErrors).toEqual([])
  expect(plan.report.entries.new).toBe(2)
  expect(plan.report.clients.new).toBe(2)
  expect(plan.report.projects.new).toBe(2)
  expect(plan.items[0]!.project).not.toBe(plan.items[1]!.project)
  expect(plan.items[0]!.project!.parent!.name).toBe('A/B')
  expect(plan.items[1]!.project!.parent!.name).toBe('A')
  expect(plan.items[0]!.project!.name).toBe('C')
  expect(plan.items[1]!.project!.name).toBe('B/C')
})
