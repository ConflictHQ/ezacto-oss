import { createFakeApplyStore } from './csv-apply-fake.js'
import { describeApplyContract } from './csv-apply-suite.js'

describeApplyContract('in-memory reference store', () => {
  const store = createFakeApplyStore()
  return { store, failNext: store.failNext, entryCount: () => store.keys.size }
})
