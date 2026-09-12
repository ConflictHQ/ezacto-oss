import { randomUUID } from 'node:crypto'
import {
  type EzactoClient,
  type GeneralResource,
  type Invoice,
  type TimeEntry,
  type Expense,
  type UninvoicedCurrencyTotal,
  type ClientRollupNode,
  type ProjectBudgetGrain,
} from '@ezacto/client'

export interface MoneyCommandResult {
  json: unknown
  human: string
  csv?: string
}

// --- helpers ----------------------------------------------------------------

const centsToDollars = (cents: number): string =>
  (cents / 100).toFixed(2)

const collectGeneral = async (
  load: (cursor?: string) => ReturnType<EzactoClient['listClients']>,
): Promise<GeneralResource[]> => {
  const records: GeneralResource[] = []
  let cursor: string | undefined
  do {
    const page = await load(cursor)
    records.push(...page.data)
    cursor = page.page.next_cursor ?? undefined
  } while (cursor !== undefined)
  return records
}

const textField = (resource: GeneralResource, name: string): string | null => {
  const value = resource[name]
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

const displayName = (resource: GeneralResource): string =>
  textField(resource, 'name') ?? textField(resource, 'code') ?? `#${resource.id}`

const normalizedLabel = (value: string): string =>
  value
    .normalize('NFKD')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '')

const resolveResource = (
  kind: string,
  raw: string,
  resources: readonly GeneralResource[],
): GeneralResource => {
  const wanted = normalizedLabel(raw)
  const matches = resources.filter((resource) => {
    const labels = [textField(resource, 'name'), textField(resource, 'code')]
      .filter((value): value is string => value !== null)
      .map(normalizedLabel)
    return labels.includes(wanted) || String(resource.id) === raw
  })
  if (matches.length === 0) throw new Error(`${kind} not found: ${raw}`)
  if (matches.length > 1) {
    throw new Error(
      `${kind} is ambiguous: ${raw} (${matches.map(displayName).join(', ')})`,
    )
  }
  return matches[0]!
}

const canonicalDatePattern = /^\d{4}-\d{2}-\d{2}$/

const canonicalDate = (raw: string): string => {
  if (!canonicalDatePattern.test(raw)) throw new Error(`invalid date: ${raw}`)
  const parsed = new Date(`${raw}T00:00:00.000Z`)
  if (
    !Number.isFinite(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== raw
  ) {
    throw new Error(`invalid date: ${raw}`)
  }
  return raw
}

const collectTimeEntries = async (
  client: EzactoClient,
  query: Readonly<Record<string, string | number | boolean | undefined>>,
): Promise<TimeEntry[]> => {
  const records: TimeEntry[] = []
  let cursor: string | undefined
  do {
    const page = await client.listTimeEntries({
      query: { ...query, per_page: 200, ...(cursor === undefined ? {} : { cursor }) },
    })
    records.push(...page.data)
    cursor = page.page.next_cursor ?? undefined
  } while (cursor !== undefined)
  return records
}

const collectExpenses = async (
  client: EzactoClient,
  query: Readonly<Record<string, string | number | boolean | undefined>>,
): Promise<Expense[]> => {
  const records: Expense[] = []
  let cursor: string | undefined
  do {
    const page = await client.listExpenses({
      query: { ...query, per_page: 200, ...(cursor === undefined ? {} : { cursor }) },
    })
    records.push(...page.data)
    cursor = page.page.next_cursor ?? undefined
  } while (cursor !== undefined)
  return records
}

const collectInvoices = async (
  client: EzactoClient,
): Promise<Invoice[]> => {
  const records: Invoice[] = []
  let cursor: string | undefined
  do {
    const page = await client.listInvoices({
      query: { per_page: 200, ...(cursor === undefined ? {} : { cursor }) },
    })
    records.push(...page.data)
    cursor = page.page.next_cursor ?? undefined
  } while (cursor !== undefined)
  return records
}

// --- CSV formatting ---------------------------------------------------------

const csvEscape = (value: string): string =>
  /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value

const csvRow = (fields: readonly string[]): string =>
  fields.map(csvEscape).join(',')

// --- uninvoiced -------------------------------------------------------------

const formatCurrencyTotal = (total: UninvoicedCurrencyTotal): string => {
  const parts = [
    `  ${total.currency}:`,
    `${total.time_entry_count} time entries (${Math.round(total.rounded_seconds / 3600 * 100) / 100}h)`,
    `${total.expense_count} expenses`,
  ]
  if (total.total_cents !== undefined) {
    parts.push(`total ${centsToDollars(total.total_cents)}`)
  }
  return parts.join(' ')
}

export const uninvoiced = async (
  client: EzactoClient,
  input: {
    from: string
    to: string
    clientId?: number
    projectId?: number
  },
): Promise<MoneyCommandResult> => {
  const report = (
    await client.getUninvoicedReport({
      query: {
        from: canonicalDate(input.from),
        to: canonicalDate(input.to),
        ...(input.clientId === undefined ? {} : { client_id: input.clientId }),
        ...(input.projectId === undefined ? {} : { project_id: input.projectId }),
      },
    })
  ).data

  const lines = [`uninvoiced ${report.from} — ${report.to}`]
  if (report.client_id !== null) lines[0] += ` (client #${report.client_id})`
  if (report.project_id !== null) lines[0] += ` (project #${report.project_id})`
  if (report.totals.length === 0) {
    lines.push('  (no uninvoiced amounts)')
  } else {
    for (const total of report.totals) {
      lines.push(formatCurrencyTotal(total))
    }
  }

  return { json: report, human: lines.join('\n') }
}

// --- invoice generate -------------------------------------------------------

export const generateInvoice = async (
  client: EzactoClient,
  input: {
    clientId: number
    from: string
    to: string
    projectIds: number[]
    timeSummaryType?: string | null
    expenseSummaryType?: string | null
  },
): Promise<MoneyCommandResult> => {
  const validTimeSummary = new Set(['project', 'task', 'people', 'detailed'])
  const validExpenseSummary = new Set(['project', 'category', 'people', 'detailed'])

  if (
    input.timeSummaryType !== undefined &&
    input.timeSummaryType !== null &&
    !validTimeSummary.has(input.timeSummaryType)
  ) {
    throw new Error(`invalid --time-summary: ${input.timeSummaryType}; use project, task, people, or detailed`)
  }
  if (
    input.expenseSummaryType !== undefined &&
    input.expenseSummaryType !== null &&
    !validExpenseSummary.has(input.expenseSummaryType)
  ) {
    throw new Error(`invalid --expense-summary: ${input.expenseSummaryType}; use project, category, people, or detailed`)
  }

  const invoice = (
    await client.generateInvoice({
      'Idempotency-Key': randomUUID(),
      body: {
        client_id: input.clientId,
        from: canonicalDate(input.from),
        to: canonicalDate(input.to),
        project_ids: input.projectIds,
        time_summary_type: (input.timeSummaryType ?? null) as
          'project' | 'task' | 'people' | 'detailed' | null,
        expense_summary_type: (input.expenseSummaryType ?? null) as
          'project' | 'category' | 'people' | 'detailed' | null,
      },
    })
  ).data

  return {
    json: invoice,
    human: [
      `invoice #${invoice.number} created (${invoice.state})`,
      `  client:  #${invoice.client_id}`,
      `  period:  ${invoice.period_start ?? '—'} — ${invoice.period_end ?? '—'}`,
      `  amount:  $${centsToDollars(invoice.amount_cents)} ${invoice.currency}`,
      `  due:     ${invoice.due_date}`,
    ].join('\n'),
  }
}

// --- invoice send -----------------------------------------------------------

export const sendInvoice = async (
  client: EzactoClient,
  input: {
    invoiceId: number
    recipients?: Array<{ name: string; email: string }>
  },
): Promise<MoneyCommandResult> => {
  const invoice = (await client.getInvoice({ id: input.invoiceId })).data

  const result = (
    await client.transitionInvoice({
      id: input.invoiceId,
      'Idempotency-Key': randomUUID(),
      body: {
        command: 'send',
        expected_version: invoice.version,
        ...(input.recipients === undefined
          ? {}
          : { recipients: input.recipients }),
      },
    })
  ).data

  return {
    json: result,
    human: `invoice #${invoice.number} sent (${result.command.invoice.state})`,
  }
}

// --- invoice list -----------------------------------------------------------

export const listInvoices = async (
  client: EzactoClient,
): Promise<MoneyCommandResult> => {
  const invoices = await collectInvoices(client)

  if (invoices.length === 0) {
    return { json: [], human: '(no invoices)' }
  }

  const lines = invoices.map(
    (invoice) =>
      `#${invoice.number}  ${invoice.state.padEnd(6)}  $${centsToDollars(invoice.amount_cents).padStart(10)} ${invoice.currency}  ${invoice.issue_date}  client #${invoice.client_id}`,
  )

  return { json: invoices, human: lines.join('\n') }
}

// --- report run -------------------------------------------------------------

const reportDefinitions = new Set(['uninvoiced', 'client-rollup', 'project-budget'])

export const validReportDefinitions = (): readonly string[] => [...reportDefinitions]

export const runReport = async (
  client: EzactoClient,
  input: {
    definition: string
    from: string
    to: string
    clientId?: number
    projectId?: number
  },
): Promise<MoneyCommandResult> => {
  if (!reportDefinitions.has(input.definition)) {
    throw new Error(
      `unknown report: ${input.definition}; available: ${[...reportDefinitions].join(', ')}`,
    )
  }

  if (input.definition === 'uninvoiced') {
    return uninvoiced(client, input)
  }

  if (input.definition === 'client-rollup') {
    if (input.clientId === undefined) {
      throw new Error('client-rollup report requires --client')
    }
    const report = (
      await client.getClientRollupReport({
        clientId: input.clientId,
        query: { from: canonicalDate(input.from), to: canonicalDate(input.to) },
      })
    ).data

    const lines = [`client-rollup ${report.from} — ${report.to} (client #${report.root_client_id})`]
    for (const node of report.nodes) {
      const indent = '  '.repeat(node.depth + 1)
      lines.push(`${indent}${node.name}: ${node.rollup.time_entry_count} entries, ${Math.round(node.rollup.rounded_seconds / 3600 * 100) / 100}h`)
    }

    const csvLines = [
      csvRow(['client_id', 'name', 'parent_client_id', 'depth', 'time_entry_count', 'expense_count', 'rounded_seconds', 'billable_seconds']),
      ...report.nodes.map((node: ClientRollupNode) =>
        csvRow([
          String(node.client_id),
          node.name,
          node.parent_client_id === null ? '' : String(node.parent_client_id),
          String(node.depth),
          String(node.rollup.time_entry_count),
          String(node.rollup.expense_count),
          String(node.rollup.rounded_seconds),
          String(node.rollup.billable_seconds),
        ]),
      ),
    ]

    return { json: report, human: lines.join('\n'), csv: csvLines.join('\n') }
  }

  // project-budget
  if (input.projectId === undefined) {
    throw new Error('project-budget report requires --project')
  }
  const report = (
    await client.getProjectBudgetReport({
      projectId: input.projectId,
      query: { from: canonicalDate(input.from), to: canonicalDate(input.to) },
    })
  ).data

  const lines = [
    `project-budget ${report.from} — ${report.to} (project #${report.project_id}, budget by ${report.budget_by})`,
  ]
  for (const grain of report.grains) {
    const budget = grain.unit === 'seconds'
      ? `${grain.budget_seconds ?? '—'}s`
      : `$${grain.budget_cents != null ? centsToDollars(grain.budget_cents) : '—'}`
    const spent = grain.unit === 'seconds'
      ? `${grain.spent_seconds ?? 0}s`
      : `$${grain.spent_cents != null ? centsToDollars(grain.spent_cents) : '—'}`
    lines.push(`  ${grain.source} #${grain.source_id}: budget ${budget}, spent ${spent}`)
  }

  const csvLines = [
    csvRow(['source', 'source_id', 'unit', 'calculation', 'budget', 'spent', 'remaining', 'unpriced_entry_count']),
    ...report.grains.map((grain: ProjectBudgetGrain) => {
      const budget = grain.unit === 'seconds'
        ? String(grain.budget_seconds ?? '')
        : String(grain.budget_cents ?? '')
      // An absent cost spend is withheld, not zero. The seconds branch keeps
      // its 0 — a time grain always reports one — but printing 0 for a cents
      // grain the filter emptied would state the very number we refuse to state.
      const spent = grain.unit === 'seconds'
        ? String(grain.spent_seconds ?? 0)
        : String(grain.spent_cents ?? '')
      const remaining = grain.unit === 'seconds'
        ? String(grain.remaining_seconds ?? '')
        : String(grain.remaining_cents ?? '')
      return csvRow([
        grain.source,
        String(grain.source_id),
        grain.unit,
        grain.calculation,
        budget,
        spent,
        remaining,
        String(grain.unpriced_entry_count),
      ])
    }),
  ]

  return { json: report, human: lines.join('\n'), csv: csvLines.join('\n') }
}

// --- export columns ---------------------------------------------------------

/**
 * One column an export knows how to emit. `confidential` marks the fields that
 * price our own labour rather than describe the work: #310 hands these exports
 * to an agency that subcontracted us and bills its own client under its own
 * brand, and a cost rate that leaves that way leaves once and permanently.
 */
export interface ExportColumn<Row> {
  readonly name: string
  readonly confidential: boolean
  readonly value: (row: Row) => string | number | boolean | null
}

/**
 * The closed set of time-entry columns. The API hands an administrator
 * `billable_rate_cents` and `cost_rate_cents` on every entry — canViewMoneyField
 * in @ezacto/core gates them by who is asking, not by who will read the file —
 * so they are enumerated here and marked confidential rather than simply left
 * out. A column the enumeration does not mention is a column nobody has decided
 * about, and this list is the one place that decision can be made once.
 */
export const timeExportColumns: readonly ExportColumn<TimeEntry>[] = [
  { name: 'id', confidential: false, value: (entry) => entry.id },
  { name: 'user_id', confidential: false, value: (entry) => entry.user_id },
  { name: 'project_id', confidential: false, value: (entry) => entry.project_id },
  { name: 'task_id', confidential: false, value: (entry) => entry.task_id },
  { name: 'spent_date', confidential: false, value: (entry) => entry.spent_date },
  { name: 'seconds', confidential: false, value: (entry) => entry.seconds },
  { name: 'billable', confidential: false, value: (entry) => entry.billable },
  { name: 'billed', confidential: true, value: (entry) => entry.is_billed ?? null },
  { name: 'notes', confidential: false, value: (entry) => entry.notes ?? '' },
  {
    name: 'billable_rate_cents',
    confidential: true,
    value: (entry) => entry.billable_rate_cents ?? null,
  },
  {
    name: 'cost_rate_cents',
    confidential: true,
    value: (entry) => entry.cost_rate_cents ?? null,
  },
]

/**
 * Expenses carry no rate of ours: `total_cost_cents` is the third-party amount
 * the client is asked to reimburse, which is precisely what a subcontracted
 * export has to show. Invoice state is confidential; the flag is spelled out
 * on every column so that adding one forces the question.
 */
export const expenseExportColumns: readonly ExportColumn<Expense>[] = [
  { name: 'id', confidential: false, value: (expense) => expense.id },
  { name: 'user_id', confidential: false, value: (expense) => expense.user_id },
  { name: 'project_id', confidential: false, value: (expense) => expense.project_id },
  {
    name: 'expense_category_id',
    confidential: false,
    value: (expense) => expense.expense_category_id,
  },
  { name: 'spent_date', confidential: false, value: (expense) => expense.spent_date },
  {
    name: 'total_cost_cents',
    confidential: false,
    value: (expense) => expense.total_cost_cents,
  },
  { name: 'billable', confidential: false, value: (expense) => expense.billable },
  {
    name: 'billed',
    confidential: true,
    value: (expense) => expense.is_billed ?? null,
  },
  { name: 'notes', confidential: false, value: (expense) => expense.notes ?? '' },
]

export type ExportKind = 'time' | 'expenses'

const exportableNames = <Row>(
  columns: readonly ExportColumn<Row>[],
): readonly string[] =>
  columns.filter((column) => !column.confidential).map((column) => column.name)

export const validExportColumns = (kind: ExportKind): readonly string[] =>
  kind === 'time'
    ? exportableNames(timeExportColumns)
    : exportableNames(expenseExportColumns)

/**
 * Resolve `--columns` against the enumeration. An unrecognised name is refused
 * rather than dropped, because a silently ignored column produces a file that is
 * missing data the operator believes is in it. A confidential name gets its own
 * refusal: it is not a typo but a request we will not serve, and it stays
 * refused until the client export profile of #310 exists to say who is asking.
 */
const selectExportColumns = <Row>(
  kind: ExportKind,
  columns: readonly ExportColumn<Row>[],
  requested: string | undefined,
): readonly ExportColumn<Row>[] => {
  const exportable = columns.filter((column) => !column.confidential)
  if (requested === undefined) return exportable

  const names = requested.split(',').map((name) => name.trim())
  if (names.some((name) => name === '')) {
    throw new Error('--columns must be a comma-separated list of column names')
  }

  const chosen = new Set<string>()
  return names.map((name) => {
    const column = columns.find((candidate) => candidate.name === name)
    if (column === undefined) {
      throw new Error(
        `unknown ${kind} export column: ${name}; available: ${exportable.map((c) => c.name).join(', ')}`,
      )
    }
    if (column.confidential) {
      throw new Error(
        `${kind} export column is confidential and cannot be exported: ${name}`,
      )
    }
    if (chosen.has(name)) throw new Error(`duplicate ${kind} export column: ${name}`)
    chosen.add(name)
    return column
  })
}

const csvCell = (value: string | number | boolean | null): string =>
  value === null ? '' : String(value)

/**
 * Both renderings go through the chosen columns, JSON included. `ez export time
 * --json` used to print the raw API entries, which is where the rates actually
 * reached a terminal; a redaction that only edits the CSV header would be the
 * render-time hiding #310 asks us not to build.
 */
const renderExport = <Row>(
  columns: readonly ExportColumn<Row>[],
  rows: readonly Row[],
): { json: unknown; csv: string } => ({
  json: rows.map((row) =>
    Object.fromEntries(columns.map((column) => [column.name, column.value(row)])),
  ),
  csv: [
    csvRow(columns.map((column) => column.name)),
    ...rows.map((row) => csvRow(columns.map((column) => csvCell(column.value(row))))),
  ].join('\n'),
})

// --- confidentiality --------------------------------------------------------

/**
 * Every name the export enumeration already refuses to hand out, plus the two
 * report fields the API derives from the same cost rates: `cost_cents` is what
 * a client's work costs us, and `budget_burn_cents` is that cost measured
 * against a budget. The enumeration is where the decision lives, so this reads
 * it back rather than restating it — one list changes when a field's status does.
 */
const confidentialFieldNames: ReadonlySet<string> = new Set([
  ...[...timeExportColumns, ...expenseExportColumns]
    .filter((column) => column.confidential)
    .map((column) => column.name),
  'cost_cents',
  'budget_burn_cents',
])

/**
 * `spent_cents` and `remaining_cents` are our cost base only on a record the API
 * priced from cost rates; where it priced them from billable rates the identical
 * field is the amount the client is asked to pay, which is exactly what an
 * export exists to show. So this pair is decided by the record it sits in, not
 * by its name.
 */
const costCalculatedAmountNames: ReadonlySet<string> = new Set([
  'spent_cents',
  'remaining_cents',
])

/**
 * Whether the record says the pair was priced at the client's rate. A budget
 * grain says it in `calculation`; the budget summary beside it — the same report
 * family, one row per project — carries no `calculation` at all and says the
 * same thing in `budget_by`, where only `task_fees` bills at the client's rate.
 * These are the two spellings the API's own `canViewMoneyField` gating reads.
 *
 * A record that spells neither has not said it, and the pair is withheld. The
 * hole is a rule that lets our cost base through because its discriminator is
 * absent, not the name of any one discriminator: this register is trusted to
 * cover the next payload shape somebody adds, and a shape it does not recognise
 * has to fail closed to deserve that.
 */
const isBillablePricedRecord = (
  record: Readonly<Record<string, unknown>>,
): boolean =>
  record['calculation'] === 'billable' || record['budget_by'] === 'task_fees'

const isConfidentialField = (
  name: string,
  record: Readonly<Record<string, unknown>>,
): boolean =>
  confidentialFieldNames.has(name) ||
  (costCalculatedAmountNames.has(name) && !isBillablePricedRecord(record))

/** Drop every confidential field from an API payload, at any depth. */
export const withoutConfidentialFields = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutConfidentialFields)
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  const kept: Record<string, unknown> = {}
  for (const [name, nested] of Object.entries(record)) {
    if (isConfidentialField(name, record)) continue
    kept[name] = withoutConfidentialFields(nested)
  }
  return kept
}

/**
 * A `fetch` that filters the API's JSON before the client ever parses it.
 *
 * The filter belongs on arrival rather than in each verb's output, because a
 * verb is not one exit: `ez export time` projected its rows through the
 * enumeration while `ez report run` and `ez week` still printed the payload
 * verbatim, and a report's human and CSV renderings are built from that same
 * payload. Filtering here leaves nothing for any rendering — those three, or
 * the next verb somebody adds — to reach for.
 */
export const confidentialityFilteredFetch = (
  inner: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch =>
  async (input, init) => {
    const response = await inner(input, init)
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('application/json')) return response
    const body = await response.text()
    let filtered: string | null = null
    if (body !== '') {
      try {
        filtered = JSON.stringify(withoutConfidentialFields(JSON.parse(body)))
      } catch {
        // Not JSON after all. Hand back what arrived: the client has its own
        // parse guard, and inventing a body here would hide the server's fault.
        filtered = body
      }
    }
    const headers = new Headers(response.headers)
    // The filtered body is a different length, and the client reads the text
    // rather than the header, so keeping the original would only mislead.
    headers.delete('content-length')
    return new Response(filtered, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }

// --- export -----------------------------------------------------------------

export const exportTimeEntries = async (
  client: EzactoClient,
  input: {
    from: string
    to: string
    clientId?: number
    projectId?: number
    columns?: string
  },
): Promise<MoneyCommandResult> => {
  // Resolve the columns before the first request: a bad --columns should cost
  // the operator nothing but the typo.
  const columns = selectExportColumns('time', timeExportColumns, input.columns)

  const entries = await collectTimeEntries(client, {
    from: canonicalDate(input.from),
    to: canonicalDate(input.to),
    ...(input.clientId === undefined ? {} : { client_id: input.clientId }),
    ...(input.projectId === undefined ? {} : { project_id: input.projectId }),
  })

  const { json, csv } = renderExport(columns, entries)
  return {
    json,
    human: entries.length === 0
      ? '(no time entries)'
      : `${entries.length} time entries exported`,
    csv,
  }
}

export const exportExpenses = async (
  client: EzactoClient,
  input: {
    from: string
    to: string
    clientId?: number
    projectId?: number
    columns?: string
  },
): Promise<MoneyCommandResult> => {
  const columns = selectExportColumns('expenses', expenseExportColumns, input.columns)

  const expenses = await collectExpenses(client, {
    from: canonicalDate(input.from),
    to: canonicalDate(input.to),
    ...(input.clientId === undefined ? {} : { client_id: input.clientId }),
    ...(input.projectId === undefined ? {} : { project_id: input.projectId }),
  })

  const { json, csv } = renderExport(columns, expenses)
  return {
    json,
    human: expenses.length === 0
      ? '(no expenses)'
      : `${expenses.length} expenses exported`,
    csv,
  }
}

// --- resource resolution helpers (exported for CLI integration) --------------

export const resolveClientId = async (
  client: EzactoClient,
  raw: string,
): Promise<number> => {
  const clients = await collectGeneral((cursor) =>
    client.listClients({
      query: { per_page: 200, ...(cursor === undefined ? {} : { cursor }) },
    }),
  )
  return resolveResource('client', raw, clients).id
}

export const resolveProjectId = async (
  client: EzactoClient,
  raw: string,
): Promise<number> => {
  const projects = await collectGeneral((cursor) =>
    client.listProjects({
      query: {
        per_page: 200,
        is_active: true,
        ...(cursor === undefined ? {} : { cursor }),
      },
    }),
  )
  return resolveResource('project', raw, projects).id
}

export const resolveProjectIds = async (
  client: EzactoClient,
  rawValues: readonly string[],
): Promise<number[]> => {
  const projects = await collectGeneral((cursor) =>
    client.listProjects({
      query: {
        per_page: 200,
        is_active: true,
        ...(cursor === undefined ? {} : { cursor }),
      },
    }),
  )
  return rawValues.map((raw) => resolveResource('project', raw, projects).id)
}
