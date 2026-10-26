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
