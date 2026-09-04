import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database, migrateContainer, migrateD1 } from '@ezacto/db'
import {
  D1_MAX_BOUND_PARAMETERS,
  assertD1Statements,
  boundedInsertBatches,
  loadNextChunk,
  runLoad,
} from '../src/load.js'
import { buildSanitizedLoadSnapshot } from './load-fixture.js'
import { readManifest, writeManifest } from '../src/manifest.js'
import { checksumReportDigest, snapshotDigest, type ChecksumReport } from '../src/verify.js'

const fileHash = async (path: string): Promise<string> =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex')

const refreshChecksum = async (snapshotDir: string): Promise<void> => {
  const checksumsPath = join(snapshotDir, 'checksums.json')
  const checksums = JSON.parse(await readFile(checksumsPath, 'utf8')) as ChecksumReport
  checksums.snapshot_sha256 = await snapshotDigest(snapshotDir, await readManifest(snapshotDir))
  const { report_sha256: previous, ...payload } = checksums
  void previous
  checksums.report_sha256 = checksumReportDigest(payload)
  await writeFile(checksumsPath, `${JSON.stringify(checksums)}\n`)
}

describe('transform and load', () => {
  let dir: string
  let snapshotDir: string
  let databasePath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ezacto-load-'))
    snapshotDir = join(dir, 'snapshot')
    databasePath = join(dir, 'ezacto.sqlite')
    await buildSanitizedLoadSnapshot(snapshotDir)
  })

  afterEach(async () => rm(dir, { recursive: true, force: true }))

  it('[integration] loads sanitized golden slices and a retry is byte-identical', async () => {
    const first = await runLoad({ snapshotDir, databasePath })
    expect(first.loadedRows).toBeGreaterThan(0)
    expect(first.anomalies).toEqual([
      expect.objectContaining({ kind: 'payment_date_disagreement', source_id: '50863457' }),
    ])
    const db = new BetterSqlite3(databasePath, { readonly: true })
    try {
      expect(
        db
          .prepare(
            `SELECT harvest_id, seconds, seconds_without_timer, rounded_seconds,
          billable_rate_cents, cost_rate_cents FROM time_entries
          WHERE harvest_id = '9007199254740993'`,
          )
          .get(),
      ).toEqual({
        harvest_id: '9007199254740993',
        seconds: 4500,
        seconds_without_timer: 4500,
        rounded_seconds: 5400,
        billable_rate_cents: 17_500,
        cost_rate_cents: 8050,
      })
      expect(
        db
          .prepare(
            `SELECT entry.approval_status, entry.source_approval_status,
              submission.status, submission.origin, submission.source_status,
              submission.period_start, submission.period_end,
              submission.submitted_by_user_id, submission.submitted_at,
              submission.reviewed_by_user_id, submission.reviewed_at,
              event.event_type
             FROM time_entries entry
             JOIN timesheet_submissions submission
               ON submission.id = entry.timesheet_submission_id
             JOIN event_outbox event ON event.aggregate_type = 'timesheet_submission'
               AND event.aggregate_id = submission.id
             WHERE entry.harvest_id = '9007199254740993'`,
          )
          .get(),
      ).toEqual({
        approval_status: 'approved',
        source_approval_status: 'approved',
        status: 'approved',
        origin: 'harvest_import',
        source_status: 'approved',
        period_start: '2026-08-10',
        period_end: '2026-08-16',
        submitted_by_user_id: null,
        submitted_at: null,
        reviewed_by_user_id: null,
        reviewed_at: null,
        event_type: 'timesheet.status_imported',
      })
      const aggregate = db
        .prepare(
          `SELECT timesheet_submission_id AS id FROM time_entries
           WHERE harvest_id = '9007199254740993'`,
        )
        .get() as { id: number }
      expect(
        db
          .prepare(
            `SELECT harvest_id, total_cost_cents, approval_status,
              source_approval_status, timesheet_submission_id
             FROM expenses WHERE harvest_id IN (152975211, 152975212)
             ORDER BY harvest_id`,
          )
          .all(),
      ).toEqual([
        {
          harvest_id: 152975211,
          total_cost_cents: 8125,
          approval_status: 'approved',
          source_approval_status: 'approved',
          timesheet_submission_id: aggregate.id,
        },
        {
          harvest_id: 152975212,
          total_cost_cents: 10_000,
          approval_status: 'approved',
          source_approval_status: 'approved',
          timesheet_submission_id: aggregate.id,
        },
      ])
      expect(
        db
          .prepare(
            `SELECT count(*) AS count FROM event_outbox
             WHERE aggregate_type = 'timesheet_submission' AND aggregate_id = ?`,
          )
          .get(aggregate.id),
      ).toEqual({ count: 1 })
      expect(
        db
          .prepare(
            `SELECT harvest_id, seconds, seconds_without_timer, timer_started_at, started_time
        FROM time_entries WHERE harvest_id = '9007199254740994'`,
          )
          .get(),
      ).toEqual({
        harvest_id: '9007199254740994',
        seconds: 4500,
        seconds_without_timer: 3600,
        timer_started_at: null,
        started_time: '15:30',
      })
      const invoice = db
        .prepare(
          `SELECT invoice.id, invoice.harvest_id, invoice.client_key,
          invoice.source_creator_id, invoice.source_creator_name, invoice.amount_cents,
          invoice.source_amount_cents, estimate.harvest_id AS estimate_harvest_id
        FROM invoices invoice LEFT JOIN estimates estimate ON estimate.id = invoice.estimate_id
        WHERE invoice.harvest_id = 13150403`,
        )
        .get() as Record<string, unknown>
      expect(invoice.client_key).not.toBe('harvest-public-link-secret-must-not-survive')
      expect(invoice).toMatchObject({
        source_creator_id: 1782959,
        source_creator_name: 'Sanitized Creator',
        amount_cents: 227_500,
        source_amount_cents: 227_500,
        estimate_harvest_id: 920001,
      })
      const message = db
        .prepare(
          `SELECT id, harvest_id, sent_by, sent_by_email,
          sent_from, sent_from_email FROM invoice_messages`,
        )
        .get() as Record<string, unknown>
      expect(message.id).not.toBe(message.harvest_id)
      expect(message).toMatchObject({
        sent_by: 'Sanitized Creator',
        sent_by_email: 'creator@example.invalid',
        sent_from: 'Sanitized Billing',
        sent_from_email: 'billing@example.invalid',
      })
      expect(db.prepare('SELECT count(*) AS count FROM harvest_expense_receipts').get()).toEqual({
        count: 1,
      })
      expect(
        db
          .prepare(
            `SELECT file.content_hash, file.byte_size FROM harvest_expense_receipts receipt
          JOIN attachments attachment ON attachment.id = receipt.attachment_id
          JOIN file_objects file ON file.id = attachment.file_object_id`,
          )
          .get(),
      ).toMatchObject({ byte_size: 51 })
      expect(
        db.prepare(`SELECT amount_cents FROM user_billable_rates WHERE harvest_id = 81001`).get(),
      ).toEqual({ amount_cents: 17_500 })
      expect(
        db
          .prepare(`SELECT harvest_id, end_date FROM user_billable_rates ORDER BY start_date`)
          .all(),
      ).toEqual([
        { harvest_id: 81001, end_date: '2026-06-30' },
        { harvest_id: 81003, end_date: null },
      ])
      expect(
        db
          .prepare(
            `SELECT budget_seconds, budget_cents FROM task_assignments
        WHERE harvest_id = 53001`,
          )
          .get(),
      ).toEqual({ budget_seconds: null, budget_cents: 12_345 })
      expect(
        db.prepare(`SELECT invoice_recipient_status FROM contacts WHERE harvest_id = 61001`).get(),
      ).toEqual({ invoice_recipient_status: 'cc' })
      expect(
        db
          .prepare(
            `SELECT use_as_service, use_as_expense FROM invoice_item_categories
        WHERE harvest_id = 52001`,
          )
          .get(),
      ).toEqual({ use_as_service: 1, use_as_expense: 0 })
      expect(
        db
          .prepare(
            `SELECT payment.recorded_by_user_id, user.harvest_id AS user_harvest_id
        FROM invoice_payments payment LEFT JOIN users user ON user.id = payment.recorded_by_user_id`,
          )
          .get(),
      ).toEqual({ recorded_by_user_id: expect.any(Number), user_harvest_id: 1782960 })
      expect(
        db
          .prepare(
            `SELECT invoice.harvest_id AS invoice_harvest_id
        FROM time_entries entry JOIN invoices invoice ON invoice.id = entry.invoice_id
        WHERE entry.harvest_id = ?`,
          )
          .get('9007199254740993'),
      ).toEqual({ invoice_harvest_id: 12000001 })
      expect(
        db
          .prepare(
            `SELECT invoice.harvest_id AS invoice_harvest_id
        FROM expenses expense JOIN invoices invoice ON invoice.id = expense.invoice_id
        WHERE expense.harvest_id = 152975211`,
          )
          .get(),
      ).toEqual({ invoice_harvest_id: 12000001 })
      expect(
        db
          .prepare(
            `SELECT manager.harvest_id AS manager_harvest_id,
          teammate.harvest_id AS teammate_harvest_id
        FROM teammate_assignments assignment
        JOIN users manager ON manager.id = assignment.manager_id
        JOIN users teammate ON teammate.id = assignment.user_id`,
          )
          .get(),
      ).toEqual({ manager_harvest_id: 1782959, teammate_harvest_id: 1782960 })
      expect(
        db
          .prepare(
            `SELECT user.harvest_id AS user_harvest_id
        FROM user_roles assignment JOIN users user ON user.id = assignment.user_id
        JOIN roles role ON role.id = assignment.role_id WHERE role.harvest_id = 71001`,
          )
          .all(),
      ).toEqual([{ user_harvest_id: 1782960 }])
      expect(
        JSON.parse(
          (
            db.prepare('SELECT modules FROM organizations WHERE id = 1').get() as {
              modules: string
            }
          ).modules,
        ),
      ).toMatchObject({ approval: true, team: true })
      expect(
        db.prepare('SELECT harvest_id, profile, is_owner FROM users ORDER BY id').all(),
      ).toEqual([
        { harvest_id: 1782959, profile: 'administrator', is_owner: 1 },
        { harvest_id: 1782960, profile: 'member', is_owner: 0 },
      ])
    } finally {
      db.close()
    }
    const before = await fileHash(databasePath)
    const retry = await runLoad({ snapshotDir, databasePath })
    expect(retry.loadedRows).toBe(0)
    expect(retry.snapshotSha256).toBe(first.snapshotSha256)
    expect(await fileHash(databasePath)).toBe(before)

    const retryDb = new BetterSqlite3(databasePath)
    const identities = retryDb
      .prepare(
        `SELECT invoice.id AS invoice_id,
        invoice.client_key, line.id AS line_id, message.id AS message_id,
        (SELECT id FROM estimate_messages WHERE harvest_id = 921001) AS estimate_message_id
      FROM invoices invoice
      JOIN invoice_line_items line ON line.invoice_id = invoice.id
      JOIN invoice_messages message ON message.invoice_id = invoice.id
      WHERE invoice.harvest_id = 13150403`,
      )
      .get()
    retryDb
      .prepare(
        `UPDATE estimate_messages SET body = 'locally stale body'
      WHERE harvest_id = 921001`,
      )
      .run()
    retryDb
      .prepare(
        `DELETE FROM _ezacto_load_progress
      WHERE resource IN ('estimates','invoices','time_entries','expenses')`,
      )
      .run()
    retryDb.close()
    await runLoad({ snapshotDir, databasePath })
    const afterGap = new BetterSqlite3(databasePath, { readonly: true })
    try {
      expect(
        afterGap
          .prepare(
            `SELECT invoice.id AS invoice_id,
          invoice.client_key, line.id AS line_id, message.id AS message_id,
          (SELECT id FROM estimate_messages WHERE harvest_id = 921001) AS estimate_message_id
        FROM invoices invoice
        JOIN invoice_line_items line ON line.invoice_id = invoice.id
        JOIN invoice_messages message ON message.invoice_id = invoice.id
        WHERE invoice.harvest_id = 13150403`,
          )
          .get(),
      ).toEqual(identities)
      expect(afterGap.prepare('SELECT count(*) AS count FROM invoice_line_items').get()).toEqual({
        count: 2,
      })
      expect(afterGap.prepare('SELECT count(*) AS count FROM invoice_messages').get()).toEqual({
        count: 1,
      })
      expect(afterGap.prepare('SELECT harvest_id FROM retainers').all()).toEqual([
        { harvest_id: 88001 },
      ])
      expect(afterGap.prepare('SELECT harvest_id FROM recurring_invoices').all()).toEqual([
        { harvest_id: 99001 },
      ])
      expect(
        afterGap.prepare('SELECT body FROM estimate_messages WHERE harvest_id = 921001').get(),
      ).toEqual({ body: 'Please review the sanitized estimate.' })
    } finally {
      afterGap.close()
    }
  }, 30_000)

  it('[integration] preserves a signed Harvest direct-expense amount', async () => {
    const path = join(snapshotDir, 'raw', 'expenses.jsonl')
    const source = await readFile(path, 'utf8')
    expect(source).toContain('"total_cost":100')
    await writeFile(path, source.replace('"total_cost":100', '"total_cost":-100'))
    await refreshChecksum(snapshotDir)

    await runLoad({ snapshotDir, databasePath })
    const db = new BetterSqlite3(databasePath, { readonly: true })
    try {
      expect(
        db
          .prepare(`SELECT total_cost_cents FROM expenses WHERE harvest_id = 152975212`)
          .get(),
      ).toEqual({ total_cost_cents: -10_000 })
    } finally {
      db.close()
    }
  }, 30_000)

  it('[integration] rejects an estimate-message identity owned by another estimate', async () => {
    await runLoad({ snapshotDir, databasePath })
    const db = new BetterSqlite3(databasePath)
    try {
      db.prepare(
        `INSERT INTO estimates (
          harvest_id, client_id, number, currency, issue_date, created_at, updated_at
        ) SELECT 920002, client_id, 'EST-OTHER', currency, issue_date, created_at, updated_at
          FROM estimates WHERE harvest_id = 920001`,
      ).run()
      db.prepare(
        `UPDATE estimate_messages SET estimate_id =
          (SELECT id FROM estimates WHERE harvest_id = 920002)
        WHERE harvest_id = 921001`,
      ).run()
      db.prepare(`DELETE FROM _ezacto_load_progress WHERE resource = 'estimates'`).run()
    } finally {
      db.close()
    }

    await expect(runLoad({ snapshotDir, databasePath })).rejects.toThrow(/estimate.*identity/i)
    const after = new BetterSqlite3(databasePath, { readonly: true })
    try {
      expect(
        after
          .prepare(
            `SELECT estimate.harvest_id AS estimate_harvest_id
            FROM estimate_messages message
            JOIN estimates estimate ON estimate.id = message.estimate_id
            WHERE message.harvest_id = 921001`,
          )
          .get(),
      ).toEqual({ estimate_harvest_id: 920002 })
      expect(
        after
          .prepare(
            `SELECT count(*) AS count FROM _ezacto_load_progress WHERE resource = 'estimates'`,
          )
          .get(),
      ).toEqual({ count: 0 })
    } finally {
      after.close()
    }
  }, 30_000)

  it('[integration] fails a three-decimal money token before inserting its resource row', async () => {
    const path = join(snapshotDir, 'raw', 'expenses.jsonl')
    await writeFile(
      path,
      (await readFile(path, 'utf8')).replace('"total_cost":81.25', '"total_cost":81.251'),
    )
    await refreshChecksum(snapshotDir)
    await expect(runLoad({ snapshotDir, databasePath })).rejects.toThrow('plain decimal')
    const db = new BetterSqlite3(databasePath, { readonly: true })
    try {
      expect(db.prepare('SELECT count(*) AS count FROM expenses').get()).toEqual({ count: 0 })
    } finally {
      db.close()
    }
  }, 30_000)

  it('[integration] refuses a missing billed invoice before advancing load progress', async () => {
    const path = join(snapshotDir, 'raw', 'time_entries.jsonl')
    await writeFile(path, (await readFile(path, 'utf8')).replace('"id":12000001', '"id":99999999'))
    await refreshChecksum(snapshotDir)

    await expect(runLoad({ snapshotDir, databasePath })).rejects.toThrow(
      /dangling_fk raw\/time_entries\.jsonl:1\.invoice\.id/,
    )
    const db = new BetterSqlite3(databasePath, { readonly: true })
    try {
      expect(db.prepare('SELECT count(*) AS count FROM _ezacto_load_progress').get()).toEqual({
        count: 0,
      })
    } finally {
      db.close()
    }
  }, 30_000)

  it('[integration] requires the verified checksum and binds load overrides to durable progress', async () => {
    const checksumsPath = join(snapshotDir, 'checksums.json')
    const checksums = JSON.parse(await readFile(checksumsPath, 'utf8')) as ChecksumReport
    checksums.snapshot_sha256 = '0'.repeat(64)
    const { report_sha256: previous, ...payload } = checksums
    void previous
    checksums.report_sha256 = checksumReportDigest(payload)
    await writeFile(checksumsPath, `${JSON.stringify(checksums)}\n`)
    await expect(runLoad({ snapshotDir, databasePath })).rejects.toThrow('has not passed verify')

    await refreshChecksum(snapshotDir)
    await runLoad({
      snapshotDir,
      databasePath,
      organizationCurrency: 'usd',
      organizationAddress: 'Sanitized address A',
    })
    await expect(
      runLoad({
        snapshotDir,
        databasePath,
        organizationCurrency: 'EUR',
        organizationAddress: 'Sanitized address A',
      }),
    ).rejects.toThrow('different snapshot')
    await expect(
      runLoad({
        snapshotDir,
        databasePath,
        organizationCurrency: 'USD',
        organizationAddress: 'Sanitized address B',
      }),
    ).rejects.toThrow('different snapshot')
  }, 30_000)

  it('[integration] rejects report evidence edited after verify', async () => {
    const checksumsPath = join(snapshotDir, 'checksums.json')
    const checksums = JSON.parse(await readFile(checksumsPath, 'utf8')) as ChecksumReport
    checksums.reports.tampered = [{ total_hours: 999 }]
    await writeFile(checksumsPath, `${JSON.stringify(checksums)}\n`)
    await expect(runLoad({ snapshotDir, databasePath })).rejects.toThrow('report evidence')
  }, 30_000)

  it('[integration] records source rate drift while loading the derived chain', async () => {
    const path = join(snapshotDir, 'raw', 'billable_rates.jsonl')
    await writeFile(
      path,
      (await readFile(path, 'utf8')).replace('"end_date":"2026-06-30"', '"end_date":"2026-06-29"'),
    )
    await refreshChecksum(snapshotDir)

    const result = await runLoad({ snapshotDir, databasePath })
    expect(result.anomalies).toContainEqual(
      expect.objectContaining({
        resource: 'billable_rates',
        source_id: '81001',
        kind: 'rate_chain_mismatch',
      }),
    )
    const db = new BetterSqlite3(databasePath, { readonly: true })
    try {
      expect(
        db.prepare('SELECT end_date FROM user_billable_rates WHERE harvest_id = 81001').get(),
      ).toEqual({ end_date: '2026-06-30' })
    } finally {
      db.close()
    }
  }, 30_000)

  it('[integration] loads an expense when its receipt has a recorded download anomaly', async () => {
    const manifest = await readManifest(snapshotDir)
    delete manifest.binaries?.receipts['152975211']
    manifest.binaries?.anomalies.push({
      kind: 'download_failed',
      resource: 'receipt',
      source_id: 152975211,
      message: 'request_failed',
    })
    await writeManifest(snapshotDir, manifest)
    await refreshChecksum(snapshotDir)

    const result = await runLoad({ snapshotDir, databasePath })
    expect(result.anomalies).toContainEqual({
      resource: 'expenses',
      source_id: '152975211',
      kind: 'receipt_download_missing',
      detail: 'download_failed:request_failed',
    })
    const db = new BetterSqlite3(databasePath, { readonly: true })
    try {
      expect(db.prepare('SELECT count(*) AS count FROM expenses').get()).toEqual({ count: 2 })
      expect(db.prepare('SELECT count(*) AS count FROM harvest_expense_receipts').get()).toEqual({
        count: 0,
      })
    } finally {
      db.close()
    }
  }, 30_000)

  it('[integration] resolves an older unknown team feature from the completed child sweep', async () => {
    const manifest = await readManifest(snapshotDir)
    manifest.preflight.team_feature = 'unknown'
    await writeManifest(snapshotDir, manifest)
    await refreshChecksum(snapshotDir)
    await runLoad({ snapshotDir, databasePath })
    const db = new BetterSqlite3(databasePath, { readonly: true })
    try {
      const modules = JSON.parse(
        (
          db.prepare('SELECT modules FROM organizations').get() as {
            modules: string
          }
        ).modules,
      ) as Record<string, unknown>
      expect(modules.team).toBe(true)
      expect(Object.values(modules)).not.toContain('unknown')
    } finally {
      db.close()
    }
  }, 30_000)

  it('[integration] refuses implicit owner elevation from a non-admin snapshot', async () => {
    const manifest = await readManifest(snapshotDir)
    manifest.preflight.user.is_administrator = false
    manifest.preflight.user.access_roles = ['member']
    await writeManifest(snapshotDir, manifest)
    await refreshChecksum(snapshotDir)
    await expect(runLoad({ snapshotDir, databasePath })).rejects.toThrow('privilege elevation')
  }, 30_000)

  it('[integration] loads through the D1 adapter with pinned immutable artifacts', async () => {
    const miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: ['DB'],
    })
    try {
      const d1 = await miniflare.getD1Database('DB')
      await migrateD1(d1)
      const database = createD1Database(d1)
      const checksum = JSON.parse(await readFile(join(snapshotDir, 'checksums.json'), 'utf8')) as {
        snapshot_sha256: string
      }
      let complete = false
      let invocations = 0
      while (!complete) {
        const result = await loadNextChunk({
          database,
          snapshotDir,
          maxRows: 2,
          immutableSnapshotSha256: checksum.snapshot_sha256,
        })
        complete = result.complete
        invocations += 1
      }
      expect(invocations).toBeGreaterThan(10)
      expect(
        (await d1.prepare('SELECT count(*) AS count FROM time_entries').first<{ count: number }>())
          ?.count,
      ).toBe(2)
      await expect(
        loadNextChunk({
          database,
          snapshotDir,
          maxStatements: 1000,
          immutableSnapshotSha256: checksum.snapshot_sha256,
        }),
      ).rejects.toThrow('reserves query overhead')
    } finally {
      await miniflare.dispose()
    }
  }, 30_000)

  it('[integration] resumes cold D1 admission and streams a high-cardinality rate history', async () => {
    const ratePath = join(snapshotDir, 'raw', 'billable_rates.jsonl')
    const lineagePath = join(snapshotDir, 'raw', 'billable_rates.lineage.jsonl')
    const count = 260
    const rates = Array.from({ length: count }, (_, index) => {
      const start = new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10)
      const next =
        index + 1 === count
          ? null
          : new Date(Date.UTC(2024, 0, 2 + index)).toISOString().slice(0, 10)
      return {
        id: 820_000 + index,
        amount: 100 + index,
        start_date: start,
        end_date:
          next === null
            ? null
            : new Date(Date.parse(`${next}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10),
        created_at: '2026-08-27T15:30:00Z',
        updated_at: '2026-08-27T15:30:00Z',
      }
    })
    const extractionOrder = [...rates].reverse()
    await writeFile(ratePath, `${extractionOrder.map((rate) => JSON.stringify(rate)).join('\n')}\n`)
    await writeFile(
      lineagePath,
      `${extractionOrder
        .map((rate) => JSON.stringify({ source_id: rate.id, parent_id: 1782959 }))
        .join('\n')}\n`,
    )
    const manifest = await readManifest(snapshotDir)
    manifest.resources.billable_rates!.count = count
    await writeManifest(snapshotDir, manifest)
    await refreshChecksum(snapshotDir)
    const checksum = JSON.parse(await readFile(join(snapshotDir, 'checksums.json'), 'utf8')) as {
      snapshot_sha256: string
    }

    const miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: ['DB'],
    })
    try {
      const d1 = await miniflare.getD1Database('DB')
      await migrateD1(d1)
      let complete = false
      let admissionSteps = 0
      let sawLoadedResource = false
      let invocations = 0
      let restoreLineageAfterCall: string | null = null
      let provedLineageResume = false
      let cleanupSteps = 0
      while (!complete) {
        let prepared = 0
        const cold = new Proxy(d1, {
          get(target, property, receiver) {
            if (property === 'prepare') {
              return (sql: string) => {
                prepared += 1
                return target.prepare(sql)
              }
            }
            const value = Reflect.get(target, property, receiver) as unknown
            return typeof value === 'function' ? value.bind(target) : value
          },
        })
        const result = await loadNextChunk({
          database: createD1Database(cold),
          snapshotDir,
          maxRows: 10_000,
          maxStatements: 40,
          immutableSnapshotSha256: checksum.snapshot_sha256,
        })
        if (restoreLineageAfterCall !== null) {
          await writeFile(lineagePath, restoreLineageAfterCall)
          restoreLineageAfterCall = null
          provedLineageResume = true
        }
        expect(prepared).toBeLessThanOrEqual(1000)
        if (!result.complete && result.resource === null) {
          expect(sawLoadedResource).toBe(false)
          admissionSteps += 1
        } else if (result.resource !== null) {
          sawLoadedResource = true
        }
        const rateProgress = await d1
          .prepare(
            `SELECT source_lineage_byte_offset AS lineageOffset, staged_rows AS stagedRows,
              loaded_rows AS loadedRows, cleaned_rows AS cleanedRows
             FROM _ezacto_load_rate_progress WHERE resource = 'billable_rates'`,
          )
          .first<{
            lineageOffset: number
            stagedRows: number
            loadedRows: number
            cleanedRows: number
          }>()
        if (rateProgress?.loadedRows === count && rateProgress.cleanedRows > 0) {
          cleanupSteps += 1
          expect(
            (
              await d1
                .prepare('SELECT count(*) AS count FROM _ezacto_load_billable_rates')
                .first<{ count: number }>()
            )?.count,
          ).toBe(count - rateProgress.cleanedRows)
        }
        if (
          rateProgress !== null &&
          rateProgress.stagedRows > 0 &&
          rateProgress.stagedRows < count &&
          rateProgress.lineageOffset > 0 &&
          !provedLineageResume &&
          restoreLineageAfterCall === null
        ) {
          const original = await readFile(lineagePath, 'utf8')
          const poisoned = original.replace('"source_id":820259', '"source_id":920259')
          expect(Buffer.byteLength(poisoned)).toBe(Buffer.byteLength(original))
          expect(poisoned).not.toBe(original)
          await writeFile(lineagePath, poisoned)
          restoreLineageAfterCall = original
        }
        complete = result.complete
        invocations += 1
        expect(invocations).toBeLessThan(200)
      }
      // Two incomplete calls plus the call that finishes indexing and begins the
      // organization prove the 260-row parent was not admitted as one sweep.
      expect(admissionSteps).toBeGreaterThanOrEqual(2)
      expect(invocations).toBeGreaterThan(30)
      expect(provedLineageResume).toBe(true)
      expect(cleanupSteps).toBeGreaterThan(1)
      expect(
        await d1
          .prepare(
            `SELECT harvest_id, start_date, end_date
             FROM user_billable_rates ORDER BY start_date, harvest_id`,
          )
          .all(),
      ).toMatchObject({
        results: rates.map((rate) => ({
          harvest_id: rate.id,
          start_date: rate.start_date,
          end_date: rate.end_date,
        })),
      })
      expect(
        (await d1.prepare('SELECT count(*) AS count FROM _ezacto_load_billable_rates').first())
          ?.count,
      ).toBe(0)
      expect(
        (
          await d1
            .prepare(
              `SELECT count(*) AS count FROM _ezacto_load_rate_progress
               WHERE resource = 'billable_rates'`,
            )
            .first()
        )?.count,
      ).toBe(0)
    } finally {
      await miniflare.dispose()
    }
  }, 70_000)

  it('[integration] resumes generic child lineage from its durable byte cursor', async () => {
    const userPath = join(snapshotDir, 'raw', 'users.jsonl')
    const originalUsers = (await readFile(userPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const member = originalUsers.find((user) => user.id === 1782960)!
    const count = 240
    const teammateIds = Array.from({ length: count }, (_, index) => 1_900_000 + index)
    const users = [
      ...originalUsers,
      ...teammateIds.map((id) => ({
        ...member,
        id,
        email: `lineage-${id}@example.invalid`,
      })),
    ]
    await writeFile(userPath, `${users.map((row) => JSON.stringify(row)).join('\n')}\n`)

    const teammatePath = join(snapshotDir, 'raw', 'teammates.jsonl')
    const lineagePath = join(snapshotDir, 'raw', 'teammates.lineage.jsonl')
    const teammate = JSON.parse((await readFile(teammatePath, 'utf8')).trim()) as Record<
      string,
      unknown
    >
    await writeFile(
      teammatePath,
      `${teammateIds.map((id) => JSON.stringify({ ...teammate, id })).join('\n')}\n`,
    )
    await writeFile(
      lineagePath,
      `${teammateIds
        .map((sourceId) => JSON.stringify({ source_id: sourceId, parent_id: 1782959 }))
        .join('\n')}\n`,
    )
    const manifest = await readManifest(snapshotDir)
    manifest.resources.users!.count = users.length
    manifest.resources.teammates!.count = teammateIds.length
    await writeManifest(snapshotDir, manifest)
    await refreshChecksum(snapshotDir)
    const checksum = JSON.parse(await readFile(join(snapshotDir, 'checksums.json'), 'utf8')) as {
      snapshot_sha256: string
    }

    const miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: ['DB'],
    })
    try {
      const d1 = await miniflare.getD1Database('DB')
      await migrateD1(d1)
      let complete = false
      let invocations = 0
      let teammateSteps = 0
      const recoveryCheckpoints: number[] = []
      let restoreLineageAfterCall: string | null = null
      let provedLineageResume = false
      let installedDeepLegacyCheckpoint = false
      while (!complete) {
        let prepared = 0
        const cold = new Proxy(d1, {
          get(target, property, receiver) {
            if (property === 'prepare') {
              return (sql: string) => {
                prepared += 1
                return target.prepare(sql)
              }
            }
            const value = Reflect.get(target, property, receiver) as unknown
            return typeof value === 'function' ? value.bind(target) : value
          },
        })
        const result = await loadNextChunk({
          database: createD1Database(cold),
          snapshotDir,
          maxRows: 225,
          maxStatements: 230,
          immutableSnapshotSha256: checksum.snapshot_sha256,
        })
        if (restoreLineageAfterCall !== null) {
          await writeFile(lineagePath, restoreLineageAfterCall)
          restoreLineageAfterCall = null
          provedLineageResume = true
        }
        expect(prepared).toBeLessThanOrEqual(1000)
        if (result.resource === 'teammates') {
          teammateSteps += 1
          if (!installedDeepLegacyCheckpoint) {
            expect(result.loadedRows).toBe(225)
            // Model an in-flight database created by the prior loader: domain
            // progress is deep in one parent group but no cursor table exists.
            await d1.exec('DROP TABLE _ezacto_load_lineage_progress')
            installedDeepLegacyCheckpoint = true
          } else if (result.loadedRows === 0) {
            const checkpoint = await d1
              .prepare(
                `SELECT rows_scanned AS rowsScanned, byte_offset AS byteOffset
                 FROM _ezacto_load_lineage_progress WHERE resource = 'teammates'`,
              )
              .first<{ rowsScanned: number; byteOffset: number }>()
            expect(checkpoint?.byteOffset).toBeGreaterThan(0)
            recoveryCheckpoints.push(checkpoint!.rowsScanned)
          }
          if (
            recoveryCheckpoints.at(-1) === 225 &&
            !provedLineageResume &&
            restoreLineageAfterCall === null
          ) {
            const checkpoint = await d1
              .prepare(
                `SELECT byte_offset AS byteOffset
                 FROM _ezacto_load_lineage_progress WHERE resource = 'teammates'`,
              )
              .first<{ byteOffset: number }>()
            const original = await readFile(lineagePath, 'utf8')
            const firstBoundary = original.indexOf('\n')
            expect(firstBoundary).toBeGreaterThan(0)
            expect(firstBoundary).toBeLessThan(checkpoint!.byteOffset)
            // Same-size damage before the durable cursor changes the legacy
            // line count. A retry that scans from the parent origin misaligns;
            // a cursor-based retry never opens this consumed prefix.
            const poisoned = `${original.slice(0, firstBoundary)} ${original.slice(firstBoundary + 1)}`
            expect(Buffer.byteLength(poisoned)).toBe(Buffer.byteLength(original))
            await writeFile(lineagePath, poisoned)
            restoreLineageAfterCall = original
          }
        }
        complete = result.complete
        invocations += 1
        expect(invocations).toBeLessThan(250)
      }
      expect(recoveryCheckpoints).toEqual([100, 200, 225])
      expect(provedLineageResume).toBe(true)
      expect(teammateSteps).toBe(5)
      expect(
        (await d1.prepare('SELECT count(*) AS count FROM teammate_assignments').first())?.count,
      ).toBe(count)
    } finally {
      await miniflare.dispose()
    }
  }, 70_000)

  it('[integration] checkpoints legacy organization-currency inference in bounded cold windows', async () => {
    const clientPath = join(snapshotDir, 'raw', 'clients.jsonl')
    const originalClients = (await readFile(clientPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const clients = Array.from({ length: 260 }, (_, index) => ({
      ...(originalClients[index] ?? originalClients[0]),
      id: originalClients[index]?.id ?? 600_000 + index,
      name: `Sanitized Client ${index}`,
    }))
    await writeFile(clientPath, `${clients.map((row) => JSON.stringify(row)).join('\n')}\n`)
    const manifest = await readManifest(snapshotDir)
    manifest.preflight.organization_currency = null
    manifest.resources.clients!.count = clients.length
    await writeManifest(snapshotDir, manifest)
    await refreshChecksum(snapshotDir)

    for (const expected of [100, 200]) {
      const sqlite = new BetterSqlite3(databasePath)
      try {
        migrateContainer(sqlite)
        const result = await loadNextChunk({
          database: createContainerDatabase(sqlite),
          snapshotDir,
          maxRows: 1,
        })
        expect(result.resource).toBeNull()
        expect(
          sqlite
            .prepare(
              `SELECT rows_scanned AS rowsScanned, currency, completed
               FROM _ezacto_load_currency_progress WHERE singleton = 1`,
            )
            .get(),
        ).toEqual({ rowsScanned: expected, currency: 'USD', completed: 0 })
      } finally {
        sqlite.close()
      }
    }
    const sqlite = new BetterSqlite3(databasePath)
    try {
      migrateContainer(sqlite)
      expect(
        (
          await loadNextChunk({
            database: createContainerDatabase(sqlite),
            snapshotDir,
            maxRows: 1,
          })
        ).resource,
      ).toBe('organization')
      expect(
        sqlite.prepare('SELECT 1 FROM _ezacto_load_currency_progress WHERE singleton = 1').get(),
      ).toBeUndefined()
    } finally {
      sqlite.close()
    }
  }, 30_000)

  it('[integration] serializes concurrent index builders and reclaims crash artifacts', async () => {
    const userPath = join(snapshotDir, 'raw', 'users.jsonl')
    const originalUsers = (await readFile(userPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const users = Array.from({ length: 180 }, (_, index) => ({
      ...(originalUsers[index] ?? originalUsers[0]),
      id: originalUsers[index]?.id ?? 1_700_000 + index,
      email: originalUsers[index]?.email ?? `concurrent-${index}@example.invalid`,
    }))
    await writeFile(userPath, `${users.map((row) => JSON.stringify(row)).join('\n')}\n`)
    const manifest = await readManifest(snapshotDir)
    manifest.preflight.organization_currency = 'USD'
    manifest.resources.users!.count = users.length
    await writeManifest(snapshotDir, manifest)
    await refreshChecksum(snapshotDir)

    const sqlite = new BetterSqlite3(databasePath)
    try {
      migrateContainer(sqlite)
      const database = createContainerDatabase(sqlite)
      const first = await loadNextChunk({ database, snapshotDir, maxRows: 1 })
      expect(first.resource).toBeNull()
      const indexDirectory = join(snapshotDir, 'raw', '.load-index')
      const state = (await readdir(indexDirectory)).find((entry) => entry.endsWith('.state.json'))
      expect(state).toBeDefined()
      await writeFile(join(indexDirectory, `${state!}.2147483647.dead.tmp`), 'torn')
      await mkdir(join(indexDirectory, '.builder.lock.claim-2147483647-crashed'))
      const lock = join(indexDirectory, '.builder.lock')
      await mkdir(lock)
      await writeFile(
        join(lock, 'owner.json'),
        `${JSON.stringify({
          pid: 2_147_483_647,
          host: hostname(),
          token: 'crashed-index-build',
          startedAt: 0,
        })}\n`,
      )

      await Promise.all([
        loadNextChunk({ database, snapshotDir, maxRows: 1 }),
        loadNextChunk({ database, snapshotDir, maxRows: 1 }),
      ])
      const after = await readdir(indexDirectory)
      expect(after.some((entry) => entry.endsWith('.tmp'))).toBe(false)
      expect(after.some((entry) => entry.startsWith('.builder.lock.claim-'))).toBe(false)
      expect(after).not.toContain('.builder.lock')
      expect(after.some((entry) => entry.startsWith('.builder.lock.stale-'))).toBe(true)

      await mkdir(lock)
      await writeFile(
        join(lock, 'owner.json'),
        `${JSON.stringify({
          pid: 1,
          host: 'active-remote-host.invalid',
          token: 'active-remote-index-build',
          startedAt: Date.now(),
        })}\n`,
      )
      await expect(loadNextChunk({ database, snapshotDir, maxRows: 1 })).rejects.toThrow(
        'already being built',
      )
      await rm(lock, { recursive: true })

      await mkdir(lock)
      await writeFile(
        join(lock, 'owner.json'),
        `${JSON.stringify({
          pid: 1,
          host: 'crashed-remote-host.invalid',
          token: 'crashed-remote-index-build',
          startedAt: 0,
        })}\n`,
      )
      await loadNextChunk({ database, snapshotDir, maxRows: 1 })
      expect(
        (await readdir(indexDirectory)).filter((entry) => entry.startsWith('.builder.lock.stale-')),
      ).toHaveLength(2)

      let reachedLoad = false
      for (let invocation = 0; invocation < 20 && !reachedLoad; invocation += 1) {
        reachedLoad = (await loadNextChunk({ database, snapshotDir, maxRows: 1 })).resource !== null
      }
      expect(reachedLoad).toBe(true)
    } finally {
      sqlite.close()
    }
  }, 30_000)

  it('[integration] invalidates and rebuilds a corrupt same-size child index', async () => {
    const userPath = join(snapshotDir, 'raw', 'users.jsonl')
    const users = (await readFile(userPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    users.push(
      { ...users[0], id: 1_782_961, email: 'index-one@example.invalid' },
      { ...users[0], id: 1_782_962, email: 'index-two@example.invalid' },
    )
    await writeFile(userPath, `${users.map((row) => JSON.stringify(row)).join('\n')}\n`)
    const rawPath = join(snapshotDir, 'raw', 'teammates.jsonl')
    const lineagePath = join(snapshotDir, 'raw', 'teammates.lineage.jsonl')
    const teammate = JSON.parse((await readFile(rawPath, 'utf8')).trim()) as Record<string, unknown>
    const teammateIds = [1_782_959, 1_782_961, 1_782_962, 1_782_960]
    await writeFile(
      rawPath,
      `${teammateIds.map((id) => JSON.stringify({ ...teammate, id })).join('\n')}\n`,
    )
    await writeFile(
      lineagePath,
      `${teammateIds
        .map((sourceId, index) =>
          JSON.stringify({ source_id: sourceId, parent_id: users[index]!.id }),
        )
        .join('\n')}\n`,
    )
    const manifest = await readManifest(snapshotDir)
    manifest.resources.users!.count = users.length
    manifest.resources.teammates!.count = teammateIds.length
    await writeManifest(snapshotDir, manifest)
    await refreshChecksum(snapshotDir)

    const sqlite = new BetterSqlite3(databasePath)
    try {
      migrateContainer(sqlite)
      const database = createContainerDatabase(sqlite)
      const admitted = await loadNextChunk({ database, snapshotDir, maxRows: 1 })
      const indexPath = join(
        snapshotDir,
        'raw',
        '.load-index',
        `teammates.${admitted.snapshotSha256}.idx`,
      )
      const records = (await readFile(indexPath, 'utf8'))
        .trimEnd()
        .split('\n')
        .map((line) => line.split(' '))
      expect(records).toHaveLength(users.length)
      // A prior implementation accepted this fixed-size edit and silently
      // treated the first parent's real child as an empty group.
      records[1]![6] = '000000000000'
      await writeFile(indexPath, `${records.map((fields) => fields.join(' ')).join('\n')}\n`)

      let complete = false
      let rejectedCorruption = false
      for (let invocation = 0; invocation < 100 && !complete; invocation += 1) {
        try {
          complete = (await loadNextChunk({ database, snapshotDir, maxRows: 1 })).complete
        } catch (error) {
          expect((error as Error).message).toMatch(/teammates child index/)
          rejectedCorruption = true
        }
      }
      expect(rejectedCorruption).toBe(true)
      expect(complete).toBe(true)
      expect(sqlite.prepare('SELECT count(*) AS count FROM teammate_assignments').get()).toEqual({
        count: teammateIds.length,
      })
    } finally {
      sqlite.close()
    }
  }, 30_000)

  it('[integration] durably partitions high-fanout roles, estimates, and invoices', async () => {
    const rolePath = join(snapshotDir, 'raw', 'roles.jsonl')
    const role = JSON.parse((await readFile(rolePath, 'utf8')).trim()) as Record<string, unknown>
    role.user_ids = Array.from({ length: 705 }, (_, index) => (index % 2 === 0 ? 1782959 : 1782960))
    await writeFile(rolePath, `${JSON.stringify(role)}\n`)

    const estimateResourcePath = join(snapshotDir, 'raw', 'estimates.jsonl')
    const estimate = JSON.parse((await readFile(estimateResourcePath, 'utf8')).trim()) as Record<
      string,
      unknown
    >
    const originalEstimateLines = estimate.line_items as Array<Record<string, unknown>>
    estimate.line_items = Array.from({ length: 9 }, (_, index) =>
      index < originalEstimateLines.length
        ? originalEstimateLines[index]
        : {
            ...originalEstimateLines[0],
            id: 922000 + index,
            quantity: 0,
            unit_price: 0,
            amount: 0,
            taxed: false,
            taxed2: false,
          },
    )
    await writeFile(estimateResourcePath, `${JSON.stringify(estimate)}\n`)

    const estimatePath = join(snapshotDir, 'raw', 'estimate_messages.jsonl')
    const estimateLineagePath = join(snapshotDir, 'raw', 'estimate_messages.lineage.jsonl')
    const estimateMessage = JSON.parse((await readFile(estimatePath, 'utf8')).trim()) as Record<
      string,
      unknown
    >
    const estimateMessages = Array.from({ length: 40 }, (_, index) => ({
      ...estimateMessage,
      id: 921001 + index,
    }))
    await writeFile(
      estimatePath,
      `${estimateMessages.map((row) => JSON.stringify(row)).join('\n')}\n`,
    )
    await writeFile(
      estimateLineagePath,
      `${estimateMessages
        .map((row) =>
          JSON.stringify({
            source_id: row.id,
            parent_id: 920001,
          }),
        )
        .join('\n')}\n`,
    )

    const invoicePath = join(snapshotDir, 'raw', 'invoice_messages.jsonl')
    const invoiceLineagePath = join(snapshotDir, 'raw', 'invoice_messages.lineage.jsonl')
    const invoiceMessage = JSON.parse((await readFile(invoicePath, 'utf8')).trim()) as Record<
      string,
      unknown
    >
    const invoiceMessages = Array.from({ length: 40 }, (_, index) => ({
      ...invoiceMessage,
      id: 6850100 + index,
    }))
    await writeFile(
      invoicePath,
      `${invoiceMessages.map((row) => JSON.stringify(row)).join('\n')}\n`,
    )
    await writeFile(
      invoiceLineagePath,
      `${invoiceMessages
        .map((row) =>
          JSON.stringify({
            source_id: row.id,
            parent_id: 13150403,
          }),
        )
        .join('\n')}\n`,
    )

    const manifest = await readManifest(snapshotDir)
    manifest.resources.estimate_messages!.count = estimateMessages.length
    manifest.resources.invoice_messages!.count = invoiceMessages.length
    await writeManifest(snapshotDir, manifest)
    await refreshChecksum(snapshotDir)

    const result = await runLoad({ snapshotDir, databasePath, maxStatements: 20, maxRows: 2 })
    expect(result.invocations).toBeGreaterThan(40)
    const db = new BetterSqlite3(databasePath, { readonly: true })
    try {
      expect(db.prepare('SELECT count(*) AS count FROM user_roles').get()).toEqual({ count: 2 })
      expect(db.prepare('SELECT count(*) AS count FROM estimate_messages').get()).toEqual({
        count: estimateMessages.length,
      })
      expect(db.prepare('SELECT count(*) AS count FROM estimate_line_items').get()).toEqual({
        count: 9,
      })
      expect(db.prepare('SELECT count(*) AS count FROM invoice_messages').get()).toEqual({
        count: invoiceMessages.length,
      })
      expect(db.prepare('SELECT count(*) AS count FROM _ezacto_load_subprogress').get()).toEqual({
        count: 0,
      })
      expect(
        db
          .prepare(
            `SELECT count(*) AS count FROM invoice_import_reconciliations
        WHERE completed = 0`,
          )
          .get(),
      ).toEqual({ count: 0 })
    } finally {
      db.close()
    }
  }, 30_000)

  it('[integration] keeps a 700-line D1 invoice under the total invocation query budget', async () => {
    const taskPath = join(snapshotDir, 'raw', 'tasks.jsonl')
    const task = JSON.parse((await readFile(taskPath, 'utf8')).trim()) as Record<string, unknown>
    const tasks = Array.from({ length: 700 }, (_, index) => ({
      ...task,
      id: 51001 + index,
      name: `Migration ${index}`,
    }))
    await writeFile(taskPath, `${tasks.map((row) => JSON.stringify(row)).join('\n')}\n`)
    const taskAssignmentPath = join(snapshotDir, 'raw', 'task_assignments.jsonl')
    const taskAssignment = JSON.parse(
      (await readFile(taskAssignmentPath, 'utf8')).trim(),
    ) as Record<string, unknown>
    const taskAssignments = Array.from({ length: 700 }, (_, index) => ({
      ...taskAssignment,
      id: 53001 + index,
      task: { id: 51001 + index },
    }))
    await writeFile(
      taskAssignmentPath,
      `${taskAssignments.map((row) => JSON.stringify(row)).join('\n')}\n`,
    )
    const invoicePath = join(snapshotDir, 'raw', 'invoices.jsonl')
    const invoices = (await readFile(invoicePath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const sourceLines = invoices[0]!.line_items as Array<Record<string, unknown>>
    invoices[0]!.line_items = Array.from({ length: 700 }, (_, index) =>
      index < sourceLines.length
        ? sourceLines[index]
        : {
            ...sourceLines[1],
            id: 53_340_000 + index,
            quantity: 0,
            unit_price: 0,
            amount: 0,
            taxed: false,
            taxed2: false,
          },
    )
    await writeFile(
      invoicePath,
      `${invoices.map((invoice) => JSON.stringify(invoice)).join('\n')}\n`,
    )
    const manifest = await readManifest(snapshotDir)
    manifest.resources.tasks!.count = tasks.length
    manifest.resources.task_assignments!.count = taskAssignments.length
    await writeManifest(snapshotDir, manifest)
    await refreshChecksum(snapshotDir)

    const miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: ['DB'],
    })
    try {
      const d1 = await miniflare.getD1Database('DB')
      await migrateD1(d1)
      let prepared = 0
      const counted = new Proxy(d1, {
        get(target, property, receiver) {
          if (property === 'prepare') {
            return (sql: string) => {
              prepared += 1
              return target.prepare(sql)
            }
          }
          const value = Reflect.get(target, property, receiver) as unknown
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      const database = createD1Database(counted)
      const checksum = JSON.parse(await readFile(join(snapshotDir, 'checksums.json'), 'utf8')) as {
        snapshot_sha256: string
      }
      let complete = false
      let invoiceSteps = 0
      while (!complete) {
        prepared = 0
        const result = await loadNextChunk({
          database,
          snapshotDir,
          maxRows: 700,
          maxStatements: 700,
          immutableSnapshotSha256: checksum.snapshot_sha256,
        })
        expect(prepared).toBeLessThanOrEqual(1000)
        complete = result.complete
        if (result.resource === 'invoices') invoiceSteps += 1
      }
      expect(invoiceSteps).toBeGreaterThan(2)
      expect(
        (await d1.prepare('SELECT count(*) AS count FROM task_assignments').first())?.count,
      ).toBe(700)
      expect(
        (await d1.prepare('SELECT count(*) AS count FROM invoice_line_items').first())?.count,
      ).toBe(700)
      expect(
        (
          await d1
            .prepare(
              `SELECT count(*) AS count FROM invoice_import_reconciliations
        WHERE completed = 0`,
            )
            .first()
        )?.count,
      ).toBe(0)
    } finally {
      await miniflare.dispose()
    }
  }, 60_000)

  it('[property] never plans more than 100 bindings per statement', () => {
    for (let columns = 1; columns <= D1_MAX_BOUND_PARAMETERS; columns += 1) {
      const rows = Array.from({ length: 233 }, (_, index) => index)
      for (const batch of boundedInsertBatches(rows, columns)) {
        const statement = { sql: 'SELECT 1', bindings: Array(batch.length * columns).fill(1) }
        expect(() => assertD1Statements([statement])).not.toThrow()
        expect(statement.bindings.length).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS)
      }
    }
    expect(() => assertD1Statements([{ sql: 'SELECT 1', bindings: Array(101).fill(1) }])).toThrow(
      'D1 permits 100',
    )
  })
})
