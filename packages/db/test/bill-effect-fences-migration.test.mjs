import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'vitest'
import { billEffectFencesMigration } from '../src/migrations/0188_bill_effect_fences.ts'

const fixture = () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE clients(id INTEGER PRIMARY KEY,name TEXT NOT NULL);
    CREATE TABLE contacts(id INTEGER PRIMARY KEY,client_id INTEGER,email TEXT,invoice_recipient_status TEXT);
    CREATE TABLE invoices(id INTEGER PRIMARY KEY,client_id INTEGER,number TEXT,currency TEXT,issue_date TEXT,due_date TEXT,subject TEXT,amount_cents INTEGER,due_amount_cents INTEGER);
    CREATE TABLE invoice_line_items(id INTEGER PRIMARY KEY,invoice_id INTEGER,position INTEGER,description TEXT,quantity REAL,unit_price_cents INTEGER,amount_cents INTEGER);
    CREATE TABLE bill_managed_connection(singleton INTEGER PRIMARY KEY,generation INTEGER,status TEXT,sealed_credential TEXT);
    CREATE TABLE bill_links(kind TEXT,ezacto_id INTEGER,bill_id TEXT,PRIMARY KEY(kind,ezacto_id));
    INSERT INTO clients VALUES(1,'Owned'),(2,'Other');
    INSERT INTO contacts VALUES(1,1,'owned@example.test','recipient');
    INSERT INTO invoices VALUES(1,1,'INV-1','USD','2026-01-01','2026-02-01','Work',100,100),(2,2,'INV-2','USD','2026-01-01','2026-02-01','Other',200,200);
    INSERT INTO invoice_line_items VALUES(1,1,0,'Work',1,100,100),(2,2,0,'Other',1,200,200);
    INSERT INTO bill_managed_connection VALUES(1,1,'configured','sealed');`)
  for (const statement of billEffectFencesMigration) db.exec(statement)
  const id = '11111111-1111-4111-8111-111111111111', owner = '22222222-2222-4222-8222-222222222222'
  db.prepare("INSERT INTO bill_effect_fences VALUES(?,?,?,?,?,?,?,?,?)").run(id, owner, 1, 1, 1, 'invoice-create', 'a'.repeat(64), 'held', '2026-01-01T00:00:00.000Z')
  return { db, id }
}

test('holds only the native fields used by the provider request', () => {
  const { db, id } = fixture()
  try {
    for (const statement of ["UPDATE invoices SET number='changed' WHERE id=1", "UPDATE invoice_line_items SET amount_cents=101 WHERE id=1",
      "INSERT INTO invoice_line_items VALUES(3,1,1,'New',1,1,1)", "DELETE FROM invoice_line_items WHERE id=1",
      "UPDATE clients SET name='Changed' WHERE id=1", "UPDATE contacts SET email='changed@example.test' WHERE id=1",
      "INSERT INTO contacts VALUES(2,1,'other@example.test','recipient')", "DELETE FROM contacts WHERE id=1"]) {
      assert.throws(() => db.exec(statement), /bill_effect_source_held/)
    }
    db.exec("INSERT INTO bill_links VALUES('customer',1,'0cu1'),('invoice',1,'00e1'),('invoice',2,'00e2')")
    assert.throws(() => db.exec("DELETE FROM bill_links WHERE kind='customer' AND ezacto_id=1"), /bill_effect_source_held/)
    assert.throws(() => db.exec("DELETE FROM bill_links WHERE kind='invoice' AND ezacto_id=1"), /bill_effect_source_held/)
    db.exec("DELETE FROM bill_links WHERE kind='invoice' AND ezacto_id=2")
    db.exec("UPDATE invoices SET amount_cents=101,due_amount_cents=99 WHERE id=1; UPDATE clients SET name='Other changed' WHERE id=2")
    assert.deepEqual({ ...db.prepare('SELECT amount_cents,due_amount_cents FROM invoices WHERE id=1').get() }, { amount_cents: 101, due_amount_cents: 99 })
    db.prepare("UPDATE bill_effect_fences SET state='released' WHERE effect_id=?").run(id)
    db.exec("UPDATE invoices SET number='changed' WHERE id=1; UPDATE contacts SET email='changed@example.test' WHERE id=1")
  } finally { db.close() }
})

test('requires exact connection and immutable retained ownership', () => {
  const { db, id } = fixture()
  try {
    assert.throws(() => db.prepare('UPDATE bill_effect_fences SET owner_id=? WHERE effect_id=?').run('33333333-3333-4333-8333-333333333333', id), /bill_effect_fence_immutable/)
    assert.throws(() => db.prepare('DELETE FROM bill_effect_fences WHERE effect_id=?').run(id), /bill_effect_fence_retained/)
    assert.throws(() => db.prepare('INSERT INTO bill_effect_fences VALUES(?,?,?,?,?,?,?,?,?)').run('33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444', 2, 2, 2, 'invoice-create', 'b'.repeat(64), 'held', '2026-01-01T00:00:00.000Z'), /bill_effect_fence_invalid/)
  } finally { db.close() }
})
