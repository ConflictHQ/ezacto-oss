import {
  EzactoApiError,
  type ClientRollupMetrics,
  type ClientRollupReport,
  type GeneralResource,
  type ProjectBudgetReport,
  type UninvoicedReport,
  type Whoami,
} from '@ezacto/client'
import {
  canReadFinancialReports,
  formatReportCents,
  formatReportHours,
  formatReportMoney,
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

const reportHeading = (title: string, detail: string): HTMLElement => {
  const header = element('header', 'report-result-heading')
  header.append(textElement('h2', title, 'report-result-title'), textElement('p', detail))
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

const renderClientRollup = (report: Readonly<ClientRollupReport>): DocumentFragment => {
  const fragment = document.createDocumentFragment()
  fragment.append(
    reportHeading('Client rollup', `${report.from} through ${report.to} · root client #${report.root_client_id}`),
  )
  if (report.nodes.length === 0) {
    fragment.append(textElement('p', 'No clients were found in this hierarchy.', 'report-empty'))
    return fragment
  }
  const names = new Map(report.nodes.map((node) => [node.client_id, node.name]))
  const list = element('ol', 'report-client-tree')
  for (const node of report.nodes) {
    const item = element('li', 'report-client-node')
    item.style.setProperty('--report-depth', String(node.depth))
    const header = element('header')
    const identity = element('div')
    identity.append(textElement('h3', node.name))
    identity.append(
      textElement(
        'p',
        node.parent_client_id === null
          ? `Root client · client #${node.client_id}`
          : `Child of ${names.get(node.parent_client_id) ?? `client #${node.parent_client_id}`} · client #${node.client_id}`,
      ),
    )
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

const sourceLabel = (source: string, id: number): string => {
  if (source === 'task_assignment') return `Task assignment #${id}`
  if (source === 'user_assignment') return `User assignment #${id}`
  return `Project #${id}`
}

const renderProjectBudget = (
  report: Readonly<ProjectBudgetReport>,
): DocumentFragment => {
  const fragment = document.createDocumentFragment()
  const heading = reportHeading(
    'Project budget',
    `${report.from} through ${report.to} · project #${report.project_id}`,
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
      textElement('h3', sourceLabel(grain.source, grain.source_id)),
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
  const kindInput = required<HTMLSelectElement>('[data-report-kind]')
  const fromInput = required<HTMLInputElement>('[data-report-from]')
  const toInput = required<HTMLInputElement>('[data-report-to]')
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
  let clients: readonly GeneralResource[] = []
  let projects: readonly GeneralResource[] = []
  let pending = false
  let retryAction: (() => void) | null = null
  let queuedLocationFilters: ReportFilters | null = null

  const currentSession = (): ActiveSession | null =>
    session === null || session.signal.aborted ? null : session

  const setPending = (value: boolean): void => {
    pending = value
    run.disabled = value
    kindInput.disabled = value
    fromInput.disabled = value
    toInput.disabled = value
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
    kind: kindInput.value as ReportKind,
    from: fromInput.value,
    to: toInput.value,
    clientId: selectedId(clientInput),
    projectId: selectedId(projectInput),
  })

  const updateVisibleFilters = (): void => {
    const kind = kindInput.value as ReportKind
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

  const populateCatalog = (filters: Readonly<ReportFilters>): void => {
    const optional = (label: string): HTMLOptionElement => {
      const item = document.createElement('option')
      item.value = ''
      item.textContent = label
      return item
    }
    clientInput.replaceChildren(optional('All clients'), ...clients.map(option))
    projectInput.replaceChildren(optional('All projects'), ...projects.map(option))
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
      results.replaceChildren(renderClientRollup(report as ClientRollupReport))
    } else {
      results.replaceChildren(
        renderProjectBudget(report as ProjectBudgetReport),
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
    kindInput.value = filters.kind
    fromInput.value = filters.from
    toInput.value = filters.to
    populateCatalog(filters)
    updateVisibleFilters()
    void loadReport(filters, false)
  }

  kindInput.addEventListener('change', updateVisibleFilters)
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
      pending = false
      retryAction = null
      queuedLocationFilters = null
      kindInput.disabled = false
      fromInput.disabled = false
      toInput.disabled = false
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
          status.textContent = 'Sign in to view reports.'
        },
        { once: true },
      )
      const initial = reportFiltersFromUrl(
        new URL(globalThis.location.href),
        localToday(),
        canReadFinancialReports(identity.profile),
      )
      kindInput.value = initial.kind
      fromInput.value = initial.from
      toInput.value = initial.to
      updateVisibleFilters()
      const financialOptions = [
        kindInput.querySelector<HTMLOptionElement>('option[value="uninvoiced"]'),
        kindInput.querySelector<HTMLOptionElement>('option[value="client-rollup"]'),
      ]
      for (const item of financialOptions) {
        if (item !== null) item.disabled = !canReadFinancialReports(identity.profile)
      }
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
          const [loadedClients, loadedProjects] = await Promise.all([
            collect((cursor) => api.listReportClients!(cursor, signal), signal),
            collect((cursor) => api.listReportProjects!(cursor, signal), signal),
          ])
          if (currentSession() !== active) return
          clients = loadedClients
          projects = loadedProjects
          const next = queuedLocationFilters ?? initial
          queuedLocationFilters = null
          kindInput.value = next.kind
          fromInput.value = next.from
          toInput.value = next.to
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
