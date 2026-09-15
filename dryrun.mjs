import BetterSqlite3 from 'better-sqlite3'
import { createContainerDatabase } from './packages/db/dist/adapters.js'
import { backfillBandClaims } from './packages/db/dist/band-claim-backfill.js'
const db = new BetterSqlite3(process.argv[2])
const orm = createContainerDatabase(db)
const money = (c) => '$' + (c/100).toLocaleString('en-US',{minimumFractionDigits:2})
const r = await backfillBandClaims(orm, {
  invoiceIds: [29, 16, 8, 741], projectIds: [3, 4], actorUserId: 1,
  runId: process.argv[3], occurredAt: process.argv[4], recurringInvoiceId: 3,
})
console.log('REHEARSAL — applied =', r.applied)
for (const i of r.invoices) {
  console.log(`  ${i.number} ${i.issueDate} ${i.state.padEnd(5)} ${money(i.amountCents).padStart(12)}`
    + ` -> ${String(i.entryCount).padStart(4)} entries ${(i.seconds/3600).toFixed(2).padStart(9)}h`
    + `  list ${money(i.billableValueCents).padStart(13)}`
    + `  absorbed ${money(i.foregoneBillableCents).padStart(12)}`
    + `  unpriced ${i.entriesWithoutBillableRate}`)
}
const tot = r.invoices.reduce((s,i)=>s+i.entryCount,0)
const hrs = r.invoices.reduce((s,i)=>s+i.seconds,0)/3600
console.log(`  TOTAL ${tot} entries, ${hrs.toFixed(2)}h`)
console.log(`  left unclaimed afterwards: ${r.remainingEntryCount} entries, ${(r.remainingSeconds/3600).toFixed(2)}h`)
db.close()
