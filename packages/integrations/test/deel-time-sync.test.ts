import { describe, expect, it } from 'vitest'
import type { ContractMatch } from '../src/deel/matching.js'
import {
  planTimeTransfer,
  submitTransferPlan,
  timeEntryFingerprint,
  type TransferLogRecord,
} from '../src/deel/time-sync.js'

const matches: readonly ContractMatch[] = [
  {
    userId: 7,
    payrollEmail: 'ana.personal@example.test',
    personId: 'per_ana',
    contractId: 'con_ana_hourly',
  },
  {
    userId: 9,
    payrollEmail: 'byron.personal@example.test',
    personId: 'per_byron',
    contractId: 'con_byron_hourly',
  },
]

const entry = (id: number, userId: number, spentDate: string, roundedSeconds: number) => ({
  id,
  userId,
  spentDate,
  roundedSeconds,
})

describe('Deel time transfer planning', () => {
  it('[unit] the same hours cannot transfer twice: a logged entry is skipped, its neighbours are not', () => {
    const transferred = entry(1, 7, '2026-08-14', 3_600)
    const log: readonly TransferLogRecord[] = [
      {
        entryId: 1,
        fingerprint: timeEntryFingerprint({
          contractId: 'con_ana_hourly',
          spentDate: '2026-08-14',
          roundedSeconds: 3_600,
        }),
        timesheetId: 'tms_0001',
      },
    ]

    const plan = planTimeTransfer({
      entries: [transferred, entry(2, 7, '2026-08-14', 1_800)],
      matches,
      log,
    })

    expect(plan.alreadyTransferred).toEqual([{ entryId: 1, timesheetId: 'tms_0001' }])
    expect(plan.submissions).toEqual([
      {
        contractId: 'con_ana_hourly',
        userId: 7,
        spentDate: '2026-08-14',
        roundedSeconds: 1_800,
        quantityHours: 0.5,
        entries: [
          {
            entryId: 2,
            fingerprint: 'con_ana_hourly:2026-08-14:1800',
          },
        ],
      },
    ])
    expect(plan.conflicts).toEqual([])
  })

  it('[unit] re-running with nothing new produces no submissions at all', () => {
    const entries = [entry(1, 7, '2026-08-14', 3_600), entry(2, 9, '2026-08-15', 5_400)]
    const log = entries.map((row, index) => ({
      entryId: row.id,
      fingerprint: timeEntryFingerprint({
        contractId: index === 0 ? 'con_ana_hourly' : 'con_byron_hourly',
        spentDate: row.spentDate,
        roundedSeconds: row.roundedSeconds,
      }),
      timesheetId: `tms_000${index + 1}`,
    }))

    expect(planTimeTransfer({ entries, matches, log }).submissions).toEqual([])
  })

  it('[unit] an entry edited after its transfer is a conflict, never a second transfer', () => {
    const log: readonly TransferLogRecord[] = [
      {
        entryId: 1,
        fingerprint: 'con_ana_hourly:2026-08-14:3600',
        timesheetId: 'tms_0001',
      },
    ]

    const plan = planTimeTransfer({
      entries: [entry(1, 7, '2026-08-14', 7_200)],
      matches,
      log,
    })

    expect(plan.submissions).toEqual([])
    expect(plan.conflicts).toEqual([
      {
        entryId: 1,
        timesheetId: 'tms_0001',
        transferredFingerprint: 'con_ana_hourly:2026-08-14:3600',
        currentFingerprint: 'con_ana_hourly:2026-08-14:7200',
      },
    ])
  })

  it('[unit] groups one person-day into a single submission and rounds hours half-up to four places', () => {
    const plan = planTimeTransfer({
      entries: [entry(3, 7, '2026-08-14', 3_600), entry(4, 7, '2026-08-14', 1_234)],
      matches,
      log: [],
    })

    expect(plan.submissions).toEqual([
      {
        contractId: 'con_ana_hourly',
        userId: 7,
        spentDate: '2026-08-14',
        roundedSeconds: 4_834,
        quantityHours: 1.3428,
        entries: [
          { entryId: 3, fingerprint: 'con_ana_hourly:2026-08-14:3600' },
          { entryId: 4, fingerprint: 'con_ana_hourly:2026-08-14:1234' },
        ],
      },
    ])
  })

  it('[unit] reports the entries it cannot send rather than quietly totalling the rest', () => {
    const plan = planTimeTransfer({
      entries: [
        entry(5, 7, '2026-08-14', -1_800),
        entry(6, 99, '2026-08-14', 3_600),
        entry(7, 7, '2026-08-15', 3_600),
      ],
      matches,
      log: [],
    })

    expect(plan.unsyncable).toEqual([
      { entryId: 5, userId: 7, reason: 'non_positive_seconds' },
      { entryId: 6, userId: 99, reason: 'no_contract_match' },
    ])
    expect(plan.submissions.map((submission) => submission.spentDate)).toEqual(['2026-08-15'])
  })

  it('[unit] refuses a batch that carries the same entry id twice', () => {
    expect(() =>
      planTimeTransfer({
        entries: [entry(8, 7, '2026-08-14', 3_600), entry(8, 7, '2026-08-15', 3_600)],
        matches,
        log: [],
      }),
    ).toThrow(/time entry id/i)
  })
})

describe('Deel time transfer submission', () => {
  const plan = planTimeTransfer({
    entries: [entry(1, 7, '2026-08-14', 3_600), entry(2, 9, '2026-08-14', 5_400)],
    matches,
    log: [],
  })

  it('[unit] writes one transfer-log record per entry in a submission Deel accepted', async () => {
    const sent: unknown[] = []
    const result = await submitTransferPlan({
      plan,
      client: {
        createTimesheet: async (input) => {
          sent.push(input)
          return { timesheetId: `tms_${sent.length}` }
        },
      },
    })

    expect(sent).toEqual([
      {
        contractId: 'con_ana_hourly',
        spentDate: '2026-08-14',
        quantityHours: 1,
        description: 'ezacto time sync 2026-08-14',
      },
      {
        contractId: 'con_byron_hourly',
        spentDate: '2026-08-14',
        quantityHours: 1.5,
        description: 'ezacto time sync 2026-08-14',
      },
    ])
    expect(result.records).toEqual([
      { entryId: 1, fingerprint: 'con_ana_hourly:2026-08-14:3600', timesheetId: 'tms_1' },
      { entryId: 2, fingerprint: 'con_byron_hourly:2026-08-14:5400', timesheetId: 'tms_2' },
    ])
    expect(result.failed).toEqual([])
  })

  it('[unit] a rejected submission writes no record, so the next run retries only it', async () => {
    const result = await submitTransferPlan({
      plan,
      client: {
        createTimesheet: async (input) => {
          if (input.contractId === 'con_ana_hourly') throw new Error('Deel said 422')
          return { timesheetId: 'tms_2' }
        },
      },
    })

    expect(result.records).toEqual([
      { entryId: 2, fingerprint: 'con_byron_hourly:2026-08-14:5400', timesheetId: 'tms_2' },
    ])
    expect(result.failed).toEqual([
      {
        contractId: 'con_ana_hourly',
        spentDate: '2026-08-14',
        entryIds: [1],
        reason: 'Deel said 422',
      },
    ])
  })
})
