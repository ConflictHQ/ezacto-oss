import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeManifest, type Manifest, type ManifestBinaryAsset } from '../src/manifest.js'
import { checksumReportDigest, snapshotDigest, type ChecksumReportPayload } from '../src/verify.js'
import { preflight, resourceProgress } from './fixtures.js'

const golden = (name: string): URL => new URL(`../../db/test/fixtures/${name}`, import.meta.url)
const goldenJson = async (name: string): Promise<string> =>
  JSON.stringify(JSON.parse(await readFile(golden(name), 'utf8')))
const timestamp = '2026-08-27T15:30:00Z'

export interface SanitizedLoadSnapshot {
  snapshotDir: string
  receipt: ManifestBinaryAsset
  timeEntryHarvestId: string
}

/** Reusable full-slice source fixture for #78 and its sync/reconciliation successors. */
export const buildSanitizedLoadSnapshot = async (
  snapshotDir: string,
): Promise<SanitizedLoadSnapshot> => {
  await mkdir(join(snapshotDir, 'raw'), { recursive: true })
  const resources: Manifest['resources'] = {}
  const writeRows = async (
    resource: string,
    rows: readonly string[],
    lineage?: readonly { source_id: number; parent_id: number }[],
  ): Promise<void> => {
    await writeFile(
      join(snapshotDir, 'raw', `${resource}.jsonl`),
      rows.length === 0 ? '' : `${rows.join('\n')}\n`,
    )
    resources[resource] = resourceProgress({ count: rows.length })
    if (lineage) {
      await writeFile(
        join(snapshotDir, 'raw', `${resource}.lineage.jsonl`),
        lineage.length === 0 ? '' : `${lineage.map((row) => JSON.stringify(row)).join('\n')}\n`,
      )
    }
  }
  const json = (value: unknown): string => JSON.stringify(value)
  const users = [
    {
      id: 1782960,
      first_name: 'Sanitized',
      last_name: 'Member',
      email: 'recorder@example.invalid',
      telephone: null,
      timezone: 'UTC',
      is_contractor: false,
      is_active: true,
      has_access_to_all_future_projects: false,
      weekly_capacity: 126000,
      access_roles: ['member'],
      avatar_url: null,
      saml_exempt: false,
      created_at: timestamp,
      updated_at: timestamp,
    },
    {
      id: 1782959,
      first_name: 'Sanitized',
      last_name: 'Creator',
      email: 'creator@example.invalid',
      telephone: null,
      timezone: 'UTC',
      is_contractor: false,
      is_active: true,
      has_access_to_all_future_projects: true,
      weekly_capacity: 126000,
      access_roles: ['administrator'],
      avatar_url: null,
      saml_exempt: false,
      created_at: timestamp,
      updated_at: timestamp,
    },
  ]
  await writeRows('users', users.map(json))
  await writeRows(
    'billable_rates',
    [
      json({
        id: 81003,
        amount: 180.0,
        start_date: '2026-07-01',
        end_date: null,
        created_at: timestamp,
        updated_at: timestamp,
      }),
      json({
        id: 81001,
        amount: 175.0,
        start_date: '2026-01-01',
        end_date: '2026-06-30',
        created_at: timestamp,
        updated_at: timestamp,
      }),
    ],
    [
      { source_id: 81003, parent_id: 1782959 },
      { source_id: 81001, parent_id: 1782959 },
    ],
  )
  await writeRows(
    'cost_rates',
    [
      json({
        id: 81002,
        amount: 80.5,
        start_date: '2026-01-01',
        end_date: null,
        created_at: timestamp,
        updated_at: timestamp,
      }),
    ],
    [{ source_id: 81002, parent_id: 1782959 }],
  )
  await writeRows(
    'teammates',
    [json({ id: 1782960, created_at: timestamp, updated_at: timestamp })],
    [{ source_id: 1782960, parent_id: 1782959 }],
  )
  await writeRows('roles', [
    json({
      id: 71001,
      name: 'Sanitized Role',
      user_ids: [1782960],
      created_at: timestamp,
      updated_at: timestamp,
    }),
  ])
  await writeRows(
    'clients',
    [5735776, 41001].map((id) =>
      json({
        id,
        name: `Sanitized Client ${id}`,
        address: null,
        currency: 'USD',
        is_active: true,
        created_at: timestamp,
        updated_at: timestamp,
      }),
    ),
  )
  await writeRows('contacts', [
    json({
      id: 61001,
      client: { id: 5735776 },
      title: null,
      first_name: 'Sanitized',
      last_name: 'Recipient',
      email: 'recipient@example.invalid',
      phone_office: null,
      phone_mobile: null,
      fax: null,
      invoice_recipient_status: 'cc',
      created_at: timestamp,
      updated_at: timestamp,
    }),
  ])
  await writeRows('tasks', [
    json({
      id: 51001,
      name: 'Migration',
      billable_by_default: true,
      default_hourly_rate: 175,
      is_default: false,
      is_active: true,
      created_at: timestamp,
      updated_at: timestamp,
    }),
  ])
  await writeRows('expense_categories', [
    await goldenJson('harvest-expense-category.json'),
    await goldenJson('harvest-expense-direct-category.json'),
  ])
  await writeRows('invoice_item_categories', [
    json({
      id: 52001,
      name: 'Service',
      use_as_service: true,
      use_as_expense: false,
      created_at: timestamp,
      updated_at: timestamp,
    }),
  ])
  await writeRows('estimate_item_categories', [
    await goldenJson('harvest-estimate-item-category.json'),
  ])
  const projects = [14308069, 14308070].map((id) => ({
    id,
    client: { id: 5735776 },
    name: `Sanitized Project ${id}`,
    code: String(id),
    is_active: true,
    is_billable: true,
    is_fixed_fee: false,
    bill_by: 'Project',
    hourly_rate: 175,
    fee: null,
    budget_by: id === 14308069 ? 'task_fees' : 'project',
    budget: id === 14308069 ? null : 10,
    cost_budget: null,
    budget_is_monthly: false,
    cost_budget_include_expenses: false,
    notify_when_over_budget: false,
    over_budget_notification_percentage: null,
    over_budget_notification_date: null,
    show_budget_to_all: true,
    starts_on: '2026-08-01',
    ends_on: null,
    notes: null,
    billable_rate_currency: 'USD',
    created_at: timestamp,
    updated_at: timestamp,
  }))
  await writeRows('projects', projects.map(json))
  await writeRows('task_assignments', [
    json({
      id: 53001,
      project: { id: 14308069 },
      task: { id: 51001 },
      is_active: true,
      billable: true,
      hourly_rate: 175,
      budget: 123.45,
      created_at: timestamp,
      updated_at: timestamp,
    }),
  ])
  await writeRows('user_assignments', [
    json({
      id: 54001,
      project: { id: 14308069 },
      user: { id: 1782959 },
      is_active: true,
      is_project_manager: true,
      use_default_rates: false,
      hourly_rate: 175,
      budget: null,
      created_at: timestamp,
      updated_at: timestamp,
    }),
    json({
      id: 54002,
      project: { id: 14308069 },
      user: { id: 1782960 },
      is_active: true,
      is_project_manager: false,
      use_default_rates: true,
      hourly_rate: null,
      budget: null,
      created_at: timestamp,
      updated_at: timestamp,
    }),
  ])
  const estimateRow = JSON.parse(await goldenJson('harvest-estimate.json')) as Record<
    string,
    unknown
  >
  estimateRow.client = { id: 5735776, name: 'Sanitized Client' }
  await writeRows('estimates', [json(estimateRow)])
  await writeRows(
    'estimate_messages',
    [await goldenJson('harvest-estimate-message.json')],
    [{ source_id: 921001, parent_id: 920001 }],
  )
  const invoiceRow = JSON.parse(await goldenJson('harvest-invoice.json')) as Record<string, unknown>
  invoiceRow.estimate = { id: 920001 }
  const invoice = json(invoiceRow)
  const expenseInvoice = json({
    id: 12000001,
    client: { id: 5735776 },
    line_items: [],
    estimate: null,
    retainer: { id: 88001 },
    creator: { id: 1782959, name: 'Sanitized Creator' },
    number: 'INV-EXPENSE',
    purchase_order: null,
    amount: 0,
    due_amount: 0,
    tax: null,
    tax_amount: 0,
    tax2: null,
    tax2_amount: 0,
    discount: null,
    discount_amount: 0,
    subject: null,
    notes: null,
    currency: 'USD',
    state: 'open',
    period_start: null,
    period_end: null,
    issue_date: '2026-08-15',
    due_date: '2026-08-15',
    payment_term: 'upon receipt',
    payment_options: [],
    sent_at: timestamp,
    paid_at: null,
    paid_date: null,
    closed_at: null,
    recurring_invoice_id: 99001,
    created_at: timestamp,
    updated_at: timestamp,
  })
  await writeRows('invoices', [invoice, expenseInvoice])
  await writeRows(
    'invoice_messages',
    [await goldenJson('harvest-invoice-message.json')],
    [{ source_id: 6850124, parent_id: 13150403 }],
  )
  await writeRows(
    'invoice_payments',
    [await goldenJson('harvest-invoice-payment.json')],
    [{ source_id: 50863457, parent_id: 13150403 }],
  )
  const timeEntryHarvestId = '9007199254740993'
  await writeRows('time_entries', [
    `{"id":${timeEntryHarvestId},"user":{"id":1782959},"project":{"id":14308069},` +
      `"task":{"id":51001},"user_assignment":{"id":54001},"task_assignment":{"id":53001},` +
      '"spent_date":"2026-08-16","hours":1.25,"hours_without_timer":1.25,"rounded_hours":1.50,"timer_started_at":null,' +
      '"started_time":"8:00am","ended_time":"9:15am","notes":"Sanitized time","billable":true,' +
      '"budgeted":true,"billable_rate":175.00,"cost_rate":80.50,"external_reference":null,' +
      `"calendar_event":null,"invoice":null,"approval_status":"approved",` +
      `"created_at":"${timestamp}","updated_at":"${timestamp}"}`,
    `{"id":9007199254740994,"user":{"id":1782960},"project":{"id":14308069},` +
      `"task":{"id":51001},"user_assignment":{"id":54002},"task_assignment":{"id":53001},` +
      '"spent_date":"2026-08-27","hours":1.25,"hours_without_timer":1.00,"rounded_hours":1.25,' +
      '"timer_started_at":null,"started_time":"3:30pm","ended_time":null,' +
      '"notes":"Sanitized running time","billable":true,"budgeted":true,' +
      '"billable_rate":175.00,"cost_rate":80.50,"external_reference":null,' +
      `"calendar_event":null,"invoice":null,"approval_status":"approved",` +
      `"created_at":"${timestamp}","updated_at":"${timestamp}"}`,
  ])
  await writeRows('expenses', [
    await goldenJson('harvest-expense.json'),
    await goldenJson('harvest-expense-direct.json'),
  ])

  const receiptBytes = await readFile(golden('harvest-receipt.pdf'))
  const sha256 = createHash('sha256').update(receiptBytes).digest('hex')
  const receiptPath = `receipts/${sha256}.pdf`
  await mkdir(join(snapshotDir, 'receipts'), { recursive: true })
  await copyFile(golden('harvest-receipt.pdf'), join(snapshotDir, receiptPath))
  const receipt: ManifestBinaryAsset = {
    source_id: 152975211,
    sha256,
    path: receiptPath,
    bytes: receiptBytes.length,
    content_type: 'application/pdf',
  }
  const manifest: Manifest = {
    account: { id: '42', name: 'Sanitized Account' },
    company_name: 'Sanitized Company',
    started_at: '2026-08-27T12:00:00Z',
    finished_at: timestamp,
    tool_version: '0.0.0',
    preflight: preflight({
      user: { id: 1782959, access_roles: ['administrator'], is_administrator: true },
    }),
    resources,
    updated_since: {},
    binaries: { receipts: { '152975211': receipt }, avatars: {}, anomalies: [] },
  }
  await writeManifest(snapshotDir, manifest)
  const checksumPayload: ChecksumReportPayload = {
    version: 1,
    account_id: manifest.account.id,
    snapshot_sha256: await snapshotDigest(snapshotDir, manifest),
    generated_at: timestamp,
    periods: [],
    reports: {},
    requests: 0,
  }
  await writeFile(
    join(snapshotDir, 'checksums.json'),
    `${JSON.stringify(
      {
        ...checksumPayload,
        report_sha256: checksumReportDigest(checksumPayload),
      },
      null,
      2,
    )}\n`,
  )
  return { snapshotDir, receipt, timeEntryHarvestId }
}
