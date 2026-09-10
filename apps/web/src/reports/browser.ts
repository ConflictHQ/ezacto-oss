import {
  EzactoApiError,
  type ClientRollupMetrics,
  type ClientRollupReport,
  type GeneralResource,
  type ProjectBudgetReport,
  type UninvoicedReport,
  type Whoami,
} from '@ezacto/client'
import { createPeriodControl } from '../components/period.js'
import {
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

const fact = (term: string, detail: string): HTMLDivElement => {
  const wrapper = element('div')
  wrapper.append(textElement('dt', term), textElement('dd', detail))
  return wrapper
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
    header.append(textElement('h3', total.currency), textElement('strong', formatReportMoney(total.total_cents, total.currency)))
    const facts = element('dl', 'report-facts')
    facts.append(
      fact('Tracked time', formatReportHours(total.rounded_seconds)),
      fact('Time amount', formatReportMoney(total.time_cents, total.currency)),
      fact('Expense amount', formatReportMoney(total.expense_cents, total.currency)),
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
        textElement('td', formatReportMoney(currency.expense_cents, currency.currency)),
        textElement('td', formatReportMoney(currency.uninvoiced_total_cents, currency.currency)),
        textElement('td', formatReportMoney(currency.money_budget_cents, currency.currency)),
        textElement('td', formatReportMoney(currency.cost_cents, currency.currency)),
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
        fact('Budget', formatReportCents(grain.budget_cents)),
        fact('Spent', formatReportCents(grain.spent_cents)),
        fact('Remaining', formatReportCents(grain.remaining_cents)),
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
  const presentedKind = (requested: ReportKind, financial: boolean): ReportKind =>
    financial || requested === 'project-budget' ? requested : 'project-budget'

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
    clientField.hidden = kind === 'project-budget'
    projectField.hidden = kind === 'client-rollup'
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
    report: UninvoicedReport | ClientRollupReport | ProjectBudgetReport,
  ): void => {
    if (filters.kind === 'uninvoiced') {
      results.replaceChildren(renderUninvoiced(report as UninvoicedReport))
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
    if (filters.kind !== 'project-budget' && !canReadFinancialReports(active.identity.profile)) {
      clearReportPresentation()
      status.textContent = 'Your profile does not have access to this financial report.'
      return
    }
    if (
      api.getUninvoicedReport === undefined ||
      api.getClientRollupReport === undefined ||
      api.getProjectBudgetReport === undefined
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
        filters.kind === 'uninvoiced'
          ? await api.getUninvoicedReport(
              {
                ...range,
                ...(filters.clientId === null ? {} : { client_id: filters.clientId }),
                ...(filters.projectId === null ? {} : { project_id: filters.projectId }),
              },
              active.signal,
            )
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
    setKind(presentedKind(filters.kind, canReadFinancialReports(active.identity.profile)))
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
      const financial = canReadFinancialReports(identity.profile)
      setKind(presentedKind(initial.kind, financial))
      period.setRange(initial)
      updateVisibleFilters()
      // A kind this profile cannot read leaves the strip rather than sitting in
      // it refusing to work: a disabled control that gives no reason is worse
      // than an absent one. The tabs are re-hung rather than destroyed so a
      // second session in the same document gets the strip its profile earns.
      kindStrip?.replaceChildren(
        ...[...kindTabs]
          .filter(([tabKind]) => financial || tabKind === 'project-budget')
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
          setKind(presentedKind(next.kind, financial))
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
