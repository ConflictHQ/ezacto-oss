import {
  EzactoApiError,
  type ClientRollupMetrics,
  type ClientRollupReport,
  type ContractorCostReport,
  type ContractorCostRow,
  type GeneralResource,
  type MyHoursReport,
  type ProjectBudgetReport,
  type UninvoicedReport,
  type Whoami,
} from '@ezacto/client'
import { createPeriodControl } from '../components/period.js'
import { moneyText } from '../money-display.js'
import {
  canReadCostReports,
  canReadFinancialReports,
  formatReportCents,
  formatReportHours,
  formatReportMoney,
  isReportKind,
  reportFiltersFromUrl,
  reportFiltersUrl,
  reportResourceLabel,
  validateReportFilters,
  type ReportFilters,
  type ReportKind,
  type ReportWorkspaceApi,
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
  kind === 'contractor-cost'
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

const renderUninvoiced = (report: Readonly<UninvoicedReport>): DocumentFragment => {
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
      fact('Tracked time', formatReportHours(total.rounded_seconds)),
      fact('Time amount', reportMoney(total.time_cents, total.currency)),
      fact('Expense amount', reportMoney(total.expense_cents, total.currency)),
      fact('Time entries', total.time_entry_count.toLocaleString('en-US')),
      fact('Expenses', total.expense_count.toLocaleString('en-US')),
    )
    card.append(header, facts)
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
  return fragment
}

const metricsFacts = (metrics: Readonly<ClientRollupMetrics>): HTMLDListElement => {
  const facts = element('dl', 'report-facts report-rollup-facts')
  facts.append(
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
const renderContractorCost = (
  report: Readonly<ContractorCostReport>,
): DocumentFragment => {
  const fragment = document.createDocumentFragment()
  fragment.append(
    reportHeading(
      'Contractor cost',
      `${report.from} through ${report.to} · everybody who tracked time`,
    ),
  )
  if (report.rows.length === 0) {
    fragment.append(
      textElement('p', 'Nobody tracked time in this period.', 'report-empty'),
    )
    return fragment
  }
  const byCurrency = new Map<string, ContractorCostRow[]>()
  for (const row of report.rows) {
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
    for (const label of ['Person', 'Total hours', 'Cost']) {
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
        cost.textContent = formatReportMoney(row.cost_cents, currency)
      }
      const line = element('tr')
      line.append(person, textElement('td', formatReportHours(row.rounded_seconds)), cost)
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
      textElement('td', formatReportHours(seconds)),
      textElement(
        'td',
        cents === null ? 'Not costed' : formatReportMoney(cents, currency),
      ),
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
  const catalogInput = required<HTMLSelectElement>('[data-report-catalog]')
  const clientField = required<HTMLElement>('[data-report-client-field]')
  const clientLabel = required<HTMLElement>('[data-report-client-label]')
  const clientInput = required<HTMLSelectElement>('[data-report-client]')
  const projectField = required<HTMLElement>('[data-report-project-field]')
  const projectInput = required<HTMLSelectElement>('[data-report-project]')
  const run = required<HTMLButtonElement>('[data-report-run]')
  const retry = required<HTMLButtonElement>('[data-report-retry]')
  const status = required<HTMLElement>('[data-report-status]')
  const results = required<HTMLElement>('[data-report-results]')
  page.hidden = !reportsPage

  let session: ActiveSession | null = null
  let kind: ReportKind = 'uninvoiced'
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
  let pending = false
  let retryAction: (() => void) | null = null
  let queuedLocationFilters: ReportFilters | null = null

  const currentSession = (): ActiveSession | null =>
    session === null || session.signal.aborted ? null : session

  const setPending = (value: boolean): void => {
    pending = value
    run.disabled = value
    period.setDisabled(value)
    catalogInput.disabled = value
    clientInput.disabled = value
    projectInput.disabled = value
    if (value) results.setAttribute('aria-busy', 'true')
    else results.removeAttribute('aria-busy')
  }

  const clearReportPresentation = (): void => {
    setPending(false)
    retryAction = null
    retry.hidden = true
    results.replaceChildren()
  }

  const selectedId = (input: HTMLSelectElement): number | null => {
    const value = Number(input.value)
    return Number.isSafeInteger(value) && value > 0 ? value : null
  }

  const filtersFromForm = (): ReportFilters => ({
    kind,
    ...period.range(),
    clientId: selectedId(clientInput),
    projectId: selectedId(projectInput),
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
      anchor.href = reportFiltersUrl({ ...filters, kind: tabKind })
    }
  }

  const updateVisibleFilters = (): void => {
    // My hours has no client picker: the report is the acting user's own rows,
    // narrowed by project or not at all, and a client control would suggest a
    // second axis the endpoint does not take. Contractor cost has neither: it
    // takes a range alone, and a picker it would ignore is worse than no picker.
    clientField.hidden =
      kind === 'project-budget' || kind === 'my-hours' || kind === 'contractor-cost'
    projectField.hidden = kind === 'client-rollup' || kind === 'contractor-cost'
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

  const renderReport = (
    filters: Readonly<ReportFilters>,
    report:
      | UninvoicedReport
      | ClientRollupReport
      | ProjectBudgetReport
      | MyHoursReport
      | ContractorCostReport,
  ): void => {
    if (filters.kind === 'my-hours') {
      results.replaceChildren(renderMyHours(report as MyHoursReport))
    } else if (filters.kind === 'uninvoiced') {
      results.replaceChildren(renderUninvoiced(report as UninvoicedReport))
    } else if (filters.kind === 'contractor-cost') {
      results.replaceChildren(renderContractorCost(report as ContractorCostReport))
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
          : 'Your profile does not have access to this financial report.'
      return
    }
    if (
      api.getUninvoicedReport === undefined ||
      api.getClientRollupReport === undefined ||
      api.getProjectBudgetReport === undefined ||
      api.getMyHoursReport === undefined ||
      api.getContractorCostReport === undefined
    ) {
      clearReportPresentation()
      status.textContent = 'Reports are unavailable in this build.'
      return
    }
    syncKindHrefs(filters)
    if (updateUrl) globalThis.history.pushState(null, '', reportFiltersUrl(filters))
    setPending(true)
    retry.hidden = true
    retryAction = null
    results.replaceChildren()
    status.textContent = 'Loading report…'
    try {
      const range = { from: filters.from, to: filters.to }
      const report =
        filters.kind === 'my-hours'
        ? await api.getMyHoursReport(
            {
              ...range,
              ...(filters.projectId === null ? {} : { project_id: filters.projectId }),
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
    const filters = reportFiltersFromUrl(
      new URL(globalThis.location.href),
      localToday(),
      canReadFinancialReports(active.identity.profile),
    )
    setKind(presentedKind(filters.kind, active.identity))
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
    void loadReport(filtersFromForm(), true)
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
      catalogFilter = 'active'
      pending = false
      retryAction = null
      queuedLocationFilters = null
      catalogInput.value = 'active'
      period.setDisabled(false)
      catalogInput.disabled = false
      clientInput.disabled = false
      projectInput.disabled = false
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
      const initial = reportFiltersFromUrl(
        new URL(globalThis.location.href),
        localToday(),
        canReadFinancialReports(identity.profile),
      )
      setKind(presentedKind(initial.kind, identity))
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
