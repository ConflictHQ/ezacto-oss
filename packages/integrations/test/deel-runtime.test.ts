import { describe, expect, it } from 'vitest'
import { reconcileTransferLog } from '../src/deel/reconcile.js'
import {
  createDeelSyncRuntime,
  type DeelSyncSource,
  type DeelSyncSummary,
} from '../src/deel/runtime.js'
import {
  timeEntryFingerprint,
  type TransferLogRecord,
  type TransferTimeEntry,
} from '../src/deel/time-sync.js'
import { peoplePageOne, timesheetCreated } from './fixtures/deel-api.js'

/**
 * Issue 103. Every request here is answered from a recorded fixture; nothing
 * reaches Deel and no money moves. The runner is the thing under test, so the
 * storage behind it is an in-memory source with the same contract the
 * database implements (that one is tested against a real migrated database in
 * `@ezacto/db`).
 */

const ana = 7
const byron = 9
const anaFingerprint = (spentDate: string, roundedSeconds: number): string =>
  timeEntryFingerprint({ contractId: 'con_ana_hourly', spentDate, roundedSeconds })

interface Harness {
  source: DeelSyncSource
  log: Map<number, TransferLogRecord>
  runs: { outcome: string; summary: DeelSyncSummary | null }[]
  entries: TransferTimeEntry[]
  requests: { method: string; url: string; body: unknown }[]
  fetch: (request: Request) => Promise<Response>
}

const harness = (options: { rejectTimesheets?: boolean } = {}): Harness => {
  const log = new Map<number, TransferLogRecord>()
  const runs: Harness['runs'] = []
  const entries: TransferTimeEntry[] = []
  const requests: Harness['requests'] = []
  let created = 0
  const source: DeelSyncSource = {
    directory: async () => [
      { userId: ana, emails: [{ address: 'ana.personal@example.test', kind: 'payroll' }] },
      { userId: byron, emails: [{ address: 'byron.personal@example.test', kind: 'payroll' }] },
    ],
    entries: async (window) =>
      entries.filter((entry) => entry.spentDate >= window.from && entry.spentDate <= window.to),
    log: async () => [...log.values()],
    logged: async () =>
      [...log.values()].map((row) => ({
        ...row,
        current: entries.find((entry) => entry.id === row.entryId) ?? null,
      })),
    record: async (record) => {
      if (log.has(record.entryId)) throw new Error('already logged')
      log.set(record.entryId, record)
    },
    beginRun: async () => {
      if (runs.some((run) => run.outcome === 'running')) return null
      runs.push({ outcome: 'running', summary: null })
      return runs.length
    },
    finishRun: async (id, outcome, summary) => {
      runs[id - 1] = { outcome, summary }
    },
  }
  return {
    source,
    log,
    runs,
    entries,
    requests,
    fetch: async (request) => {
      const text = request.method === 'GET' ? null : await request.text()
      requests.push({
        method: request.method,
        url: request.url,
        body: text === null ? null : JSON.parse(text),
      })
      if (request.method === 'GET') return Response.json(peoplePageOne)
      if (options.rejectTimesheets === true) return new Response('{}', { status: 422 })
      created += 1
      return Response.json({
        data: { ...timesheetCreated.data, id: `tms_${String(created).padStart(4, '0')}` },
      })
    },
  }
}

const runtimeFor = (
  h: Harness,
  config: { token?: string; startDate?: string },
  now = '2026-10-19T03:00:00.000Z',
) =>
  createDeelSyncRuntime({
    config,
    source: h.source,
    fetch: h.fetch,
    now: () => new Date(now),
  })

const configured = { token: 'fixture-token', startDate: '2026-09-01' }

describe('Deel sync runtime: fails closed', () => {
  it.each([
    ['no token', { startDate: '2026-09-01' }],
    ['a blank token', { token: '  ', startDate: '2026-09-01' }],
    ['no start date', { token: 'fixture-token' }],
    ['an impossible start date', { token: 'fixture-token', startDate: '2026-02-31' }],
    ['a start date that is not a date', { token: 'fixture-token', startDate: 'last month' }],
  ])('does nothing with %s', async (_label, config) => {
    const h = harness()
    h.entries.push({ id: 1, userId: ana, spentDate: '2026-09-02', roundedSeconds: 3_600 })
    const runtime = runtimeFor(h, config)

    expect(runtime.status().configured).toBe(false)
    expect(await runtime.run()).toMatchObject({ status: 'unconfigured' })
    expect(await runtime.reconcile()).toMatchObject({ status: 'unconfigured' })
    expect(h.requests).toEqual([])
    expect(h.runs).toEqual([])
    expect(h.log.size).toBe(0)
  })
})

describe('Deel sync runtime: one timesheet per person-day, once', () => {
  it('[unit] submits a day once, logs it, and a second run sends nothing', async () => {
    const h = harness()
    h.entries.push(
      { id: 1, userId: ana, spentDate: '2026-09-02', roundedSeconds: 3_600 },
      { id: 2, userId: ana, spentDate: '2026-09-02', roundedSeconds: 1_800 },
      { id: 3, userId: ana, spentDate: '2026-09-03', roundedSeconds: 7_200 },
    )
    const runtime = runtimeFor(h, configured)

    const first = await runtime.run()
    expect(first).toMatchObject({
      status: 'completed',
      timesheetsSubmitted: 2,
      entriesTransferred: 3,
    })
    const posts = h.requests.filter((request) => request.method === 'POST')
    expect(posts.map((post) => (post.body as { data: unknown }).data)).toEqual([
      expect.objectContaining({
        contract_id: 'con_ana_hourly',
        date_submitted: '2026-09-02',
        quantity: 1.5,
      }),
      expect.objectContaining({ date_submitted: '2026-09-03', quantity: 2 }),
    ])
    expect(h.log.get(1)).toEqual({
      entryId: 1,
      fingerprint: anaFingerprint('2026-09-02', 3_600),
      timesheetId: 'tms_0001',
    })
    expect(h.log.get(2)?.timesheetId).toBe('tms_0001')

    const second = await runtime.run()
    expect(second).toMatchObject({ status: 'completed', timesheetsSubmitted: 0 })
    expect(h.requests.filter((request) => request.method === 'POST')).toHaveLength(2)
  })

  it('never sends today, or a day before the start date', async () => {
    const h = harness()
    h.entries.push(
      { id: 1, userId: ana, spentDate: '2026-08-31', roundedSeconds: 3_600 },
      { id: 2, userId: ana, spentDate: '2026-10-18', roundedSeconds: 3_600 },
      { id: 3, userId: ana, spentDate: '2026-10-19', roundedSeconds: 3_600 },
    )
    const result = await runtimeFor(h, configured).run()

    expect(result).toMatchObject({ status: 'completed', entriesTransferred: 1 })
    expect([...h.log.keys()]).toEqual([2])
  })

  it('reports an edited entry as a conflict and sends nothing for it', async () => {
    const h = harness()
    h.entries.push({ id: 1, userId: ana, spentDate: '2026-09-02', roundedSeconds: 3_600 })
    const runtime = runtimeFor(h, configured)
    await runtime.run()

    h.entries[0] = { id: 1, userId: ana, spentDate: '2026-09-02', roundedSeconds: 5_400 }
    const again = await runtime.run()

    expect(again).toMatchObject({ status: 'completed', timesheetsSubmitted: 0 })
    expect(again.status === 'completed' && again.reconciliation?.edited).toEqual([
      {
        entryId: 1,
        timesheetId: 'tms_0001',
        transferredFingerprint: anaFingerprint('2026-09-02', 3_600),
        currentFingerprint: anaFingerprint('2026-09-02', 5_400),
      },
    ])
    expect(h.requests.filter((request) => request.method === 'POST')).toHaveLength(1)
    const detail = h.runs.at(-1)?.summary?.detail as { conflicts: { entryId: number }[] }
    expect(detail.conflicts.map((conflict) => conflict.entryId)).toEqual([1])
  })

  it('a rejected submission writes no log record and is retried by the next run', async () => {
    const rejecting = harness({ rejectTimesheets: true })
    rejecting.entries.push({ id: 1, userId: ana, spentDate: '2026-09-02', roundedSeconds: 3_600 })

    const failed = await runtimeFor(rejecting, configured).run()

    expect(failed).toMatchObject({ status: 'failed', entriesTransferred: 0 })
    expect(rejecting.log.size).toBe(0)
    expect(rejecting.runs[0]?.outcome).toBe('failed')

    // The same entry, now accepted: sent once.
    const accepting = harness()
    accepting.entries.push(...rejecting.entries)
    expect(await runtimeFor(accepting, configured).run()).toMatchObject({
      status: 'completed',
      entriesTransferred: 1,
    })
  })

  it('reports people it could not match instead of skipping them', async () => {
    const h = harness()
    h.entries.push({ id: 1, userId: 99, spentDate: '2026-09-02', roundedSeconds: 3_600 })

    const result = await runtimeFor(h, configured).run()

    expect(result).toMatchObject({ status: 'completed', entriesTransferred: 0 })
    const detail = h.runs[0]?.summary?.detail as { unsyncable: { reason: string }[] }
    expect(detail.unsyncable).toEqual([
      { entryId: 1, userId: 99, reason: 'no_contract_match' },
    ])
    expect(h.requests.filter((request) => request.method === 'POST')).toEqual([])
  })

  it('refuses to start while another run holds the lock', async () => {
    const h = harness()
    h.runs.push({ outcome: 'running', summary: null })

    expect(await runtimeFor(h, configured).run()).toEqual({ status: 'busy' })
    expect(h.requests).toEqual([])
  })

  it('records a failure of the people listing and releases the lock', async () => {
    const h = harness()
    const runtime = createDeelSyncRuntime({
      config: configured,
      source: h.source,
      fetch: async () => new Response('{}', { status: 503 }),
      now: () => new Date('2026-10-19T03:00:00.000Z'),
    })

    const result = await runtime.run()

    expect(result).toMatchObject({
      status: 'failed',
      error: 'Deel request failed with status 503',
    })
    expect(h.runs[0]?.outcome).toBe('failed')
  })
})

describe('transfer log reconciliation', () => {
  const matches = [
    {
      userId: ana,
      payrollEmail: 'ana.personal@example.test',
      personId: 'per_ana',
      contractId: 'con_ana_hourly',
    },
  ]
  const logged = (entryId: number, seconds: number) => ({
    entryId,
    fingerprint: anaFingerprint('2026-09-02', seconds),
    timesheetId: `tms_${entryId}`,
  })

  it('confirms matching rows and names edited, removed and unmatched ones', () => {
    const report = reconcileTransferLog({
      matches,
      logged: [
        {
          ...logged(1, 3_600),
          current: { id: 1, userId: ana, spentDate: '2026-09-02', roundedSeconds: 3_600 },
        },
        {
          ...logged(2, 3_600),
          current: { id: 2, userId: ana, spentDate: '2026-09-02', roundedSeconds: 1_800 },
        },
        { ...logged(3, 3_600), current: null },
        {
          ...logged(4, 3_600),
          current: { id: 4, userId: byron, spentDate: '2026-09-02', roundedSeconds: 3_600 },
        },
      ],
    })

    expect(report.confirmed).toBe(1)
    expect(report.edited.map((row) => row.entryId)).toEqual([2])
    expect(report.removed).toEqual([{ entryId: 3, timesheetId: 'tms_3' }])
    expect(report.unmatched).toEqual([{ entryId: 4, timesheetId: 'tms_4', userId: byron }])
  })

  it('treats a moved date as an edit', () => {
    const report = reconcileTransferLog({
      matches,
      logged: [
        {
          ...logged(1, 3_600),
          current: { id: 1, userId: ana, spentDate: '2026-09-03', roundedSeconds: 3_600 },
        },
      ],
    })
    expect(report.edited).toHaveLength(1)
  })
})
