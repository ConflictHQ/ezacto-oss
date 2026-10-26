import { expect, it, vi } from 'vitest'
import { createDeelStagingRuntime, type DeelStageStore } from '../src/deel/staging.js'

const previewWithDirectory = async (directory: unknown[]) => {
  const store: DeelStageStore = {
    snapshot: vi.fn(async () => ({
      directory: [{ userId: 7, emails: [{ kind: 'payroll' as const, address: 'ana@example.test' }] }],
      entries: [{ id: 11, userId: 7, spentDate: '2026-10-01', roundedSeconds: 3600 }],
      log: [], unresolved: [], sourceFacts: 'approved source revision',
    })),
    lookup: vi.fn(), begin: vi.fn(), claim: vi.fn(), record: vi.fn(),
    release: vi.fn(), finish: vi.fn(),
  }
  const requests: Request[] = []
  const runtime = createDeelStagingRuntime({
    token: 'deel-token-for-tests', startDate: '2026-10-01', store,
    now: () => new Date('2026-10-26T00:00:00Z'),
    fetch: async (request) => {
      requests.push(request)
      expect(request.method).toBe('GET')
      expect(new URL(request.url).pathname).toBe('/rest/people')
      return Response.json({ data: directory })
    },
  })
  const preview = await runtime.preview(
    { userId: 1, sessionId: 1 },
    { userIds: [7], from: '2026-10-01', to: '2026-10-25' },
  )
  expect(requests).toHaveLength(1)
  expect(store.snapshot).toHaveBeenCalledTimes(2)
  for (const write of [store.begin, store.claim, store.record, store.release, store.finish])
    expect(write).not.toHaveBeenCalled()
  return preview
}
const remotePerson = (id: string, emails: unknown[]) => ({
  id, full_name: 'Ana', emails,
  employments: [{ id: `contract_${id}`, contract_status: 'in_progress' }],
})

it('previews the selected verified payroll address despite an unrelated email-less Deel person', async () => {
  const result = await previewWithDirectory([
    remotePerson('unrelated', [{ value: null }, {}, { value: '  ' }]),
    remotePerson('selected', [{ value: null }, { value: ' ANA@EXAMPLE.TEST ' }]),
  ])
  expect(result.people).toEqual([{ userId: 7, contractId: 'contract_selected', seconds: 3600, entries: 1 }])
  expect(result.entryIds).toEqual([11])
  expect(result.unmatched).toEqual([])
})

it('leaves an email-less same-name person unmatched rather than choosing their contract', async () => {
  const result = await previewWithDirectory([remotePerson('same_name', [{ value: null }])])
  expect(result.people[0]!.contractId).toBeNull()
  expect(result.entryIds).toEqual([])
  expect(result.unmatched).toEqual([{ userId: 7, reason: 'no_deel_person' }])
})

it('preserves ambiguity across valid addresses alongside absent email values', async () => {
  const result = await previewWithDirectory([
    remotePerson('first', [{ value: null }, { value: 'ana@example.test' }]),
    remotePerson('second', [{}, { value: 'ANA@EXAMPLE.TEST' }]),
  ])
  expect(result.people[0]!.contractId).toBeNull()
  expect(result.entryIds).toEqual([])
  expect(result.unmatched).toEqual([{ userId: 7, reason: 'ambiguous_deel_person' }])
})

it('skips zero-duration rows while staging matching positive rows', async () => {
  const submissions: unknown[] = []
  const store: DeelStageStore = {
    snapshot: vi.fn(async () => ({
      directory: [{ userId: 7, emails: [{ kind: 'payroll' as const, address: 'ana@example.test' }] }],
      entries: [
        { id: 11, userId: 7, spentDate: '2026-10-01', roundedSeconds: 3600 },
        { id: 12, userId: 7, spentDate: '2026-10-01', roundedSeconds: 0 },
        { id: 13, userId: 7, spentDate: '2026-10-01', roundedSeconds: 1800 },
      ],
      log: [{
        entryId: 13,
        fingerprint: 'contract_selected:2026-10-01:1800',
        timesheetId: 'timesheet_existing',
      }],
      unresolved: [], sourceFacts: 'approved source revision',
    })),
    lookup: vi.fn(async () => null),
    begin: vi.fn(async () => 1), claim: vi.fn(async () => true),
    record: vi.fn(async () => undefined), release: vi.fn(async () => undefined),
    finish: vi.fn(async () => undefined),
  }
  const runtime = createDeelStagingRuntime({
    token: 'test', startDate: '2026-10-01', store,
    now: () => new Date('2026-10-26T00:00:00Z'),
    fetch: async () => Response.json({ data: [remotePerson('selected', [{ value: 'ana@example.test' }])] }),
    client: {
      listPeople: async () => [{
        id: 'selected', fullName: 'Ana', emails: ['ana@example.test'],
        contracts: [{ id: 'contract_selected', status: 'in_progress' }],
      }],
      createTimesheet: async (input) => {
        submissions.push(input)
        return { timesheetId: 'timesheet_1' }
      },
    },
  })
  const authority = { userId: 1, sessionId: 1 }
  const selection = { userIds: [7], from: '2026-10-01', to: '2026-10-25' }
  const preview = await runtime.preview(authority, selection)
  expect(preview.entryIds).toEqual([11])
  expect(preview.zeroDurationEntryIds).toEqual([12])
  expect(preview.alreadyStagedEntryIds).toEqual([13])
  expect(preview.unsyncable).toEqual([])
  const result = await runtime.stage(authority, {
    ...selection,
    id: '123e4567-e89b-42d3-a456-426614174000',
    fingerprint: preview.fingerprint,
  })
  expect(result.status).toBe('staged')
  expect(result.entriesStaged).toBe(1)
  expect(submissions).toHaveLength(1)
  expect(submissions[0]).toMatchObject({ quantityHours: 1 })
  expect(store.claim).toHaveBeenCalledWith(
    authority,
    1,
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ entries: [expect.objectContaining({ entryId: 11 })] }),
    expect.any(String),
  )
})
