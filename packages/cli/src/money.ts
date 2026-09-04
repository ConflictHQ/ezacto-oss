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
    parts.push(`total $${centsToDollars(total.total_cents)}`)
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
      const spent = grain.unit === 'seconds'
        ? String(grain.spent_seconds ?? 0)
        : String(grain.spent_cents ?? 0)
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

// --- export -----------------------------------------------------------------

export const exportTimeEntries = async (
  client: EzactoClient,
  input: {
    from: string
    to: string
    clientId?: number
    projectId?: number
  },
): Promise<MoneyCommandResult> => {
  const entries = await collectTimeEntries(client, {
    from: canonicalDate(input.from),
    to: canonicalDate(input.to),
    ...(input.clientId === undefined ? {} : { client_id: input.clientId }),
    ...(input.projectId === undefined ? {} : { project_id: input.projectId }),
  })

  const header = csvRow([
    'id', 'user_id', 'project_id', 'task_id', 'spent_date',
    'seconds', 'billable', 'is_billed', 'notes',
  ])
  const rows = entries.map((entry) =>
    csvRow([
      String(entry.id),
      String(entry.user_id),
      String(entry.project_id),
      String(entry.task_id),
      entry.spent_date,
      String(entry.seconds),
      String(entry.billable),
      String(entry.is_billed),
      entry.notes ?? '',
    ]),
  )

  const csv = [header, ...rows].join('\n')
  return {
    json: entries,
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
  },
): Promise<MoneyCommandResult> => {
  const expenses = await collectExpenses(client, {
    from: canonicalDate(input.from),
    to: canonicalDate(input.to),
    ...(input.clientId === undefined ? {} : { client_id: input.clientId }),
    ...(input.projectId === undefined ? {} : { project_id: input.projectId }),
  })

  const header = csvRow([
    'id', 'user_id', 'project_id', 'expense_category_id', 'spent_date',
    'total_cost_cents', 'billable', 'is_billed', 'notes',
  ])
  const rows = expenses.map((expense) =>
    csvRow([
      String(expense.id),
      String(expense.user_id),
      String(expense.project_id),
      String(expense.expense_category_id),
      expense.spent_date,
      String(expense.total_cost_cents),
      String(expense.billable),
      String(expense.is_billed),
      expense.notes ?? '',
    ]),
  )

  const csv = [header, ...rows].join('\n')
  return {
    json: expenses,
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
