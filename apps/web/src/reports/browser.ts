import {
  EzactoApiError,
  type ClientRollupMetrics,
  type ClientRollupReport,
  type ContractorCostReport,
  type ContractorCostRow,
  type DetailedExpenseReport,
  type DetailedTimeReport,
  type DetailedTimeRow,
  type GeneralResource,
  type InvoicedReport,
  type MyHoursReport,
  type PaymentsReceivedReport,
  type ProfitabilityReport,
  type ProfitabilityDimensionRow,
  type ProjectBudgetReport,
  type ReceivablesReport,
  type ReportDefinitionRegistry,
  type ReportRunnerResult,
  type SavedReport,
  type SavedReportInput,
  type TimeReport,
  type TimeReportAmount,
  type TimeReportClientRow,
  type TimeReportProjectRow,
  type TimeReportTaskRow,
  type TimeReportTeammateRow,
  type TimeReportTotals,
  type UninvoicedReport,
  type Whoami,
} from '@conflict-hq/ezacto-client'
import { createPeriodControl } from '../components/period.js'
import { invoiceIdentityCanWrite } from '../invoices/model.js'
import { moneyText } from '../money-display.js'
// The team roster's own formatter. Utilization is one figure with one meaning,
// and a second renderer for it here is how the same person comes to read 17%
// on one screen and 17.4% on another.
import { teamCapabilities, teamUtilization } from '../team/model.js'
import {
  billablePercent,
  canReadCostReports,
  activityEventLabel,
  activitySubjectLabel,
  canReadFinancialReports,
  contractorCostCsv,
  profitabilityDelta,
  decimalHours,
  detailedExpenseCsv,
  detailedExpenseOptionsFromUrl,
  detailedTimeCsv,
  detailedTimeOptionsFromUrl,
  detailedTimeProjectLabel,
  formatReportCents,
  formatReportHours,
  formatReportMoney,
  groupDetailedTimeRows,
  isReportKind,
  invoicedReportOptionsFromUrl,
  profitabilityOptionsFromUrl,
  reportFiltersFromUrl,
  reportFiltersUrl,
  reportResourceLabel,
  timeReportOptionsFromUrl,
  validateReportFilters,
  type DetailedTimeGrain,
  type DetailedTimeGrouping,
  type DetailedTimeHours,
  type DetailedTimeOptions,
  type DetailedExpenseOptions,
  type ReportFilters,
  type ActivityLogEntry,
  type ReportKind,
  type ReportWorkspaceApi,
  type InvoicedReportOptions,
  type InvoicedReportStatus,
  type ProfitabilityDimension,
  type ProfitabilityOptions,
  type TimeReportTab,
  type TimeReportOptions,
} from './model.js'

/**
 * The kinds that are not the financial surface. `my-hours` is here because it
 * returns the acting user's own rows and nothing else -- the API decides whose
 * they are -- and `project-budget` because a project's own budget is visible
 * wherever the project is.
 */
const openToEveryProfile: ReadonlySet<ReportKind> = new Set<ReportKind>([
  'my-hours',
  'project-budget',
])

/**
 * Three tiers, not two. `contractor-cost` is all cost, and the route refuses it
 * to anybody but an administrator, so treating it as one more financial kind
 * would hand accounting and an executive manager a tab that 403s -- the failure
 * the strip already avoids for a member.
 */
const canReadKind = (
  kind: ReportKind,
  identity: Pick<Whoami, 'profile' | 'manager_grants'>,
): boolean =>
  kind === 'contractor-cost' || kind === 'profitability'
    ? canReadCostReports(identity)
    : openToEveryProfile.has(kind) || canReadFinancialReports(identity.profile)

const required = <ElementType extends Element>(selector: string): ElementType => {
  const element = document.querySelector<ElementType>(selector)
  if (element === null) throw new Error(`reports element missing: ${selector}`)
  return element
}

const messageFor = (error: unknown): string => {
  if (error instanceof EzactoApiError) {
    if (error.status === 403) return 'Your profile does not have access to this report.'
    if (error.status === 404) return 'This report is unavailable or outside your project access.'
    if (typeof error.body === 'object' && error.body !== null) {
      const detail = Reflect.get(error.body, 'error')
      if (typeof detail === 'object' && detail !== null) {
        const fields = Reflect.get(detail, 'fields')
        if (Array.isArray(fields)) {
          const first = fields.find(
            (field) =>
              typeof field === 'object' &&
              field !== null &&
              typeof Reflect.get(field, 'message') === 'string',
          )
          if (first !== undefined) return String(Reflect.get(first, 'message'))
        }
        const message = Reflect.get(detail, 'message')
        if (typeof message === 'string' && message.trim() !== '') return message
      }
    }
  }
  return error instanceof Error ? error.message : 'The report could not be loaded.'
}

const collect = async (
  load: (cursor?: string) => Promise<{
    readonly data: readonly GeneralResource[]
    readonly page: { readonly next_cursor: string | null }
  }>,
  signal: AbortSignal,
): Promise<GeneralResource[]> => {
  const values: GeneralResource[] = []
  let cursor: string | undefined
  do {
    signal.throwIfAborted()
    const page = await load(cursor)
    values.push(...page.data)
    cursor = page.page.next_cursor ?? undefined
  } while (cursor !== undefined)
  return values
}

const element = <Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  className?: string,
): HTMLElementTagNameMap[Tag] => {
  const result = document.createElement(tag)
  if (className !== undefined) result.className = className
  return result
}

const textElement = <Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  text: string,
  className?: string,
): HTMLElementTagNameMap[Tag] => {
  const result = element(tag, className)
  result.textContent = text
  return result
}

const linkElement = (href: string, text: string): HTMLAnchorElement => {
  const anchor = element('a')
  anchor.href = href
  anchor.textContent = text
  return anchor
}

/** Reports carry ids; the filter catalogs carry the names those ids stand for. */
const catalogLabel = (
  resources: readonly GeneralResource[],
  id: number,
  fallback: string,
): string => {
  const match = resources.find((resource) => resource.id === id)
  return match === undefined ? fallback : reportResourceLabel(match)
}

const countLabel = (count: number, singular: string, plural = `${singular}s`): string =>
  `${count.toLocaleString('en-US')} ${count === 1 ? singular : plural}`

const fact = (term: string, detail: string | Node): HTMLDivElement => {
  const wrapper = element('div')
  const value = element('dd')
  value.append(detail)
  wrapper.append(textElement('dt', term), value)
  return wrapper
}

/**
 * A report amount, marked as one. The em dash a withheld or absent figure
 * renders is left unmarked: it is the absence of an amount, and dots over it
 * would claim there is a number behind them.
 */
const reportMoney = (
  cents: number | null | undefined,
  currency: string,
): string | HTMLSpanElement => {
  const label = formatReportMoney(cents, currency)
  return cents === null || cents === undefined ? label : moneyText(label)
}

const reportCents = (cents: number | null | undefined): string | HTMLSpanElement => {
  const label = formatReportCents(cents)
  return cents === null || cents === undefined ? label : moneyText(label)
}

const moneyCell = (cents: number | null | undefined, currency: string): HTMLTableCellElement => {
  const cell = element('td')
  cell.append(reportMoney(cents, currency))
  return cell
}

const warning = (message: string): HTMLParagraphElement => {
  const result = textElement('p', message, 'report-warning')
  result.setAttribute('role', 'status')
  return result
}

const localToday = (): string => {
  const today = new Date()
  return [
    String(today.getFullYear()).padStart(4, '0'),
    String(today.getMonth() + 1).padStart(2, '0'),
    String(today.getDate()).padStart(2, '0'),
  ].join('-')
}

const reportHeading = (
  title: string,
  ...detail: readonly (string | Node)[]
): HTMLElement => {
  const header = element('header', 'report-result-heading')
  const description = element('p')
  description.append(...detail)
  header.append(textElement('h2', title, 'report-result-title'), description)
  return header
}

/**
 * One row per project, and both durations on each. The tracked column is the
 * number the week grid shows, so the report and the timesheet a member came
 * from agree; the rounded column is what the same hours are worth to a budget
 * or an invoice. Where the account does not round they read the same, which is
 * the answer to "why are there two", not a reason to drop one.
 */
const renderMyHours = (report: Readonly<MyHoursReport>): DocumentFragment => {
  const fragment = document.createDocumentFragment()
  fragment.append(reportHeading('My hours', `${report.from} through ${report.to}`))
  if (report.projects.length === 0) {
    fragment.append(
      textElement('p', 'You logged no time in this period.', 'report-empty'),
    )
    return fragment
  }
  const facts = element('dl', 'report-facts')
  facts.append(
    fact('Tracked time', formatReportHours(report.seconds)),
    fact('Rounded time', formatReportHours(report.rounded_seconds)),
    fact('Billable time', formatReportHours(report.billable_seconds)),
    fact('Time entries', report.time_entry_count.toLocaleString('en-US')),
  )
  const wrapper = element('div', 'report-table-wrap')
  const table = element('table', 'report-table')
  const head = element('thead')
  const headerRow = element('tr')
  for (const label of [
    'Client',
    'Project',
    'Tracked',
    'Rounded',
    'Billable',
    'Entries',
  ]) {
    const cell = textElement('th', label)
    cell.scope = 'col'
    headerRow.append(cell)
  }
  head.append(headerRow)
  const body = element('tbody')
  for (const project of report.projects) {
    const row = element('tr')
    const client = element('th')
    client.scope = 'row'
    client.append(linkElement(`/clients/${project.client_id}`, project.client_name))
    const name = element('td')
    name.append(
      linkElement(
        `/projects/${project.project_id}`,
        // Same test `reportResourceLabel` applies, and for the same reason: a
        // project with no code stores the empty string, not null, so a
        // null-check alone prints an empty pair of brackets in front of the
        // name.
        project.project_code.trim() === ''
          ? project.project_name
          : `[${project.project_code.trim()}] ${project.project_name}`,
      ),
    )
    row.append(
      client,
      name,
      textElement('td', formatReportHours(project.seconds)),
      textElement('td', formatReportHours(project.rounded_seconds)),
      textElement('td', formatReportHours(project.billable_seconds)),
      textElement('td', project.time_entry_count.toLocaleString('en-US')),
    )
    body.append(row)
  }
  const foot = element('tfoot')
  const totalRow = element('tr')
  const totalLabel = textElement('th', 'Total')
  totalLabel.scope = 'row'
  totalLabel.colSpan = 2
  totalRow.append(
    totalLabel,
    textElement('td', formatReportHours(report.seconds)),
    textElement('td', formatReportHours(report.rounded_seconds)),
    textElement('td', formatReportHours(report.billable_seconds)),
    textElement('td', report.time_entry_count.toLocaleString('en-US')),
  )
  foot.append(totalRow)
  table.append(head, body, foot)
  wrapper.append(table)
  fragment.append(facts, wrapper)
  return fragment
}

const invoiceHref = (
  report: Readonly<UninvoicedReport>,
  project: Readonly<UninvoicedReport['projects'][number]>,
): string => {
  const query = new URLSearchParams({
    client_id: String(project.client_id),
    project_id: String(project.project_id),
    from: report.from,
    to: report.to,
  })
  return `/invoices/new?${query.toString()}`
}

const renderUninvoicedProjects = (
  report: Readonly<UninvoicedReport>,
  canInvoice: boolean,
): HTMLElement => {
  const grouped = new Map<number, UninvoicedReport['projects']>()
  for (const project of report.projects ?? []) {
    const projects = grouped.get(project.client_id) ?? []
    projects.push(project)
    grouped.set(project.client_id, projects)
  }

  const clients = element('div', 'report-uninvoiced-clients')
  clients.dataset.uninvoicedProjects = ''
  for (const projects of grouped.values()) {
    const section = element('section', 'report-uninvoiced-client')
    section.append(textElement('h3', projects[0]!.client_name))
    const wrapper = element('div', 'report-table-wrap')
    const table = element('table', 'report-table')
    const head = element('thead')
    const header = element('tr')
    for (const label of ['Project', 'Currency', 'Time', 'Expenses', 'Total', '']) {
      const cell = textElement('th', label)
      cell.scope = 'col'
      header.append(cell)
    }
    head.append(header)
    const body = element('tbody')
    for (const project of projects) {
      for (const [index, total] of project.totals.entries()) {
        const row = element('tr')
        row.dataset.projectId = String(project.project_id)
        const projectCell = textElement(
          'th',
          index === 0
            ? `${project.project_name}${project.project_code === '' ? '' : ` (${project.project_code})`}`
            : '',
        )
        projectCell.scope = 'row'
        const action = element('td')
        if (canInvoice && index === 0) {
          const link = textElement('a', 'Invoice')
          link.className = 'report-row-action'
          link.setAttribute('href', invoiceHref(report, project))
          action.append(link)
        }
        row.append(
          projectCell,
          textElement('td', total.currency),
          moneyCell(total.time_cents, total.currency),
          moneyCell(total.expense_cents, total.currency),
          moneyCell(total.total_cents, total.currency),
          action,
        )
        body.append(row)
      }
    }
    table.append(head, body)
    wrapper.append(table)
    section.append(wrapper)
    clients.append(section)
  }
  return clients
}

const renderUninvoiced = (
  report: Readonly<UninvoicedReport>,
  canInvoice: boolean,
): DocumentFragment => {
  const fragment = document.createDocumentFragment()
  fragment.append(
    reportHeading('Uninvoiced work', `${report.from} through ${report.to}`),
  )
  if (report.totals.length === 0) {
    fragment.append(
      textElement('p', 'No uninvoiced time or expenses matched these filters.', 'report-empty'),
    )
    return fragment
  }
  const grid = element('div', 'report-currency-grid')
  for (const total of report.totals) {
    const card = element('article', 'report-currency-card')
    const header = element('header')
    const headline = element('strong')
    headline.append(reportMoney(total.total_cents, total.currency))
    header.append(textElement('h3', total.currency), headline)
    const facts = element('dl', 'report-facts')
    facts.append(
      // Not "Tracked time", which this is not. The figure is the generation
      // preview: billable only, uninvoiced only, active projects only. Labelled
      // as tracked time it reads as hours the migration lost -- 901 against
      // Harvest's 1,275 for the same month -- and that is exactly the wrong
      // conclusion to hand somebody deciding whether to trust the books. The
      // heading already says "Uninvoiced work", so repeating the word here is
      // the disambiguation rather than a redundancy (issue 534).
      fact('Uninvoiced billable time', formatReportHours(total.rounded_seconds)),
      fact('Time amount', reportMoney(total.time_cents, total.currency)),
      fact('Expense amount', reportMoney(total.expense_cents, total.currency)),
      fact('Time entries', total.time_entry_count.toLocaleString('en-US')),
      fact('Expenses', total.expense_count.toLocaleString('en-US')),
    )
    card.append(header, facts)
    // Said once per card, because the three filters are the whole reason the
    // number differs from the one an operator is comparing it against.
    card.append(
      textElement(
        'p',
        'Billable, not yet invoiced, on active projects. Invoiced and non-billable time and archived projects are excluded.',
        'report-card-note',
      ),
    )
    if (total.unpriced_time_entry_count > 0) {
      card.append(
        warning(
          `${countLabel(total.unpriced_time_entry_count, 'billable time entry', 'billable time entries')} without a resolved rate ${total.unpriced_time_entry_count === 1 ? 'is' : 'are'} excluded from money totals.`,
        ),
      )
    }
    grid.append(card)
  }
  fragment.append(grid)
  if ((report.projects?.length ?? 0) > 0) {
    fragment.append(renderUninvoicedProjects(report, canInvoice))
  }
  return fragment
}

const metricsFacts = (metrics: Readonly<ClientRollupMetrics>): HTMLDListElement => {
  const facts = element('dl', 'report-facts report-rollup-facts')
  facts.append(
    // Genuinely tracked time here, and correct: the rollup counts every entry
    // and reports billable separately on the next line. Issue 534 asked whether
    // this borrowed the same wrong label; it does not, and the pair of facts is
    // what makes it unambiguous.
    fact('Tracked time', formatReportHours(metrics.rounded_seconds)),
    fact('Billable time', formatReportHours(metrics.billable_seconds)),
    fact('Time entries', metrics.time_entry_count.toLocaleString('en-US')),
    fact('Expenses', metrics.expense_count.toLocaleString('en-US')),
  )
  return facts
}

const currencyTable = (metrics: Readonly<ClientRollupMetrics>): HTMLElement => {
  const wrapper = element('div', 'report-table-wrap')
  const table = element('table', 'report-table')
  const head = element('thead')
  const headerRow = element('tr')
  for (const label of ['Currency', 'Expenses', 'Uninvoiced', 'Money budget', 'Cost']) {
    const cell = textElement('th', label)
    cell.scope = 'col'
    headerRow.append(cell)
  }
  head.append(headerRow)
  const body = element('tbody')
  if (metrics.currencies.length === 0) {
    const row = element('tr')
    const cell = textElement('td', 'No currency activity')
    cell.colSpan = 5
    row.append(cell)
    body.append(row)
  } else {
    for (const currency of metrics.currencies) {
      const row = element('tr')
      row.append(
        textElement('th', currency.currency),
        moneyCell(currency.expense_cents, currency.currency),
        moneyCell(currency.uninvoiced_total_cents, currency.currency),
        moneyCell(currency.money_budget_cents, currency.currency),
        moneyCell(currency.cost_cents, currency.currency),
      )
      ;(row.firstElementChild as HTMLTableCellElement).scope = 'row'
      body.append(row)
    }
  }
  table.append(head, body)
  wrapper.append(table)
  return wrapper
}

const metricsSection = (
  label: string,
  metrics: Readonly<ClientRollupMetrics>,
): HTMLElement => {
  const section = element('section', 'report-metrics')
  section.append(textElement('h4', label), metricsFacts(metrics), currencyTable(metrics))
  const unpriced = metrics.unpriced_billable_entry_count + metrics.unpriced_cost_entry_count
  if (unpriced > 0) {
    section.append(
      warning(
        `${countLabel(metrics.unpriced_billable_entry_count, 'unpriced billable entry', 'unpriced billable entries')} and ${countLabel(metrics.unpriced_cost_entry_count, 'entry without cost', 'entries without cost')} affect these money totals.`,
      ),
    )
  }
  return section
}

const renderClientRollup = (
  report: Readonly<ClientRollupReport>,
  clients: readonly GeneralResource[],
): DocumentFragment => {
  const fragment = document.createDocumentFragment()
  const names = new Map(report.nodes.map((node) => [node.client_id, node.name]))
  // The report names every client it walked; the catalog covers a parent that
  // sits outside that walk, and the root when the walk returned nothing.
  const clientLabel = (id: number): string =>
    names.get(id) ?? catalogLabel(clients, id, `Client #${id}`)
  fragment.append(
    reportHeading(
      'Client rollup',
      `${report.from} through ${report.to} · `,
      linkElement(`/clients/${report.root_client_id}`, clientLabel(report.root_client_id)),
    ),
  )
  if (report.nodes.length === 0) {
    fragment.append(textElement('p', 'No clients were found in this hierarchy.', 'report-empty'))
    return fragment
  }
  const list = element('ol', 'report-client-tree')
  for (const node of report.nodes) {
    const item = element('li', 'report-client-node')
    item.style.setProperty('--report-depth', String(node.depth))
    const header = element('header')
    const identity = element('div')
    const name = element('h3')
    name.append(linkElement(`/clients/${node.client_id}`, clientLabel(node.client_id)))
    const lineage = element('p')
    if (node.parent_client_id === null) lineage.textContent = 'Root client'
    else {
      lineage.append(
        'Child of ',
        linkElement(
          `/clients/${node.parent_client_id}`,
          clientLabel(node.parent_client_id),
        ),
      )
    }
    identity.append(name, lineage)
    header.append(identity)
    const comparison = element('div', 'report-rollup-comparison')
    comparison.append(
      metricsSection('Direct activity', node.direct),
      metricsSection('Including descendants', node.rollup),
    )
    item.append(header, comparison)
    list.append(item)
  }
  fragment.append(list)
  return fragment
}

/** Assignment ids stay raw: no loaded catalog resolves one to its task or person. */
const sourceLabel = (source: string, id: number, projectLabel: string): string => {
  if (source === 'task_assignment') return `Task assignment #${id}`
  if (source === 'user_assignment') return `User assignment #${id}`
  return projectLabel
}

const renderProjectBudget = (
  report: Readonly<ProjectBudgetReport>,
  projects: readonly GeneralResource[],
): DocumentFragment => {
  const fragment = document.createDocumentFragment()
  const projectLabel = catalogLabel(
    projects,
    report.project_id,
    `Project #${report.project_id}`,
  )
  const heading = reportHeading(
    'Project budget',
    `${report.from} through ${report.to} · `,
    linkElement(`/projects/${report.project_id}`, projectLabel),
  )
  const metadata = element('dl', 'report-metadata')
  metadata.append(
    fact('Budget basis', report.budget_by.replaceAll('_', ' ')),
    fact('Expenses included', report.expenses_included ? 'Yes' : 'No'),
  )
  fragment.append(heading, metadata)
  if (report.grains.length === 0) {
    fragment.append(
      textElement('p', 'This project has no configured budget grain.', 'report-empty'),
    )
    return fragment
  }
  const list = element('ol', 'report-budget-list')
  for (const grain of report.grains) {
    const item = element('li', 'report-budget-card')
    const header = element('header')
    header.append(
      textElement('h3', sourceLabel(grain.source, grain.source_id, projectLabel)),
      textElement(
        'span',
        `${grain.calculation} · ${grain.unit === 'seconds' ? 'time' : 'money in API cents'}`,
      ),
    )
    const facts = element('dl', 'report-facts')
    if (grain.unit === 'seconds') {
      facts.append(
        fact('Budget', formatReportHours(grain.budget_seconds)),
        fact('Spent', formatReportHours(grain.spent_seconds)),
        fact('Remaining', formatReportHours(grain.remaining_seconds)),
      )
    } else {
      facts.append(
        // The seconds branch above is the same three facts in hours, and it
        // carries no marker: a budget measured in time is not money.
        fact('Budget', reportCents(grain.budget_cents)),
        fact('Spent', reportCents(grain.spent_cents)),
        fact('Remaining', reportCents(grain.remaining_cents)),
      )
    }
    item.append(header, facts)
    if (grain.unpriced_entry_count > 0) {
      item.append(
        warning(
          `${countLabel(grain.unpriced_entry_count, 'entry', 'entries')} cannot be priced for this ${grain.calculation} calculation.`,
        ),
      )
    }
    list.append(item)
  }
  fragment.append(list)
  return fragment
}

/**
 * The three columns Harvest's own contractor report carries -- person, total
 * hours, cost -- rather than a wider one of our own. Two departures, both
 * forced by what the endpoint answers with:
 *
 * One table per currency instead of one table. A row states the currency its
 * cost is in, so rows in two currencies are two different questions;
 * `contractorCostReport` in packages/db refuses to add them because this system
 * holds no exchange rate, and a single table with a currency column is an
 * invitation to add them anyway. Separate tables cannot be totalled by eye.
 *
 * The person column says contractor or employee. The endpoint has no
 * `is_contractor` filter -- it totals everybody who tracked time in the range,
 * and `is_contractor` is a flag on the row -- so a column headed "Contractor"
 * would be naming employees as contractors.
 */
/**
 * What happened, newest first.
 *
 * A feed rather than a table of figures, so it is read down a column of times
 * instead of across one of amounts. It carries no money, which is why nothing
 * here is masked: the whole log is the same class of fact as the tab that
 * reaches it.
 */
const renderActivityLog = (
  entries: readonly ActivityLogEntry[],
  range: { readonly from: string; readonly to: string },
): DocumentFragment => {
  const fragment = document.createDocumentFragment()
  fragment.append(
    reportHeading('Activity log', `${range.from} through ${range.to} · newest first`),
  )
  if (entries.length === 0) {
    fragment.append(
      textElement('p', 'Nothing was recorded in this period.', 'report-empty'),
    )
    return fragment
  }
  const wrapper = element('div', 'report-table-wrap')
  const table = element('table', 'report-table')
  const head = element('thead')
  const headerRow = element('tr')
  for (const label of ['When', 'Event', 'Subject']) {
    const cell = textElement('th', label)
    cell.scope = 'col'
    headerRow.append(cell)
  }
  head.append(headerRow)
  const body = element('tbody')
  // Sorted here rather than trusted from the wire: the route orders by the
  // recorded time and the column shown is the occurred time, and for a replayed
  // or back-dated event those disagree.
  const ordered = [...entries].sort((left, right) =>
    right.occurred_at.localeCompare(left.occurred_at),
  )
  for (const entry of ordered) {
    const row = element('tr')
    const when = element('th')
    when.scope = 'row'
    const stamp = element('time')
    stamp.dateTime = entry.occurred_at
    stamp.textContent = entry.occurred_at.replace('T', ' ').slice(0, 19)
    when.append(stamp)
    row.append(when, textElement('td', activityEventLabel(entry.event_type)))
    row.append(textElement('td', activitySubjectLabel(entry.aggregate)))
    body.append(row)
  }
  table.append(head, body)
  wrapper.append(table)
  fragment.append(wrapper)
  return fragment
}

/** A signed percentage, or an em dash where the change cannot be stated. */
const deltaLabel = (fraction: number | null): string => {
  if (fraction === null) return '\u2014'
  const percent = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 1,
    signDisplay: 'exceptZero',
  }).format(fraction * 100)
  return `${percent}%`
}

const invoiceStateLabel = (state: InvoicedReport['rows'][number]['state']): string =>
  state === 'open' ? 'Sent' : state[0]!.toLocaleUpperCase('en-US') + state.slice(1)

const renderInvoiced = (report: Readonly<InvoicedReport>): DocumentFragment => {
  const fragment = document.createDocumentFragment()
  fragment.append(
    reportHeading(
      'Invoiced',
      `${report.from} through ${report.to} · ${report.rows.length} ${report.rows.length === 1 ? 'invoice' : 'invoices'}`,
    ),
  )
  if (report.rows.length === 0) {
    fragment.append(textElement('p', 'No invoices were issued in this period.', 'report-empty'))
    return fragment
  }
  const wrapper = element('div', 'report-table-wrap')
  const table = element('table', 'report-table')
  const head = element('thead')
  const header = element('tr')
  for (const label of ['Status', 'Issue date', 'Due date', 'Invoice', 'Client', 'Invoiced', 'Paid', 'Balance']) {
    const cell = textElement('th', label)
    cell.scope = 'col'
    header.append(cell)
  }
  head.append(header)
  const body = element('tbody')
  for (const row of report.rows) {
    const line = element('tr')
    line.append(textElement('td', invoiceStateLabel(row.state)))
    line.append(textElement('td', row.issue_date), textElement('td', row.due_date))
    const invoice = element('th')
    invoice.scope = 'row'
    invoice.append(linkElement(`/invoices/${row.invoice_id}`, row.number))
    line.append(invoice)
    const client = element('td')
    client.append(linkElement(`/clients/${row.client_id}`, row.client_name))
    if (row.subject !== null && row.subject.trim() !== '') {
      client.append(textElement('small', row.subject, 'report-row-note'))
    }
    line.append(client)
    line.append(
      moneyCell(row.invoiced_cents, row.currency),
      moneyCell(row.paid_cents, row.currency),
      moneyCell(row.balance_cents, row.currency),
    )
    body.append(line)
  }
  table.append(head, body)
  wrapper.append(table)
  fragment.append(wrapper)
  return fragment
}

const renderPaymentsReceived = (
  report: Readonly<PaymentsReceivedReport>,
): DocumentFragment => {
  const fragment = document.createDocumentFragment()
  fragment.append(
    reportHeading(
      'Payments received',
      `${report.from} through ${report.to} · ${report.rows.length} ${report.rows.length === 1 ? 'payment' : 'payments'}`,
    ),
  )
  if (report.rows.length === 0) {
    fragment.append(textElement('p', 'No payments were received in this period.', 'report-empty'))
    return fragment
  }
  const wrapper = element('div', 'report-table-wrap')
  const table = element('table', 'report-table')
  const head = element('thead')
  const header = element('tr')
  for (const label of ['Payment date', 'Invoice', 'Client', 'Provider', 'Invoice total', 'Payment']) {
    const cell = textElement('th', label)
    cell.scope = 'col'
    header.append(cell)
  }
  head.append(header)
  const body = element('tbody')
  for (const row of report.rows) {
    const line = element('tr')
    line.append(textElement('td', row.payment_date))
    const invoice = element('th')
    invoice.scope = 'row'
    invoice.append(linkElement(`/invoices/${row.invoice_id}`, row.invoice_number))
    const client = element('td')
    client.append(linkElement(`/clients/${row.client_id}`, row.client_name))
    line.append(invoice, client, textElement('td', row.provider))
    line.append(
      moneyCell(row.invoice_total_cents, row.currency),
      moneyCell(row.payment_cents, row.currency),
    )
    body.append(line)
  }
  table.append(head, body)
  wrapper.append(table)
  fragment.append(wrapper)
  return fragment
}

const renderReceivables = (report: Readonly<ReceivablesReport>): DocumentFragment => {
  const fragment = document.createDocumentFragment()
  fragment.append(reportHeading('Receivables', `Outstanding balances as of ${report.as_of}`))
  if (report.rows.length === 0) {
    fragment.append(textElement('p', 'No outstanding receivables as of this date.', 'report-empty'))
    return fragment
  }
  const wrapper = element('div', 'report-table-wrap')
  const table = element('table', 'report-table')
  const head = element('thead')
  const header = element('tr')
  for (const label of ['Client', 'Currency', 'Invoices', 'Total', 'Outstanding', 'Not due', '1–30 days', '31–60 days', '61–90 days', '90+ days']) {
    const cell = textElement('th', label)
    cell.scope = 'col'
    header.append(cell)
  }
  head.append(header)
  const body = element('tbody')
  for (const row of report.rows) {
    const line = element('tr')
    const client = element('th')
    client.scope = 'row'
    client.append(linkElement(`/clients/${row.client_id}`, row.client_name))
    line.append(client, textElement('td', row.currency), textElement('td', String(row.invoice_count)))
    line.append(
      moneyCell(row.invoiced_cents, row.currency),
      moneyCell(row.outstanding_cents, row.currency),
      moneyCell(row.not_due_cents, row.currency),
      moneyCell(row.days_1_to_30_cents, row.currency),
      moneyCell(row.days_31_to_60_cents, row.currency),
      moneyCell(row.days_61_to_90_cents, row.currency),
      moneyCell(row.days_90_plus_cents, row.currency),
    )
    body.append(line)
  }
  table.append(head, body)
  wrapper.append(table)
  fragment.append(wrapper)
  return fragment
}

/**
 * Revenue, cost and margin, against the window before.
 *
 * Three things here are deliberately blank rather than confident. A project
 * billing in another currency reports both sides and no margin, because its
 * revenue and the organization-currency cost are not the same unit. A missing
 * rate blanks its side rather than dropping the hours, which would read as a
 * healthier margin than the account has. And a delta against a period of zero
 * is blank, because growth from nothing has no denominator.
 */
const renderProfitability = (
  report: Readonly<ProfitabilityReport>,
  options: Readonly<ProfitabilityOptions>,
  onDimension: (dimension: ProfitabilityDimension) => void,
): DocumentFragment => {
  const fragment = document.createDocumentFragment()
  const currency = report.organization_currency
  fragment.append(
    reportHeading(
      'Profitability',
      `${report.from} through ${report.to} \u00b7 against ${report.previous_from} through ${report.previous_to}`,
    ),
  )

  const summary = element('div', 'report-profit-summary')
  const totals = report.totals
  const previous = report.previous_totals
  for (const [label, value, before] of [
    ['Revenue', totals.revenue_cents, previous.revenue_cents],
    ['Cost', totals.cost_cents, previous.cost_cents],
    ['Revenue fees', totals.revenue_fee_cents, previous.revenue_fee_cents],
    ['Profit', totals.profit_cents, previous.profit_cents],
  ] as const) {
    const tile = element('div', 'report-profit-tile')
    tile.append(textElement('p', label, 'report-profit-label'))
    const figure = element('p', 'report-profit-figure')
    figure.append(reportMoney(value, currency))
    tile.append(
      figure,
      textElement('p', deltaLabel(profitabilityDelta(value, before)), 'report-profit-delta'),
    )
    summary.append(tile)
  }
  fragment.append(summary)

  if (report.trend.length > 0) {
    const trend = element('section', 'report-profit-trend')
    trend.append(textElement('h3', 'Period trend'))
    const trendTable = element('table', 'report-table')
    const trendHead = element('thead')
    const trendHeader = element('tr')
    for (const label of ['Period', 'Revenue', 'Cost', 'Revenue fees', 'Profit', 'Return on cost']) {
      const cell = textElement('th', label)
      cell.scope = 'col'
      trendHeader.append(cell)
    }
    trendHead.append(trendHeader)
    const trendBody = element('tbody')
    for (const row of report.trend) {
      const line = element('tr')
      if (row.current) line.classList.add('is-current')
      line.append(
        textElement('th', `${row.period_start} – ${row.period_end}${row.current ? ' · Current' : ''}`),
        moneyCell(row.revenue_cents, row.currency),
        moneyCell(row.cost_cents, currency),
        moneyCell(row.revenue_fee_cents, row.currency),
        moneyCell(row.profit_cents, currency),
        textElement(
          'td',
          row.return_on_cost_ppm === null
            ? '—'
            : `${(row.return_on_cost_ppm / 10_000).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`,
        ),
      )
      trendBody.append(line)
    }
    trendTable.append(trendHead, trendBody)
    trend.append(trendTable)
    fragment.append(trend)
  }

  if (totals.projects_not_converted > 0) {
    const count = totals.projects_not_converted
    fragment.append(
      warning(
        `${count} ${count === 1 ? 'project bills' : 'projects bill'} in another currency and ${
          count === 1 ? 'is' : 'are'
        } not in these totals. Cost is held in ${currency}; converting revenue is not yet supported.`,
      ),
    )
  }
  if (totals.entries_without_billable_rate > 0 || totals.entries_without_cost_rate > 0) {
    fragment.append(
      warning(
        `${totals.entries_without_billable_rate} tracked ${
          totals.entries_without_billable_rate === 1 ? 'entry has' : 'entries have'
        } no billable rate and ${totals.entries_without_cost_rate} ${
          totals.entries_without_cost_rate === 1 ? 'has' : 'have'
        } no cost rate. Any figure they affect is left blank rather than understated.`,
      ),
    )
  }

  const projectRows: readonly ProfitabilityDimensionRow[] = report.rows.map((row) => ({
    dimension_id: row.project_id,
    dimension_name: row.project_code === '' ? row.project_name : `[${row.project_code}] ${row.project_name}`,
    currency: row.currency,
    rounded_seconds: row.rounded_seconds,
    revenue_cents: row.revenue_cents,
    cost_cents: row.cost_cents,
    profit_cents: row.profit_cents,
    return_on_cost_ppm: row.return_on_cost_ppm,
    revenue_fee_cents: row.revenue_fee_cents,
    fees_included_in_delivery_cost_cents: row.fees_included_in_delivery_cost_cents,
    entries_without_billable_rate: row.entries_without_billable_rate,
    entries_without_cost_rate: row.entries_without_cost_rate,
    included_in_headline: row.currency === currency,
  }))
  const selectedRows =
    options.dimension === 'projects'
      ? projectRows
      : options.dimension === 'clients'
        ? report.clients
        : options.dimension === 'teammates'
          ? report.teammates
          : report.tasks

  const tabs = element('div', 'report-subtabs')
  for (const [dimension, label] of [
    ['clients', 'Clients'],
    ['projects', 'Projects'],
    ['teammates', 'Team'],
    ['tasks', 'Tasks'],
  ] as const) {
    const button = textElement('button', label)
    button.type = 'button'
    if (dimension === options.dimension) button.setAttribute('aria-current', 'page')
    button.addEventListener('click', () => onDimension(dimension))
    tabs.append(button)
  }
  fragment.append(tabs)

  if (selectedRows.length === 0) {
    fragment.append(textElement('p', 'No time was tracked in this period.', 'report-empty'))
    return fragment
  }

  const wrapper = element('div', 'report-table-wrap')
  const table = element('table', 'report-table')
  const head = element('thead')
  const headerRow = element('tr')
  const dimensionLabel =
    options.dimension === 'teammates'
      ? 'Teammate'
      : options.dimension === 'tasks'
        ? 'Task'
        : options.dimension === 'clients'
          ? 'Client'
          : 'Project'
  for (const label of [
    dimensionLabel, 'Hours', 'Revenue', 'Cost', 'Revenue fees', 'Profit', 'Return on cost',
  ]) {
    const cell = textElement('th', label)
    cell.scope = 'col'
    headerRow.append(cell)
  }
  head.append(headerRow)
  const body = element('tbody')
  // Worst margin first: the report is opened to find what is losing money, and
  // a blank margin sorts last because it is a question rather than an answer.
  const ordered = [...selectedRows].sort((left, right) => {
    if (left.profit_cents === null) return right.profit_cents === null ? 0 : 1
    if (right.profit_cents === null) return -1
    return left.profit_cents - right.profit_cents
  })
  for (const row of ordered) {
    const line = element('tr')
    const dimension = element('th')
    dimension.scope = 'row'
    const href =
      options.dimension === 'projects'
        ? `/projects/${row.dimension_id}`
        : options.dimension === 'clients'
          ? `/clients/${row.dimension_id}`
          : options.dimension === 'teammates'
            ? `/team/${row.dimension_id}`
            : null
    dimension.append(
      href === null ? row.dimension_name : linkElement(href, row.dimension_name),
    )
    line.append(dimension)
    line.append(textElement('td', formatReportHours(row.rounded_seconds)))
    // Revenue in the project's own currency, cost always in the
    // organization's: labelling both with one currency would relabel a figure
    // rather than convert it.
    line.append(moneyCell(row.revenue_cents, row.currency))
    line.append(moneyCell(row.cost_cents, currency))
    line.append(moneyCell(row.revenue_fee_cents, row.currency))
    line.append(moneyCell(row.profit_cents, currency))
    line.append(
      textElement(
        'td',
        row.return_on_cost_ppm === null
          ? '—'
          : `${(row.return_on_cost_ppm / 10_000).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`,
      ),
    )
    body.append(line)
  }
  table.append(head, body)
  wrapper.append(table)
  fragment.append(wrapper)
  return fragment
}

/**
 * Every expense in the period, one row each.
 *
 * Totals stay per currency and are never added together, the same rule the
 * uninvoiced report follows: two amounts in different currencies are two
 * numbers, and one figure over them would be arithmetic on unlike units.
 *
 * Amounts may be absent rather than null -- the route omits the field for a
 * viewer refused billable money -- so the money column reads an undefined the
 * same way it reads a missing figure, as an em dash rather than a zero.
 */
const renderDetailedExpense = (
  report: Readonly<DetailedExpenseReport>,
  options: Readonly<DetailedExpenseOptions>,
  labels: Readonly<{ client: string; project: string }>,
  canOpenTeam: boolean,
  handlers: { readonly onExport: () => void; readonly onPrint: () => void },
): DocumentFragment => {
  const fragment = document.createDocumentFragment()
  const heading = reportHeading('Detailed expense', `${report.from} through ${report.to}`)
  const actions = element('div', 'report-actions')
  const exportButton = textElement('button', 'Export CSV')
  exportButton.setAttribute('type', 'button')
  exportButton.dataset.expenseExport = ''
  exportButton.addEventListener('click', handlers.onExport)
  const printButton = textElement('button', 'Print')
  printButton.setAttribute('type', 'button')
  printButton.dataset.expensePrint = ''
  printButton.addEventListener('click', handlers.onPrint)
  actions.append(exportButton, printButton)
  heading.append(actions)
  fragment.append(heading)
  const predicates = [
    labels.client,
    labels.project,
    options.categoryId === null ? 'All categories' : `Category #${options.categoryId}`,
    options.userId === null ? 'All teammates' : `Teammate #${options.userId}`,
    options.billable === 'all' ? 'All billing states' : options.billable === 'yes' ? 'Billable' : 'Non-billable',
    options.reimbursable === 'all'
      ? 'All reimbursement states'
      : options.reimbursable === 'yes'
        ? 'Reimbursable'
        : 'Not reimbursable',
    options.invoiceState === 'all'
      ? 'All invoice states'
      : options.invoiceState === 'invoiced'
        ? 'Invoiced'
        : 'Uninvoiced',
    options.activeProjectsOnly ? 'Active projects only' : 'Active and archived projects',
  ]
  fragment.append(textElement('p', predicates.join(' · '), 'report-filter-recap'))
  if (report.rows.length === 0) {
    fragment.append(
      textElement('p', 'No expenses were recorded in this period.', 'report-empty'),
    )
    return fragment
  }
  const summary = element('p', 'report-expense-totals')
  summary.append(
    ...report.totals.flatMap((total, index) => {
      const label = `${total.expense_count} ${
        total.expense_count === 1 ? 'expense' : 'expenses'
      } · `
      const parts: (string | Node)[] = [
        label,
        reportMoney(total.total_cost_cents, total.currency),
      ]
      return index === 0 ? parts : [' · ', ...parts]
    }),
  )
  fragment.append(summary)

  const wrapper = element('div', 'report-table-wrap')
  const table = element('table', 'report-table')
  const head = element('thead')
  const headerRow = element('tr')
  for (const label of ['Date', 'Client', 'Project', 'Category', 'Person', 'Notes', 'Amount']) {
    const cell = textElement('th', label)
    cell.scope = 'col'
    headerRow.append(cell)
  }
  head.append(headerRow)
  const body = element('tbody')
  for (const row of report.rows) {
    const line = element('tr')
    const date = element('th')
    date.scope = 'row'
    date.append(linkElement(`/expenses/${row.expense_id}`, row.spent_date))
    const client = element('td')
    client.append(linkElement(`/clients/${row.client_id}`, row.client_name))
    line.append(date, client)
    const project = element('td')
    project.append(
      linkElement(
        `/projects/${row.project_id}`,
        row.project_code === '' ? row.project_name : `[${row.project_code}] ${row.project_name}`,
      ),
    )
    line.append(project)
    const category = element('td')
    category.append(linkElement(`/expense-categories?category_id=${row.category_id}`, row.category_name))
    // Non-billable and reimbursable are facts about the expense, not money, so
    // they stay readable beside an amount that may be withheld.
    if (!row.billable) {
      category.append(textElement('span', 'Non-billable', 'report-cost-note'))
    }
    if (row.reimbursable) {
      category.append(textElement('span', 'Reimbursable', 'report-cost-note'))
    }
    line.append(
      category,
      (() => {
        const person = element('td')
        person.append(
          canOpenTeam
            ? linkElement(`/team/${row.user_id}`, row.user_name)
            : document.createTextNode(row.user_name),
        )
        return person
      })(),
      textElement('td', row.notes ?? '', 'report-entry-notes'),
    )
    line.append(moneyCell(row.total_cost_cents, row.currency))
    body.append(line)
  }
  table.append(head, body)
  wrapper.append(table)
  fragment.append(wrapper)
  return fragment
}

const renderContractorCost = (
  report: Readonly<ContractorCostReport>,
  contractorOnly: boolean,
  handlers: { readonly onExport: () => void; readonly onPopulation: (value: boolean) => void },
): DocumentFragment => {
  const fragment = document.createDocumentFragment()
  const visibleRows = contractorOnly
    ? report.rows.filter((row) => row.is_contractor)
    : report.rows
  const heading = reportHeading(
    'Contractor cost',
    `${report.from} through ${report.to} · ${contractorOnly ? 'contractors only' : 'everybody who tracked time'}`,
  )
  const population = selectControl(
    'ez-contractor-population',
    'Population',
    [['all', 'Everybody'], ['contractors', 'Contractors only']],
    contractorOnly ? 'contractors' : 'all',
    (value) => handlers.onPopulation(value === 'contractors'),
  )
  const exportButton = textElement('button', 'Export CSV')
  exportButton.setAttribute('type', 'button')
  exportButton.dataset.contractorExport = ''
  exportButton.addEventListener('click', handlers.onExport)
  heading.append(population, exportButton)
  fragment.append(heading)
  if (visibleRows.length === 0) {
    fragment.append(
      textElement(
        'p',
        contractorOnly
          ? 'No contractors tracked time in this period.'
          : 'Nobody tracked time in this period.',
        'report-empty',
      ),
    )
    return fragment
  }
  const byCurrency = new Map<string, ContractorCostRow[]>()
  for (const row of visibleRows) {
    const bucket = byCurrency.get(row.currency)
    if (bucket === undefined) byCurrency.set(row.currency, [row])
    else bucket.push(row)
  }
  for (const [currency, rows] of byCurrency) {
    const section = element('section', 'report-cost-currency')
    section.append(textElement('h3', currency))
    const wrapper = element('div', 'report-table-wrap')
    const table = element('table', 'report-table')
    const head = element('thead')
    const headerRow = element('tr')
    for (const label of [
      'Person', 'Payroll email', 'Hours', 'Utilization', 'Rate', 'Entries', 'Cost',
    ]) {
      const cell = textElement('th', label)
      cell.scope = 'col'
      headerRow.append(cell)
    }
    head.append(headerRow)
    const body = element('tbody')
    let seconds = 0
    let cents: number | null = 0
    let entriesWithoutRate = 0
    let peopleWithoutRate = 0
    for (const row of rows) {
      seconds += row.rounded_seconds
      entriesWithoutRate += row.entries_without_rate
      const person = element('th')
      person.scope = 'row'
      person.append(
        linkElement(`/team/${row.user_id}`, row.name),
        textElement(
          'span',
          row.is_contractor ? 'Contractor' : 'Employee',
          'report-cost-note',
        ),
      )
      const cost = element('td')
      if (row.cost_cents === null) {
        peopleWithoutRate += 1
        cents = null
        // Not an em dash and not a zero. Both read as "nothing to pay" against
        // hours that were worked; this says the total does not exist, and the
        // line under it says how many entries are the reason.
        cost.append(
          textElement('span', 'Not costed'),
          textElement(
            'span',
            `${countLabel(row.entries_without_rate, 'entry', 'entries')} without a cost rate`,
            'report-cost-note',
          ),
        )
      } else {
        if (cents !== null) cents += row.cost_cents
        cost.append(moneyText(formatReportMoney(row.cost_cents, currency)))
      }
      const line = element('tr')
      const rate = element('td')
      if (row.cost_rate_is_mixed) {
        rate.append(textElement('span', 'Mixed rates'))
      } else {
        rate.append(reportMoney(row.cost_rate_cents, currency))
      }
      const entries = element('td')
      entries.append(String(row.entry_count))
      if (row.entries_without_rate > 0) {
        entries.append(
          textElement(
            'span',
            `${row.entries_without_rate} unrated`,
            'report-cost-note',
          ),
        )
      }
      line.append(
        person,
        textElement('td', row.payroll_email ?? '—'),
        (() => {
          const hours = element('td')
          hours.append(linkElement(
            `/reports?report=detailed-time&from=${report.from}&to=${report.to}&user_id=${row.user_id}&grain=entry`,
            formatReportHours(row.rounded_seconds),
          ))
          return hours
        })(),
        textElement(
          'td',
          row.utilization_ppm === null
            ? '—'
            : `${(row.utilization_ppm / 10_000).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`,
        ),
        rate,
        (() => {
          const cell = element('td')
          const link = linkElement(
            `/reports?report=detailed-time&from=${report.from}&to=${report.to}&user_id=${row.user_id}&grain=entry`,
            String(row.entry_count),
          )
          cell.append(link, ...Array.from(entries.childNodes).slice(1))
          return cell
        })(),
        cost,
      )
      body.append(line)
    }
    const foot = element('tfoot')
    const totalRow = element('tr')
    const totalLabel = textElement('th', 'Total')
    totalLabel.scope = 'row'
    // The hours total whatever the rates say: seconds carry no rate and no
    // currency, so they are the one figure an uncosted row does not take away.
    totalRow.append(
      totalLabel,
      textElement('td', ''),
      textElement('td', formatReportHours(seconds)),
      textElement('td', ''),
      textElement('td', ''),
      textElement('td', ''),
      cents === null ? textElement('td', 'Not costed') : moneyCell(cents, currency),
    )
    foot.append(totalRow)
    table.append(head, body, foot)
    wrapper.append(table)
    section.append(wrapper)
    if (entriesWithoutRate > 0) {
      section.append(
        warning(
          `${countLabel(entriesWithoutRate, 'entry', 'entries')} across ${countLabel(peopleWithoutRate, 'person', 'people')} ${entriesWithoutRate === 1 ? 'has' : 'have'} no cost rate, so ${currency} has no total.`,
        ),
      )
    }
    fragment.append(section)
  }
  return fragment
}

interface DetailedTimeHandlers {
  readonly onOptions: (next: DetailedTimeOptions) => void
  readonly onExport: () => void
  readonly onPrint: () => void
  readonly onAction?: (
    action: 'mark_invoiced' | 'mark_uninvoiced' | 'move',
    entryIds: readonly number[],
  ) => void
}

const selectControl = (
  id: string,
  label: string,
  options: readonly (readonly [string, string])[],
  value: string,
  onChange: (next: string) => void,
): HTMLElement => {
  const field = element('div', 'report-filter-field')
  const caption = textElement('label', label)
  caption.htmlFor = id
  const select = element('select')
  select.id = id
  for (const [optionValue, optionLabel] of options) {
    const item = document.createElement('option')
    item.value = optionValue
    item.textContent = optionLabel
    select.append(item)
  }
  select.value = value
  select.addEventListener('change', () => onChange(select.value))
  field.append(caption, select)
  return field
}

const idControl = (
  id: string,
  label: string,
  value: number | null,
  onChange: (next: number | null) => void,
): HTMLElement => {
  const field = element('div', 'report-filter-field')
  const caption = textElement('label', label)
  caption.htmlFor = id
  const input = element('input')
  input.id = id
  input.inputMode = 'numeric'
  input.pattern = '[1-9][0-9]*'
  input.value = value === null ? '' : String(value)
  input.addEventListener('change', () => {
    const parsed = Number(input.value)
    onChange(Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null)
  })
  field.append(caption, input)
  return field
}

/**
 * The filter recap Harvest puts opposite the totals. It is worth carrying over:
 * a row of collapsed dropdowns hides what a report actually covers, and this
 * says it explicitly in a list that survives being printed or screenshotted.
 *
 * Every value is read from the response, not the pending form state, so a
 * screenshot records the filters that actually produced the rows.
 */
const detailedTimeRecap = (
  clientLabel: string,
  projectLabel: string,
  report: Readonly<DetailedTimeReport>,
): HTMLDListElement => {
  const recap = element('dl', 'report-facts report-filter-recap')
  recap.append(
    fact('Clients', clientLabel),
    fact('Projects', projectLabel),
    fact('Tasks', report.task_id === null ? 'All tasks' : `Task #${report.task_id}`),
    fact('Team', report.user_id === null ? 'All people' : `Person #${report.user_id}`),
    fact('Role', report.role_id === null ? 'All roles' : `Role #${report.role_id}`),
    fact('Tag', report.tag_id === null ? 'All tags' : `Tag #${report.tag_id}`),
    fact('Invoice state', report.invoice_state),
    fact('Grain', report.grain === 'entry' ? 'Individual entries' : 'Daily totals'),
  )
  return recap
}

const detailedTimeCells = (
  row: Readonly<DetailedTimeRow>,
  grain: DetailedTimeGrain,
): readonly Node[] => {
  const client = element('th')
  client.scope = 'row'
  client.append(linkElement(`/clients/${row.client_id}`, row.client_name))
  const project = element('td')
  project.append(
    linkElement(`/projects/${row.project_id}`, detailedTimeProjectLabel(row)),
  )
  const cells = [
    client,
    project,
    textElement('td', row.task_name),
    // Empty rather than "—": a person holding no role is a fact about the
    // account, where an em dash in this column would read as "not loaded".
    textElement('td', row.roles.join(', ')),
    textElement('td', row.user_name),
  ]
  if (grain === 'entry') {
    // What the drill-through is for: at the folded grain two entries share a
    // line and have two notes between them, so the column can only exist here.
    cells.push(textElement('td', row.notes ?? ''))
    const claim = element('td')
    if (row.invoice_id === null || row.invoice_id === undefined) {
      // Not an em dash: "no invoice has taken this hour" is a state somebody
      // acts on, where a dash reads as a value that failed to load.
      claim.append(textElement('span', 'Not claimed', 'report-muted'))
    } else {
      claim.append(linkElement(`/invoices/${row.invoice_id}`, `#${row.invoice_id}`))
    }
    cells.push(claim)
  }
  const hours = element('td', 'report-numeric')
  if (grain === 'entry' && row.time_entry_id !== undefined) {
    hours.append(linkElement(`/time?entry_id=${row.time_entry_id}`, decimalHours(row.seconds)))
  } else {
    hours.append(decimalHours(row.seconds))
  }
  cells.push(hours)
  return cells
}

const renderDetailedTime = (
  report: Readonly<DetailedTimeReport>,
  options: Readonly<DetailedTimeOptions>,
  labels: { readonly client: string; readonly project: string },
  handlers: DetailedTimeHandlers,
): DocumentFragment => {
  const fragment = document.createDocumentFragment()
  fragment.append(
    reportHeading(
      // Harvest's own title, dates and all: the range is the report's identity,
      // and a heading that said only "Detailed time" would print without it.
      `Detailed time report: ${report.from} – ${report.to}`,
      `${report.time_entry_count.toLocaleString('en-US')} time ${report.time_entry_count === 1 ? 'entry' : 'entries'}`,
    ),
  )
  const summary = element('div', 'report-detailed-summary')
  const totals = element('dl', 'report-facts')
  totals.append(
    fact('Total hours', formatReportHours(report.seconds)),
    fact('Uninvoiced billable hours', formatReportHours(report.uninvoiced_billable_seconds)),
    // Tracked, not billable: a band absorbs the period, so the hours nobody
    // ticked billable are part of what it took (#708).
    fact('Claimed hours', formatReportHours(report.claimed_seconds)),
    fact('Unclaimed hours', formatReportHours(report.unclaimed_seconds)),
  )
  for (const currency of report.currencies) {
    // Absent for a profile that cannot read billable rates; the fact is then
    // not drawn at all rather than drawn empty.
    if (currency.billable_amount_cents === undefined) continue
    totals.append(
      fact(
        `Billable amount (${currency.currency})`,
        formatReportMoney(currency.billable_amount_cents, currency.currency),
      ),
    )
  }
  summary.append(totals, detailedTimeRecap(labels.client, labels.project, report))
  fragment.append(summary)

  const controls = element('div', 'report-detailed-controls')
  controls.append(
    selectControl(
      'ez-detailed-hours',
      'Show',
      [
        ['all', 'All hours'],
        ['billable', 'Billable hours'],
        ['non_billable', 'Non-billable hours'],
        ['uninvoiced', 'Uninvoiced billable hours'],
        ['claimed', 'Claimed by an invoice'],
        ['unclaimed', 'Not claimed yet'],
      ],
      options.hours,
      (next) => handlers.onOptions({ ...options, hours: next as DetailedTimeHours }),
    ),
    selectControl(
      'ez-detailed-grain',
      'Rows',
      [
        ['day', 'Daily totals'],
        ['entry', 'Individual entries'],
      ],
      options.grain,
      (next) => handlers.onOptions({ ...options, grain: next === 'entry' ? 'entry' : 'day' }),
    ),
    selectControl(
      'ez-detailed-invoice-state',
      'Invoice state',
      [
        ['all', 'All entries'],
        ['invoiced', 'Invoiced'],
        ['uninvoiced', 'Uninvoiced'],
      ],
      options.invoiceState,
      (next) => handlers.onOptions({
        ...options,
        invoiceState: next === 'invoiced' || next === 'uninvoiced' ? next : 'all',
      }),
    ),
    idControl('ez-detailed-task', 'Task ID', options.taskId, (taskId) =>
      handlers.onOptions({ ...options, taskId })),
    idControl('ez-detailed-person', 'Person ID', options.userId, (userId) =>
      handlers.onOptions({ ...options, userId })),
    idControl('ez-detailed-role', 'Role ID', options.roleId, (roleId) =>
      handlers.onOptions({ ...options, roleId })),
    idControl('ez-detailed-tag', 'Tag ID', options.tagId, (tagId) =>
      handlers.onOptions({ ...options, tagId })),
    selectControl(
      'ez-detailed-group',
      'Group by',
      [
        ['date', 'Date'],
        ['client', 'Client'],
        ['project', 'Project'],
        ['task', 'Task'],
        ['person', 'Person'],
        ['role', 'Role'],
        ['claimed', 'Claimed'],
      ],
      options.grouping,
      (next) =>
        handlers.onOptions({ ...options, grouping: next as DetailedTimeGrouping }),
    ),
  )
  const activeField = element('div', 'report-filter-field report-detailed-active')
  const activeInput = element('input')
  activeInput.type = 'checkbox'
  activeInput.id = 'ez-detailed-active'
  activeInput.checked = options.activeProjectsOnly
  activeInput.addEventListener('change', () =>
    handlers.onOptions({ ...options, activeProjectsOnly: activeInput.checked }),
  )
  const activeLabel = textElement('label', 'Active projects only')
  activeLabel.htmlFor = 'ez-detailed-active'
  activeField.append(activeInput, activeLabel)
  const actions = element('div', 'report-detailed-actions')
  const exportButton = textElement('button', 'Export')
  exportButton.type = 'button'
  exportButton.dataset['detailedExport'] = ''
  exportButton.addEventListener('click', handlers.onExport)
  const printButton = textElement('button', 'Print')
  printButton.type = 'button'
  printButton.dataset['detailedPrint'] = ''
  printButton.addEventListener('click', handlers.onPrint)
  actions.append(exportButton, printButton)
  const selected = new Set<number>()
  const mutationButtons: HTMLButtonElement[] = []
  const updateMutationButtons = (): void => {
    for (const button of mutationButtons) button.disabled = selected.size === 0
  }
  if (handlers.onAction !== undefined && report.grain === 'entry') {
    for (const [action, label] of [
      ['mark_invoiced', 'Mark invoiced'],
      ['mark_uninvoiced', 'Mark uninvoiced'],
      ['move', 'Move hours'],
    ] as const) {
      const button = textElement('button', label)
      button.type = 'button'
      button.disabled = true
      button.dataset['detailedAction'] = action
      button.addEventListener('click', () => handlers.onAction?.(action, [...selected]))
      mutationButtons.push(button)
      actions.append(button)
    }
  }
  controls.append(activeField, actions)
  fragment.append(controls)

  if (report.rows.length === 0) {
    exportButton.disabled = true
    fragment.append(
      textElement('p', 'No time was tracked under these filters.', 'report-empty'),
    )
    return fragment
  }

  const wrapper = element('div', 'report-table-wrap')
  const table = element('table', 'report-table report-detailed-table')
  const head = element('thead')
  const headerRow = element('tr')
  const selectable = handlers.onAction !== undefined && report.grain === 'entry'
  const headers =
    options.grain === 'entry'
      ? [...(selectable ? ['Select'] : []), 'Client', 'Project', 'Task', 'Roles', 'Person', 'Notes', 'Claimed by', 'Hours']
      : ['Client', 'Project', 'Task', 'Roles', 'Person', 'Hours']
  for (const label of headers) {
    const cell = textElement('th', label)
    cell.scope = 'col'
    if (label === 'Hours') cell.className = 'report-numeric'
    headerRow.append(cell)
  }
  head.append(headerRow)
  const body = element('tbody')
  for (const band of groupDetailedTimeRows(report.rows, options.grouping)) {
    const bandRow = element('tr', 'report-band-row')
    const bandLabel = textElement('th', band.label)
    bandLabel.colSpan = headers.length - 1
    bandLabel.scope = 'colgroup'
    bandRow.append(bandLabel, textElement('td', decimalHours(band.seconds), 'report-numeric'))
    body.append(bandRow)
    for (const row of band.rows) {
      const line = element('tr')
      if (selectable) {
        const cell = element('td')
        const checkbox = element('input')
        checkbox.type = 'checkbox'
        checkbox.disabled = row.time_entry_id === undefined
        checkbox.setAttribute('aria-label', `Select time entry ${row.time_entry_id ?? ''}`.trim())
        checkbox.addEventListener('change', () => {
          if (row.time_entry_id === undefined) return
          if (checkbox.checked) selected.add(row.time_entry_id)
          else selected.delete(row.time_entry_id)
          updateMutationButtons()
        })
        cell.append(checkbox)
        line.append(cell)
      }
      line.append(...detailedTimeCells(row, options.grain))
      body.append(line)
    }
  }
  const foot = element('tfoot')
  const totalRow = element('tr')
  const totalLabel = textElement('th', 'Total')
  totalLabel.scope = 'row'
  totalLabel.colSpan = headers.length - 1
  totalRow.append(totalLabel, textElement('td', decimalHours(report.seconds), 'report-numeric'))
  foot.append(totalRow)
  table.append(head, body, foot)
  wrapper.append(table)
  fragment.append(wrapper)

  const unpriced = report.currencies.reduce(
    (count, currency) => count + currency.entries_without_billable_rate,
    0,
  )
  if (unpriced > 0) {
    fragment.append(
      warning(
        `${countLabel(unpriced, 'billable time entry', 'billable time entries')} without a resolved rate ${unpriced === 1 ? 'is' : 'are'} excluded from billable amounts.`,
      ),
    )
  }
  return fragment
}

/**
 * The Time report's summary strip: total hours, the billable split, and the two
 * money figures. The money cards are absent, not blank, for a viewer whose
 * response carried no `amounts` -- a card reading "—" would say the month had
 * no billable value rather than that this reader may not see it.
 */
const timeSummary = (totals: Readonly<TimeReportTotals>): HTMLElement => {
  const section = element('section', 'report-summary')
  section.setAttribute('aria-label', 'Time report summary')
  const nonBillableSeconds = totals.rounded_seconds - totals.billable_seconds
  const metric = (label: string, value: string, swatch?: string): HTMLElement => {
    const wrapper = element('div')
    if (swatch !== undefined) wrapper.dataset['swatch'] = swatch
    wrapper.append(textElement('span', label), textElement('strong', value))
    return wrapper
  }
  section.append(
    metric('Total hours', formatReportHours(totals.rounded_seconds)),
    metric('Billable', formatReportHours(totals.billable_seconds), 'billable'),
    metric('Non-billable', formatReportHours(nonBillableSeconds), 'nonbillable'),
  )
  if (totals.amounts !== undefined) {
    // One line per currency rather than a sum: this product holds no exchange
    // rate, and adding EUR to USD would be inventing one.
    const money = (label: string, pick: (amount: TimeReportAmount) => number): HTMLElement => {
      const wrapper = element('div')
      wrapper.append(textElement('span', label))
      if (totals.amounts!.length === 0) wrapper.append(textElement('strong', '—'))
      else {
        for (const amount of totals.amounts!) {
          wrapper.append(
            textElement('strong', formatReportMoney(pick(amount), amount.currency)),
          )
        }
      }
      return wrapper
    }
    section.append(
      money('Billable amount', (amount) => amount.billable_cents),
      money('Uninvoiced amount', (amount) => amount.uninvoiced_cents),
    )
  }
  const bar = element('div', 'report-summary-bar')
  // A period with no tracked time has no split to draw; a bar of two zero-width
  // segments is a stray hairline that says nothing.
  if (totals.rounded_seconds > 0) {
    const billable = element('span')
    billable.dataset['part'] = 'billable'
    billable.style.flexGrow = String(Math.max(0, totals.billable_seconds))
    const nonBillable = element('span')
    nonBillable.dataset['part'] = 'nonbillable'
    nonBillable.style.flexGrow = String(Math.max(0, nonBillableSeconds))
    bar.append(billable, nonBillable)
    section.append(bar)
  }
  return section
}

const timeTabNames: readonly { readonly tab: TimeReportTab; readonly label: string }[] = [
  { tab: 'clients', label: 'Clients' },
  { tab: 'projects', label: 'Projects' },
  { tab: 'tasks', label: 'Tasks' },
  { tab: 'teammates', label: 'Teammates' },
]

/**
 * Real links, so a tab can be opened in a new window and sent to somebody, but
 * an unmodified click is handled here: the four tabs are folds of a response
 * already in memory, and re-fetching the month to redraw the same rows would
 * make the fastest interaction on the screen the slowest.
 */
const timeTabStrip = (
  filters: Readonly<ReportFilters>,
  onTab: (tab: TimeReportTab) => void,
  options: Readonly<TimeReportOptions>,
): HTMLElement => {
  const nav = element('nav', 'report-subtabs')
  nav.setAttribute('aria-label', 'Time report grouping')
  for (const entry of timeTabNames) {
    const anchor = linkElement(
      reportFiltersUrl({ ...filters, tab: entry.tab }, undefined, options),
      entry.label,
    )
    if (entry.tab === filters.tab) anchor.setAttribute('aria-current', 'page')
    anchor.dataset['reportTimeTab'] = entry.tab
    anchor.addEventListener('click', (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      onTab(entry.tab)
    })
    nav.append(anchor)
  }
  return nav
}

interface TimeRowFigures {
  readonly rounded_seconds: number
  readonly billable_seconds: number
  readonly amounts?: readonly TimeReportAmount[]
}

const hoursBar = (seconds: number, maximum: number, label: string): HTMLElement => {
  const bar = document.createElement('progress')
  // Against the largest row, not the period total: a bar scaled to the whole
  // month leaves every row but the biggest client a stub, which is a column of
  // ink that ranks nothing.
  bar.max = Math.max(1, maximum)
  bar.value = Math.max(0, Math.min(seconds, bar.max))
  bar.setAttribute('aria-label', label)
  return bar
}

const billableCell = (row: Readonly<TimeRowFigures>): HTMLTableCellElement => {
  const cell = element('td')
  const share = billablePercent(row.billable_seconds, row.rounded_seconds)
  cell.textContent =
    share === null
      ? formatReportHours(row.billable_seconds)
      : `${formatReportHours(row.billable_seconds)} (${share}%)`
  return cell
}

const amountCell = (
  amounts: readonly TimeReportAmount[],
  pick: (amount: TimeReportAmount) => number,
): HTMLTableCellElement => {
  const cell = element('td')
  if (amounts.length === 0) {
    cell.textContent = '—'
    return cell
  }
  for (const amount of amounts) {
    cell.append(textElement('span', formatReportMoney(pick(amount), amount.currency)))
  }
  return cell
}

/**
 * One table for all four tabs. The columns before the figures differ -- a
 * project names its client, a teammate carries a utilization -- but Hours, the
 * bar, Billable hours and Billable amount are the same four questions on every
 * tab, so they are built once. A second copy per tab is how the Total row and a
 * column drift apart.
 */
interface TimeTableColumn<Row> {
  readonly label: string
  readonly cell: (row: Row) => HTMLTableCellElement
  /** The total row's cell, where the column has one. */
  readonly total?: HTMLTableCellElement
}

const timeTable = <Row extends TimeRowFigures>(
  leading: readonly TimeTableColumn<Row>[],
  trailing: readonly TimeTableColumn<Row>[],
  groups: readonly { readonly label: string | null; readonly rows: readonly Row[] }[],
  totals: Readonly<TimeReportTotals>,
  barLabel: (row: Row) => string,
): HTMLElement => {
  const showMoney = totals.amounts !== undefined
  const wrapper = element('div', 'report-table-wrap')
  const table = element('table', 'report-table report-time-table')
  const labels = [
    ...leading.map((column) => column.label),
    'Hours',
    '',
    'Billable hours',
    ...(showMoney ? ['Billable amount'] : []),
    ...trailing.map((column) => column.label),
  ]
  const head = element('thead')
  const headerRow = element('tr')
  for (const label of labels) {
    const cell = textElement('th', label)
    cell.scope = 'col'
    headerRow.append(cell)
  }
  head.append(headerRow)

  const every = groups.flatMap((group) => group.rows)
  const maximum = every.reduce((largest, row) => Math.max(largest, row.rounded_seconds), 0)
  const body = element('tbody')
  if (every.length === 0) {
    const row = element('tr')
    const cell = textElement('td', 'No time was tracked in this period.')
    cell.colSpan = labels.length
    row.append(cell)
    body.append(row)
  }
  for (const group of groups) {
    if (group.rows.length === 0) continue
    if (group.label !== null) {
      const groupRow = element('tr', 'report-group-row')
      const groupCell = textElement('th', group.label)
      groupCell.scope = 'colgroup'
      groupCell.colSpan = labels.length
      groupRow.append(groupCell)
      body.append(groupRow)
    }
    for (const row of group.rows) {
      const tableRow = element('tr')
      for (const column of leading) tableRow.append(column.cell(row))
      const hours = textElement('td', formatReportHours(row.rounded_seconds))
      const bar = element('td', 'report-bar-cell')
      bar.append(hoursBar(row.rounded_seconds, maximum, barLabel(row)))
      tableRow.append(hours, bar, billableCell(row))
      if (showMoney) {
        tableRow.append(amountCell(row.amounts ?? [], (amount) => amount.billable_cents))
      }
      for (const column of trailing) tableRow.append(column.cell(row))
      body.append(tableRow)
    }
  }

  const foot = element('tfoot')
  const totalRow = element('tr')
  const totalLabel = textElement('th', 'Total')
  totalLabel.scope = 'row'
  totalLabel.colSpan = leading.length
  totalRow.append(
    totalLabel,
    textElement('td', formatReportHours(totals.rounded_seconds)),
    // The bar column has no total: the bars rank rows against each other, and a
    // full-width bar on the Total row would read as a fifth data row.
    element('td', 'report-bar-cell'),
    billableCell(totals),
  )
  if (showMoney) {
    totalRow.append(amountCell(totals.amounts ?? [], (amount) => amount.billable_cents))
  }
  for (const column of trailing) totalRow.append(column.total ?? element('td'))
  foot.append(totalRow)
  table.append(head, body, foot)
  wrapper.append(table)
  return wrapper
}

const plainNameCell = (label: string): HTMLTableCellElement => {
  const cell = element('th')
  cell.scope = 'row'
  cell.textContent = label
  return cell
}

const nameCell = (href: string, label: string): HTMLTableCellElement => {
  const cell = element('th')
  cell.scope = 'row'
  cell.append(linkElement(href, label))
  return cell
}

/** `[code] Name`, and the bare name where the project carries no code. */
const projectLabel = (row: Readonly<TimeReportProjectRow>): string =>
  row.project_code.trim() === ''
    ? row.project_name
    : `[${row.project_code.trim()}] ${row.project_name}`

const renderTimeReport = (
  report: Readonly<TimeReport>,
  filters: Readonly<ReportFilters>,
  onTab: (tab: TimeReportTab) => void,
  options: Readonly<TimeReportOptions>,
  /**
   * Whether this viewer may open a person's page. `reports:read` and `team:read`
   * are different sets -- accounting holds the first and not the second -- so a
   * teammate row linked unconditionally hands them a link to a page the shell
   * keeps out of their nav and the screen refuses on arrival.
   */
  canOpenTeam: boolean,
): DocumentFragment => {
  const fragment = document.createDocumentFragment()
  fragment.append(
    reportHeading('Time', `${report.from} through ${report.to}`),
    textElement(
      'p',
      report.fixed_fee_included
        ? 'Fixed-fee project hours are included. Their amounts are hourly value at resolved rates, not fixed-fee revenue.'
        : 'Fixed-fee project hours are excluded from every total and grouping.',
      'report-card-note',
    ),
    timeSummary(report.totals),
    timeTabStrip(filters, onTab, options),
  )
  if (report.totals.unpriced_billable_entry_count > 0 && report.totals.amounts !== undefined) {
    fragment.append(
      warning(
        `${countLabel(report.totals.unpriced_billable_entry_count, 'billable time entry', 'billable time entries')} without a resolved rate ${report.totals.unpriced_billable_entry_count === 1 ? 'is' : 'are'} counted in hours and excluded from the amounts.`,
      ),
    )
  }
  if (filters.tab === 'clients') {
    fragment.append(
      timeTable<TimeReportClientRow>(
        [
          {
            label: 'Name',
            cell: (row) => nameCell(`/clients/${row.client_id}`, row.client_name),
          },
        ],
        [],
        [{ label: null, rows: report.clients }],
        report.totals,
        (row) => `${row.client_name} hours`,
      ),
    )
  } else if (filters.tab === 'projects') {
    fragment.append(
      timeTable<TimeReportProjectRow>(
        [
          {
            label: 'Name',
            cell: (row) => nameCell(`/projects/${row.project_id}`, projectLabel(row)),
          },
          {
            label: 'Clients',
            cell: (row) => {
              const cell = element('td')
              cell.append(linkElement(`/clients/${row.client_id}`, row.client_name))
              return cell
            },
          },
        ],
        [],
        [{ label: null, rows: report.projects }],
        report.totals,
        (row) => `${row.project_name} hours`,
      ),
    )
  } else if (filters.tab === 'tasks') {
    fragment.append(
      timeTable<TimeReportTaskRow>(
        [
          {
            label: 'Name',
            cell: (row) => {
              const cell = element('th')
              cell.scope = 'row'
              // No link: a task has no screen of its own outside Manage, and a
              // dead link is worse than plain text.
              cell.textContent = row.task_name
              return cell
            },
          },
        ],
        [],
        [{ label: null, rows: report.tasks }],
        report.totals,
        (row) => `${row.task_name} hours`,
      ),
    )
  } else {
    fragment.append(
      timeTable<TimeReportTeammateRow>(
        [
          {
            label: 'Name',
            // Plain text where the viewer cannot read Team, which is what the
            // Tasks tab already does for the same reason: a dead link is worse
            // than no link, because it looks like a way in.
            cell: (row) =>
              canOpenTeam
                ? nameCell(`/team/${row.user_id}`, row.user_name)
                : plainNameCell(row.user_name),
          },
        ],
        [
          {
            label: 'Utilization',
            cell: (row) => {
              const cell = element('td')
              cell.textContent = teamUtilization(row.utilization_ppm)
              return cell
            },
            // No total: utilizations are ratios against different capacities,
            // and the one number that could go here -- the team's hours over
            // the team's capacity -- is not what the column above it holds.
          },
        ],
        [
          { label: 'Employees', rows: report.teammates.filter((row) => !row.is_contractor) },
          { label: 'Contractors', rows: report.teammates.filter((row) => row.is_contractor) },
        ],
        report.totals,
        (row) => `${row.user_name} hours`,
      ),
    )
  }
  return fragment
}

interface ActiveSession {
  readonly identity: Whoami
  readonly signal: AbortSignal
  readonly onSessionFailure: (error: unknown) => boolean
}

export interface ReportsController {
  activate(
    identity: Whoami,
    signal: AbortSignal,
    onSessionFailure: (error: unknown) => boolean,
  ): Promise<void>
}

export const createReportsController = (
  api: Partial<ReportWorkspaceApi>,
): ReportsController => {
  const reportsPage = document.documentElement.dataset.appView === 'reports'
  const page = required<HTMLElement>('[data-reports-page]')
  const form = required<HTMLFormElement>('[data-report-form]')
  // The strip is the shell's, rendered for the /reports route alone, so its
  // links carry no reports markers of their own: a tab is identified by the
  // kind in the address it points at, which is the address this controller
  // pushes anyway. Every other page renders a strip that holds none of them,
  // and the map is then empty -- this factory runs on every page.
  const kindTabs = new Map<ReportKind, HTMLAnchorElement>()
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>('.tabstrip a')) {
    const target = new URL(anchor.getAttribute('href') ?? '', globalThis.location.origin)
    const tabKind = target.searchParams.get('report')
    if (target.pathname !== '/reports' || tabKind === null || !isReportKind(tabKind)) continue
    kindTabs.set(tabKind, anchor)
  }
  const kindStrip = [...kindTabs.values()][0]?.parentElement ?? null
  /**
   * The two From/To fields the card used to carry, as the shared control. An
   * arrow reloads immediately because stepping is navigation, not filtering:
   * the run button exists for the pickers beside it, and making somebody press
   * it after every arrow would turn "last quarter, the one before, the one
   * before that" into six clicks. A hand-edited custom range still waits for
   * the button, because half a range is not a range.
   *
   * The callback ignores the range it is handed: the control has already
   * written it to its own inputs, which is where `filtersFromForm` reads the
   * range from, and taking it from the argument instead would be a second copy
   * of the same dates that could disagree with the pickers beside them.
   */
  const period = createPeriodControl({
    label: 'Period',
    today: localToday,
    onChange: () => {
      void loadReport(filtersFromForm(), true)
    },
  })
  required<HTMLElement>('[data-report-period]').appendChild(period.element)
  const catalogField = required<HTMLElement>('[data-report-catalog-field]')
  const catalogInput = required<HTMLSelectElement>('[data-report-catalog]')
  const clientField = required<HTMLElement>('[data-report-client-field]')
  const clientLabel = required<HTMLElement>('[data-report-client-label]')
  const clientInput = required<HTMLSelectElement>('[data-report-client]')
  const projectField = required<HTMLElement>('[data-report-project-field]')
  const projectInput = required<HTMLSelectElement>('[data-report-project]')
  const fixedFeeField = required<HTMLElement>('[data-report-fixed-fee-field]')
  const fixedFeeInput = required<HTMLInputElement>('[data-report-fixed-fee]')
  const invoiceStatusField = required<HTMLElement>('[data-report-invoice-status-field]')
  const invoiceStatusInput = required<HTMLSelectElement>('[data-report-invoice-status]')
  const profitStatusField = required<HTMLElement>('[data-report-profit-status-field]')
  const profitStatusInput = required<HTMLSelectElement>('[data-report-profit-status]')
  const profitBillingField = required<HTMLElement>('[data-report-profit-billing-field]')
  const profitBillingInput = required<HTMLSelectElement>('[data-report-profit-billing]')
  const profitManagerField = required<HTMLElement>('[data-report-profit-manager-field]')
  const profitManagerInput = required<HTMLInputElement>('[data-report-profit-manager]')
  const profitTagField = required<HTMLElement>('[data-report-profit-tag-field]')
  const profitTagInput = required<HTMLInputElement>('[data-report-profit-tag]')
  const expenseCategoryField = required<HTMLElement>('[data-report-expense-category-field]')
  const expenseCategoryInput = required<HTMLInputElement>('[data-report-expense-category]')
  const expenseUserField = required<HTMLElement>('[data-report-expense-user-field]')
  const expenseUserInput = required<HTMLInputElement>('[data-report-expense-user]')
  const expenseBillableField = required<HTMLElement>('[data-report-expense-billable-field]')
  const expenseBillableInput = required<HTMLSelectElement>('[data-report-expense-billable]')
  const expenseReimbursableField = required<HTMLElement>('[data-report-expense-reimbursable-field]')
  const expenseReimbursableInput = required<HTMLSelectElement>('[data-report-expense-reimbursable]')
  const expenseInvoiceField = required<HTMLElement>('[data-report-expense-invoice-field]')
  const expenseInvoiceInput = required<HTMLSelectElement>('[data-report-expense-invoice]')
  const expenseActiveField = required<HTMLElement>('[data-report-expense-active-field]')
  const expenseActiveInput = required<HTMLInputElement>('[data-report-expense-active]')
  const run = required<HTMLButtonElement>('[data-report-run]')
  const retry = required<HTMLButtonElement>('[data-report-retry]')
  const status = required<HTMLElement>('[data-report-status]')
  const results = required<HTMLElement>('[data-report-results]')
  const savedOpen = required<HTMLButtonElement>('[data-saved-reports-open]')
  const savedLibrary = required<HTMLElement>('[data-saved-reports-library]')
  const savedClose = required<HTMLButtonElement>('[data-saved-reports-close]')
  const savedSearch = required<HTMLInputElement>('[data-saved-search]')
  const savedCustomOnly = required<HTMLInputElement>('[data-saved-custom-only]')
  const savedStatus = required<HTMLElement>('[data-saved-status]')
  const savedList = required<HTMLElement>('[data-saved-list]')
  const builderOpen = required<HTMLButtonElement>('[data-report-builder-open]')
  const builder = required<HTMLDialogElement>('[data-report-builder]')
  const builderClose = required<HTMLButtonElement>('[data-report-builder-close]')
  const builderForm = required<HTMLFormElement>('[data-report-builder-form]')
  const builderTemplate = required<HTMLSelectElement>('[data-builder-template]')
  const builderName = required<HTMLInputElement>('[data-builder-name]')
  const builderFields = required<HTMLSelectElement>('[data-builder-fields]')
  const builderMetrics = required<HTMLSelectElement>('[data-builder-metrics]')
  const builderFieldsUp = required<HTMLButtonElement>('[data-builder-fields-up]')
  const builderFieldsDown = required<HTMLButtonElement>('[data-builder-fields-down]')
  const builderMetricsUp = required<HTMLButtonElement>('[data-builder-metrics-up]')
  const builderMetricsDown = required<HTMLButtonElement>('[data-builder-metrics-down]')
  const builderFrom = required<HTMLInputElement>('[data-builder-from]')
  const builderTo = required<HTMLInputElement>('[data-builder-to]')
  const builderClients = required<HTMLInputElement>('[data-builder-clients]')
  const builderProjects = required<HTMLInputElement>('[data-builder-projects]')
  const builderGroup = required<HTMLSelectElement>('[data-builder-group]')
  const builderResult = required<HTMLSelectElement>('[data-builder-result]')
  const builderGrouped = required<HTMLInputElement>('[data-builder-grouped]')
  const builderZero = required<HTMLInputElement>('[data-builder-zero]')
  const builderStatus = required<HTMLElement>('[data-builder-status]')
  const builderPreview = required<HTMLButtonElement>('[data-builder-preview]')
  page.hidden = !reportsPage

  let session: ActiveSession | null = null
  /**
   * `reports:read` and `team:read` are different sets -- accounting is in the
   * first and not the second -- so whether a teammate name is a link is a
   * question about the viewer, asked of the same helper the Team screen and the
   * nav both use rather than a second copy of the rule.
   */
  const canOpenTeam = (): boolean =>
    session !== null && teamCapabilities(session.identity).canRead
  let kind: ReportKind = 'uninvoiced'
  let timeTab: TimeReportTab = 'clients'
  /**
   * The last Time response, kept so the four sub-tabs redraw from it. They are
   * four foldings of one answer, so asking the server again to switch between
   * them would be four requests for a month it has already reported on -- and
   * four chances for the tabs to disagree if an entry is saved between them.
   */
  let lastTimeReport: TimeReport | null = null
  let lastProfitabilityReport: ProfitabilityReport | null = null
  let contractorOnly = false
  let clients: readonly GeneralResource[] = []
  let projects: readonly GeneralResource[] = []
  /**
   * Reporting on an archived client or project is the point -- the year you are
   * closing is mostly work that has since finished -- so the catalogs are still
   * fetched whole and this narrows the two pickers rather than the requests
   * behind them. On the account #495 was raised from, 66 of 78 projects are
   * archived, which is a picker six parts noise to one part signal; the same
   * active/all distinction the client and project directories carry answers it,
   * defaulting to what you can still book work against. It is one control for
   * both pickers because a card whose Project list hid archived work while the
   * Client list beside it did not would be lying about what it holds.
   */
  let catalogFilter: 'active' | 'all' = 'active'
  /**
   * The last detailed report, kept so a change of grouping re-folds what is
   * already here. Cleared whenever a request goes out, so Export can never hand
   * out rows from a report the screen has stopped showing.
   */
  let detailedReport: DetailedTimeReport | null = null
  let detailedOptions: DetailedTimeOptions = {
    hours: 'all',
    grouping: 'date',
    grain: 'day',
    activeProjectsOnly: false,
    taskId: null,
    userId: null,
    roleId: null,
    tagId: null,
    invoiceState: 'all',
  }
  let timeOptions: TimeReportOptions = { includeFixedFee: false }
  let invoicedOptions: InvoicedReportOptions = { status: null }
  let profitabilityOptions: ProfitabilityOptions = {
    dimension: 'projects',
    projectStatus: 'all',
    billingMethod: null,
    managerId: null,
    tagId: null,
  }
  let expenseOptions: DetailedExpenseOptions = {
    categoryId: null,
    userId: null,
    billable: 'all',
    reimbursable: 'all',
    invoiceState: 'all',
    activeProjectsOnly: false,
  }
  let pending = false
  let retryAction: (() => void) | null = null
  let queuedLocationFilters: ReportFilters | null = null
  let savedView: 'all' | 'yours' | 'shared' = 'all'
  let builderRegistry: ReportDefinitionRegistry | null = null
  let editingSaved: SavedReport | null = null

  const currentSession = (): ActiveSession | null =>
    session === null || session.signal.aborted ? null : session

  const savedReportInput = (): SavedReportInput => {
    const ids = (input: HTMLInputElement): number[] => input.value
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((value) => Number.isSafeInteger(value) && value > 0)
    const fields = [...builderFields.selectedOptions].map((option) => ({
      id: option.value,
      label: option.textContent ?? option.value,
      visible: true,
    }))
    const metrics = [...builderMetrics.selectedOptions].map(({ value }) => value)
    const group = builderGroup.value
    const clientIds = ids(builderClients)
    const projectIds = ids(builderProjects)
    return {
      name: builderName.value.trim(),
      fields,
      metrics,
      filters: [
        { field: 'spent_date', operator: 'between', value: [builderFrom.value, builderTo.value] },
        ...(clientIds.length === 0 ? [] : [{ field: 'client_id', operator: 'in' as const, value: clientIds }]),
        ...(projectIds.length === 0 ? [] : [{ field: 'project_id', operator: 'in' as const, value: projectIds }]),
      ],
      group_by:
        group === 'client' || group === 'project' || group === 'task' || group === 'user' || group === 'date'
          ? { dimension: group }
          : null,
      presentation: {
        result: builderResult.value === 'detailed' ? 'detailed' : 'summary',
        grouped: builderGrouped.checked,
        include_zero_values: builderZero.checked,
      },
    }
  }

  const renderRunnerResult = (report: Readonly<ReportRunnerResult>, name: string): void => {
    const fragment = document.createDocumentFragment()
    fragment.append(reportHeading(name, `${report.rows.length} result ${report.rows.length === 1 ? 'row' : 'rows'}`))
    if (report.state === 'empty') {
      fragment.append(textElement('p', 'No live rows match this saved definition.', 'report-empty'))
    } else if (report.state === 'too_many_rows') {
      fragment.append(textElement('p', 'This definition matches more than 10,000 rows. Narrow its filters.', 'report-empty'))
    } else {
      const table = element('table', 'report-table')
      const body = element('tbody')
      for (const raw of report.rows) {
        const row = raw as { label?: unknown; metrics?: unknown; drillThrough?: unknown }
        const line = element('tr')
        const heading = element('th')
        heading.scope = 'row'
        const label = typeof row.label === 'string' ? row.label : 'Result'
        heading.append(typeof row.drillThrough === 'string' ? linkElement(row.drillThrough, label) : document.createTextNode(label))
        line.append(heading, textElement('td', JSON.stringify(row.metrics ?? {})))
        body.append(line)
      }
      table.append(body)
      fragment.append(table)
    }
    results.replaceChildren(fragment)
  }

  const loadSavedReports = async (): Promise<void> => {
    const active = currentSession()
    if (active === null || api.listSavedReports === undefined) return
    savedStatus.textContent = 'Loading saved reports…'
    try {
      const reports = await api.listSavedReports({
        view: savedView,
        ...(savedSearch.value.trim() === '' ? {} : { q: savedSearch.value.trim() }),
        ...(savedCustomOnly.checked ? { custom_only: true } : {}),
      }, active.signal)
      if (currentSession() !== active) return
      savedList.replaceChildren(...reports.map((report: SavedReport) => {
        const card = element('article', 'report-saved-card')
        const open = textElement('button', report.name)
        open.type = 'button'
        open.addEventListener('click', () => {
          if (api.runSavedReport === undefined) return
          savedStatus.textContent = `Running ${report.name}…`
          void api.runSavedReport(report.id, active.signal).then((result) => {
            savedLibrary.hidden = true
            renderRunnerResult(result, report.name)
            status.textContent = `Saved report version ${report.version} loaded with ${report.filters.length} active filters.`
          }).catch((error: unknown) => { savedStatus.textContent = messageFor(error) })
        })
        const metadata = textElement(
          'p',
          `${String(report.owner.name ?? 'Unknown owner')} · Updated ${report.updated_at.slice(0, 10)} · ${report.filters.length} filters · ${report.presentation.result} · ${report.presentation.grouped ? 'Grouped' : 'Ungrouped'}${report.presentation.include_zero_values ? ' · Includes zero values' : ''}`,
        )
        const pin = textElement('button', report.pinned ? 'Unpin' : 'Pin')
        pin.type = 'button'
        pin.addEventListener('click', () => {
          const action = report.pinned ? api.unpinSavedReport : api.pinSavedReport
          if (action === undefined) return
          void action(report.id, active.signal).then(loadSavedReports)
        })
        const duplicate = textElement('button', 'Duplicate')
        duplicate.type = 'button'
        duplicate.addEventListener('click', () => {
          if (api.duplicateSavedReport === undefined) return
          void api.duplicateSavedReport(report.id, active.signal).then(loadSavedReports)
        })
        const ownerId = typeof report.owner.user_id === 'number' ? report.owner.user_id : null
        const owned = ownerId === active.identity.user_id
        const edit = textElement('button', 'Edit')
        edit.type = 'button'
        edit.hidden = !owned
        edit.addEventListener('click', () => {
          editingSaved = report
          builderName.value = report.name
          builderFrom.value = String((report.filters.find((filter) => filter['field'] === 'spent_date')?.['value'] as readonly unknown[] | undefined)?.[0] ?? period.range().from)
          builderTo.value = String((report.filters.find((filter) => filter['field'] === 'spent_date')?.['value'] as readonly unknown[] | undefined)?.[1] ?? period.range().to)
          builderClients.value = ((report.filters.find((filter) => filter['field'] === 'client_id')?.['value'] as readonly unknown[] | undefined) ?? []).join(', ')
          builderProjects.value = ((report.filters.find((filter) => filter['field'] === 'project_id')?.['value'] as readonly unknown[] | undefined) ?? []).join(', ')
          const group = report.group_by?.['dimension']
          builderGroup.value = typeof group === 'string' ? group : ''
          builderResult.value = report.presentation.result
          builderGrouped.checked = report.presentation.grouped
          builderZero.checked = report.presentation.include_zero_values
          void openBuilder(report)
        })
        const share = textElement('button', 'Share')
        share.type = 'button'
        share.hidden = !owned
        share.addEventListener('click', () => {
          if (api.shareSavedReport === undefined) return
          const answer = globalThis.prompt('Share with user ID')
          const userId = Number(answer)
          if (!Number.isSafeInteger(userId) || userId < 1) return
          savedStatus.textContent = `Sharing ${report.name}…`
          void api.shareSavedReport(report.id, userId, active.signal)
            .then(() => { savedStatus.textContent = `${report.name} shared.` })
            .catch((error: unknown) => { savedStatus.textContent = messageFor(error) })
        })
        const remove = textElement('button', 'Delete')
        remove.type = 'button'
        remove.hidden = !owned
        remove.addEventListener('click', () => {
          if (api.deleteSavedReport === undefined || !globalThis.confirm(`Delete ${report.name}?`)) return
          void api.deleteSavedReport(report.id, active.signal).then(loadSavedReports)
        })
        card.append(open, metadata, pin, duplicate, edit, share, remove)
        return card
      }))
      savedStatus.textContent = reports.length === 0 ? 'No saved reports match.' : `${reports.length} saved reports.`
    } catch (error) {
      savedStatus.textContent = messageFor(error)
    }
  }

  const setPending = (value: boolean): void => {
    pending = value
    run.disabled = value
    period.setDisabled(value)
    catalogInput.disabled = value
    clientInput.disabled = value
    projectInput.disabled = value
    fixedFeeInput.disabled = value
    invoiceStatusInput.disabled = value
    profitStatusInput.disabled = value
    profitBillingInput.disabled = value
    profitManagerInput.disabled = value
    profitTagInput.disabled = value
    expenseCategoryInput.disabled = value
    expenseUserInput.disabled = value
    expenseBillableInput.disabled = value
    expenseReimbursableInput.disabled = value
    expenseInvoiceInput.disabled = value
    expenseActiveInput.disabled = value
    if (value) results.setAttribute('aria-busy', 'true')
    else results.removeAttribute('aria-busy')
  }

  const clearReportPresentation = (): void => {
    setPending(false)
    retryAction = null
    retry.hidden = true
    detailedReport = null
    results.replaceChildren()
  }

  const selectedId = (input: HTMLSelectElement): number | null => {
    const value = Number(input.value)
    return Number.isSafeInteger(value) && value > 0 ? value : null
  }

  const typedId = (input: HTMLInputElement): number | null => {
    if (input.value.trim() === '') return null
    const value = Number(input.value)
    return Number.isSafeInteger(value) && value > 0 ? value : null
  }

  const showProfitabilityOptions = (): void => {
    profitStatusInput.value = profitabilityOptions.projectStatus
    profitBillingInput.value = profitabilityOptions.billingMethod ?? ''
    profitManagerInput.value = profitabilityOptions.managerId === null
      ? ''
      : String(profitabilityOptions.managerId)
    profitTagInput.value = profitabilityOptions.tagId === null
      ? ''
      : String(profitabilityOptions.tagId)
  }

  const showExpenseOptions = (): void => {
    expenseCategoryInput.value = expenseOptions.categoryId === null ? '' : String(expenseOptions.categoryId)
    expenseUserInput.value = expenseOptions.userId === null ? '' : String(expenseOptions.userId)
    expenseBillableInput.value = expenseOptions.billable
    expenseReimbursableInput.value = expenseOptions.reimbursable
    expenseInvoiceInput.value = expenseOptions.invoiceState
    expenseActiveInput.checked = expenseOptions.activeProjectsOnly
  }

  const filtersFromForm = (): ReportFilters => ({
    kind,
    ...period.range(),
    clientId: selectedId(clientInput),
    projectId: selectedId(projectInput),
    tab: timeTab,
  })

  /**
   * The strip only carries the kinds this profile can read, so marking one it
   * cannot leaves the marked tab about to be removed: a single visible tab with
   * no aria-current, beside a filter card still dressed for a report that is no
   * longer in the strip — the "which report am I looking at" failure #293 opens
   * with. Presentation therefore falls back to the readable kind. loadReport
   * still receives the kind the URL asked for, so the withheld API call and the
   * message naming the denial are unchanged.
   */
  const presentedKind = (
    requested: ReportKind,
    identity: Pick<Whoami, 'profile' | 'manager_grants'>,
  ): ReportKind => (canReadKind(requested, identity) ? requested : 'my-hours')

  const setKind = (next: ReportKind): void => {
    kind = next
    for (const [tabKind, anchor] of kindTabs) {
      if (tabKind === next) anchor.setAttribute('aria-current', 'page')
      else anchor.removeAttribute('aria-current')
    }
  }

  /**
   * The tabs keep the range the user is looking at, so opening one in a new tab
   * lands on the same window the dropdown used to carry across a change of kind.
   */
  const syncKindHrefs = (filters: Readonly<ReportFilters>): void => {
    for (const [tabKind, anchor] of kindTabs) {
      anchor.href = reportFiltersUrl(
        { ...filters, kind: tabKind },
        detailedOptions,
        timeOptions,
        invoicedOptions,
        profitabilityOptions,
        expenseOptions,
      )
    }
  }

  const updateVisibleFilters = (): void => {
    // My hours has no client picker: the report is the acting user's own rows,
    // narrowed by project or not at all, and a client control would suggest a
    // second axis the endpoint does not take. Contractor cost has neither: it
    // takes a range alone, and a picker it would ignore is worse than no picker.
    // The Time report has neither either: it is the whole account over a
    // period, and a narrowed one is what the client and project tabs inside it
    // are for.
    clientField.hidden =
      kind === 'project-budget' ||
      kind === 'my-hours' ||
      kind === 'contractor-cost' ||
      kind === 'activity-log' ||
      kind === 'profitability' ||
      kind === 'time'
    projectField.hidden =
      kind === 'client-rollup' ||
      kind === 'invoiced' ||
      kind === 'payments-received' ||
      kind === 'receivables' ||
      kind === 'contractor-cost' ||
      kind === 'activity-log' ||
      kind === 'profitability' ||
      kind === 'time'
    // The catalog switch exists to widen those two pickers. With neither on
    // screen it is a control that changes nothing, which is worse than an
    // absent one: the first person to move it waits for something to happen.
    catalogField.hidden = clientField.hidden && projectField.hidden
    fixedFeeField.hidden = kind !== 'time'
    invoiceStatusField.hidden = kind !== 'invoiced'
    profitStatusField.hidden = kind !== 'profitability'
    profitBillingField.hidden = kind !== 'profitability'
    profitManagerField.hidden = kind !== 'profitability'
    profitTagField.hidden = kind !== 'profitability'
    expenseCategoryField.hidden = kind !== 'detailed-expense'
    expenseUserField.hidden = kind !== 'detailed-expense'
    expenseBillableField.hidden = kind !== 'detailed-expense'
    expenseReimbursableField.hidden = kind !== 'detailed-expense'
    expenseInvoiceField.hidden = kind !== 'detailed-expense'
    expenseActiveField.hidden = kind !== 'detailed-expense'
    clientLabel.textContent = kind === 'client-rollup' ? 'Root client' : 'Client (optional)'
    required<HTMLElement>('[data-report-project-label]').textContent =
      kind === 'project-budget' ? 'Project' : 'Project (optional)'
  }

  const option = (resource: GeneralResource): HTMLOptionElement => {
    const item = document.createElement('option')
    item.value = String(resource.id)
    item.textContent = `${reportResourceLabel(resource)}${resource['is_active'] === false ? ' (archived)' : ''}`
    return item
  }

  /**
   * The narrowed list keeps whatever the filters already name, archived or not:
   * that resource is the report on screen, and an option that vanished from
   * under it would retarget the report to "all" without anybody asking.
   */
  const listed = (
    resources: readonly GeneralResource[],
    selected: number | null,
  ): readonly GeneralResource[] =>
    catalogFilter === 'all'
      ? resources
      : resources.filter(
          (resource) => resource['is_active'] !== false || resource.id === selected,
        )

  const populateCatalog = (filters: Readonly<ReportFilters>): void => {
    const optional = (label: string): HTMLOptionElement => {
      const item = document.createElement('option')
      item.value = ''
      item.textContent = label
      return item
    }
    clientInput.replaceChildren(
      optional('All clients'),
      ...listed(clients, filters.clientId).map(option),
    )
    projectInput.replaceChildren(
      optional('All projects'),
      ...listed(projects, filters.projectId).map(option),
    )
    clientInput.value = filters.clientId === null ? '' : String(filters.clientId)
    projectInput.value = filters.projectId === null ? '' : String(filters.projectId)
  }

  /**
   * The export writes what the table holds, in the order the table holds it.
   * It never asks the API again: a second request could be answered with rows
   * the screen was not shown, and the money columns are decided by whether the
   * fetched rows carry the field rather than by anything read here.
   */
  const exportDetailedTime = (): void => {
    if (detailedReport === null) return
    const blob = new Blob([detailedTimeCsv(detailedReport, detailedOptions.grouping)], {
      type: 'text/csv;charset=utf-8',
    })
    const href = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = href
    link.download = `detailed-time-${detailedReport.from}-to-${detailedReport.to}.csv`
    link.click()
    URL.revokeObjectURL(href)
  }

  const exportContractorCost = (report: Readonly<ContractorCostReport>): void => {
    const blob = new Blob([contractorCostCsv(report)], { type: 'text/csv;charset=utf-8' })
    const href = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = href
    link.download = `contractor-cost-${report.from}-to-${report.to}.csv`
    link.click()
    URL.revokeObjectURL(href)
  }

  const exportDetailedExpense = (report: Readonly<DetailedExpenseReport>): void => {
    const blob = new Blob([detailedExpenseCsv(report)], { type: 'text/csv;charset=utf-8' })
    const href = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = href
    link.download = `detailed-expense-${report.from}-to-${report.to}.csv`
    link.click()
    URL.revokeObjectURL(href)
  }

  const renderDetailed = (report: Readonly<DetailedTimeReport>): void => {
    const filters = filtersFromForm()
    const active = currentSession()
    results.replaceChildren(
      renderDetailedTime(
        report,
        detailedOptions,
        {
          client:
            report.client_id === null
              ? 'All clients'
              : catalogLabel(clients, report.client_id, `Client #${report.client_id}`),
          project:
            report.project_id === null
              ? 'All projects'
              : catalogLabel(projects, report.project_id, `Project #${report.project_id}`),
        },
        {
          onOptions: (next) => {
            const regroupOnly =
              next.hours === detailedOptions.hours &&
              next.grain === detailedOptions.grain &&
              next.activeProjectsOnly === detailedOptions.activeProjectsOnly &&
              next.taskId === detailedOptions.taskId &&
              next.userId === detailedOptions.userId &&
              next.roleId === detailedOptions.roleId &&
              next.tagId === detailedOptions.tagId &&
              next.invoiceState === detailedOptions.invoiceState
            detailedOptions = next
            // Grouping is a re-fold of rows already here, so it re-renders
            // without a request; Show, Active projects only and Detail change
            // which rows exist, so they go back to the API.
            if (regroupOnly) {
              globalThis.history.pushState(
                null,
                '',
                reportFiltersUrl({ ...filters, kind: 'detailed-time' }, detailedOptions),
              )
              renderDetailed(report)
              return
            }
            void loadReport({ ...filters, kind: 'detailed-time' }, true)
          },
          onExport: exportDetailedTime,
          onPrint: () => globalThis.print(),
          ...(active !== null && api.executeDetailedTimeAction !== undefined &&
            ['administrator', 'accounting', 'executive_manager'].includes(active.identity.profile)
            ? {
                onAction: (action: 'mark_invoiced' | 'mark_uninvoiced' | 'move', entryIds: readonly number[]) => {
                  const invoiceId = action === 'mark_invoiced' ? Number(globalThis.prompt('Draft invoice ID')) : undefined
                  const projectId = action === 'move' ? Number(globalThis.prompt('Destination project ID')) : undefined
                  const taskId = action === 'move' ? Number(globalThis.prompt('Destination task ID')) : undefined
                  if (invoiceId !== undefined && (!Number.isSafeInteger(invoiceId) || invoiceId < 1)) return
                  if (projectId !== undefined && (!Number.isSafeInteger(projectId) || projectId < 1)) return
                  if (taskId !== undefined && (!Number.isSafeInteger(taskId) || taskId < 1)) return
                  if (!globalThis.confirm(`${action.replaceAll('_', ' ')} ${entryIds.length} selected time entries?`)) return
                  status.textContent = 'Applying confirmed time action…'
                  void api.executeDetailedTimeAction?.({
                    command_id: globalThis.crypto.randomUUID(),
                    action,
                    entry_ids: [...entryIds],
                    confirmed: true,
                    ...(invoiceId === undefined ? {} : { invoice_id: invoiceId }),
                    ...(projectId === undefined ? {} : { project_id: projectId }),
                    ...(taskId === undefined ? {} : { task_id: taskId }),
                  }, active.signal).then((outcome) => {
                    status.textContent = `${outcome.changed_entry_ids.length} entries changed; ${outcome.ineligible_entry_ids.length} were ineligible.`
                    void loadReport({ ...filters, kind: 'detailed-time' }, false)
                  }).catch((error: unknown) => { status.textContent = messageFor(error) })
                },
              }
            : {}),
        },
      ),
    )
  }

  /**
   * A sub-tab is presentation, so it redraws what is already here and pushes
   * the address that names it. A run in flight declines the click for the same
   * reason the kind tabs do: the report about to arrive is the one the tab
   * would be drawing.
   */
  const showTimeTab = (tab: TimeReportTab): void => {
    if (pending || tab === timeTab) return
    timeTab = tab
    const filters = filtersFromForm()
    syncKindHrefs(filters)
    globalThis.history.pushState(null, '', reportFiltersUrl(filters, detailedOptions, timeOptions))
    if (lastTimeReport === null) return
    results.replaceChildren(
      renderTimeReport(lastTimeReport, filters, showTimeTab, timeOptions, canOpenTeam()),
    )
  }

  const renderReport = (
    filters: Readonly<ReportFilters>,
    report:
      | UninvoicedReport
      | ClientRollupReport
      | ProjectBudgetReport
      | MyHoursReport
      | ContractorCostReport
      | DetailedTimeReport
      | DetailedExpenseReport
      | ProfitabilityReport
      | TimeReport
      | InvoicedReport
      | PaymentsReceivedReport
      | ReceivablesReport
      | readonly ActivityLogEntry[],
  ): void => {
    if (filters.kind === 'time') {
      lastTimeReport = report as TimeReport
      results.replaceChildren(
        renderTimeReport(lastTimeReport, filters, showTimeTab, timeOptions, canOpenTeam()),
      )
    } else if (filters.kind === 'detailed-time') {
      detailedReport = report as DetailedTimeReport
      renderDetailed(detailedReport)
    } else if (filters.kind === 'my-hours') {
      results.replaceChildren(renderMyHours(report as MyHoursReport))
    } else if (filters.kind === 'uninvoiced') {
      results.replaceChildren(
        renderUninvoiced(
          report as UninvoicedReport,
          session !== null && invoiceIdentityCanWrite(session.identity),
        ),
      )
    } else if (filters.kind === 'invoiced') {
      results.replaceChildren(renderInvoiced(report as InvoicedReport))
    } else if (filters.kind === 'payments-received') {
      results.replaceChildren(renderPaymentsReceived(report as PaymentsReceivedReport))
    } else if (filters.kind === 'receivables') {
      results.replaceChildren(renderReceivables(report as ReceivablesReport))
    } else if (filters.kind === 'activity-log') {
      results.replaceChildren(
        renderActivityLog(report as readonly ActivityLogEntry[], filters),
      )
    } else if (filters.kind === 'profitability') {
      lastProfitabilityReport = report as ProfitabilityReport
      results.replaceChildren(
        renderProfitability(lastProfitabilityReport, profitabilityOptions, (dimension) => {
          if (pending || dimension === profitabilityOptions.dimension) return
          profitabilityOptions = { ...profitabilityOptions, dimension }
          globalThis.history.pushState(
            null,
            '',
            reportFiltersUrl(
              filtersFromForm(),
              detailedOptions,
              timeOptions,
              invoicedOptions,
              profitabilityOptions,
              expenseOptions,
            ),
          )
          if (lastProfitabilityReport !== null) {
            renderReport(filtersFromForm(), lastProfitabilityReport)
          }
        }),
      )
    } else if (filters.kind === 'detailed-expense') {
      const expenseReport = report as DetailedExpenseReport
      results.replaceChildren(
        renderDetailedExpense(
          expenseReport,
          expenseOptions,
          {
            client:
              expenseReport.client_id === null
                ? 'All clients'
                : catalogLabel(clients, expenseReport.client_id, `Client #${expenseReport.client_id}`),
            project:
              expenseReport.project_id === null
                ? 'All projects'
                : catalogLabel(projects, expenseReport.project_id, `Project #${expenseReport.project_id}`),
          },
          canOpenTeam(),
          {
            onExport: () => exportDetailedExpense(expenseReport),
            onPrint: () => globalThis.print(),
          },
        ),
      )
    } else if (filters.kind === 'contractor-cost') {
      const contractorReport = report as ContractorCostReport
      const visibleReport = {
        ...contractorReport,
        rows: contractorOnly
          ? contractorReport.rows.filter((row) => row.is_contractor)
          : contractorReport.rows,
      }
      results.replaceChildren(
        renderContractorCost(contractorReport, contractorOnly, {
          onExport: () => exportContractorCost(visibleReport),
          onPopulation: (next) => {
            contractorOnly = next
            const location = new URL(globalThis.location.href)
            if (next) location.searchParams.set('contractor_only', 'true')
            else location.searchParams.delete('contractor_only')
            globalThis.history.pushState(null, '', `${location.pathname}${location.search}`)
            renderReport(filters, contractorReport)
          },
        }),
      )
    } else if (filters.kind === 'client-rollup') {
      results.replaceChildren(renderClientRollup(report as ClientRollupReport, clients))
    } else {
      results.replaceChildren(
        renderProjectBudget(report as ProjectBudgetReport, projects),
      )
    }
  }

  const loadReport = async (filters: ReportFilters, updateUrl: boolean): Promise<void> => {
    const active = currentSession()
    if (active === null) return
    if (pending) {
      if (!updateUrl) queuedLocationFilters = filters
      return
    }
    const validation = validateReportFilters(filters)
    if (validation !== null) {
      clearReportPresentation()
      status.textContent = validation
      return
    }
    if (!canReadKind(filters.kind, active.identity)) {
      clearReportPresentation()
      // Named rather than folded into the financial refusal: accounting reads
      // the financial reports and is still refused this one, so "your profile
      // does not have access to this financial report" would leave them
      // hunting for a permission that does not exist.
      status.textContent =
        filters.kind === 'contractor-cost'
          ? 'Only an administrator can read the contractor cost report.'
          : filters.kind === 'profitability'
            ? 'Only an administrator can read the profitability report.'
            : 'Your profile does not have access to this financial report.'
      return
    }
    if (
      api.getUninvoicedReport === undefined ||
      api.getClientRollupReport === undefined ||
      api.getProjectBudgetReport === undefined ||
      api.getMyHoursReport === undefined ||
      api.getContractorCostReport === undefined ||
      api.getDetailedTimeReport === undefined ||
      api.getTimeReport === undefined ||
      api.getActivityLog === undefined ||
      api.getProfitabilityReport === undefined ||
      api.getDetailedExpenseReport === undefined ||
      (filters.kind === 'invoiced' && api.getInvoicedReport === undefined) ||
      (filters.kind === 'payments-received' && api.getPaymentsReceivedReport === undefined) ||
      (filters.kind === 'receivables' && api.getReceivablesReport === undefined)
    ) {
      clearReportPresentation()
      status.textContent = 'Reports are unavailable in this build.'
      return
    }
    syncKindHrefs(filters)
    if (updateUrl) {
      const nextUrl = reportFiltersUrl(
        filters,
        detailedOptions,
        timeOptions,
        invoicedOptions,
        profitabilityOptions,
        expenseOptions,
      )
      globalThis.history.pushState(
        null,
        '',
        filters.kind === 'contractor-cost' && contractorOnly
          ? `${nextUrl}&contractor_only=true`
          : nextUrl,
      )
    }
    setPending(true)
    retry.hidden = true
    retryAction = null
    detailedReport = null
    // The cached fold belongs to the range that produced it; keeping it across
    // a reload would let a sub-tab click redraw last month under this month's
    // heading.
    lastTimeReport = null
    lastProfitabilityReport = null
    results.replaceChildren()
    status.textContent = 'Loading report…'
    try {
      const range = { from: filters.from, to: filters.to }
      const report =
        filters.kind === 'time'
        ? await api.getTimeReport(
            {
              ...range,
              ...(timeOptions.includeFixedFee ? { include_fixed_fee: true } : {}),
            },
            active.signal,
          )
        : filters.kind === 'invoiced'
          ? await api.getInvoicedReport!(
              {
                ...range,
                ...(filters.clientId === null ? {} : { client_id: filters.clientId }),
                ...(invoicedOptions.status === null ? {} : { status: invoicedOptions.status }),
              },
              active.signal,
            )
        : filters.kind === 'payments-received'
          ? await api.getPaymentsReceivedReport!(
              {
                ...range,
                ...(filters.clientId === null ? {} : { client_id: filters.clientId }),
              },
              active.signal,
            )
        : filters.kind === 'receivables'
          ? await api.getReceivablesReport!(
              {
                as_of: filters.to,
                ...(filters.clientId === null ? {} : { client_id: filters.clientId }),
              },
              active.signal,
            )
        : filters.kind === 'my-hours'
        ? await api.getMyHoursReport(
            {
              ...range,
              ...(filters.projectId === null ? {} : { project_id: filters.projectId }),
            },
            active.signal,
          )
        : filters.kind === 'detailed-time'
          ? await api.getDetailedTimeReport(
              {
                ...range,
                ...(filters.clientId === null ? {} : { client_id: filters.clientId }),
                ...(filters.projectId === null ? {} : { project_id: filters.projectId }),
                hours: detailedOptions.hours,
                grain: detailedOptions.grain,
                ...(detailedOptions.taskId === null ? {} : { task_id: detailedOptions.taskId }),
                ...(detailedOptions.userId === null ? {} : { user_id: detailedOptions.userId }),
                ...(detailedOptions.roleId === null ? {} : { role_id: detailedOptions.roleId }),
                ...(detailedOptions.tagId === null ? {} : { tag_id: detailedOptions.tagId }),
                invoice_state: detailedOptions.invoiceState,
                active_projects_only: detailedOptions.activeProjectsOnly,
              },
              active.signal,
            )
        : filters.kind === 'activity-log'
          ? await api.getActivityLog({ from: filters.from, to: filters.to }, active.signal)
        : filters.kind === 'detailed-expense'
          ? await api.getDetailedExpenseReport(
              {
                ...range,
                ...(filters.clientId === null ? {} : { client_id: filters.clientId }),
                ...(filters.projectId === null ? {} : { project_id: filters.projectId }),
                ...(expenseOptions.categoryId === null ? {} : { category_id: expenseOptions.categoryId }),
                ...(expenseOptions.userId === null ? {} : { user_id: expenseOptions.userId }),
                ...(expenseOptions.billable === 'all'
                  ? {}
                  : { billable: expenseOptions.billable === 'yes' }),
                ...(expenseOptions.reimbursable === 'all'
                  ? {}
                  : { reimbursable: expenseOptions.reimbursable === 'yes' }),
                invoice_state: expenseOptions.invoiceState,
                active_projects_only: expenseOptions.activeProjectsOnly,
              },
              active.signal,
            )
        : filters.kind === 'uninvoiced'
          ? await api.getUninvoicedReport(
              {
                ...range,
                ...(filters.clientId === null ? {} : { client_id: filters.clientId }),
                ...(filters.projectId === null ? {} : { project_id: filters.projectId }),
              },
              active.signal,
            )
          : filters.kind === 'profitability'
            ? await api.getProfitabilityReport(
                {
                  ...range,
                  project_status: profitabilityOptions.projectStatus,
                  ...(profitabilityOptions.billingMethod === null
                    ? {}
                    : { billing_method: profitabilityOptions.billingMethod }),
                  ...(profitabilityOptions.managerId === null
                    ? {}
                    : { manager_id: profitabilityOptions.managerId }),
                  ...(profitabilityOptions.tagId === null
                    ? {}
                    : { tag_id: profitabilityOptions.tagId }),
                },
                active.signal,
              )
          : filters.kind === 'contractor-cost'
            ? await api.getContractorCostReport(range, active.signal)
            : filters.kind === 'client-rollup'
              ? await api.getClientRollupReport(filters.clientId!, range, active.signal)
              : await api.getProjectBudgetReport(filters.projectId!, range, active.signal)
      if (currentSession() !== active) return
      if (queuedLocationFilters !== null) return
      renderReport(filters, report)
      status.textContent = 'Report loaded.'
    } catch (error) {
      if (currentSession() !== active) return
      if (active.onSessionFailure(error)) return
      if (active.signal.aborted) return
      if (queuedLocationFilters !== null) return
      status.textContent = messageFor(error)
      retry.hidden = false
      retryAction = () => void loadReport(filters, false)
    } finally {
      if (currentSession() === active) {
        setPending(false)
        const queued = queuedLocationFilters
        queuedLocationFilters = null
        if (queued !== null) void loadReport(queued, false)
      }
    }
  }

  const applyLocation = (): void => {
    const active = currentSession()
    if (active === null) return
    const location = new URL(globalThis.location.href)
    const filters = reportFiltersFromUrl(
      location,
      localToday(),
      canReadFinancialReports(active.identity.profile),
    )
    detailedOptions = detailedTimeOptionsFromUrl(location)
    timeOptions = timeReportOptionsFromUrl(location)
    invoicedOptions = invoicedReportOptionsFromUrl(location)
    profitabilityOptions = profitabilityOptionsFromUrl(location)
    expenseOptions = detailedExpenseOptionsFromUrl(location)
    contractorOnly = location.searchParams.get('contractor_only') === 'true'
    fixedFeeInput.checked = timeOptions.includeFixedFee
    invoiceStatusInput.value = invoicedOptions.status ?? ''
    showProfitabilityOptions()
    showExpenseOptions()
    setKind(presentedKind(filters.kind, active.identity))
    timeTab = filters.tab
    period.setRange(filters)
    populateCatalog(filters)
    updateVisibleFilters()
    void loadReport(filters, false)
  }

  for (const [tabKind, anchor] of kindTabs) {
    anchor.addEventListener('click', (event) => {
      // A modified click still belongs to the browser: it opens the tab's own
      // address, which syncKindHrefs keeps pointed at the visible range.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      // A run in flight disabled the dropdown this replaced. A link cannot be
      // disabled, so it declines the click instead.
      if (pending) return
      setKind(tabKind)
      updateVisibleFilters()
      void loadReport(filtersFromForm(), true)
    })
  }
  // Widening the catalogs re-dresses the pickers and nothing else: the report on
  // screen was run against the filters it names, and those are untouched here.
  catalogInput.addEventListener('change', () => {
    catalogFilter = catalogInput.value === 'all' ? 'all' : 'active'
    populateCatalog(filtersFromForm())
  })
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    timeOptions = { includeFixedFee: fixedFeeInput.checked }
    const selectedStatus = invoiceStatusInput.value
    invoicedOptions = {
      status:
        selectedStatus === 'draft' || selectedStatus === 'open' ||
        selectedStatus === 'paid' || selectedStatus === 'closed'
          ? selectedStatus as InvoicedReportStatus
          : null,
    }
    const selectedProjectStatus = profitStatusInput.value
    const selectedBillingMethod = profitBillingInput.value
    profitabilityOptions = {
      ...profitabilityOptions,
      projectStatus:
        selectedProjectStatus === 'active' || selectedProjectStatus === 'archived'
          ? selectedProjectStatus
          : 'all',
      billingMethod:
        selectedBillingMethod === 'non_billable' ||
        selectedBillingMethod === 'time_materials' ||
        selectedBillingMethod === 'fixed_fee'
          ? selectedBillingMethod
          : null,
      managerId: typedId(profitManagerInput),
      tagId: typedId(profitTagInput),
    }
    const selectedExpenseBillable = expenseBillableInput.value
    const selectedExpenseReimbursable = expenseReimbursableInput.value
    const selectedExpenseInvoice = expenseInvoiceInput.value
    expenseOptions = {
      categoryId: typedId(expenseCategoryInput),
      userId: typedId(expenseUserInput),
      billable:
        selectedExpenseBillable === 'yes' || selectedExpenseBillable === 'no'
          ? selectedExpenseBillable
          : 'all',
      reimbursable:
        selectedExpenseReimbursable === 'yes' || selectedExpenseReimbursable === 'no'
          ? selectedExpenseReimbursable
          : 'all',
      invoiceState:
        selectedExpenseInvoice === 'invoiced' || selectedExpenseInvoice === 'uninvoiced'
          ? selectedExpenseInvoice
          : 'all',
      activeProjectsOnly: expenseActiveInput.checked,
    }
    void loadReport(filtersFromForm(), true)
  })
  savedOpen.addEventListener('click', () => {
    savedLibrary.hidden = false
    void loadSavedReports()
  })
  savedClose.addEventListener('click', () => { savedLibrary.hidden = true })
  for (const choice of document.querySelectorAll<HTMLButtonElement>('[data-saved-view]')) {
    choice.addEventListener('click', () => {
      const view = choice.dataset.savedView
      if (view !== 'all' && view !== 'yours' && view !== 'shared') return
      savedView = view
      for (const button of document.querySelectorAll<HTMLButtonElement>('[data-saved-view]')) {
        button.setAttribute('aria-pressed', String(button === choice))
      }
      void loadSavedReports()
    })
  }
  savedSearch.addEventListener('input', () => { void loadSavedReports() })
  savedCustomOnly.addEventListener('change', () => { void loadSavedReports() })

  const openBuilder = async (source?: Readonly<SavedReport>): Promise<void> => {
    const active = currentSession()
    if (active === null || api.getReportDefinitionRegistry === undefined) return
    builderStatus.textContent = 'Loading fields and metrics…'
    builder.showModal()
    builderFrom.value = period.range().from
    builderTo.value = period.range().to
    if (source === undefined) {
      builderClients.value = ''
      builderProjects.value = ''
    }
    try {
      builderRegistry ??= await api.getReportDefinitionRegistry(active.signal)
      const fields = builderRegistry.fields.flatMap((raw) => {
        const field = raw as { id?: unknown; label?: unknown; groupable?: unknown }
        return typeof field.id === 'string' && typeof field.label === 'string' && field.groupable === true
          ? [{ id: field.id, label: field.label }]
          : []
      })
      const metrics = builderRegistry.metrics.flatMap((raw) => {
        const metric = raw as { id?: unknown; label?: unknown }
        return typeof metric.id === 'string' && typeof metric.label === 'string'
          ? [{ id: metric.id, label: metric.label }]
          : []
      })
      builderFields.replaceChildren(...fields.map(({ id, label }) => {
        const option = document.createElement('option'); option.value = id; option.textContent = label; return option
      }))
      builderMetrics.replaceChildren(...metrics.map(({ id, label }) => {
        const option = document.createElement('option'); option.value = id; option.textContent = label; return option
      }))
      const selectedFields = new Set(source?.fields.map((field) => String(field['id'])) ?? [])
      const selectedMetrics = new Set(source?.metrics ?? [])
      for (const option of builderFields.options) option.selected = source === undefined ? option.index === 0 : selectedFields.has(option.value)
      for (const option of builderMetrics.options) option.selected = source === undefined ? option.index === 0 : selectedMetrics.has(option.value)
      builderStatus.textContent = ''
    } catch (error) {
      builderStatus.textContent = messageFor(error)
    }
  }
  builderOpen.addEventListener('click', () => { editingSaved = null; void openBuilder() })
  const moveSelected = (select: HTMLSelectElement, direction: -1 | 1): void => {
    const selected = direction < 0 ? [...select.selectedOptions] : [...select.selectedOptions].reverse()
    for (const option of selected) {
      const sibling = direction < 0 ? option.previousElementSibling : option.nextElementSibling
      if (!(sibling instanceof HTMLOptionElement) || sibling.selected) continue
      if (direction < 0) select.insertBefore(option, sibling)
      else select.insertBefore(sibling, option)
    }
  }
  builderFieldsUp.addEventListener('click', () => moveSelected(builderFields, -1))
  builderFieldsDown.addEventListener('click', () => moveSelected(builderFields, 1))
  builderMetricsUp.addEventListener('click', () => moveSelected(builderMetrics, -1))
  builderMetricsDown.addEventListener('click', () => moveSelected(builderMetrics, 1))
  builderClose.addEventListener('click', () => builder.close())
  builderTemplate.addEventListener('change', () => {
    const template = builderTemplate.value
    if (template === 'detailed-time') {
      builderName.value = 'Detailed time'
      builderResult.value = 'detailed'
      builderGrouped.checked = false
    } else if (template === 'detailed-expense') {
      builderName.value = 'Detailed expense'
      builderResult.value = 'detailed'
      builderGrouped.checked = false
    }
  })
  builderPreview.addEventListener('click', () => {
    const active = currentSession()
    if (active === null || api.previewReportDefinition === undefined) return
    const input = savedReportInput()
    builderStatus.textContent = 'Running preview…'
    void api.previewReportDefinition(input, active.signal).then((report) => {
      renderRunnerResult(report, input.name)
      builderStatus.textContent = report.state === 'ready' ? 'Preview is ready.' : report.state === 'empty' ? 'No rows match.' : 'Narrow the report filters.'
    }).catch((error: unknown) => { builderStatus.textContent = messageFor(error) })
  })
  builderForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const active = currentSession()
    if (active === null || api.createSavedReport === undefined) return
    const input = savedReportInput()
    builderStatus.textContent = editingSaved === null ? 'Saving report…' : 'Updating report…'
    const save = editingSaved === null
      ? api.createSavedReport(input, active.signal)
      : api.updateSavedReport?.(editingSaved.id, { version: editingSaved.version, ...input }, active.signal)
    if (save === undefined) return
    void save.then((report) => {
      editingSaved = null
      builder.close()
      savedLibrary.hidden = false
      savedStatus.textContent = `${report.name} saved.`
      void loadSavedReports()
    }).catch((error: unknown) => { builderStatus.textContent = messageFor(error) })
  })
  retry.addEventListener('click', () => {
    retryAction?.()
  })
  return {
    async activate(identity, signal, onSessionFailure) {
      if (!reportsPage) return
      session = { identity, signal, onSessionFailure }
      clients = []
      projects = []
      detailedReport = null
      lastTimeReport = null
      lastProfitabilityReport = null
      timeOptions = { includeFixedFee: false }
      invoicedOptions = { status: null }
      profitabilityOptions = {
        dimension: 'projects',
        projectStatus: 'all',
        billingMethod: null,
        managerId: null,
        tagId: null,
      }
      expenseOptions = {
        categoryId: null,
        userId: null,
        billable: 'all',
        reimbursable: 'all',
        invoiceState: 'all',
        activeProjectsOnly: false,
      }
      catalogFilter = 'active'
      pending = false
      retryAction = null
      queuedLocationFilters = null
      catalogInput.value = 'active'
      period.setDisabled(false)
      catalogInput.disabled = false
      clientInput.disabled = false
      projectInput.disabled = false
      fixedFeeInput.disabled = false
      invoiceStatusInput.disabled = false
      profitStatusInput.disabled = false
      profitBillingInput.disabled = false
      profitManagerInput.disabled = false
      profitTagInput.disabled = false
      expenseCategoryInput.disabled = false
      expenseUserInput.disabled = false
      expenseBillableInput.disabled = false
      expenseReimbursableInput.disabled = false
      expenseInvoiceInput.disabled = false
      expenseActiveInput.disabled = false
      run.disabled = false
      clientInput.replaceChildren()
      projectInput.replaceChildren()
      results.replaceChildren()
      results.removeAttribute('aria-busy')
      retry.hidden = true
      status.textContent = 'Loading report filters…'
      globalThis.addEventListener('popstate', applyLocation, { signal })
      signal.addEventListener(
        'abort',
        () => {
          if (session?.signal !== signal) return
          session = null
          clients = []
          projects = []
          detailedReport = null
          lastTimeReport = null
          lastProfitabilityReport = null
          pending = false
          retryAction = null
          queuedLocationFilters = null
          clientInput.replaceChildren()
          projectInput.replaceChildren()
          results.replaceChildren()
          results.removeAttribute('aria-busy')
          retry.hidden = true
          run.disabled = true
          period.setDisabled(true)
          status.textContent = 'Sign in to view reports.'
        },
        { once: true },
      )
      const initialLocation = new URL(globalThis.location.href)
      const initial = reportFiltersFromUrl(
        initialLocation,
        localToday(),
        canReadFinancialReports(identity.profile),
      )
      detailedOptions = detailedTimeOptionsFromUrl(initialLocation)
      timeOptions = timeReportOptionsFromUrl(initialLocation)
      invoicedOptions = invoicedReportOptionsFromUrl(initialLocation)
      profitabilityOptions = profitabilityOptionsFromUrl(initialLocation)
      expenseOptions = detailedExpenseOptionsFromUrl(initialLocation)
      contractorOnly = initialLocation.searchParams.get('contractor_only') === 'true'
      fixedFeeInput.checked = timeOptions.includeFixedFee
      invoiceStatusInput.value = invoicedOptions.status ?? ''
      showProfitabilityOptions()
      showExpenseOptions()
      setKind(presentedKind(initial.kind, identity))
      timeTab = initial.tab
      period.setRange(initial)
      updateVisibleFilters()
      // A kind this profile cannot read leaves the strip rather than sitting in
      // it refusing to work: a disabled control that gives no reason is worse
      // than an absent one. The tabs are re-hung rather than destroyed so a
      // second session in the same document gets the strip its profile earns.
      kindStrip?.replaceChildren(
        ...[...kindTabs]
          .filter(([tabKind]) => canReadKind(tabKind, identity))
          .map(([, anchor]) => anchor),
      )
      if (api.listReportClients === undefined || api.listReportProjects === undefined) {
        status.textContent = 'Report filters are unavailable in this build.'
        run.disabled = true
        return
      }
      const loadCatalogAndReport = async (): Promise<void> => {
        const active = currentSession()
        if (active === null) return
        status.textContent = 'Loading report filters…'
        retry.hidden = true
        retryAction = null
        setPending(true)
        let loaded = false
        let filtersToLoad: ReportFilters | null = null
        try {
          const [loadedClients, loadedProjects, settings] = await Promise.all([
            collect((cursor) => api.listReportClients!(cursor, signal), signal),
            collect((cursor) => api.listReportProjects!(cursor, signal), signal),
            // Alongside the catalogs rather than before them, and swallowing
            // its own failure: the week-start setting decides a label, and a
            // report that would not open because a display preference was
            // unreachable is a worse trade than a week called "custom".
            api.getTimeEntrySettings?.(signal).catch(() => null) ?? Promise.resolve(null),
          ])
          if (currentSession() !== active) return
          clients = loadedClients
          projects = loadedProjects
          const next = queuedLocationFilters ?? initial
          queuedLocationFilters = null
          setKind(presentedKind(next.kind, identity))
          timeTab = next.tab
          // Before the range, so the range is read under the organisation's own
          // week rather than under Monday and then re-read.
          if (settings !== null) period.setWeekStartDay(settings.week_start_day)
          period.setRange(next)
          populateCatalog(next)
          updateVisibleFilters()
          filtersToLoad = next
          loaded = true
        } catch (error) {
          if (currentSession() !== active) return
          if (active.onSessionFailure(error) || active.signal.aborted) return
          status.textContent = messageFor(error)
          retry.hidden = false
          retryAction = () => void loadCatalogAndReport()
        } finally {
          if (currentSession() === active) setPending(false)
        }
        if (loaded && filtersToLoad !== null) await loadReport(filtersToLoad, false)
      }
      await loadCatalogAndReport()
    },
  }
}
