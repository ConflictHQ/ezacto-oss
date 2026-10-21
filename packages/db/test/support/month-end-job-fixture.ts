import { sql } from 'drizzle-orm'
import {
  executeInvoiceLifecycleCommand,
  type InvoiceStateDatabase,
} from '../../src/invoice-state.js'
export const seedMonthEndJobFixture = async (
  database: InvoiceStateDatabase,
  period = '2026-09',
  now = '2026-10-01T09:00:00.000Z',
) => {
  for (const statement of [
    sql`INSERT OR IGNORE INTO organizations(id,name,currency,timezone,modules,created_at,updated_at)
      VALUES(1,'Scheduled Job Fixture','USD','UTC','{}',${now},${now})`,
    sql`INSERT OR IGNORE INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at)
      VALUES(1,'Admin','One','administrator','[]',${now},${now}),
      (2,'Member','Two','member','[]',${now},${now}),(3,'Admin','Three','administrator','[]',${now},${now})`,
    sql`INSERT INTO clients(id,name,currency,created_at,updated_at)
      VALUES(1,'Month End A','USD',${now},${now}),(2,'Month End B','USD',${now},${now})`,
    sql`INSERT INTO contacts(id,client_id,first_name,email,invoice_recipient_status,created_at,updated_at)
      VALUES(1,1,'Accounts','a@example.test','recipient',${now},${now}),
      (2,2,'Accounts','b@example.test','recipient',${now},${now})`,
    sql`INSERT INTO invoices(id,client_id,number,currency,issue_date,due_date,created_at,updated_at)
      VALUES(1,1,'MONTH-A','USD',${period + '-15'},${period + '-28'},${now},${now}),
      (2,2,'MONTH-B','USD',${period + '-15'},${period + '-28'},${now},${now})`,
    sql`INSERT INTO invoice_line_items(invoice_id,position,kind,description,quantity,unit_price_cents,amount_cents,created_at,updated_at)
      VALUES(1,0,'Service','Advisory',1,10000,10000,${now},${now}),
      (2,0,'Service','Advisory',1,20000,20000,${now},${now})`,
  ])
    await database.run(statement)
  for (const invoiceId of [1, 2])
    await executeInvoiceLifecycleCommand(database, {
      invoiceId,
      commandId: `fixture-send-${invoiceId}`,
      command: 'send',
      actor: { type: 'user', id: 1 },
      authorize: async () => true,
      expectedVersion: 0,
      occurredAt: now,
      messageId: invoiceId,
      eventId: `fixture-sent-${invoiceId}`,
    })
}
