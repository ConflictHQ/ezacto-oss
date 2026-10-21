import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import {
  StaffPaymentError,
  paymentActualsTotal,
  matchStaffInvoices,
  staffInvoiceAmount,
  validateStaffInvoice,
  validPaymentMonth,
  type StaffInvoice,
  type StaffInvoiceVersion,
  type StaffInvoiceDocument,
  type StaffInvoicesStore,
  type PaymentActualEntry,
} from '@ezacto/core'
const hasControl = (value: string) =>
  [...value].some((c) => c.charCodeAt(0) <= 31 || c.charCodeAt(0) === 127)

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>
type VersionRow = Omit<StaffInvoiceVersion, 'version' | 'lines' | 'has_payment_history'> & {
  has_payment_history: number
  invoice_id: number
  expected_version: number
  lines_json: string
}
const versionOf = ({
  expected_version,
  has_payment_history,
  lines_json,
  invoice_id: _invoice,
  ...rest
}: VersionRow): StaffInvoiceVersion => {
  void _invoice
  return {
    ...rest,
    version: expected_version + 1,
    has_payment_history: has_payment_history === 1,
    lines: JSON.parse(lines_json) as StaffInvoiceVersion['lines'],
  }
}
const fail = (message: string): never => {
  throw new StaffPaymentError('conflict', message)
}
const translate = (error: unknown): never => {
  let cause: unknown = error
  for (let depth = 0; depth < 6 && cause; depth++) {
    if (
      /staff invoice|UNIQUE constraint|FOREIGN KEY constraint|CHECK constraint/u.test(String(cause))
    )
      fail(
        'The invoice reference, version, earning review, attachment or payment history changed. Reload before recording it again.',
      )
    cause = cause instanceof Error ? cause.cause : null
  }
  throw error
}
const rootId = async (command: string) =>
  Number.parseInt(
    Array.from(
      new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`staff-invoice:${command}`)),
      ),
    )
      .map((n) => n.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 12),
    16,
  ) || 1

export const createStaffInvoicesStore = (database: Database): StaffInvoicesStore => {
  const report: StaffInvoicesStore['report'] = async (month, ownUserId) => {
    if (!validPaymentMonth(month))
      throw new StaffPaymentError('invalid', 'Choose a valid work month (YYYY-MM).')
    const roots = await database.all<
      Omit<StaffInvoice, 'versions' | 'matched_cents' | 'flags' | 'line_flags'>
    >(sql`
      SELECT i.id,i.user_id,v.month,v.currency,i.reference FROM staff_invoices i JOIN staff_invoice_versions v ON v.invoice_id=i.id
        AND v.expected_version=(SELECT MAX(expected_version) FROM staff_invoice_versions WHERE invoice_id=i.id) WHERE v.month=${month} ${
          ownUserId === undefined
            ? sql``
            : sql`AND i.user_id=${ownUserId}
        AND (SELECT kind FROM staff_invoice_versions WHERE invoice_id=i.id ORDER BY expected_version DESC LIMIT 1) IN ('received','void')
        AND EXISTS(SELECT 1 FROM staff_invoice_versions WHERE invoice_id=i.id AND kind='received')`
        } ORDER BY i.user_id,i.id`)
    const versions =
      roots.length === 0
        ? []
        : await database.all<VersionRow>(sql`
      SELECT command_id,invoice_id,expected_version,month,currency,kind,lines_json,amount_cents,review_id,document_id,reason,actor_id,recorded_at,paid_cents_at_recording,has_payment_history
      FROM staff_invoice_versions WHERE invoice_id IN (${sql.join(
        roots.map((root) => sql`${root.id}`),
        sql`,`,
      )}) ${ownUserId === undefined ? sql`` : sql`AND user_id=${ownUserId} AND kind IN ('received','void')`}
      ORDER BY invoice_id,expected_version`)
    const balances = await database.all<{
      user_id: number
      name: string
      currency: string | null
      earned_cents: number | null
      paid_cents: number
    }>(sql`
      SELECT u.id AS user_id,u.first_name||' '||u.last_name AS name,b.currency,b.amount_cents AS earned_cents,COALESCE(b.paid_cents,0) AS paid_cents
      FROM users u LEFT JOIN staff_payment_balances b ON b.user_id=u.id AND b.month=${month}
      WHERE (b.user_id IS NOT NULL OR EXISTS(SELECT 1 FROM staff_invoices i JOIN staff_invoice_versions v ON v.invoice_id=i.id
        AND v.expected_version=(SELECT MAX(expected_version) FROM staff_invoice_versions WHERE invoice_id=i.id) WHERE i.user_id=u.id AND v.month=${month}))
      ${ownUserId === undefined ? sql`` : sql`AND u.id=${ownUserId}`} ORDER BY u.first_name,u.id`)
    const reviews = await database.all<{
      user_id: number
      currency: string
      entries_json: string
    }>(sql`
      SELECT a.user_id,a.currency,a.entries_json FROM staff_payment_actuals a WHERE a.month=${month}
      AND a.expected_version=(SELECT MAX(expected_version) FROM staff_payment_actuals WHERE user_id=a.user_id AND month=a.month)
      ${ownUserId === undefined ? sql`` : sql`AND a.user_id=${ownUserId}`}`)
    const people = balances
      .map((balance) => {
        const invoices: StaffInvoice[] = roots
          .filter((r) => r.user_id === balance.user_id)
          .map((root) => ({
            ...root,
            versions: versions.filter((v) => v.invoice_id === root.id).map(versionOf),
            matched_cents: 0,
            flags: [],
            line_flags: [],
          }))
        const review = reviews.find((r) => r.user_id === balance.user_id)
        const entries = review ? (JSON.parse(review.entries_json) as PaymentActualEntry[]) : []
        matchStaffInvoices(invoices, entries, review?.currency ?? null)
        if (
          review &&
          balance.currency === review.currency &&
          balance.earned_cents !== paymentActualsTotal(entries)
        ) {
          for (const invoice of invoices) {
            invoice.flags.push(
              'Monthly obligation differs from reviewed earnings: review before matching',
            )
            invoice.matched_cents = 0
          }
        }
        // Each currency gets its own row. A foreign-currency document is visible
        // for matching review, never silently netted against this month's earnings.
        const currencies = new Set<string | null>([
          balance.currency,
          ...invoices.map((i) => i.currency),
        ])
        if (currencies.size > 1) currencies.delete(null)
        return [...currencies].map((currency) => {
          const own = invoices.filter((i) => i.currency === currency)
          const received = own.filter((i) => i.versions.at(-1)!.kind === 'received')
          const invoiced = received.reduce(
            (n, i) => n + BigInt(i.versions.at(-1)!.amount_cents),
            0n,
          )
          if (invoiced > BigInt(Number.MAX_SAFE_INTEGER))
            throw new StaffPaymentError(
              'invalid',
              'The invoice report total exceeds the supported range.',
            )
          const matched = received.reduce((n, i) => n + i.matched_cents, 0)
          const earned = balance.currency === currency ? balance.earned_cents : null
          return {
            user_id: balance.user_id,
            name: balance.name,
            currency,
            earned_cents: earned,
            paid_cents: balance.currency === currency ? balance.paid_cents : 0,
            invoiced_cents: Number(invoiced),
            matched_invoice_cents: matched,
            uninvoiced_cents: earned === null ? null : Math.max(0, earned - matched),
            invoices: own,
          }
        })
      })
      .flat()
    return { month, people }
  }
  const current = async (invoiceId: number, month: string) => {
    const latest = (
      await database.all<{ month: string }>(
        sql`SELECT month FROM staff_invoice_versions WHERE invoice_id=${invoiceId} ORDER BY expected_version DESC LIMIT 1`,
      )
    )[0]
    const invoice = (await report(latest?.month ?? month)).people
      .flatMap((p) => p.invoices)
      .find((i) => i.id === invoiceId)
    if (!invoice) throw new StaffPaymentError('not_found', 'Contractor invoice not found.')
    return invoice
  }
  return {
    report,
    save: async (command, actorId, requestId, now) => {
      validateStaffInvoice(command)
      const encoded = JSON.stringify(command)
      const existing = async () =>
        (
          await database.all<{
            invoice_id: number
            command_json: string
            actor_id: number
            month: string
          }>(
            sql`SELECT invoice_id,command_json,actor_id,month FROM staff_invoice_versions WHERE command_id=${command.id}`,
          )
        )[0]
      const replay = await existing()
      if (replay) {
        if (replay.command_json !== encoded || replay.actor_id !== actorId)
          fail('This invoice command identifier was already used.')
        return current(replay.invoice_id, replay.month)
      }
      const review = (
        await database.all<{ id: string; currency: string; entries_json: string }>(sql`
        SELECT id,currency,entries_json FROM staff_payment_actuals WHERE user_id=${command.user_id} AND month=${command.month} ORDER BY expected_version DESC LIMIT 1`)
      )[0]
      let lines = command.lines
      if (command.from_review) {
        if (!review || review.currency !== command.currency)
          fail('Drafting requires reviewed earnings in the selected currency.')
        const entries = JSON.parse(review!.entries_json) as PaymentActualEntry[]
        if (entries.some((entry) => entry.selected_seconds !== 0 && entry.cost_rate_cents === null))
          fail('Resolve missing cost rates before drafting.')
        lines = entries
          .filter((e) => e.selected_seconds !== 0)
          .map((e) => ({
            description: `${e.project_name} · ${e.spent_date}`,
            project_id: e.project_id,
            entry_id: e.entry_id,
            seconds: e.selected_seconds,
            rate_cents: e.cost_rate_cents!,
          }))
      }
      if (command.kind !== 'void' && lines.length === 0)
        throw new StaffPaymentError('invalid', 'Record at least one invoice line.')
      const amount = staffInvoiceAmount(lines)
      const payment = (
        await database.all<{ paid_cents: number; has_payment_history: number }>(sql`SELECT
        COALESCE((SELECT paid_cents FROM staff_payment_balances WHERE user_id=${command.user_id} AND month=${command.month} AND currency=${command.currency}),0) AS paid_cents,
        (EXISTS(SELECT 1 FROM staff_payment_balances WHERE user_id=${command.user_id} AND month IN (${command.month},COALESCE((SELECT month FROM staff_invoice_versions WHERE invoice_id=${command.invoice_id} ORDER BY expected_version DESC LIMIT 1),${command.month})) AND paid_cents>0)
        OR EXISTS(SELECT 1 FROM staff_invoice_versions WHERE invoice_id=${command.invoice_id} AND has_payment_history=1)) AS has_payment_history`)
      )[0]!
      const invoiceId = command.invoice_id ?? (await rootId(command.id))
      try {
        await database.run(sql`INSERT INTO staff_invoice_versions(command_id,invoice_id,expected_version,user_id,month,currency,reference,kind,lines_json,amount_cents,review_id,document_id,reason,command_json,actor_id,recorded_at,request_id,paid_cents_at_recording,has_payment_history)
          VALUES(${command.id},${invoiceId},${command.expected_version},${command.user_id},${command.month},${command.currency},${command.reference.trim()},${command.kind},${JSON.stringify(lines)},${amount},${review?.id ?? null},${command.document_id},${command.reason.trim()},${encoded},${actorId},${now},${requestId},${payment.paid_cents},${payment.has_payment_history})`)
      } catch (error) {
        const raced = await existing()
        if (!raced || raced.command_json !== encoded || raced.actor_id !== actorId) translate(error)
      }
      return current(invoiceId, command.month)
    },
    recordDocument: async (command, actorId, requestId, now) => {
      if (
        !/^[a-zA-Z0-9._-]{1,100}$/u.test(command.id) ||
        !Number.isSafeInteger(command.invoice_id) ||
        command.invoice_id <= 0 ||
        !/^[0-9a-f]{64}$/u.test(command.content_hash) ||
        command.file_key !== `sha256/${command.content_hash.slice(0, 2)}/${command.content_hash}` ||
        !Number.isSafeInteger(command.byte_size) ||
        command.byte_size < 0 ||
        command.byte_size > 25 * 1024 * 1024 ||
        !command.name.trim() ||
        command.name.length > 255 ||
        hasControl(command.name) ||
        !command.content_type.trim() ||
        command.content_type.length > 255 ||
        hasControl(command.content_type)
      )
        throw new StaffPaymentError(
          'invalid',
          'Provide a valid invoice file within the 25 MiB upload limit.',
        )
      const encoded = JSON.stringify(command)
      const existing = async () =>
        (
          await database.all<{ command_json: string; actor_id: number }>(
            sql`SELECT command_json,actor_id FROM staff_invoice_document_commands WHERE id=${command.id}`,
          )
        )[0]
      const replay = await existing()
      if (replay) {
        if (replay.command_json === encoded && replay.actor_id === actorId) return
        fail('This document command identifier was already used.')
      }
      try {
        await database.run(sql`INSERT INTO staff_invoice_document_commands(id,invoice_id,content_hash,file_key,byte_size,content_type,name,command_json,actor_id,recorded_at,request_id)
          VALUES(${command.id},${command.invoice_id},${command.content_hash},${command.file_key},${command.byte_size},${command.content_type},${command.name},${encoded},${actorId},${now},${requestId})`)
      } catch (error) {
        const raced = await existing()
        if (!raced || raced.command_json !== encoded || raced.actor_id !== actorId) translate(error)
      }
    },
    document: async (invoiceId, documentId, ownUserId) =>
      (
        await database.all<StaffInvoiceDocument>(sql`
      SELECT d.id,d.invoice_id,d.name,f.file_key,f.content_hash,f.byte_size,f.content_type FROM staff_invoice_documents d
      JOIN file_objects f ON f.id=d.file_object_id JOIN staff_invoices i ON i.id=d.invoice_id
      WHERE d.id=${documentId} AND d.invoice_id=${invoiceId} ${
        ownUserId === undefined
          ? sql``
          : sql`AND i.user_id=${ownUserId}
        AND EXISTS(SELECT 1 FROM staff_invoice_versions WHERE invoice_id=i.id AND kind='received' AND document_id=d.id)`
      }`)
      )[0] ?? null,
  }
}
