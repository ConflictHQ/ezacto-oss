import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'
import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { sql } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { createContainerSessionStore, createD1SessionStore } from '../src/sessions.js'
import {
  createBankDepositReviewService,
  createBankDepositIngestionService,
} from '../src/bank-deposit-review.js'
import {
  executeInvoiceLifecycleCommand,
  recordInvoicePayment,
  deleteInvoicePayment,
} from '../src/invoice-state.js'
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(closers.splice(0).map((f) => f()))
})
const setup = async (kind: 'sqlite' | 'd1') => {
  const sqlite = kind === 'sqlite' ? new BetterSqlite3(':memory:') : null
  const mf = sqlite
    ? null
    : new Miniflare({
        modules: true,
        script: 'export default {fetch(){return new Response("ok")}}',
        d1Databases: ['DB'],
      })
  const raw = mf ? await mf.getD1Database('DB') : null
  if (sqlite) migrateContainer(sqlite)
  else await migrateD1(raw!)
  closers.push(async () => {
    sqlite?.close()
    await mf?.dispose()
  })
  const db = sqlite ? createContainerDatabase(sqlite) : createD1Database(raw!),
    now = new Date().toISOString()
  await db.run(
    sql`INSERT INTO organizations(name,modules,created_at,updated_at) VALUES('Owned','{}',${now},${now})`,
  )
  await db.run(
    sql`INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(1,'Owner','Owned','administrator','[]',${now},${now}),(2,'Reviewer','Owned','accounting','[]',${now},${now}),(3,'Member','Owned','member','[]',${now},${now})`,
  )
  await db.run(
    sql`INSERT INTO clients(id,name,currency,created_at,updated_at) VALUES(1,'Owned','USD',${now},${now})`,
  )
  for (const id of [1, 2]) {
    await db.run(
      sql`INSERT INTO invoices(id,client_id,number,currency,issue_date,due_date,payment_options,created_at,updated_at) VALUES(${id},1,${'OWNED-' + id},'USD',${now.slice(0, 10)},${now.slice(0, 10)},'["mercury_transfer"]',${now},${now})`,
    )
    await db.run(
      sql`INSERT INTO invoice_line_items(invoice_id,position,kind,description,quantity,unit_price_cents,amount_cents,created_at,updated_at) VALUES(${id},0,'Service','Owned',1,10000,10000,${now},${now})`,
    )
    await executeInvoiceLifecycleCommand(db, {
      invoiceId: id,
      commandId: 'send-' + id,
      command: 'send',
      actor: { type: 'user', id: 1 },
      authorize: async () => true,
      expectedVersion: 0,
      occurredAt: now,
      messageId: id,
      eventId: 'sent-' + id,
    })
  }
  const sessions = sqlite ? createContainerSessionStore(sqlite) : createD1SessionStore(raw!),
    session = (await sessions.issue(2)).session
  const who = { userId: 2, sessionId: String(session.id) },
    service = createBankDepositReviewService(db)
  const account = await service.createAccount(who, {
    command_id: 'account',
    provider: 'mercury',
    name: 'Owned checking',
  })
  const reference = (
    await db.all<{ reference_token: string }>(sql`SELECT reference_token FROM invoices WHERE id=1`)
  )[0]!.reference_token
  const entry = {
    provider_transaction_id: 'owned_credit',
    currency: 'USD',
    posted_at: now,
    amount_cents: 10000,
    memo: reference,
    counterparty: 'Owned client',
  }
  return { db, service, who, account, entry, sessions, session, now }
}
for (const kind of ['sqlite', 'd1'] as const)
  describe(kind + ' bank deposit review', () => {
    it('ingests once, confirms explicitly through the ledger, audits once and payment deletion unconfirms', async () => {
      const f = await setup(kind)
      await f.service.ingest(f.who, {
        command_id: 'import',
        account_id: f.account.id,
        deposits: [f.entry],
        observations: { owned_credit: { status: 'final', classification: 'external_credit' } },
      })
      await f.service.ingest(f.who, {
        command_id: 'import-again',
        account_id: f.account.id,
        deposits: [f.entry],
        observations: { owned_credit: { status: 'final', classification: 'external_credit' } },
      })
      const before = await f.service.list(f.who)
      expect(before.data).toHaveLength(1)
      const deposit = before.data[0]!
      expect(deposit.state).toBe('suggested')
      expect(deposit.suggested_invoice?.id).toBe(1)
      expect(await f.db.all(sql`SELECT id FROM invoice_payments`)).toHaveLength(0)
      const command = {
        command_id: 'confirm',
        deposit_id: deposit.id,
        expected_version: deposit.version,
        invoice_id: 1,
        expected_invoice_version: deposit.suggested_invoice!.version,
        confirm_overpayment: false,
      }
      expect((await f.service.confirm(f.who, command))?.state).toBe('confirmed')
      await f.service.confirm(f.who, command)
      expect(await f.db.all(sql`SELECT id FROM invoice_payments`)).toHaveLength(1)
      expect(
        await f.db.all(sql`SELECT command_id FROM bank_deposit_audit WHERE operation='confirm'`),
      ).toHaveLength(1)
      const invoice = (
        await f.db.all<{ state: string; version: number }>(
          sql`SELECT state,version FROM invoices WHERE id=1`,
        )
      )[0]!
      expect(invoice.state).toBe('paid')
      const payment = (
        await f.db.all<{ id: number; updated_at: string }>(
          sql`SELECT id,updated_at FROM invoice_payments`,
        )
      )[0]!
      await deleteInvoicePayment(f.db, {
        invoiceId: 1,
        commandId: 'delete',
        actor: { type: 'user', id: 1 },
        authorize: async () => true,
        expectedVersion: invoice.version,
        occurredAt: f.now,
        eventIds: ['delete-recorded', 'delete-reopened'],
        paymentId: payment.id,
        expectedPaymentUpdatedAt: payment.updated_at,
      })
      expect((await f.service.list(f.who)).data[0]?.state).toBe('suggested')
    })
    it('does not re-suggest rejected or confirmed rows and refuses changed duplicate source data', async () => {
      const f = await setup(kind)
      await f.service.ingest(f.who, {
        command_id: 'import',
        account_id: f.account.id,
        deposits: [f.entry],
        observations: { owned_credit: { status: 'final', classification: 'external_credit' } },
      })
      const row = (await f.service.list(f.who)).data[0]!
      await f.service.act(f.who, {
        command_id: 'reject',
        deposit_id: row.id,
        expected_version: row.version,
        operation: 'reject',
      })
      await f.service.ingest(f.who, {
        command_id: 'again',
        account_id: f.account.id,
        deposits: [f.entry],
        observations: { owned_credit: { status: 'final', classification: 'external_credit' } },
      })
      expect((await f.service.list(f.who)).data[0]?.state).toBe('rejected')
      await expect(
        f.service.ingest(f.who, {
          command_id: 'changed',
          account_id: f.account.id,
          deposits: [{ ...f.entry, amount_cents: 1 }],
        }),
      ).rejects.toMatchObject({ code: 'conflict' })
      expect((await f.service.list(f.who)).data[0]?.amount_cents).toBe(10000)
    })
    it('manual reassignment is audited; a stale selection and revoked authority cannot confirm', async () => {
      const f = await setup(kind)
      await f.service.ingest(f.who, {
        command_id: 'import',
        account_id: f.account.id,
        deposits: [f.entry],
        observations: { owned_credit: { status: 'final', classification: 'external_credit' } },
      })
      const row = (await f.service.list(f.who)).data[0]!
      const moved = await f.service.act(f.who, {
        command_id: 'assign',
        deposit_id: row.id,
        expected_version: row.version,
        operation: 'assign',
        invoice_id: 2,
      })
      await expect(
        f.service.confirm(f.who, {
          command_id: 'stale',
          deposit_id: row.id,
          expected_version: row.version,
          invoice_id: 1,
          expected_invoice_version: 1,
          confirm_overpayment: false,
        }),
      ).rejects.toMatchObject({ code: 'conflict' })
      await f.sessions.revoke(2, f.session.id)
      await expect(
        f.service.confirm(f.who, {
          command_id: 'revoked',
          deposit_id: row.id,
          expected_version: moved!.version,
          invoice_id: 2,
          expected_invoice_version: 1,
          confirm_overpayment: false,
        }),
      ).rejects.toMatchObject({ code: 'forbidden' })
      expect(await f.db.all(sql`SELECT id FROM invoice_payments`)).toHaveLength(0)
    })
    it('operator verification is distinct from provider finality and later evidence invalidates it', async () => {
      const f = await setup(kind)
      const feed = createBankDepositIngestionService(f.db)
      const account = await feed.ensureAccount({
        provider: 'wise',
        externalAccountId: 'owned_balance_1',
        name: 'Wise owned test',
      })
      const state = await feed.state(account.id)
      await feed.ingest({
        command_id: 'system-page',
        account_id: account.id,
        deposits: [f.entry],
        page: { expected_version: state!.version, cursor: 'next' },
      })
      let row = (await f.service.list(f.who)).data[0]!
      expect(row.source_status).toBe('unknown')
      expect(row.confirmation_ready).toBe(false)
      await expect(
        f.service.act(f.who, {
          command_id: 'accounting-verify',
          deposit_id: row.id,
          expected_version: row.version,
          operation: 'verify',
          verification_reference: 'provider statement REF123',
        }),
      ).rejects.toMatchObject({ code: 'forbidden' })
      const adminSession = (await f.sessions.issue(1)).session,
        admin = { userId: 1, sessionId: String(adminSession.id) }
      row = (await f.service.act(admin, {
        command_id: 'admin-verify',
        deposit_id: row.id,
        expected_version: row.version,
        operation: 'verify',
        verification_reference: 'provider statement REF123',
      }))!
      expect(row.source_status).toBe('unknown')
      expect(row.confirmation_basis).toBe('operator')
      expect(row.confirmation_ready).toBe(true)
      expect(
        await f.db.all(
          sql`SELECT actor_type,actor_user_id FROM bank_deposit_audit WHERE command_id='system-page'`,
        ),
      ).toEqual([{ actor_type: 'system', actor_user_id: null }])
      const next = await feed.state(account.id)
      await feed.ingest({
        command_id: 'new-observation',
        account_id: account.id,
        deposits: [f.entry],
        observations: { owned_credit: { status: 'pending', classification: 'external_credit' } },
        page: { expected_version: next!.version, cursor: null },
      })
      row = (await f.service.list(f.who)).data[0]!
      expect(row.source_status).toBe('pending')
      expect(row.verified_at).toBeNull()
      expect(row.confirmation_ready).toBe(false)
      await expect(
        f.service.act(admin, {
          command_id: 'override-pending',
          deposit_id: row.id,
          expected_version: row.version,
          operation: 'verify',
          verification_reference: 'no override',
        }),
      ).rejects.toMatchObject({ code: 'invalid' })
    })
    it('overpayment needs explicit confirmation and imported deposits cannot bypass their review permit', async () => {
      const f = await setup(kind)
      await f.service.ingest(f.who, {
        command_id: 'import',
        account_id: f.account.id,
        deposits: [{ ...f.entry, amount_cents: 15000 }],
        observations: { owned_credit: { status: 'final', classification: 'external_credit' } },
      })
      const row = (await f.service.list(f.who)).data[0]!
      const raw = (
        await f.db.all<{ updated_at: string }>(
          sql`SELECT updated_at FROM bank_deposits WHERE id=${row.id}`,
        )
      )[0]!
      await expect(
        recordInvoicePayment(f.db, {
          invoiceId: 1,
          commandId: 'bypass',
          actor: { type: 'user', id: 2 },
          authorize: async () => true,
          expectedVersion: 1,
          occurredAt: f.now,
          eventIds: ['bypass-recorded', 'bypass-paid'],
          payment: {
            type: 'bank_deposit',
            id: 1,
            depositId: row.id,
            expectedDepositUpdatedAt: raw.updated_at,
            expectedMatchState: 'suggested',
            paidAt: f.now,
          },
        }),
      ).rejects.toThrow()
      expect(await f.db.all(sql`SELECT id FROM invoice_payments`)).toHaveLength(0)
      const command = {
        command_id: 'overpay',
        deposit_id: row.id,
        expected_version: row.version,
        invoice_id: 1,
        expected_invoice_version: 1,
        confirm_overpayment: false,
      }
      await expect(f.service.confirm(f.who, command)).rejects.toMatchObject({ code: 'overpayment' })
      expect(
        (await f.service.confirm(f.who, { ...command, confirm_overpayment: true }))?.state,
      ).toBe('confirmed')
      expect(await f.db.all(sql`SELECT due_amount_cents FROM invoices WHERE id=1`)).toEqual([
        { due_amount_cents: -5000 },
      ])
    })
    it('abandoned confirmation permits do not block other receipts and can recover an occupied reservation', async () => {
      const f = await setup(kind)
      const second = {
        ...f.entry,
        provider_transaction_id: 'credit_two',
        amount_cents: 9000,
        memo: null,
      }
      await f.service.ingest(f.who, {
        command_id: 'two',
        account_id: f.account.id,
        deposits: [f.entry, second],
        observations: {
          owned_credit: { status: 'final', classification: 'external_credit' },
          credit_two: { status: 'final', classification: 'external_credit' },
        },
      })
      const rows = (await f.service.list(f.who)).data,
        first = rows.find((r) => r.provider_transaction_id === 'owned_credit')!,
        other = rows.find((r) => r.provider_transaction_id === 'credit_two')!
      await f.db.run(
        sql.raw(
          `CREATE TRIGGER owned_block_first BEFORE INSERT ON invoice_payments WHEN NEW.bank_deposit_id=${first.id} BEGIN SELECT RAISE(ABORT,'owned_failure'); END`,
        ),
      )
      const command = {
        command_id: 'reserved',
        deposit_id: first.id,
        expected_version: first.version,
        invoice_id: 1,
        expected_invoice_version: 1,
        confirm_overpayment: false,
      }
      await expect(f.service.confirm(f.who, command)).rejects.toMatchObject({ code: 'conflict' })
      expect(
        await f.db.all(
          sql`SELECT payment_id FROM bank_deposit_confirmation_permits WHERE command_id='reserved'`,
        ),
      ).toEqual([{ payment_id: 1 }])
      await f.db.run(sql`DROP TRIGGER owned_block_first`)
      const assigned = await f.service.act(f.who, {
        command_id: 'assign-two',
        deposit_id: other.id,
        expected_version: other.version,
        operation: 'assign',
        invoice_id: 2,
      })
      await f.service.confirm(f.who, {
        command_id: 'other-confirm',
        deposit_id: other.id,
        expected_version: assigned!.version,
        invoice_id: 2,
        expected_invoice_version: 1,
        confirm_overpayment: false,
      })
      const invoice = (
        await f.db.all<{ version: number }>(sql`SELECT version FROM invoices WHERE id=2`)
      )[0]!
      await recordInvoicePayment(f.db, {
        invoiceId: 2,
        commandId: 'manual-uses-id',
        actor: { type: 'user', id: 1 },
        authorize: async () => true,
        expectedVersion: invoice.version,
        occurredAt: f.now,
        eventIds: ['manual-recorded', 'manual-settled'],
        payment: {
          type: 'manual',
          id: 1,
          currency: 'USD',
          amountCents: 500,
          paidAt: null,
          paidDate: f.now.slice(0, 10),
        },
      })
      expect((await f.service.confirm(f.who, command))?.state).toBe('confirmed')
      expect(
        await f.db.all(
          sql`SELECT payment_id FROM bank_deposit_confirmation_permits WHERE command_id='reserved'`,
        ),
      ).toEqual([{ payment_id: 3 }])
    })
    it('observation-only invalidation revokes operator verification without changing source money', async () => {
      const f = await setup(kind),
        feed = createBankDepositIngestionService(f.db)
      const account = await feed.ensureAccount({
        provider: 'mercury',
        externalAccountId: 'attestation',
        name: 'Owned',
      })
      await feed.ingest({
        command_id: 'uncertain',
        account_id: account.id,
        deposits: [f.entry],
        observations: { owned_credit: { status: 'final', classification: 'ambiguous_credit' } },
      })
      const row = (await f.service.list(f.who)).data[0]!
      const session = (await f.sessions.issue(1)).session,
        admin = { userId: 1, sessionId: String(session.id) }
      const verified = (await f.service.act(admin, {
        command_id: 'verify-final',
        deposit_id: row.id,
        expected_version: row.version,
        operation: 'verify',
        verification_reference: 'owned provider reference',
      }))!
      expect(verified.confirmation_basis).toBe('operator')
      expect(verified.source_status).toBe('final')
      const state = await feed.state(account.id)
      await feed.ingest({
        command_id: 'invalidated',
        account_id: account.id,
        deposits: [],
        observations: {
          owned_credit: {
            status: 'ineligible',
            classification: 'ambiguous_credit',
            reason: 'mercury_not_receivable',
          },
        },
        page: { expected_version: state!.version, cursor: null },
      })
      const changed = (await f.service.list(f.who)).data[0]!
      const audit = (
        await f.db.all<{ result_json: string }>(
          sql`SELECT result_json FROM bank_deposit_audit WHERE command_id='verify-final'`,
        )
      )[0]!
      expect(JSON.parse(audit.result_json)).toMatchObject({
        verification_reference: 'owned provider reference',
        source_status: 'final',
        attested_posted: true,
        attested_external: true,
      })
      expect(changed.amount_cents).toBe(row.amount_cents)
      expect(changed.verified_at).toBeNull()
      expect(changed.confirmation_ready).toBe(false)
      await expect(
        f.service.act(admin, {
          command_id: 'cannot-override',
          deposit_id: row.id,
          expected_version: changed.version,
          operation: 'verify',
          verification_reference: 'no override',
        }),
      ).rejects.toMatchObject({ code: 'invalid' })
      expect(await f.db.all(sql`SELECT id FROM invoice_payments`)).toHaveLength(0)
    })
    it('session revocation after permission read still prevents the atomic receipt', async () => {
      const f = await setup(kind)
      await f.service.ingest(f.who, {
        command_id: 'import',
        account_id: f.account.id,
        deposits: [f.entry],
        observations: { owned_credit: { status: 'final', classification: 'external_credit' } },
      })
      const row = (await f.service.list(f.who)).data[0]!
      let revoked = false
      const wrapped = new Proxy(f.db, {
        get(target, key) {
          if (key === 'all')
            return async (query: Parameters<typeof f.db.all>[0]) => {
              const result = await target.all(query)
              const text =
                typeof query === 'string'
                  ? query
                  : new SQLiteSyncDialect().sqlToQuery(query.getSQL()).sql
              if (!revoked && text.includes('SELECT 1 AS ok')) {
                const permits = await target.all(
                  sql`SELECT command_id FROM bank_deposit_confirmation_permits WHERE command_id='race'`,
                )
                if (permits.length) {
                  revoked = true
                  await f.sessions.revoke(2, f.session.id)
                }
              }
              return result
            }
          const value = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      await expect(
        createBankDepositReviewService(wrapped).confirm(f.who, {
          command_id: 'race',
          deposit_id: row.id,
          expected_version: row.version,
          invoice_id: 1,
          expected_invoice_version: 1,
          confirm_overpayment: false,
        }),
      ).rejects.toThrow()
      expect(revoked).toBe(true)
      expect(await f.db.all(sql`SELECT id FROM invoice_payments`)).toHaveLength(0)
    })
  })
