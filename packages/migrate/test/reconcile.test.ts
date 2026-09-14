import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import {
  applyRetainerWorksheet,
  generateRetainerWorksheet,
} from '../src/worksheets.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runLoad } from '../src/load.js'
import {
  reconciliationExitCode,
  runReconcile,
  type ReconciliationReport,
} from '../src/reconcile.js'
import { readManifest, writeManifest } from '../src/manifest.js'
import {
  checksumReportDigest,
  reportChunkKey,
  snapshotDigest,
  splitReportRange,
  type ChecksumReport,
  type ChecksumReportPayload,
} from '../src/verify.js'
import { buildSanitizedLoadSnapshot } from './load-fixture.js'

const generatedAt = '2026-08-27T15:30:00Z'

const timeRow = (
  idField: string,
  id: number,
  currency: string,
  totalHours: number,
  billableAmount: number,
): Record<string, unknown> => ({
  [idField]: id,
  currency,
  total_hours: totalHours,
  billable_hours: totalHours,
  billable_amount: billableAmount,
})

const expenseRow = (
  idField: string,
  id: number,
  totalAmount: number,
  currency = 'USD',
): Record<string, unknown> => ({
  [idField]: id,
  currency,
  total_amount: totalAmount,
  billable_amount: totalAmount,
})

const writePassingChecksums = async (
  snapshotDir: string,
  multiCurrency = false,
): Promise<ChecksumReport> => {
  const manifest = await readManifest(snapshotDir)
  const payload: ChecksumReportPayload = {
    version: 1,
    account_id: manifest.account.id,
    snapshot_sha256: await snapshotDigest(snapshotDir, manifest),
    generated_at: generatedAt,
    periods: [{ year: 2026, from: '2026-08-14', to: '2026-08-27' }],
    report_ranges: { uninvoiced: { from: '2026-08-14', to: '2026-08-27' } },
    reports: {
      'time/clients/2026': multiCurrency
        ? [
            timeRow('client_id', 5735776, 'USD', 1.5, 262.5),
            timeRow('client_id', 41001, 'EUR', 1.25, 218.75),
          ]
        : [timeRow('client_id', 5735776, 'USD', 2.75, 481.25)],
      'time/projects/2026': multiCurrency
        ? [
            timeRow('project_id', 14308069, 'USD', 1.5, 262.5),
            timeRow('project_id', 14308070, 'EUR', 1.25, 218.75),
          ]
        : [timeRow('project_id', 14308069, 'USD', 2.75, 481.25)],
      'time/tasks/2026': multiCurrency
        ? [
            timeRow('task_id', 51001, 'USD', 1.5, 262.5),
            timeRow('task_id', 51001, 'EUR', 1.25, 218.75),
          ]
        : [timeRow('task_id', 51001, 'USD', 2.75, 481.25)],
      'time/team/2026': [
        timeRow('user_id', 1782959, 'USD', 1.5, 262.5),
        timeRow('user_id', 1782960, multiCurrency ? 'EUR' : 'USD', 1.25, 218.75),
      ],
      'expenses/clients/2026': multiCurrency
        ? [expenseRow('client_id', 5735776, 81.25), expenseRow('client_id', 41001, 100, 'EUR')]
        : [expenseRow('client_id', 5735776, 181.25)],
      'expenses/projects/2026': multiCurrency
        ? [
            expenseRow('project_id', 14308069, 81.25),
            expenseRow('project_id', 14308070, 100, 'EUR'),
          ]
        : [expenseRow('project_id', 14308069, 181.25)],
      'expenses/categories/2026': [
        expenseRow('expense_category_id', 4195926, 81.25),
        expenseRow('expense_category_id', 4197501, 100, multiCurrency ? 'EUR' : 'USD'),
      ],
      'expenses/team/2026': multiCurrency
        ? [expenseRow('user_id', 1782959, 81.25), expenseRow('user_id', 1782959, 100, 'EUR')]
        : [expenseRow('user_id', 1782959, 181.25)],
      uninvoiced: multiCurrency
        ? [
            {
              project_id: 14308069,
              currency: 'USD',
              total_hours: 1.5,
              uninvoiced_hours: 0,
              uninvoiced_expenses: 0,
              uninvoiced_amount: 0,
            },
            {
              project_id: 14308070,
              currency: 'EUR',
              total_hours: 1.25,
              uninvoiced_hours: 1.25,
              uninvoiced_expenses: 100,
              uninvoiced_amount: 318.75,
            },
          ]
        : [
            {
              project_id: 14308069,
              currency: 'USD',
              total_hours: 2.75,
              uninvoiced_hours: 1.25,
              uninvoiced_expenses: 100,
              uninvoiced_amount: 318.75,
            },
          ],
      'project_budget/active': [
        {
          project_id: 14308069,
          is_active: true,
          budget_by: 'task_fees',
          budget_is_monthly: false,
          budget: 123.45,
          budget_spent: multiCurrency ? 262.5 : 481.25,
          budget_remaining: multiCurrency ? -139.05 : -357.8,
        },
        {
          project_id: 14308070,
          is_active: true,
          budget_by: 'project',
          budget_is_monthly: false,
          budget: 10,
          budget_spent: multiCurrency ? 1.25 : 0,
          budget_remaining: multiCurrency ? 8.75 : 10,
        },
      ],
      'project_budget/inactive': [],
    },
    requests: 12,
  }
  const report = { ...payload, report_sha256: checksumReportDigest(payload) }
  await writeFile(join(snapshotDir, 'checksums.json'), `${JSON.stringify(report, null, 2)}\n`)
  return report
}

const rewriteChecksums = async (
  snapshotDir: string,
  update: (report: ChecksumReport) => void,
): Promise<void> => {
  const path = join(snapshotDir, 'checksums.json')
  const report = JSON.parse(await readFile(path, 'utf8')) as ChecksumReport
  update(report)
  const { report_sha256: previous, ...payload } = report
  void previous
  report.report_sha256 = checksumReportDigest(payload)
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`)
}

const bindChecksumsToSnapshot = async (snapshotDir: string): Promise<void> => {
  const manifest = await readManifest(snapshotDir)
  const digest = await snapshotDigest(snapshotDir, manifest)
  await rewriteChecksums(snapshotDir, (report) => {
    report.snapshot_sha256 = digest
  })
}

const reportHash = (report: ReconciliationReport): string =>
  createHash('sha256').update(JSON.stringify(report)).digest('hex')

const makeGoldenSlicesCoherent = async (snapshotDir: string): Promise<void> => {
  const invoicePath = join(snapshotDir, 'raw', 'invoices.jsonl')
  const lines = (await readFile(invoicePath, 'utf8')).trimEnd().split('\n')
  const invoice = JSON.parse(lines[0] ?? '') as Record<string, unknown>
  // The reusable #78 fixture deliberately combines independent mapping goldens.
  // Reconciliation needs a single account view: this invoice's separate payment
  // is 125.50, so its Harvest due amount must reflect that payment as well.
  invoice.due_amount = 2149.5
  lines[0] = JSON.stringify(invoice)
  await writeFile(invoicePath, `${lines.join('\n')}\n`)

  const paymentPath = join(snapshotDir, 'raw', 'invoice_payments.jsonl')
  const payment = JSON.parse(await readFile(paymentPath, 'utf8')) as Record<string, unknown>
  payment.paid_date = '2026-08-27'
  await writeFile(paymentPath, `${JSON.stringify(payment)}\n`)
}

const makeMultiCurrencySnapshot = async (snapshotDir: string): Promise<void> => {
  const rawDir = join(snapshotDir, 'raw')
  const readRows = async (resource: string): Promise<Array<Record<string, unknown>>> =>
    (await readFile(join(rawDir, `${resource}.jsonl`), 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  const writeRows = async (
    resource: string,
    rows: Array<Record<string, unknown>>,
  ): Promise<void> => {
    await writeFile(
      join(rawDir, `${resource}.jsonl`),
      `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    )
  }

  const clients = await readRows('clients')
  clients[1]!.currency = 'EUR'
  await writeRows('clients', clients)

  const projects = await readRows('projects')
  projects[1]!.client = { id: 41001 }
  delete projects[1]!.billable_rate_currency
  await writeRows('projects', projects)

  const taskAssignments = await readRows('task_assignments')
  taskAssignments.push({
    ...taskAssignments[0],
    id: 53002,
    project: { id: 14308070 },
  })
  await writeRows('task_assignments', taskAssignments)

  const userAssignments = await readRows('user_assignments')
  userAssignments.push({
    ...userAssignments[1],
    id: 54003,
    project: { id: 14308070 },
  })
  await writeRows('user_assignments', userAssignments)

  const timePath = join(rawDir, 'time_entries.jsonl')
  const timeLines = (await readFile(timePath, 'utf8')).trimEnd().split('\n')
  const secondTimeEntry = JSON.parse(timeLines[1] ?? '') as Record<string, unknown>
  secondTimeEntry.project = { id: 14308070 }
  secondTimeEntry.task_assignment = { id: 53002 }
  secondTimeEntry.user_assignment = { id: 54003 }
  timeLines[1] = JSON.stringify(secondTimeEntry)
  await writeFile(timePath, `${timeLines.join('\n')}\n`)

  const expenses = await readRows('expenses')
  expenses[1]!.client = { id: 41001, name: 'Sanitized Client 41001', currency: 'EUR' }
  expenses[1]!.project = {
    id: 14308070,
    name: 'Sanitized Project 14308070',
    code: '14308070',
  }
  await writeRows('expenses', expenses)

  const invoices = await readRows('invoices')
  const lineItems = invoices[0]!.line_items as Array<Record<string, unknown>>
  lineItems[1]!.project = { id: 14308069, name: 'Sanitized Project 14308069', code: '14308069' }
  await writeRows('invoices', invoices)

  const manifest = await readManifest(snapshotDir)
  manifest.resources.task_assignments!.count = taskAssignments.length
  manifest.resources.user_assignments!.count = userAssignments.length
  await writeManifest(snapshotDir, manifest)
}

const prepareLeapYearSnapshot = async (
  snapshotDir: string,
  databasePath: string,
): Promise<void> => {
  await rm(snapshotDir, { recursive: true, force: true })
  await rm(databasePath, { force: true })
  await buildSanitizedLoadSnapshot(snapshotDir)
  await makeGoldenSlicesCoherent(snapshotDir)
  const rawDir = join(snapshotDir, 'raw')
  const timePath = join(rawDir, 'time_entries.jsonl')
  const timeLines = (await readFile(timePath, 'utf8')).trimEnd().split('\n')
  timeLines[0] = timeLines[0]!.replace('"spent_date":"2026-08-16"', '"spent_date":"2024-01-01"')
  timeLines[1] = timeLines[1]!.replace('"spent_date":"2026-08-27"', '"spent_date":"2024-12-31"')
  await writeFile(timePath, `${timeLines.join('\n')}\n`)
  const expensePath = join(rawDir, 'expenses.jsonl')
  const expenseLines = (await readFile(expensePath, 'utf8')).trimEnd().split('\n')
  const firstExpense = JSON.parse(expenseLines[0] ?? '') as Record<string, unknown>
  const secondExpense = JSON.parse(expenseLines[1] ?? '') as Record<string, unknown>
  firstExpense.spent_date = '2024-01-01'
  secondExpense.spent_date = '2024-12-31'
  expenseLines[0] = JSON.stringify(firstExpense)
  expenseLines[1] = JSON.stringify(secondExpense)
  await writeFile(expensePath, `${expenseLines.join('\n')}\n`)
  await writePassingChecksums(snapshotDir)
  await rewriteChecksums(snapshotDir, (report) => {
    report.generated_at = '2024-12-31T15:30:00Z'
    report.periods = [{ year: 2024, from: '2024-01-01', to: '2024-12-31' }]
    report.report_ranges.uninvoiced = { from: '2024-01-02', to: '2024-12-31' }
    report.reports.uninvoiced![0]!.total_hours = 1.25
    for (const key of Object.keys(report.reports)) {
      if (key.startsWith('time/') || key.startsWith('expenses/')) delete report.reports[key]
    }
    const chunks = splitReportRange(report.periods[0]!)
    const reportKey = (base: string, index: number): string =>
      reportChunkKey(base, chunks[index]!, chunks.length)
    report.reports[reportKey('time/clients/2024', 0)] = [
      timeRow('client_id', 5735776, 'USD', 1.5, 262.5),
    ]
    report.reports[reportKey('time/clients/2024', 1)] = [
      timeRow('client_id', 5735776, 'USD', 1.25, 218.75),
    ]
    report.reports[reportKey('time/projects/2024', 0)] = [
      timeRow('project_id', 14308069, 'USD', 1.5, 262.5),
    ]
    report.reports[reportKey('time/projects/2024', 1)] = [
      timeRow('project_id', 14308069, 'USD', 1.25, 218.75),
    ]
    report.reports[reportKey('time/tasks/2024', 0)] = [timeRow('task_id', 51001, 'USD', 1.5, 262.5)]
    report.reports[reportKey('time/tasks/2024', 1)] = [
      timeRow('task_id', 51001, 'USD', 1.25, 218.75),
    ]
    report.reports[reportKey('time/team/2024', 0)] = [
      timeRow('user_id', 1782959, 'USD', 1.5, 262.5),
    ]
    report.reports[reportKey('time/team/2024', 1)] = [
      timeRow('user_id', 1782960, 'USD', 1.25, 218.75),
    ]
    report.reports[reportKey('expenses/clients/2024', 0)] = [
      expenseRow('client_id', 5735776, 81.25),
    ]
    report.reports[reportKey('expenses/clients/2024', 1)] = [expenseRow('client_id', 5735776, 100)]
    report.reports[reportKey('expenses/projects/2024', 0)] = [
      expenseRow('project_id', 14308069, 81.25),
    ]
    report.reports[reportKey('expenses/projects/2024', 1)] = [
      expenseRow('project_id', 14308069, 100),
    ]
    report.reports[reportKey('expenses/categories/2024', 0)] = [
      expenseRow('expense_category_id', 4195926, 81.25),
    ]
    report.reports[reportKey('expenses/categories/2024', 1)] = [
      expenseRow('expense_category_id', 4197501, 100),
    ]
    report.reports[reportKey('expenses/team/2024', 0)] = [expenseRow('user_id', 1782959, 81.25)]
    report.reports[reportKey('expenses/team/2024', 1)] = [expenseRow('user_id', 1782959, 100)]
  })
  await runLoad({ snapshotDir, databasePath })
}

describe('three-way reconciliation', () => {
  let dir: string
  let snapshotDir: string
  let databasePath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ezacto-reconcile-'))
    snapshotDir = join(dir, 'snapshot')
    databasePath = join(dir, 'ezacto.sqlite')
    await buildSanitizedLoadSnapshot(snapshotDir)
    await makeGoldenSlicesCoherent(snapshotDir)
    await writePassingChecksums(snapshotDir)
    await runLoad({ snapshotDir, databasePath, organizationCurrency: 'USD' })
  }, 60_000)

  afterEach(async () => rm(dir, { recursive: true, force: true }))

  it('[integration] [issue 288] stops reporting a worksheet gap once the worksheet is done', async () => {
    // The two manual gaps -- a retainer balance and a recurring definition --
    // can only be closed by a person reading the Harvest UI. The report used to
    // list them for every source id regardless of whether that had happened, so
    // it said exactly the same thing before and after the work, and a reader
    // had no way to tell a closed gap from an untouched stub.
    //
    // `_ezacto_worksheet_completions` was built to record it -- migration 0024
    // says so in as many words -- and nothing outside the worksheet tool ever
    // read it. Now reconcile does.
    const before = await runReconcile({ snapshotDir, databasePath })
    const retainerGaps = before.report.gaps.filter((row) => row.check === 'retainer_balance')
    const recurringBefore = before.report.gaps.filter(
      (row) => row.check === 'recurring_invoice_definition',
    ).length
    expect(retainerGaps.length).toBeGreaterThan(0)

    // Completed through the real worksheet path, not by writing the marker:
    // migration 0024 binds a completion to its opening ledger entry and to the
    // import authority behind it, so a hand-written marker is refused. Going
    // the long way round is what makes this a test of the thing operators do.
    const worksheet = await generateRetainerWorksheet({ snapshotDir, databasePath })
    const inputPath = join(dir, 'retainers-288.json')
    await writeFile(
      inputPath,
      JSON.stringify({
        ...worksheet,
        rows: worksheet.rows.map((row) => ({
          ...row,
          balance_cents: 125_500,
          occurred_on: '2026-08-27',
          notes: 'Opening balance confirmed during migration',
        })),
      }),
    )
    const applied = await applyRetainerWorksheet({ snapshotDir, databasePath, inputPath })
    expect(applied.completed).toBeGreaterThan(0)

    const after = await runReconcile({ snapshotDir, databasePath })
    const stillOpen = after.report.gaps.filter((row) => row.check === 'retainer_balance')
    // The gap the worksheet closed is gone, and the count moved by exactly what
    // was applied -- so this cannot pass by the check disappearing wholesale.
    expect(stillOpen.length).toBe(retainerGaps.length - applied.completed)
    // The recurring side is untouched: the marker is keyed on kind as well as
    // id, so closing one does not silently close the other.
    expect(
      after.report.gaps.filter((row) => row.check === 'recurring_invoice_definition').length,
    ).toBe(recurringBefore)
    // And closing a gap did not turn anything into an unexplained delta.
    expect(after.report.unexplained).toEqual([])
  }, 60_000)

  it('[integration] [inv-14] reports zero unexplained deltas and proves monthly seconds at source grain', async () => {
    const first = await runReconcile({ snapshotDir, databasePath })

    expect(first.report.unexplained).toEqual([])
    expect(first.report.summary.complete).toBe(true)
    expect(reconciliationExitCode(first.report)).toBe(0)
    expect(
      first.report.matches.filter((row) => row.check === 'inv-14' && row.metric === 'seconds'),
    ).toEqual([
      expect.objectContaining({ key: '1782959|14308069|2026-08', expected: 4500, actual: 4500 }),
      expect.objectContaining({ key: '1782960|14308069|2026-08', expected: 4500, actual: 4500 }),
    ])
    expect(await readFile(first.markdownPath, 'utf8')).toContain('## UNEXPLAINED\n\nNone.')
    expect(JSON.parse(await readFile(first.jsonPath, 'utf8'))).toEqual(first.report)
    expect(new Set(first.report.gaps.map((row) => row.check))).toEqual(
      new Set(['retainer_balance', 'recurring_invoice_definition']),
    )
    expect(first.report.gaps.every((row) => row.gap_citation !== undefined)).toBe(true)
    expect(first.report.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check: 'retainer_balance',
          gap_citation: {
            id: 'migration-spec-7-retainers-no-api',
            reference: 'docs/migration-spec.md §7: Retainers: no API.',
          },
        }),
        expect.objectContaining({
          check: 'recurring_invoice_definition',
          gap_citation: {
            id: 'migration-spec-7-recurring-invoices-no-api',
            reference: 'docs/migration-spec.md §7: Recurring invoices: no API.',
          },
        }),
      ]),
    )
    const firstJson = await readFile(first.jsonPath, 'utf8')
    const firstMarkdown = await readFile(first.markdownPath, 'utf8')
    expect(firstMarkdown).toContain(
      'gap `migration-spec-7-retainers-no-api` (docs/migration-spec.md §7: Retainers: no API.)',
    )
    expect(firstMarkdown).toContain(
      'gap `migration-spec-7-recurring-invoices-no-api` (docs/migration-spec.md §7: Recurring invoices: no API.)',
    )

    const second = await runReconcile({ snapshotDir, databasePath })
    expect(reportHash(second.report)).toBe(reportHash(first.report))
    expect(await readFile(second.jsonPath, 'utf8')).toBe(firstJson)
    expect(await readFile(second.markdownPath, 'utf8')).toBe(firstMarkdown)
  })

  it('[migration] says how far a loaded database is behind its snapshot', async () => {
    // `load` is insert-if-absent, so a row whose updated_at advanced upstream is
    // refreshed in the snapshot by `sync` and then skipped -- the row is there,
    // the counts still agree, and only its contents are behind. That is the one
    // kind of wrong that reads as right, so the report has to say it.
    const clean = await runReconcile({ snapshotDir, databasePath })
    expect(
      clean.report.matches.filter((row) => row.check === 'load currency'),
    ).not.toEqual([])
    expect(clean.report.unexplained).toEqual([])

    // Exactly what a sync does when someone renames a client in Harvest: the
    // raw row is rewritten with a later updated_at. The database is untouched.
    const rawPath = join(snapshotDir, 'raw', 'clients.jsonl')
    const lines = (await readFile(rawPath, 'utf8')).split('\n').filter((line) => line.trim())
    const edited = lines.map((line, index) => {
      if (index > 0) return line
      const row = JSON.parse(line) as Record<string, unknown>
      return JSON.stringify({ ...row, name: 'Renamed upstream', updated_at: '2099-01-01T00:00:00Z' })
    })
    await writeFile(rawPath, `${edited.join('\n')}\n`)
    await writePassingChecksums(snapshotDir)

    const stale = await runReconcile({ snapshotDir, databasePath })
    const currency = stale.report.unexplained.filter((row) => row.check === 'load currency')
    expect(currency).toEqual([
      expect.objectContaining({
        key: 'clients',
        metric: 'rows_behind_snapshot',
        expected: 0,
        actual: 1,
      }),
    ])
    // The number alone would read as a counting error. The detail has to name
    // the cause, because the totals printed below it describe the snapshot.
    expect(currency[0]?.detail).toContain('insert-if-absent')
    expect(reconciliationExitCode(stale.report)).toBe(1)
  }, 60_000)

  it('[integration] accounts for a squashed duplicate instead of reporting it as loss', async () => {
    const aliasedPath = join(dir, 'aliased.sqlite')
    await runLoad({
      snapshotDir,
      databasePath: aliasedPath,
      organizationCurrency: 'USD',
      userIdentity: { aliases: [{ duplicate: 1782960, canonical: 1782959 }] },
    })

    const result = await runReconcile({ snapshotDir, databasePath: aliasedPath })

    // Nothing was lost, so nothing may read as lost: the duplicate's month is
    // grouped where its rows were loaded rather than against an id that no
    // longer holds any of them.
    expect(result.report.unexplained).toEqual([])
    expect(result.report.summary.complete).toBe(true)
    expect(reconciliationExitCode(result.report)).toBe(0)
    expect(
      result.report.matches.filter((row) => row.check === 'inv-14' && row.metric === 'seconds'),
    ).toEqual([
      expect.objectContaining({ key: '1782959|14308069|2026-08', expected: 9000, actual: 9000 }),
    ])
    expect(
      result.report.matches.filter(
        (row) => row.check === 'monthly_money' && row.metric === 'billable_cents',
      ),
    ).toEqual([expect.objectContaining({ key: '1782959|14308069|2026-08|USD', expected: 48_125 })])
    // The rows the squash really did cost are cited one for one, so a
    // sixty-first user going missing is still a delta nothing explains.
    const citation = {
      id: 'migration-spec-7-duplicate-harvest-accounts',
      reference: 'docs/migration-spec.md §7: Two Harvest accounts for one person.',
    }
    expect(result.report.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check: 'resource_row_count',
          key: 'users',
          delta: -1,
          gap_citation: citation,
        }),
        expect.objectContaining({
          check: 'resource_row_count',
          key: 'user_assignments',
          delta: -1,
          gap_citation: citation,
        }),
        expect.objectContaining({
          check: 'resource_row_count',
          key: 'teammates',
          delta: -1,
          gap_citation: citation,
        }),
        expect.objectContaining({
          check: 'load_anomaly',
          key: 'users:1782960:duplicate_user_squashed',
          gap_citation: citation,
        }),
        expect.objectContaining({
          check: 'load_anomaly',
          key: 'user_assignments:54002:duplicate_row_merged',
          gap_citation: citation,
        }),
      ]),
    )
  }, 60_000)

  it('[unit] turns an injected one-cent discrepancy into UNEXPLAINED and failure', async () => {
    await rewriteChecksums(snapshotDir, (report) => {
      const project = report.reports['time/projects/2026']?.[0]
      if (project === undefined) throw new Error('fixture project report is missing')
      project.billable_amount = 481.26
    })

    const result = await runReconcile({ snapshotDir, databasePath })

    expect(reconciliationExitCode(result.report)).toBe(1)
    expect(result.report.summary.complete).toBe(false)
    expect(result.report.unexplained).toContainEqual(
      expect.objectContaining({
        check: 'harvest_time_report',
        key: 'time/projects/2026|14308069|USD',
        metric: 'billable_amount_cents',
        delta: -1,
      }),
    )
  })

  it('[unit] does not conflate equal Harvest IDs across currencies', async () => {
    await rm(snapshotDir, { recursive: true, force: true })
    await rm(databasePath, { force: true })
    await buildSanitizedLoadSnapshot(snapshotDir)
    await makeGoldenSlicesCoherent(snapshotDir)
    await makeMultiCurrencySnapshot(snapshotDir)
    await writePassingChecksums(snapshotDir, true)
    await runLoad({ snapshotDir, databasePath, organizationCurrency: 'USD' })

    const result = await runReconcile({ snapshotDir, databasePath })
    const clientCurrencies = result.report.matches.filter(
      (row) =>
        row.check === 'harvest_time_report' &&
        row.key.startsWith('time/clients/2026|') &&
        row.metric === 'billable_amount_cents',
    )

    expect(result.report.unexplained).toEqual([])
    expect(new Set(clientCurrencies.map((row) => row.key))).toEqual(
      new Set(['time/clients/2026|41001|EUR', 'time/clients/2026|5735776|USD']),
    )
    expect(
      result.report.matches.some(
        (row) =>
          row.check === 'monthly_money' &&
          row.key === '1782960|14308070|2026-08|EUR' &&
          row.metric === 'billable_cents',
      ),
    ).toBe(true)
  })

  it('[unit] rejects missing report periods and invalidates stale PASS artifacts', async () => {
    await runReconcile({ snapshotDir, databasePath })
    await rewriteChecksums(snapshotDir, (report) => {
      report.periods = []
    })

    await expect(runReconcile({ snapshotDir, databasePath })).rejects.toThrow(
      'no verified report periods',
    )
    expect(
      JSON.parse(await readFile(join(snapshotDir, 'reconciliation-report.json'), 'utf8')),
    ).toEqual({ version: 1, status: 'incomplete' })
  })

  it('[unit] rejects duplicate report rows instead of allowing cancellation', async () => {
    await rewriteChecksums(snapshotDir, (report) => {
      report.reports['time/clients/2026']!.push({
        ...report.reports['time/clients/2026']![0],
      })
    })

    await expect(runReconcile({ snapshotDir, databasePath })).rejects.toThrow(
      'repeats report row 5735776|USD',
    )
  })

  it('[integration] aggregates the same report identity across leap-year chunks', async () => {
    await prepareLeapYearSnapshot(snapshotDir, databasePath)

    const result = await runReconcile({ snapshotDir, databasePath })
    expect(result.report.unexplained).toEqual([])
    expect(result.report.matches).toContainEqual(
      expect.objectContaining({
        check: 'harvest_time_report',
        key: 'time/clients/2024|5735776|USD',
        metric: 'total_seconds',
        expected: 9900,
        actual: 9900,
      }),
    )
  })

  it('[unit] rejects duplicate identities within one report chunk', async () => {
    await prepareLeapYearSnapshot(snapshotDir, databasePath)
    await rewriteChecksums(snapshotDir, (report) => {
      const key = 'time/clients/2024/2024-01-01..2024-12-30'
      report.reports[key]!.push({ ...report.reports[key]![0] })
    })

    await expect(runReconcile({ snapshotDir, databasePath })).rejects.toThrow(
      '2024-01-01..2024-12-30 repeats report row 5735776|USD',
    )
  })

  it('[unit] reports a missing leap-year chunk as UNEXPLAINED', async () => {
    await prepareLeapYearSnapshot(snapshotDir, databasePath)
    const missing = 'expenses/team/2024/2024-12-31..2024-12-31'
    await rewriteChecksums(snapshotDir, (report) => {
      delete report.reports[missing]
    })

    const result = await runReconcile({ snapshotDir, databasePath })
    expect(result.report.unexplained).toContainEqual(
      expect.objectContaining({
        check: 'harvest_expense_report',
        key: missing,
        detail: 'verified report chunk is missing',
      }),
    )
  })

  it('[unit] rejects a narrowed uninvoiced evidence range', async () => {
    await rewriteChecksums(snapshotDir, (report) => {
      report.report_ranges.uninvoiced.from = '2026-08-15'
    })

    await expect(runReconcile({ snapshotDir, databasePath })).rejects.toThrow(
      'uninvoiced report range is not the canonical current period',
    )
  })

  it('[unit] rejects raw report-domain rows outside the verified periods', async () => {
    await rewriteChecksums(snapshotDir, (report) => {
      report.periods[0]!.from = '2026-08-15'
      report.report_ranges.uninvoiced.from = '2026-08-15'
    })

    await expect(runReconcile({ snapshotDir, databasePath })).rejects.toThrow(
      '2026-08-14 maps to 0 verified report periods',
    )
  })

  it('[unit] rejects negative source-report rows instead of permitting cancellation', async () => {
    await rewriteChecksums(snapshotDir, (report) => {
      report.reports['expenses/clients/2026']![0]!.total_amount = -1
    })

    await expect(runReconcile({ snapshotDir, databasePath })).rejects.toThrow(
      'total_amount cannot be negative',
    )
  })

  it('[unit] rejects report content whose evidence digest was not refreshed', async () => {
    const path = join(snapshotDir, 'checksums.json')
    const report = JSON.parse(await readFile(path, 'utf8')) as ChecksumReport
    report.reports['time/projects/2026']![0]!.billable_amount = 0
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`)

    await expect(runReconcile({ snapshotDir, databasePath })).rejects.toThrow(
      'report evidence failed its content digest',
    )
  })

  it('[unit] rejects noncanonical generation timestamps', async () => {
    await rewriteChecksums(snapshotDir, (report) => {
      report.generated_at = '2026-08-27T15:30:00+00:00'
    })

    await expect(runReconcile({ snapshotDir, databasePath })).rejects.toThrow(
      'not valid reconciliation evidence',
    )
  })

  it('[unit] reports mixed snapshot and load-option progress provenance', async () => {
    const database = new BetterSqlite3(databasePath)
    try {
      database
        .prepare(
          `UPDATE _ezacto_load_progress
           SET snapshot_sha256 = ?, load_options_json = ? WHERE resource = ?`,
        )
        .run('0'.repeat(64), '{}', 'clients')
    } finally {
      database.close()
    }

    const result = await runReconcile({ snapshotDir, databasePath })
    expect(result.report.unexplained).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check: 'load_completion',
          key: 'clients',
          metric: 'snapshot_sha256',
        }),
        expect.objectContaining({
          check: 'load_completion',
          key: 'clients',
          metric: 'load_options_json',
        }),
      ]),
    )
  })

  it('[money] reports an upstream deletion that load never applied', async () => {
    // Issue 407. `sync` writes tombstones and `load` never reads them -- its
    // writes are insert-if-absent, not upsert. So a row deleted upstream stays
    // in the loaded database and shows up as no row-count difference at all,
    // which makes the report green in exactly the case it should not be.
    const manifest = await readManifest(snapshotDir)
    manifest.deleted_upstream = { clients: [4242, 4243] }
    await writeManifest(snapshotDir, manifest)

    const result = await runReconcile({ snapshotDir, databasePath })
    expect(result.report.gaps).toContainEqual(
      expect.objectContaining({
        check: 'upstream_deletion',
        key: 'clients',
        gap_citation: expect.objectContaining({ id: 'issue-407-load-is-add-only' }),
      }),
    )
  })

  it('[money] names the deleted rows this database still holds, and only those', async () => {
    // The decision on 407: a tombstone is a gap for a person to clear, never an
    // automatic delete. Which means the report has to say *which* rows, and has
    // to count what is actually here -- a tombstone naming a row this database
    // never loaded is not work anybody has to do, and counting it overstates
    // the gap by however many there are.
    const database = new BetterSqlite3(databasePath, { readonly: true })
    const live = database
      .prepare(`SELECT harvest_id FROM clients WHERE harvest_id IS NOT NULL ORDER BY id LIMIT 1`)
      .get() as { harvest_id: number } | undefined
    database.close()
    expect(live, 'the fixture has no loaded client to tombstone').toBeDefined()

    const manifest = await readManifest(snapshotDir)
    // One row that is here, one that never was.
    manifest.deleted_upstream = { clients: [live!.harvest_id, 999_000_111] }
    await writeManifest(snapshotDir, manifest)

    const result = await runReconcile({ snapshotDir, databasePath })
    const named = result.report.gaps.find((gap) => gap.check === 'upstream_deletion_present')
    expect(named, 'no variance was reported for a row that is still here').toBeDefined()
    expect(named!.detail).toContain(String(live!.harvest_id))
    // The one that was never loaded is not somebody's work.
    expect(named!.detail).not.toContain('999000111')
    expect(named!.detail).toContain('1 row(s)')
  })

  it('[unit] says nothing when every tombstone names a row this database never had', async () => {
    // Silence is the right answer: there is nothing to clear.
    const manifest = await readManifest(snapshotDir)
    manifest.deleted_upstream = { clients: [999_000_111, 999_000_112] }
    await writeManifest(snapshotDir, manifest)

    const result = await runReconcile({ snapshotDir, databasePath })
    expect(
      result.report.gaps.filter((gap) => gap.check === 'upstream_deletion_present'),
    ).toEqual([])
  })

  it('[unit] says nothing about deletions when sync recorded none', async () => {
    // The ordinary case. A note on every run would be noise that trains
    // somebody to skim past the one that matters.
    const manifest = await readManifest(snapshotDir)
    manifest.deleted_upstream = { clients: [] }
    await writeManifest(snapshotDir, manifest)

    const result = await runReconcile({ snapshotDir, databasePath })
    expect(
      result.report.gaps.filter((gap) => gap.check === 'upstream_deletion'),
    ).toEqual([])
  })

  it('[unit] binds full manifest coverage evidence to load admission', async () => {
    const manifest = await readManifest(snapshotDir)
    manifest.resources.clients!.total_entries = 999
    await writeManifest(snapshotDir, manifest)

    const result = await runReconcile({ snapshotDir, databasePath })
    expect(result.report.unexplained).toContainEqual(
      expect.objectContaining({
        check: 'load_admission',
        key: 'snapshot',
        metric: 'manifest_sha256',
      }),
    )
  })

  it('[unit] reports loaded project-currency drift', async () => {
    const database = new BetterSqlite3(databasePath)
    try {
      database
        .prepare('UPDATE projects SET billing_currency = ? WHERE harvest_id = ?')
        .run('EUR', 14308069)
    } finally {
      database.close()
    }

    const result = await runReconcile({ snapshotDir, databasePath })
    expect(result.report.unexplained).toContainEqual(
      expect.objectContaining({
        check: 'currency_fidelity',
        key: 'project:14308069',
        metric: 'currency',
      }),
    )
  })

  it('[unit] fails closed for a cross-currency invoice allocation', async () => {
    const path = join(snapshotDir, 'raw', 'invoices.jsonl')
    const lines = (await readFile(path, 'utf8')).trimEnd().split('\n')
    const invoice = JSON.parse(lines[0] ?? '') as Record<string, unknown>
    invoice.currency = 'EUR'
    lines[0] = JSON.stringify(invoice)
    await writeFile(path, `${lines.join('\n')}\n`)
    await bindChecksumsToSnapshot(snapshotDir)

    await expect(runReconcile({ snapshotDir, databasePath })).rejects.toThrow(
      'currency EUR does not match project 14308069 currency USD',
    )
  })

  it('[unit] loads a correction entry so every total nets it out, as Harvest does', async () => {
    // #279: Harvest nets its negative correction entries into every report
    // total. time_entries.seconds was CHECK >= 0, so the loader skipped them
    // and the recomputation ran higher — one month read above Harvest by the
    // whole of a skipped correction, which is an overpayment to a contractor.
    await rm(snapshotDir, { recursive: true, force: true })
    await rm(databasePath, { force: true })
    await buildSanitizedLoadSnapshot(snapshotDir)
    await makeGoldenSlicesCoherent(snapshotDir)

    // A -0.25h correction against the same client, project, task and person as
    // the uninvoiced entry, at the same $175 rate: -$43.75.
    const timePath = join(snapshotDir, 'raw', 'time_entries.jsonl')
    const timeLines = (await readFile(timePath, 'utf8')).trimEnd().split('\n')
    const correction = JSON.parse(timeLines[1] ?? '') as Record<string, unknown>
    correction.id = 3003833999
    correction.hours = -0.25
    correction.hours_without_timer = -0.25
    correction.rounded_hours = -0.25
    correction.started_time = null
    correction.ended_time = null
    correction.notes = 'Sanitized correction'
    timeLines.push(JSON.stringify(correction))
    await writeFile(timePath, `${timeLines.join('\n')}\n`)
    const manifest = await readManifest(snapshotDir)
    manifest.resources.time_entries!.count = timeLines.length
    await writeManifest(snapshotDir, manifest)

    await writePassingChecksums(snapshotDir)
    await rewriteChecksums(snapshotDir, (report) => {
      // What Harvest reports: the correction netted into every total.
      for (const key of [
        'time/clients/2026',
        'time/projects/2026',
        'time/tasks/2026',
      ] as const) {
        const row = report.reports[key]![0] as Record<string, number>
        row.total_hours -= 0.25
        row.billable_hours -= 0.25
        row.billable_amount -= 43.75
      }
      const person = report.reports['time/team/2026']![1] as Record<string, number>
      person.total_hours -= 0.25
      person.billable_hours -= 0.25
      person.billable_amount -= 43.75
      const uninvoiced = report.reports.uninvoiced![0] as Record<string, number>
      uninvoiced.total_hours -= 0.25
      uninvoiced.uninvoiced_hours -= 0.25
      uninvoiced.uninvoiced_amount -= 43.75
      const budget = report.reports['project_budget/active']![0] as Record<string, number>
      budget.budget_spent -= 43.75
      budget.budget_remaining += 43.75
    })
    await runLoad({ snapshotDir, databasePath })

    const database = new BetterSqlite3(databasePath, { readonly: true })
    const stored = database
      .prepare('SELECT seconds, rounded_seconds FROM time_entries WHERE harvest_id = ?')
      .get('3003833999') as { seconds: number; rounded_seconds: number } | undefined
    database.close()
    expect(stored).toEqual({ seconds: -900, rounded_seconds: -900 })

    const result = await runReconcile({ snapshotDir, databasePath })
    expect(result.report.unexplained).toEqual([])
    // Nothing is skipped any more, so nothing needs citing: the recomputation
    // equals Harvest's own netted totals outright, which the assertions below
    // check directly. There is deliberately no assertion that the old
    // negative-time-entry citation is absent -- the id no longer exists, so
    // such a filter would pass whether or not corrections were handled.
    expect(
      [...result.report.matches, ...result.report.gaps].filter(
        (check) =>
          check.check === 'harvest_time_report' &&
          check.key === 'time/projects/2026|14308069|USD' &&
          check.metric === 'billable_amount_cents',
      ),
    ).toEqual([
      // 481.25 - 43.75 = 437.50, exactly what Harvest reports.
      expect.objectContaining({ delta: 0, expected: 43_750, actual: 43_750 }),
    ])
  })

  it('[unit] leaves an archived project out of uninvoiced work, as Harvest does', async () => {
    // Harvest's uninvoiced report lists active projects only. Recomputing over
    // archived ones manufactured a delta on every archived project that still
    // had uninvoiced work — three of CONFLICT's, four rows, and the runbook
    // carried them as an accepted cost of the migration when they were a defect
    // in the checker.
    await rm(snapshotDir, { recursive: true, force: true })
    await rm(databasePath, { force: true })
    await buildSanitizedLoadSnapshot(snapshotDir)
    await makeGoldenSlicesCoherent(snapshotDir)
    const path = join(snapshotDir, 'raw', 'projects.jsonl')
    const lines = (await readFile(path, 'utf8')).trimEnd().split('\n')
    const project = JSON.parse(lines[0] ?? '') as Record<string, unknown>
    project.is_active = false
    lines[0] = JSON.stringify(project)
    await writeFile(path, `${lines.join('\n')}\n`)
    await writePassingChecksums(snapshotDir)
    await rewriteChecksums(snapshotDir, (report) => {
      // What Harvest reports for an archived project: nothing at all.
      report.reports.uninvoiced = []
      report.reports['project_budget/active']![0]!.is_active = false
    })
    await runLoad({ snapshotDir, databasePath })

    const result = await runReconcile({ snapshotDir, databasePath })
    expect(
      result.report.unexplained.filter((check) =>
        check.check.endsWith('uninvoiced_report') || check.check === 'snapshot_uninvoiced_parity',
      ),
    ).toEqual([])
  })

  it('[unit] imports a non-positive receipt instead of skipping it', async () => {
    // The seven CONFLICT invoices in #283. State is derived from the payments
    // that load, so while invoice_payments.amount_cents was a strictly positive
    // receipt, a $0 or credit-note payment was skipped and the invoice it
    // settled read open. The column is signed now, like the invoice amount it
    // settles, so the payment lands and the state holds.
    await rm(snapshotDir, { recursive: true, force: true })
    await rm(databasePath, { force: true })
    await buildSanitizedLoadSnapshot(snapshotDir)
    await makeGoldenSlicesCoherent(snapshotDir)

    const paymentPath = join(snapshotDir, 'raw', 'invoice_payments.jsonl')
    const payment = JSON.parse(await readFile(paymentPath, 'utf8')) as Record<string, unknown>
    payment.amount = 0
    await writeFile(paymentPath, `${JSON.stringify(payment)}\n`)

    // The golden invoice totals $2,275, so a $0 receipt leaves it open — which
    // is the arithmetic working. What this proves is that the row survives the
    // import at all; whether a settled invoice keeps its state is asserted
    // against a $0 invoice in packages/db/test/invoice-state.test.ts.
    const invoicePath = join(snapshotDir, 'raw', 'invoices.jsonl')
    const lines = (await readFile(invoicePath, 'utf8')).trimEnd().split('\n')
    const invoice = JSON.parse(lines[0] ?? '') as Record<string, unknown>
    invoice.due_amount = 2275
    lines[0] = JSON.stringify(invoice)
    await writeFile(invoicePath, `${lines.join('\n')}\n`)

    await writePassingChecksums(snapshotDir)
    await runLoad({ snapshotDir, databasePath })

    const database = new BetterSqlite3(databasePath)
    try {
      expect(
        database
          .prepare(`SELECT amount_cents AS cents FROM invoice_payments WHERE harvest_id = 50863457`)
          .get(),
      ).toEqual({ cents: 0 })
      // Nothing was skipped, so nothing is recorded as skipped — no
      // non_positive_payment anomaly, and no state disagreement behind it.
      expect(
        database
          .prepare(
            `SELECT count(*) AS n FROM _ezacto_load_anomalies
             WHERE kind IN ('non_positive_payment', 'invoice_state_disagreement')`,
          )
          .get(),
      ).toEqual({ n: 0 })
    } finally {
      database.close()
    }

    const result = await runReconcile({ snapshotDir, databasePath })
    expect(result.report.unexplained).toEqual([])
    expect(result.report.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check: 'resource_row_count',
          key: 'invoice_payments',
          metric: 'rows',
          expected: 1,
          actual: 1,
        }),
      ]),
    )
  })

  it('[unit] fails closed for an unknown loader anomaly', async () => {
    const checksum = JSON.parse(
      await readFile(join(snapshotDir, 'checksums.json'), 'utf8'),
    ) as ChecksumReport
    const database = new BetterSqlite3(databasePath)
    try {
      database
        .prepare(
          `INSERT INTO _ezacto_load_anomalies
           (snapshot_sha256, resource, source_id, kind, detail) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(checksum.snapshot_sha256, 'invoices', '13150403', 'future_anomaly', 'safe fixture')
    } finally {
      database.close()
    }

    const result = await runReconcile({ snapshotDir, databasePath })
    expect(result.report.unexplained).toContainEqual(
      expect.objectContaining({ check: 'load_anomaly', key: 'invoices:13150403:future_anomaly' }),
    )
  })

  it('[unit] classifies only exact hours-conversion residue as rounding', async () => {
    await rm(snapshotDir, { recursive: true, force: true })
    await rm(databasePath, { force: true })
    await buildSanitizedLoadSnapshot(snapshotDir)
    await makeGoldenSlicesCoherent(snapshotDir)
    const path = join(snapshotDir, 'raw', 'time_entries.jsonl')
    const lines = (await readFile(path, 'utf8')).trimEnd().split('\n')
    const changed = lines[0]!.replace('"hours":1.25,', '"hours":1.2501,')
    expect(changed).not.toBe(lines[0])
    lines[0] = changed
    await writeFile(path, `${lines.join('\n')}\n`)
    await writePassingChecksums(snapshotDir)
    await runLoad({ snapshotDir, databasePath })

    const result = await runReconcile({ snapshotDir, databasePath })
    expect(result.report.unexplained).toEqual([])
    expect(result.report.rounding).toContainEqual(
      expect.objectContaining({
        check: 'load_anomaly',
        key: expect.stringContaining('hours_residue'),
      }),
    )
  })

  it('[unit] treats a forged hours-residue anomaly as UNEXPLAINED', async () => {
    const checksum = JSON.parse(
      await readFile(join(snapshotDir, 'checksums.json'), 'utf8'),
    ) as ChecksumReport
    const database = new BetterSqlite3(databasePath)
    try {
      database
        .prepare(
          `INSERT INTO _ezacto_load_anomalies
           (snapshot_sha256, resource, source_id, kind, detail) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(checksum.snapshot_sha256, 'invoices', '13150403', 'hours_residue', '/hours=1.2501')
    } finally {
      database.close()
    }

    const result = await runReconcile({ snapshotDir, databasePath })
    expect(result.report.unexplained).toContainEqual(
      expect.objectContaining({ check: 'load_anomaly', key: 'invoices:13150403:hours_residue' }),
    )
  })

  it('[unit] preserves fixed-fee over-invoicing and separates uninvoiced expenses', async () => {
    await rm(snapshotDir, { recursive: true, force: true })
    await rm(databasePath, { force: true })
    await buildSanitizedLoadSnapshot(snapshotDir)
    await makeGoldenSlicesCoherent(snapshotDir)
    const path = join(snapshotDir, 'raw', 'projects.jsonl')
    const lines = (await readFile(path, 'utf8')).trimEnd().split('\n')
    const project = JSON.parse(lines[0] ?? '') as Record<string, unknown>
    project.is_fixed_fee = true
    project.fee = 100
    project.starts_on = null
    lines[0] = JSON.stringify(project)
    await writeFile(path, `${lines.join('\n')}\n`)
    await writePassingChecksums(snapshotDir)
    await rewriteChecksums(snapshotDir, (report) => {
      report.reports.uninvoiced![0]!.uninvoiced_amount = -2087.5
    })
    await runLoad({ snapshotDir, databasePath })

    const result = await runReconcile({ snapshotDir, databasePath })
    expect(result.report.unexplained).toEqual([])
    expect(result.report.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check: 'harvest_uninvoiced_report',
          metric: 'uninvoiced_expense_cents',
          expected: 10000,
          actual: 10000,
        }),
        expect.objectContaining({
          check: 'harvest_uninvoiced_report',
          metric: 'uninvoiced_amount_cents',
          expected: -208750,
          actual: -208750,
        }),
      ]),
    )
  })

  it('[unit] anchors a fixed-fee project with no start date at its creation date', async () => {
    await rm(snapshotDir, { recursive: true, force: true })
    await rm(databasePath, { force: true })
    await buildSanitizedLoadSnapshot(snapshotDir)
    await makeGoldenSlicesCoherent(snapshotDir)
    const path = join(snapshotDir, 'raw', 'projects.jsonl')
    const lines = (await readFile(path, 'utf8')).trimEnd().split('\n')
    const project = JSON.parse(lines[0] ?? '') as Record<string, unknown>
    project.is_fixed_fee = true
    project.fee = 100
    project.starts_on = null
    project.created_at = '2026-08-28T00:00:00Z'
    project.updated_at = '2026-08-28T00:00:00Z'
    lines[0] = JSON.stringify(project)
    await writeFile(path, `${lines.join('\n')}\n`)
    await writePassingChecksums(snapshotDir)
    await rewriteChecksums(snapshotDir, (report) => {
      report.reports.uninvoiced![0]!.uninvoiced_amount = 0
    })
    await runLoad({ snapshotDir, databasePath })

    const result = await runReconcile({ snapshotDir, databasePath })
    expect(result.report.unexplained).toEqual([])
  })

  it('[unit] excludes blank task budgets from task-fee spent amounts', async () => {
    await rm(snapshotDir, { recursive: true, force: true })
    await rm(databasePath, { force: true })
    await buildSanitizedLoadSnapshot(snapshotDir)
    await makeGoldenSlicesCoherent(snapshotDir)
    const rawDir = join(snapshotDir, 'raw')
    const taskPath = join(rawDir, 'tasks.jsonl')
    const taskLines = (await readFile(taskPath, 'utf8')).trimEnd().split('\n')
    const secondTask = JSON.parse(taskLines[0] ?? '') as Record<string, unknown>
    secondTask.id = 51002
    secondTask.name = 'Sanitized unbudgeted task'
    taskLines.push(JSON.stringify(secondTask))
    await writeFile(taskPath, `${taskLines.join('\n')}\n`)

    const assignmentPath = join(rawDir, 'task_assignments.jsonl')
    const assignmentLines = (await readFile(assignmentPath, 'utf8')).trimEnd().split('\n')
    const secondAssignment = JSON.parse(assignmentLines[0] ?? '') as Record<string, unknown>
    secondAssignment.id = 53002
    secondAssignment.task = { id: 51002 }
    secondAssignment.budget = null
    assignmentLines.push(JSON.stringify(secondAssignment))
    await writeFile(assignmentPath, `${assignmentLines.join('\n')}\n`)

    const timePath = join(rawDir, 'time_entries.jsonl')
    const timeLines = (await readFile(timePath, 'utf8')).trimEnd().split('\n')
    const secondEntry = JSON.parse(timeLines[1] ?? '') as Record<string, unknown>
    secondEntry.task = { id: 51002 }
    secondEntry.task_assignment = { id: 53002 }
    timeLines[1] = JSON.stringify(secondEntry)
    await writeFile(timePath, `${timeLines.join('\n')}\n`)

    const manifest = await readManifest(snapshotDir)
    manifest.resources.tasks!.count = 2
    manifest.resources.task_assignments!.count = 2
    await writeManifest(snapshotDir, manifest)
    await writePassingChecksums(snapshotDir)
    await rewriteChecksums(snapshotDir, (report) => {
      report.reports['time/tasks/2026'] = [
        timeRow('task_id', 51001, 'USD', 1.5, 262.5),
        timeRow('task_id', 51002, 'USD', 1.25, 218.75),
      ]
      const budget = report.reports['project_budget/active']![0]!
      budget.budget_spent = 262.5
      budget.budget_remaining = -139.05
    })
    await runLoad({ snapshotDir, databasePath })

    const result = await runReconcile({ snapshotDir, databasePath })
    expect(result.report.unexplained).toEqual([])
  })

  it('[unit] treats null configured billable rates as zero report contribution', async () => {
    await rm(snapshotDir, { recursive: true, force: true })
    await rm(databasePath, { force: true })
    await buildSanitizedLoadSnapshot(snapshotDir)
    await makeGoldenSlicesCoherent(snapshotDir)
    const path = join(snapshotDir, 'raw', 'time_entries.jsonl')
    const lines = (await readFile(path, 'utf8')).trimEnd().split('\n')
    const changed = lines[1]!.replace('"billable_rate":175.00', '"billable_rate":null')
    expect(changed).not.toBe(lines[1])
    lines[1] = changed
    await writeFile(path, `${lines.join('\n')}\n`)
    await writePassingChecksums(snapshotDir)
    await rewriteChecksums(snapshotDir, (report) => {
      for (const key of ['time/clients/2026', 'time/projects/2026', 'time/tasks/2026']) {
        report.reports[key]![0]!.billable_amount = 262.5
      }
      report.reports['time/team/2026']![1]!.billable_amount = 0
      report.reports.uninvoiced![0]!.uninvoiced_amount = 100
      const budget = report.reports['project_budget/active']![0]!
      budget.budget_spent = 262.5
      budget.budget_remaining = -139.05
    })
    await runLoad({ snapshotDir, databasePath })

    const result = await runReconcile({ snapshotDir, databasePath })
    expect(result.report.unexplained).toEqual([])
  })

  it('[unit] uses billable rather than cost rates for project-cost budgets', async () => {
    await rm(snapshotDir, { recursive: true, force: true })
    await rm(databasePath, { force: true })
    await buildSanitizedLoadSnapshot(snapshotDir)
    await makeGoldenSlicesCoherent(snapshotDir)
    const projectPath = join(snapshotDir, 'raw', 'projects.jsonl')
    const projectLines = (await readFile(projectPath, 'utf8')).trimEnd().split('\n')
    const project = JSON.parse(projectLines[0] ?? '') as Record<string, unknown>
    project.budget_by = 'project_cost'
    project.cost_budget = 1000
    project.cost_budget_include_expenses = true
    projectLines[0] = JSON.stringify(project)
    await writeFile(projectPath, `${projectLines.join('\n')}\n`)
    const timePath = join(snapshotDir, 'raw', 'time_entries.jsonl')
    const timeLines = (await readFile(timePath, 'utf8')).trimEnd().split('\n')
    const changed = timeLines[1]!.replace('"cost_rate":80.50', '"cost_rate":null')
    expect(changed).not.toBe(timeLines[1])
    timeLines[1] = changed
    await writeFile(timePath, `${timeLines.join('\n')}\n`)
    await writePassingChecksums(snapshotDir)
    await rewriteChecksums(snapshotDir, (report) => {
      const budget = report.reports['project_budget/active']![0]!
      budget.budget_by = 'project_cost'
      budget.budget = 1000
      budget.budget_spent = 662.5
      budget.budget_remaining = 337.5
    })
    await runLoad({ snapshotDir, databasePath })

    const result = await runReconcile({ snapshotDir, databasePath })
    expect(result.report.unexplained).toEqual([])
  })
})
