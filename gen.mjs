import BetterSqlite3 from 'better-sqlite3'
import { writeFileSync } from 'node:fs'
const db = new BetterSqlite3(process.argv[2])
const RUN = 'backfill-das-2026-09-15'
const AT = '2026-09-15T03:00:00.000Z'
const invoices = db.prepare(`SELECT id, number, issue_date AS issueDate FROM invoices
  WHERE id IN (29,16,8,741) ORDER BY issue_date, id`).all()
const taken = new Set(); const lines = []
for (const inv of invoices) {
  const rows = db.prepare(`SELECT id FROM time_entries
    WHERE invoice_id IS NULL AND billable = 1 AND timer_started_at IS NULL
      AND NOT (started_time IS NOT NULL AND ended_time IS NULL)
      AND spent_date <= ? AND project_id IN (3,4)
    ORDER BY spent_date, id`).all(inv.issueDate)
  const fresh = rows.filter((r) => !taken.has(r.id))
  for (const r of fresh) {
    taken.add(r.id)
    lines.push(`INSERT INTO time_entry_claim_backfills (run_id, time_entry_id, invoice_id, recurring_invoice_id, actor_user_id, claimed_at) VALUES ('${RUN}', ${r.id}, ${inv.id}, 3, 1, '${AT}');`)
  }
  console.error(`${inv.number}: ${fresh.length} entries`)
}
// What the band absorbed, exactly as a live generation records it.
for (const inv of invoices) {
  lines.push(`UPDATE invoices SET foregone_billable_cents = max(0, coalesce((SELECT sum(CAST(ROUND(coalesce(e.rounded_seconds, e.seconds) * coalesce(e.billable_rate_cents, 0) / 3600.0) AS INTEGER)) FROM time_entries e WHERE e.invoice_id = invoices.id), 0) - invoices.amount_cents) WHERE id = ${inv.id};`)
}
writeFileSync(process.argv[3], lines.join('\n') + '\n')
console.error('statements:', lines.length)
db.close()
