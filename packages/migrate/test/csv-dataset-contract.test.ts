import { describe, expect, it } from 'vitest'
import { csvPlanDifference, csvPlanId } from '../src/csv-dataset-contract.js'
import { basePlan, csvDatasetLedgerContract } from './csv-dataset-ledger.contract.js'
import { createFakeCsvDatasetLedger } from './csv-dataset-fake.js'

describe('CSV plan identity', () => {
  it('[unit] is stable for the same plan and ignores exclusion order and repeats', () => {
    expect(csvPlanId(basePlan)).toBe(csvPlanId({ ...basePlan }))
    expect(csvPlanId({ ...basePlan, excludedLines: [2, 9] })).toBe(
      csvPlanId({ ...basePlan, excludedLines: [9, 2, 2] }),
    )
  })

  it.each([
    { fileSha256: '1'.repeat(64) },
    { mappingSha256: '2'.repeat(64) },
    { adapterId: 'toggl' },
    { identityVersion: 2 },
    { exporterZone: 'UTC' },
    { excludedLines: [2] },
    { destinationVersion: 'dest-9' },
    { datasetId: 'other' },
  ])('[unit] changes when %o changes', (change) => {
    expect(csvPlanId({ ...basePlan, ...change })).not.toBe(csvPlanId(basePlan))
  })

  it('[unit] names the first reason two plans differ, and null when none', () => {
    expect(csvPlanDifference(basePlan, { ...basePlan })).toBeNull()
    expect(csvPlanDifference(basePlan, { ...basePlan, destinationVersion: 'x' })).toBe(
      'different_destination',
    )
  })
})

csvDatasetLedgerContract('fake in-memory ledger', () => {
  const fake = createFakeCsvDatasetLedger()
  return fake
})
