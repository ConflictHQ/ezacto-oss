import { expect, it } from 'vitest'
import { assertD1CsvPlanBudget, D1_CSV_MAX_SEAL_BYTES } from '../src/csv-browser-d1.js'
import type { CsvPlanInput } from '@ezacto/core'
const plan=():CsvPlanInput=>({datasetId:'browser:'+'a'.repeat(56),fileSha256:'b'.repeat(64),mappingSha256:'c'.repeat(64),adapterId:'clockify-detailed-browser@2',identityVersion:2,dateFormat:'iso',exporterZone:'UTC',fileRows:50000,selectedRows:0,excludedLines:Array.from({length:50000},(_,i)=>i+2),destinationVersion:'d1:123',destinationFacts:JSON.stringify({kind:'d1-revision@1',initial_revision:123})})
it('keeps maximum contracted row/exclusion metadata safely below the D1 row budget',()=>{
  const bytes=assertD1CsvPlanBudget(plan())
  expect(bytes).toBeLessThan(400000)
  expect(D1_CSV_MAX_SEAL_BYTES).toBeLessThan(2_000_000)
})
it('refuses oversized native seal metadata before confirmation rather than at D1 insertion',()=>{
  expect(()=>assertD1CsvPlanBudget({...plan(),destinationFacts:'x'.repeat(D1_CSV_MAX_SEAL_BYTES)})).toThrow('snapshot_budget_exceeded')
})
