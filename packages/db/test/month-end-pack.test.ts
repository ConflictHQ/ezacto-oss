import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { migrateContainer } from '../src/migrate.js'
import { createMonthEndPackService } from '../src/month-end-pack.js'

const t = (hour: number): string => `2026-09-01T${String(hour).padStart(2, '0')}:00:00.000Z`
let sqlite: BetterSqlite3.Database | null = null

afterEach(() => {
  sqlite?.close()
  sqlite = null
})

describe('month-end pack as one action (#58)', () => {
  it('one confirmation creates a branded client-safe PDF, attaches it and queues one send', async () => {
    sqlite = new BetterSqlite3(':memory:')
    await migrateContainer(sqlite)
    sqlite.pragma('foreign_keys = ON')
    sqlite.exec(`
      INSERT INTO organizations
        (name, modules, report_notes_client_visible_default, created_at, updated_at)
        VALUES ('Organization fallback', '{}', 1, '${t(0)}', '${t(0)}');
      INSERT INTO users
        (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
        VALUES (1, 'Ada', 'Byron', 'administrator', '[]', '${t(0)}', '${t(0)}');
      INSERT INTO report_brands (id, name, created_at, updated_at)
        VALUES (1, 'Kestrel reports', '${t(0)}', '${t(0)}');
      INSERT INTO clients
        (id, name, currency, report_brand_id, created_at, updated_at)
        VALUES (1, 'Kestrel', 'USD', 1, '${t(0)}', '${t(0)}');
      INSERT INTO contacts
        (id, client_id, first_name, email, invoice_recipient_status, created_at, updated_at)
        VALUES (1, 1, 'Accounts', 'ap@kestrel.test', 'recipient', '${t(0)}', '${t(0)}');
      INSERT INTO projects
        (id, client_id, name, code, is_active, billing_method, created_at, updated_at)
        VALUES (1, 1, 'Assessment', 'A1', 1, 'time_materials', '${t(0)}', '${t(0)}');
      INSERT INTO tasks
        (id, name, billable_by_default, is_default, is_active, created_at, updated_at)
        VALUES (1, 'Advisory', 1, 1, 1, '${t(0)}', '${t(0)}');
      INSERT INTO user_assignments (id, project_id, user_id, created_at, updated_at)
        VALUES (1, 1, 1, '${t(0)}', '${t(0)}');
      INSERT INTO task_assignments (id, project_id, task_id, billable, created_at, updated_at)
        VALUES (1, 1, 1, 1, '${t(0)}', '${t(0)}');
      INSERT INTO time_entries
        (id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
         spent_date, seconds, seconds_without_timer, rounded_seconds, notes, client_visible,
         billable, cost_rate_cents, created_at, updated_at)
        VALUES
        (1, 1, 1, 1, 1, 1, '2026-08-15', 3600, 3600, 3600,
         'Visible https://example.test/pull/417', 1, 1, 4000, '${t(0)}', '${t(0)}'),
        (2, 1, 1, 1, 1, 1, '2026-08-16', 1800, 1800, 1800,
         'INTERNAL_MARGIN_SECRET', 0, 1, 4000, '${t(0)}', '${t(0)}');
      INSERT INTO invoices
        (id, client_id, number, currency, issue_date, due_date, state, created_at, updated_at)
        VALUES (1315, 1, '1315', 'USD', '2026-08-31', '2026-09-30', 'open', '${t(0)}', '${t(0)}');
      INSERT INTO scheduled_jobs
        (id, action, name, scope_json, cadence, created_by_user_id, created_at, updated_at)
        VALUES (1, 'month_end_pack', 'Month end', '{"clients":[1]}', '0 9 1 * *', 1,
          '${t(0)}', '${t(0)}');
    `)
    const attachments: { bytes: Uint8Array; key: string }[] = []
    const attach = vi.fn(async (input: { bytes: Uint8Array; idempotencyKey: string }) => {
      if (!attachments.some(({ key }) => key === input.idempotencyKey)) {
        attachments.push({ bytes: input.bytes, key: input.idempotencyKey })
      }
    })
    const sends = new Set<string>()
    const queue = vi.fn(async (input: { idempotencyKey: string }) => {
      sends.add(input.idempotencyKey)
    })
    const service = createMonthEndPackService(createContainerDatabase(sqlite), { attach, queue })
    const proposal = await service.propose({
      jobId: 1,
      occurrenceKey: '2026-08',
      clientIds: [1],
      proposedAt: t(9),
      expiresAt: t(21),
    })
    expect(proposal.outcome.outcome).toBe('proposed')
    expect(proposal.manifest.items[0]).toMatchObject({
      brandName: 'Kestrel reports',
      costCents: 6_000,
      marginCents: -6_000,
    })
    expect(proposal.previews[0]).toMatchObject({ invoiceId: 1315, brandName: 'Kestrel reports' })
    expect(proposal.previews[0]?.warnings).toContainEqual(
      expect.objectContaining({ entryId: 1, kind: 'url' }),
    )
    if (proposal.outcome.outcome !== 'proposed') throw new Error(proposal.outcome.outcome)
    const runId = proposal.outcome.run.id
    await expect(service.confirmAndExecute(runId, 1, () => t(10))).resolves.toMatchObject({
      completed: 1,
      runCompleted: true,
    })
    expect(attach).toHaveBeenCalledOnce()
    expect(queue).toHaveBeenCalledWith(expect.objectContaining({
      invoiceId: 1315,
      to: 'ap@kestrel.test',
    }))
    const pdf = new TextDecoder('latin1').decode(attachments[0]!.bytes)
    expect(pdf).toContain('Kestrel reports')
    expect(pdf).toContain('Visible https://example.test/pull/417')
    expect(pdf).not.toContain('INTERNAL_MARGIN_SECRET')

    await expect(service.confirmAndExecute(runId, 1, () => t(11))).resolves.toEqual({
      runId,
      completed: 0,
      failed: [],
      runCompleted: true,
    })
    expect(attach).toHaveBeenCalledOnce()
    expect(queue).toHaveBeenCalledOnce()
    expect(sends.size).toBe(1)
  })
})
