import { EzactoApiError, type Attachment, type GeneralResource, type Whoami } from '@ezacto/client'

import { renderDataTable } from '../components/data-table.js'
import { localDate } from '../shell/model.js'
import {
  projectBoolean,
  projectCapabilities,
  projectClientLabel,
  projectCurrency,
  projectDisplayName,
  projectEnumLabel,
  projectHours,
  projectIdFromPathname,
  projectIsActive,
  projectMoney,
  projectNumber,
  projectText,
  taskLabel,
  type ProjectBudgetSummary,
  type ProjectCapabilities,
  type ProjectDirectoryApi,
  type ProjectDirectoryPage,
} from './model.js'

const required = <ElementType extends Element>(selector: string): ElementType => {
  const element = document.querySelector<ElementType>(selector)
  if (element === null) throw new Error(`project directory element missing: ${selector}`)
  return element
}

const messageFor = (error: unknown): string => {
  if (error instanceof EzactoApiError && typeof error.body === 'object' && error.body !== null) {
    const detail = Reflect.get(error.body, 'error')
    if (typeof detail === 'object' && detail !== null) {
      const fields = Reflect.get(detail, 'fields')
      if (Array.isArray(fields)) {
        const item = fields.find(
          (candidate) =>
            typeof candidate === 'object' &&
            candidate !== null &&
            typeof Reflect.get(candidate, 'message') === 'string',
        )
        if (item !== undefined) return String(Reflect.get(item, 'message'))
      }
      const message = Reflect.get(detail, 'message')
      if (typeof message === 'string' && message.trim() !== '') return message
    }
  }
  return error instanceof Error ? error.message : 'The request could not be completed.'
}

const collect = async (
  load: (cursor?: string) => Promise<ProjectDirectoryPage>,
  signal: AbortSignal,
): Promise<GeneralResource[]> => {
  const resources: GeneralResource[] = []
  let cursor: string | undefined
  do {
    signal.throwIfAborted()
    const page = await load(cursor)
    resources.push(...page.data)
    cursor = page.page.next_cursor ?? undefined
  } while (cursor !== undefined)
  return resources
}

const label = (text: string, control: HTMLElement): HTMLLabelElement => {
  const result = document.createElement('label')
  control.setAttribute('aria-label', text)
  result.append(document.createTextNode(text), control)
  return result
}

const input = (
  name: string,
  options: Partial<Pick<HTMLInputElement, 'type' | 'required' | 'min' | 'max' | 'step' | 'placeholder'>> = {},
): HTMLInputElement => {
  const result = document.createElement('input')
  result.name = name
  Object.assign(result, options)
  return result
}

const select = (
  name: string,
  values: readonly (readonly [string, string])[],
): HTMLSelectElement => {
  const result = document.createElement('select')
  result.name = name
  result.replaceChildren(
    ...values.map(([value, text]) => {
      const item = document.createElement('option')
      item.value = value
      item.textContent = text
      return item
    }),
  )
  return result
}

const checkbox = (name: string, text: string): HTMLLabelElement => {
  const control = input(name, { type: 'checkbox' })
  const result = document.createElement('label')
  result.className = 'project-check'
  result.append(control, document.createTextNode(text))
  return result
}

const pair = (...children: HTMLElement[]): HTMLDivElement => {
  const result = document.createElement('div')
  result.className = 'project-form-pair'
  result.append(...children)
  return result
}

const formField = (
  form: HTMLFormElement,
  name: string,
): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement => {
  const result = form.elements.namedItem(name)
  if (
    !(result instanceof HTMLInputElement) &&
    !(result instanceof HTMLTextAreaElement) &&
    !(result instanceof HTMLSelectElement)
  ) {
    throw new Error(`project form field missing: ${name}`)
  }
  return result
}

const formCheckbox = (form: HTMLFormElement, name: string): HTMLInputElement => {
  const result = formField(form, name)
  if (!(result instanceof HTMLInputElement) || result.type !== 'checkbox') {
    throw new Error(`project checkbox missing: ${name}`)
  }
  return result
}

const optionalText = (data: FormData, name: string): string | null => {
  const raw = data.get(name)
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null
}

const requiredId = (data: FormData, name: string): number => {
  const raw = data.get(name)
  const value = typeof raw === 'string' ? Number(raw) : Number.NaN
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Choose a valid ${name}.`)
  return value
}

const nonnegativeNumber = (data: FormData, name: string): number | null => {
  const raw = data.get(name)
  if (typeof raw !== 'string' || raw === '') return null
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be zero or greater.`)
  return value
}

const optionalPositiveInteger = (data: FormData, name: string, maximum: number): number | null => {
  const raw = data.get(name)
  if (typeof raw !== 'string' || raw === '') return null
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be a whole number between 1 and ${maximum}.`)
  }
  return value
}

const moneyCents = (data: FormData, name: string): number | null => {
  const raw = data.get(name)
  if (typeof raw !== 'string' || raw === '') return null
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/u.test(raw)) {
    throw new Error(`${name} must be a non-negative amount with no more than two decimals.`)
  }
  const [whole, fraction = ''] = raw.split('.')
  const cents = Number(BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0')))
  if (!Number.isSafeInteger(cents)) throw new Error(`${name} is too large.`)
  return cents
}

const hoursSeconds = (data: FormData, name: string): number | null => {
  const hours = nonnegativeNumber(data, name)
  if (hours === null) return null
  const seconds = hours * 3_600
  if (!Number.isSafeInteger(seconds)) {
    throw new Error(`${name} must resolve to a whole number of seconds.`)
  }
  return seconds
}

const confirmedDialogSubmit = (event: SubmitEvent): boolean =>
  event.submitter instanceof HTMLButtonElement && event.submitter.value === 'confirm'

const centsValue = (resource: GeneralResource | null, field: string): string => {
  const value = resource === null ? null : projectNumber(resource, field)
  return value === null ? '' : String(value / 100)
}

const hoursValue = (resource: GeneralResource | null, field: string): string => {
  const value = resource === null ? null : projectNumber(resource, field)
  return value === null ? '' : String(value / 3_600)
}

const valueFor = (resource: GeneralResource | null, field: string): string => {
  const value = resource?.[field]
  return value === null || value === undefined ? '' : String(value)
}

interface ActiveSession {
  readonly identity: Whoami
  readonly capabilities: ProjectCapabilities
  readonly signal: AbortSignal
  readonly onSessionFailure: (error: unknown) => boolean
}

export interface ProjectDirectoryController {
  activate(
    identity: Whoami,
    signal: AbortSignal,
    onSessionFailure: (error: unknown) => boolean,
  ): Promise<void>
}

export const createProjectDirectoryController = (
  api: Partial<ProjectDirectoryApi>,
): ProjectDirectoryController => {
  const listPage = document.documentElement.dataset.appView === 'project-list'
  const detailPage = document.documentElement.dataset.appView === 'project-detail'
  const listPageElement = required<HTMLElement>('[data-project-list-page]')
  const detailPageElement = required<HTMLElement>('[data-project-detail-page]')
  const listStatus = required<HTMLElement>('[data-project-list-status]')
  const listQuality = required<HTMLElement>('[data-project-quality]')
  const listElement = required<HTMLElement>('[data-project-list]')
  const listRetry = required<HTMLButtonElement>('[data-project-list-retry]')
  const clientFilter = required<HTMLSelectElement>('[data-project-client-filter]')
  const search = required<HTMLInputElement>('[data-project-search]')
  const detailStatus = required<HTMLElement>('[data-project-detail-status]')
  const detail = required<HTMLElement>('[data-project-detail]')
  const facts = required<HTMLElement>('[data-project-facts]')
  const taskStatus = required<HTMLElement>('[data-project-tasks-status]')
  const assignmentList = required<HTMLUListElement>('[data-project-task-assignments]')
  const attachmentForm = required<HTMLFormElement>('[data-project-attachment-form]')
  const attachmentSubmit = required<HTMLButtonElement>('[data-project-attachment-submit]')
  const attachmentStatus = required<HTMLElement>('[data-project-attachment-status]')
  const attachmentList = required<HTMLUListElement>('[data-project-attachments]')
  const detailRetry = required<HTMLButtonElement>('[data-project-detail-retry]')
  const projectDialog = required<HTMLDialogElement>('[data-project-form-dialog]')
  const projectForm = required<HTMLFormElement>('[data-project-form]')
  const projectFormBody = required<HTMLElement>('[data-project-form-body]')
  const projectFormTitle = required<HTMLElement>('[data-project-form-title]')
  const projectFormResult = required<HTMLElement>('[data-project-form-result]')
  const projectFormSubmit = required<HTMLButtonElement>('[data-project-form-submit]')
  const assignmentDialog = required<HTMLDialogElement>('[data-task-assignment-dialog]')
  const assignmentForm = required<HTMLFormElement>('[data-task-assignment-form]')
  const assignmentFormBody = required<HTMLElement>('[data-task-assignment-form-body]')
  const assignmentFormTitle = required<HTMLElement>('[data-task-assignment-title]')
  const assignmentFormResult = required<HTMLElement>('[data-task-assignment-form-result]')
  const assignmentFormSubmit = required<HTMLButtonElement>('[data-task-assignment-form-submit]')
  const archiveDialog = required<HTMLDialogElement>('[data-project-archive-dialog]')
  const archiveForm = required<HTMLFormElement>('[data-project-archive-form]')
  const archiveResult = required<HTMLElement>('[data-project-archive-result]')
  const assignmentArchiveDialog = required<HTMLDialogElement>(
    '[data-task-assignment-archive-dialog]',
  )
  const assignmentArchiveForm = required<HTMLFormElement>(
    '[data-task-assignment-archive-form]',
  )
  const assignmentArchiveResult = required<HTMLElement>(
    '[data-task-assignment-archive-result]',
  )

  listPageElement.hidden = !listPage
  detailPageElement.hidden = !detailPage

  let session: ActiveSession | null = null
  let clients: readonly GeneralResource[] = []
  let budgets = new Map<number, ProjectBudgetSummary>()
  let projects: readonly GeneralResource[] = []
  let tasks: readonly GeneralResource[] = []
  let assignments: readonly GeneralResource[] = []
  let attachments: readonly Attachment[] = []
  let currentProject: GeneralResource | null = null
  let projectFilter: 'active' | 'all' = 'active'
  let editingProjectId: number | null = null
  let editingAssignmentId: number | null = null
  let archivingAssignmentId: number | null = null
  let mutationPending = false
  let attachmentCommandId: string | null = null

  const currentSession = (): ActiveSession | null =>
    session === null || session.signal.aborted ? null : session

  const syncMutationActions = (): void => {
    const writesEnabled = currentSession()?.capabilities.canWrite === true
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      '[data-project-mutation-action]',
    )) {
      button.disabled = !writesEnabled || mutationPending
    }
  }

  const setMutationPending = (pending: boolean): void => {
    mutationPending = pending
    syncMutationActions()
  }

  const handleFailure = (error: unknown): boolean => {
    const active = currentSession()
    return active !== null && active.onSessionFailure(error)
  }

  const closeDialogs = (): void => {
    for (const dialog of [projectDialog, assignmentDialog, archiveDialog, assignmentArchiveDialog]) {
      if (dialog.open) dialog.close()
    }
  }

  const resetMutationState = (): void => {
    setMutationPending(false)
    editingProjectId = null
    editingAssignmentId = null
    archivingAssignmentId = null
    attachmentCommandId = null
    projectFormSubmit.disabled = false
    assignmentFormSubmit.disabled = false
    attachmentSubmit.disabled = false
    required<HTMLButtonElement>('[data-project-archive-confirm]').disabled = false
    required<HTMLButtonElement>('[data-task-assignment-archive-confirm]').disabled = false
  }

  const clearPrivatePresentation = (): void => {
    clients = []
    projects = []
    tasks = []
    assignments = []
    attachments = []
    currentProject = null
    listElement.replaceChildren()
    facts.replaceChildren()
    assignmentList.replaceChildren()
    attachmentList.replaceChildren()
    projectFormBody.replaceChildren()
    assignmentFormBody.replaceChildren()
    const allClients = document.createElement('option')
    allClients.value = ''
    allClients.textContent = 'All clients'
    clientFilter.replaceChildren(allClients)
    search.value = ''
    detail.hidden = true
    listStatus.textContent = 'Loading projects…'
    detailStatus.textContent = 'Loading project…'
    taskStatus.textContent = ''
    attachmentStatus.textContent = ''
    listRetry.hidden = true
    detailRetry.hidden = true
    attachmentForm.hidden = true
    closeDialogs()
  }

  const enableWrites = (enabled: boolean): void => {
    for (const element of document.querySelectorAll<HTMLElement>('[data-project-write]')) {
      element.hidden = !enabled
      if (element instanceof HTMLButtonElement) {
        element.disabled = !enabled ||
          (mutationPending && element.hasAttribute('data-project-mutation-action'))
      }
    }
  }

  const clientOption = (client: GeneralResource): HTMLOptionElement => {
    const item = document.createElement('option')
    item.value = String(client.id)
    item.textContent = `${projectText(client, 'name') ?? `Client #${client.id}`}${projectIsActive(client) ? '' : ' (archived)'}`
    return item
  }

  const allClientsOption = (): HTMLOptionElement => {
    const item = document.createElement('option')
    item.value = ''
    item.textContent = 'All clients'
    return item
  }

  const populateClientFilter = (): void => {
    const selection = clientFilter.value
    clientFilter.replaceChildren(
      allClientsOption(),
      ...clients.map(clientOption),
    )
    clientFilter.value = clients.some((client) => String(client.id) === selection)
      ? selection
      : ''
  }

  const renderList = (): void => {
    const selectedClient = Number(clientFilter.value)
    // Every project and its client are already resident -- the list collects
    // both before it renders -- so finding one is a match over what is in hand
    // rather than a request. The name carries the code, and the client band is
    // as often what you remember, so both are searched.
    const wanted = search.value.trim().toLocaleLowerCase('en-US')
    const visible = projects.filter(
      (project) =>
        (projectFilter === 'all' || projectIsActive(project)) &&
        (!Number.isSafeInteger(selectedClient) || selectedClient < 1 ||
          projectNumber(project, 'client_id') === selectedClient) &&
        `${projectDisplayName(project)} ${projectClientLabel(project, clients)}`
          .toLocaleLowerCase('en-US')
          .includes(wanted),
    )
    if (visible.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'project-list-empty'
      empty.textContent =
        projects.length === 0
          ? 'No projects have been created or imported yet.'
          : 'No projects match these filters.'
      listElement.replaceChildren(empty)
      listStatus.textContent = empty.textContent
      return
    }
    // Two clients may share a display name, so the id joins the sort key: it
    // keeps same-named clients contiguous while still separating them, which is
    // what the band below groups on.
    const clientSortKey = (project: Readonly<GeneralResource>): string =>
      `${projectClientLabel(project, clients)}\u0000${projectNumber(project, 'client_id') ?? ''}`
    visible.sort((left, right) =>
      `${clientSortKey(left)}\u0000${projectDisplayName(left)}`.localeCompare(
        `${clientSortKey(right)}\u0000${projectDisplayName(right)}`,
        'en-US',
        { sensitivity: 'base' },
      ),
    )
    // Spent, Remaining and Costs come from the list-scoped rollup — one request
    // for the page rather than the one-per-row the per-project report would
    // have cost, which is why they were absent.
    const spentLabel = (project: Readonly<GeneralResource>): string => {
      const summary = budgets.get(project.id)
      if (summary === undefined) return '—'
      if (summary.unit === 'seconds') return projectHours(summary.spent_seconds ?? 0)
      if (summary.unit === 'cents' && summary.spent_cents !== undefined) {
        return projectMoney(summary.spent_cents, currencyFor(project))
      }
      return '—'
    }

    const remainingLabel = (project: Readonly<GeneralResource>): string => {
      const summary = budgets.get(project.id)
      if (summary === undefined) return '—'
      if (summary.unit === 'seconds') {
        return summary.remaining_seconds == null
          ? '—'
          : projectHours(summary.remaining_seconds)
      }
      return summary.remaining_cents == null
        ? '—'
        : projectMoney(summary.remaining_cents, currencyFor(project))
    }

    // The server resolves this over a join where the client row is guaranteed
    // present. Deriving it here fell back to USD when the client was missing
    // from the payload, which renders another currency's money as dollars and
    // says nothing about having guessed.
    const currencyFor = (project: Readonly<GeneralResource>): string =>
      budgets.get(project.id)?.currency ?? projectCurrency(project, clients)

    const costVisible = [...budgets.values()].some(
      (summary) => summary.cost_cents !== undefined,
    )

    const costLabel = (project: Readonly<GeneralResource>): string => {
      const cents = budgets.get(project.id)?.cost_cents
      // Absent rather than zero when a single project has no cost recorded. The
      // whole column is dropped when no project does -- see the columns below.
      return cents === undefined ? '—' : projectMoney(cents, currencyFor(project))
    }

    const budgetLabel = (project: Readonly<GeneralResource>): string => {
      const by = projectText(project, 'budget_by')
      const currency = currencyFor(project)
      if (by === 'project' || by === 'task' || by === 'person') {
        return projectHours(projectNumber(project, 'budget_seconds'))
      }
      if (by === 'project_cost') {
        return projectMoney(projectNumber(project, 'cost_budget_cents'), currency)
      }
      if (by === 'task_fees') return projectMoney(projectNumber(project, 'fee_cents'), currency)
      return '—'
    }

    const table = renderDataTable<Readonly<GeneralResource>>({
      caption: 'Projects',
      rows: visible,
      rowKey: (project) => String(project.id),
      // The client is the band, so it stops repeating on every row. Grouped on
      // the id rather than the name: the band carries a link, and two clients
      // that share a name would otherwise share a band pointing at whichever of
      // them happened to sort first.
      groupBy: (project) => String(projectNumber(project, 'client_id') ?? projectClientLabel(project, clients)),
      renderGroup: (project) => {
        const clientId = projectNumber(project, 'client_id')
        if (clientId === null) return projectClientLabel(project, clients)
        const link = document.createElement('a')
        link.href = `/clients/${clientId}`
        link.textContent = projectClientLabel(project, clients)
        return link
      },
      empty: 'No projects match this filter.',
      columns: [
        {
          key: 'name',
          label: 'Project',
          render: (project) => {
            const link = document.createElement('a')
            link.href = `/projects/${project.id}`
            link.textContent = projectDisplayName(project)
            return link
          },
        },
        {
          key: 'billing',
          label: 'Billing',
          render: (project) => projectEnumLabel(projectText(project, 'billing_method')),
        },
        { key: 'budget', label: 'Budget', numeric: true, render: budgetLabel },
        { key: 'spent', label: 'Spent', numeric: true, render: spentLabel },
        { key: 'remaining', label: 'Remaining', numeric: true, render: remainingLabel },
        // A viewer whose profile cannot see cost gets no cost_cents at all, on
        // any row. Rendering the column anyway put an em dash in every cell of
        // it, which reads as "no cost recorded" rather than "not yours to see"
        // -- and it costs a column of width on a table that wants it.
        ...(costVisible
          ? [{ key: 'costs', label: 'Costs', numeric: true, render: costLabel } as const]
          : []),
        {
          key: 'status',
          label: 'Status',
          render: (project) => {
            if (projectIsActive(project)) return 'Active'
            const pill = document.createElement('span')
            pill.className = 'project-status-pill'
            pill.textContent = 'Archived'
            return pill
          },
        },
      ],
    })
    listElement.replaceChildren(table)
    listStatus.textContent = `${visible.length} ${visible.length === 1 ? 'project' : 'projects'} shown.`
    // Money on this list is a sum over tracked rows, and an entry with no rate
    // contributes nothing to it. Saying how many were skipped is the difference
    // between a total that is wrong and a total that is short by a stated
    // amount -- the first is a bug report, the second is a task.
    const unpriced = [...budgets.values()].reduce(
      (total, summary) => total + (summary.unpriced_entry_count ?? 0),
      0,
    )
    listQuality.replaceChildren()
    listQuality.hidden = unpriced === 0
    if (unpriced > 0) {
      const note = document.createElement('p')
      note.className = 'data-quality'
      note.textContent =
        unpriced === 1
          ? '1 tracked entry has no rate, so it is missing from these money totals.'
          : `${unpriced} tracked entries have no rate, so they are missing from these money totals.`
      listQuality.append(note)
    }
  }

  const fact = (term: string, description: string | Node): HTMLDivElement => {
    const row = document.createElement('div')
    const dt = document.createElement('dt')
    const dd = document.createElement('dd')
    dt.textContent = term
    dd.append(description)
    row.append(dt, dd)
    return row
  }

  const clientFact = (project: Readonly<GeneralResource>): HTMLDivElement => {
    const clientId = projectNumber(project, 'client_id')
    if (clientId === null) return fact('Client', projectClientLabel(project, clients))
    const link = document.createElement('a')
    link.href = `/clients/${clientId}`
    link.textContent = projectClientLabel(project, clients)
    return fact('Client', link)
  }

  const renderFacts = (): void => {
    const active = currentSession()
    if (currentProject === null || active === null) return
    const currency = projectCurrency(currentProject, clients)
    const rows = [
      fact('Status', projectIsActive(currentProject) ? 'Active' : 'Archived'),
      clientFact(currentProject),
      fact('Code', projectText(currentProject, 'code') ?? 'None'),
      fact('Billing method', projectEnumLabel(projectText(currentProject, 'billing_method'))),
      fact('Bill by', projectEnumLabel(projectText(currentProject, 'bill_by'))),
      ...(active.capabilities.canViewBillableMoney
        ? [
            fact('Hourly rate', projectMoney(projectNumber(currentProject, 'hourly_rate_cents'), currency)),
            fact('Fixed fee', projectMoney(projectNumber(currentProject, 'fee_cents'), currency)),
          ]
        : []),
      fact('Budget by', projectEnumLabel(projectText(currentProject, 'budget_by'))),
      fact('Hours budget', projectHours(projectNumber(currentProject, 'budget_seconds'))),
      ...(active.capabilities.canViewCostBudget
        ? [fact('Cost budget', projectMoney(projectNumber(currentProject, 'cost_budget_cents'), currency))]
        : []),
      fact('Monthly budget', projectBoolean(currentProject, 'budget_is_monthly') ? 'Yes' : 'No'),
      fact(
        'Cost budget includes expenses',
        projectBoolean(currentProject, 'cost_budget_include_expenses') ? 'Yes' : 'No',
      ),
      fact(
        'Over-budget notification',
        projectBoolean(currentProject, 'notify_when_over_budget')
          ? `${projectNumber(currentProject, 'over_budget_pct') ?? 0}%`
          : 'Off',
      ),
      fact('Budget visible to everyone', projectBoolean(currentProject, 'show_budget_to_all') ? 'Yes' : 'No'),
      fact('Report visibility', projectEnumLabel(projectText(currentProject, 'report_visibility'))),
      fact('Starts on', projectText(currentProject, 'starts_on') ?? 'Not set'),
      fact('Ends on', projectText(currentProject, 'ends_on') ?? 'Not set'),
      fact('Billing currency', projectText(currentProject, 'billing_currency') ?? 'Organization default'),
      fact(
        'Minimum time-entry note',
        projectNumber(currentProject, 'time_entry_notes_minimum_length') === null
          ? 'Organization default'
          : `${projectNumber(currentProject, 'time_entry_notes_minimum_length')} characters`,
      ),
      ...(active.capabilities.canViewNotes
        ? [fact('Admin notes', projectText(currentProject, 'notes') ?? 'None')]
        : []),
    ]
    facts.replaceChildren(...rows)
  }

  const renderAssignments = (): void => {
    const active = currentSession()
    if (active === null) return
    const currency = currentProject === null ? 'USD' : projectCurrency(currentProject, clients)
    if (assignments.length === 0) {
      const empty = document.createElement('li')
      empty.className = 'project-related-empty'
      empty.textContent = 'No tasks are assigned. Assign a task before tracking time.'
      assignmentList.replaceChildren(empty)
      taskStatus.textContent = empty.textContent
      return
    }
    assignmentList.replaceChildren(
      ...assignments.map((assignment) => {
        const item = document.createElement('li')
        item.className = 'project-task-card'
        item.dataset.taskAssignmentId = String(assignment.id)
        const details = document.createElement('div')
        const heading = document.createElement('strong')
        const taskId = projectNumber(assignment, 'task_id') ?? 0
        heading.textContent = taskLabel(taskId, tasks)
        const metadata = document.createElement('p')
        const parts = [
          assignment['is_active'] === false ? 'Archived' : 'Active',
          projectBoolean(assignment, 'billable') ? 'Billable' : 'Non-billable',
          `Budget ${projectHours(projectNumber(assignment, 'budget_seconds'))}`,
          ...(active.capabilities.canViewBillableMoney
            ? [`Rate ${projectMoney(projectNumber(assignment, 'hourly_rate_cents'), currency)}`]
            : []),
          ...(active.capabilities.canViewCostBudget
            ? [`Fee budget ${projectMoney(projectNumber(assignment, 'budget_cents'), currency)}`]
            : []),
        ]
        metadata.textContent = parts.join(' · ')
        details.append(heading, metadata)
        item.append(details)
        if (active.capabilities.canWrite) {
          const actions = document.createElement('div')
          const edit = document.createElement('button')
          edit.type = 'button'
          edit.dataset.projectMutationAction = ''
          edit.disabled = mutationPending
          edit.textContent = assignment['is_active'] === false ? 'Edit or reactivate' : 'Edit'
          edit.addEventListener('click', () => openAssignmentForm(assignment))
          actions.append(edit)
          if (assignment['is_active'] !== false) {
            const archive = document.createElement('button')
            archive.type = 'button'
            archive.dataset.projectMutationAction = ''
            archive.disabled = mutationPending
            archive.textContent = 'Archive'
            archive.addEventListener('click', () => {
              archivingAssignmentId = assignment.id
              assignmentArchiveResult.textContent = ''
              assignmentArchiveDialog.showModal()
            })
            actions.append(archive)
          }
          item.append(actions)
        }
        return item
      }),
    )
    taskStatus.textContent = `${assignments.length} ${assignments.length === 1 ? 'task assignment' : 'task assignments'}.`
  }

  const renderAttachments = (): void => {
    if (currentProject === null) return
    if (attachments.length === 0) {
      const empty = document.createElement('li')
      empty.className = 'project-related-empty'
      empty.textContent = 'No files are attached to this project.'
      attachmentList.replaceChildren(empty)
      return
    }
    attachmentList.replaceChildren(
      ...attachments.map((attachment) => {
        const item = document.createElement('li')
        const link = document.createElement('a')
        link.href = `/api/v1/projects/${currentProject!.id}/attachments/${attachment.id}/content`
        link.textContent = attachment.name
        link.download = attachment.name
        const size = document.createElement('span')
        size.textContent = new Intl.NumberFormat('en-US', {
          style: 'unit',
          unit: 'byte',
          unitDisplay: 'narrow',
          notation: attachment.byte_size >= 1_000_000 ? 'compact' : 'standard',
          maximumFractionDigits: 1,
        }).format(attachment.byte_size)
        item.append(link, size)
        return item
      }),
    )
  }

  const buildProjectForm = (project: GeneralResource | null): void => {
    const active = currentSession()
    if (active === null || !active.capabilities.canWrite) return
    const selectedClientId = project === null ? null : projectNumber(project, 'client_id')
    const client = select(
      'client_id',
      clients
        .filter(
          (candidate) =>
            projectIsActive(candidate) || selectedClientId === candidate.id,
        )
        .map((candidate) => [String(candidate.id), projectText(candidate, 'name') ?? `Client #${candidate.id}`]),
    )
    client.required = true
    const name = input('name', { required: true })
    name.maxLength = 255
    name.autocomplete = 'off'
    const code = input('code')
    code.maxLength = 255
    const billingMethod = select('billing_method', [
      ['non_billable', 'Non billable'],
      ['time_materials', 'Time and materials'],
      ['fixed_fee', 'Fixed fee'],
    ])
    const billBy = select('bill_by', [
      ['project', 'Project rate'],
      ['tasks', 'Task rates'],
      ['people', 'Person rates'],
      ['none', 'No rate'],
    ])
    const budgetBy = select('budget_by', [
      ['none', 'No budget'],
      ['project', 'Project hours'],
      ['project_cost', 'Project cost'],
      ['task', 'Task hours'],
      ['task_fees', 'Task fees'],
      ['person', 'Person hours'],
    ])
    const billingCurrency = input('billing_currency', { placeholder: 'Organization default' })
    billingCurrency.minLength = 3
    billingCurrency.maxLength = 3
    billingCurrency.pattern = '[A-Za-z]{3}'
    const budgetHours = input('budget_seconds', { type: 'number', min: '0', step: '0.01' })
    const overBudget = input('over_budget_pct', { type: 'number', min: '0', step: '0.01' })
    const starts = input('starts_on', { type: 'date' })
    const ends = input('ends_on', { type: 'date' })
    const noteMinimum = input('time_entry_notes_minimum_length', {
      type: 'number',
      min: '1',
      max: '10000',
      step: '1',
      placeholder: 'Organization default',
    })
    const reportVisibility = select('report_visibility', [
      ['managers', 'Managers'],
      ['everyone', 'Everyone'],
    ])
    const body: HTMLElement[] = [
      label('Client', client),
      pair(label('Name', name), label('Code', code)),
      pair(label('Billing method', billingMethod), label('Bill by', billBy)),
      ...(active.capabilities.canViewBillableMoney
        ? [
            pair(
              label('Hourly rate', input('hourly_rate_cents', { type: 'number', min: '0', step: '0.01' })),
              label('Fixed fee', input('fee_cents', { type: 'number', min: '0', step: '0.01' })),
            ),
          ]
        : []),
      pair(label('Budget by', budgetBy), label('Hours budget', budgetHours)),
      ...(active.capabilities.canViewCostBudget
        ? [
            label('Cost budget', input('cost_budget_cents', { type: 'number', min: '0', step: '0.01' })),
          ]
        : []),
      pair(label('Billing currency', billingCurrency), label('Report visibility', reportVisibility)),
      pair(label('Starts on', starts), label('Ends on', ends)),
      label('Minimum time-entry note length', noteMinimum),
      checkbox('budget_is_monthly', 'Reset the budget monthly'),
      checkbox('cost_budget_include_expenses', 'Include expenses in the cost budget'),
      pair(
        checkbox('notify_when_over_budget', 'Notify when over budget'),
        label('Notify at %', overBudget),
      ),
      checkbox('show_budget_to_all', 'Show the budget to everyone'),
    ]
    if (active.capabilities.canViewNotes) {
      const notes = document.createElement('textarea')
      notes.name = 'notes'
      notes.rows = 5
      notes.maxLength = 10_000
      body.push(label('Administrator notes', notes))
    }
    projectFormBody.replaceChildren(...body)
    if (project === null) {
      billingMethod.value = 'time_materials'
      billBy.value = 'project'
      budgetBy.value = 'none'
      reportVisibility.value = 'managers'
      return
    }
    for (const fieldName of [
      'client_id',
      'name',
      'code',
      'billing_method',
      'bill_by',
      'budget_by',
      'billing_currency',
      'starts_on',
      'ends_on',
      'time_entry_notes_minimum_length',
      'over_budget_pct',
      ...(active.capabilities.canViewNotes ? ['notes'] : []),
    ]) {
      formField(projectForm, fieldName).value = valueFor(project, fieldName)
    }
    formField(projectForm, 'budget_seconds').value = hoursValue(project, 'budget_seconds')
    if (active.capabilities.canViewBillableMoney) {
      formField(projectForm, 'hourly_rate_cents').value = centsValue(project, 'hourly_rate_cents')
      formField(projectForm, 'fee_cents').value = centsValue(project, 'fee_cents')
    }
    if (active.capabilities.canViewCostBudget) {
      formField(projectForm, 'cost_budget_cents').value = centsValue(project, 'cost_budget_cents')
    }
    for (const fieldName of [
      'budget_is_monthly',
      'cost_budget_include_expenses',
      'notify_when_over_budget',
      'show_budget_to_all',
    ]) {
      formCheckbox(projectForm, fieldName).checked = projectBoolean(project, fieldName)
    }
  }

  const openProjectForm = (project: GeneralResource | null): void => {
    const active = currentSession()
    if (active === null || !active.capabilities.canWrite || mutationPending) return
    editingProjectId = project?.id ?? null
    projectFormTitle.textContent = project === null ? 'Add project' : 'Edit project'
    projectFormSubmit.textContent = project === null ? 'Add project' : 'Save project'
    projectFormResult.textContent = ''
    buildProjectForm(project)
    projectDialog.showModal()
    formField(projectForm, project === null ? 'client_id' : 'name').focus()
  }

  const buildAssignmentForm = (assignment: GeneralResource | null): void => {
    const active = currentSession()
    if (active === null || !active.capabilities.canWrite) return
    let taskSelect: HTMLSelectElement | null = null
    if (assignment === null) {
      const assignedTaskIds = new Set(
        assignments.map((candidate) => projectNumber(candidate, 'task_id')),
      )
      taskSelect = select(
        'task_id',
        tasks
          .filter((task) => projectIsActive(task) && !assignedTaskIds.has(task.id))
          .map((task) => [String(task.id), projectText(task, 'name') ?? `Task #${task.id}`]),
      )
      taskSelect.required = true
      assignmentFormBody.append(label('Task', taskSelect))
    } else {
      const taskName = document.createElement('p')
      taskName.className = 'project-assignment-task-name'
      taskName.textContent = taskLabel(projectNumber(assignment, 'task_id') ?? 0, tasks)
      assignmentFormBody.append(taskName)
    }
    assignmentFormBody.append(
      checkbox('is_active', 'Active and available for new time'),
      checkbox('billable', 'Billable by default'),
      label('Hours budget', input('budget_seconds', { type: 'number', min: '0', step: '0.01' })),
    )
    if (active.capabilities.canViewBillableMoney) {
      assignmentFormBody.append(
        label('Task hourly rate', input('hourly_rate_cents', { type: 'number', min: '0', step: '0.01' })),
      )
    }
    if (active.capabilities.canViewCostBudget) {
      assignmentFormBody.append(
        label('Task fee budget', input('budget_cents', { type: 'number', min: '0', step: '0.01' })),
      )
    }
    formCheckbox(assignmentForm, 'is_active').checked = assignment?.['is_active'] !== false
    const billable = formCheckbox(assignmentForm, 'billable')
    const applyTaskDefault = (): void => {
      const taskId = Number(taskSelect?.value)
      const selectedTask = tasks.find((candidate) => candidate.id === taskId)
      billable.checked = selectedTask !== undefined && projectBoolean(selectedTask, 'billable_by_default')
    }
    if (assignment === null) {
      applyTaskDefault()
      taskSelect?.addEventListener('change', applyTaskDefault)
    } else {
      billable.checked = assignment['billable'] !== false
    }
    formField(assignmentForm, 'budget_seconds').value = hoursValue(assignment, 'budget_seconds')
    if (active.capabilities.canViewBillableMoney) {
      formField(assignmentForm, 'hourly_rate_cents').value = centsValue(assignment, 'hourly_rate_cents')
    }
    if (active.capabilities.canViewCostBudget) {
      formField(assignmentForm, 'budget_cents').value = centsValue(assignment, 'budget_cents')
    }
  }

  const openAssignmentForm = (assignment: GeneralResource | null): void => {
    const active = currentSession()
    if (
      active === null ||
      !active.capabilities.canWrite ||
      currentProject === null ||
      mutationPending
    ) return
    editingAssignmentId = assignment?.id ?? null
    assignmentFormBody.replaceChildren()
    assignmentFormTitle.textContent = assignment === null ? 'Assign task' : 'Edit task assignment'
    assignmentFormSubmit.textContent = assignment === null ? 'Assign task' : 'Save assignment'
    assignmentFormResult.textContent = ''
    buildAssignmentForm(assignment)
    const taskControl = assignmentForm.elements.namedItem('task_id')
    const available =
      assignment !== null ||
      (taskControl instanceof HTMLSelectElement && taskControl.options.length > 0)
    assignmentFormSubmit.disabled = !available
    if (!available) {
      assignmentFormResult.textContent = 'Every active task is already assigned to this project.'
    }
    assignmentDialog.showModal()
    formField(assignmentForm, assignment === null ? 'task_id' : 'billable').focus()
  }

  const projectPayload = (): Record<string, unknown> => {
    const active = currentSession()
    if (active === null) throw new Error('Sign in is required.')
    const data = new FormData(projectForm)
    const payload: Record<string, unknown> = {
      client_id: requiredId(data, 'client_id'),
      name: optionalText(data, 'name'),
      code: optionalText(data, 'code') ?? '',
      billing_method: String(data.get('billing_method')),
      bill_by: String(data.get('bill_by')),
      budget_by: String(data.get('budget_by')),
      budget_seconds: hoursSeconds(data, 'budget_seconds'),
      budget_is_monthly: data.has('budget_is_monthly'),
      cost_budget_include_expenses: data.has('cost_budget_include_expenses'),
      notify_when_over_budget: data.has('notify_when_over_budget'),
      over_budget_pct: nonnegativeNumber(data, 'over_budget_pct'),
      show_budget_to_all: data.has('show_budget_to_all'),
      report_visibility: String(data.get('report_visibility')),
      starts_on: optionalText(data, 'starts_on'),
      ends_on: optionalText(data, 'ends_on'),
      billing_currency: optionalText(data, 'billing_currency')?.toLocaleUpperCase('en-US') ?? null,
      time_entry_notes_minimum_length: optionalPositiveInteger(
        data,
        'time_entry_notes_minimum_length',
        10_000,
      ),
    }
    if (payload.name === null) throw new Error('Project name is required.')
    if (active.capabilities.canViewBillableMoney) {
      payload.hourly_rate_cents = moneyCents(data, 'hourly_rate_cents')
      payload.fee_cents = moneyCents(data, 'fee_cents')
    }
    if (active.capabilities.canViewCostBudget) {
      payload.cost_budget_cents = moneyCents(data, 'cost_budget_cents')
    }
    if (active.capabilities.canViewNotes) payload.notes = optionalText(data, 'notes')
    return payload
  }

  const assignmentPayload = (): Record<string, unknown> => {
    const active = currentSession()
    if (active === null || currentProject === null) throw new Error('Sign in is required.')
    const data = new FormData(assignmentForm)
    const payload: Record<string, unknown> = {
      is_active: data.has('is_active'),
      billable: data.has('billable'),
      budget_seconds: hoursSeconds(data, 'budget_seconds'),
    }
    if (editingAssignmentId === null) {
      payload.project_id = currentProject.id
      payload.task_id = requiredId(data, 'task_id')
    }
    if (active.capabilities.canViewBillableMoney) {
      payload.hourly_rate_cents = moneyCents(data, 'hourly_rate_cents')
    }
    if (active.capabilities.canViewCostBudget) {
      payload.budget_cents = moneyCents(data, 'budget_cents')
    }
    return payload
  }

  const loadList = async (active: ActiveSession): Promise<void> => {
    if (api.listDirectoryProjects === undefined || api.listProjectClients === undefined) {
      listStatus.textContent = 'Project browsing is unavailable in this build.'
      return
    }
    listStatus.textContent = 'Loading projects…'
    listRetry.hidden = true
    try {
      // A project's budget is consumed over its life, not over a period the
      // list has no control to pick, so the rollup is asked for everything up
      // to today. One request for the whole list, not one per row.
      const summaries = api.listProjectBudgetSummaries
      const [loadedProjects, loadedClients, loadedBudgets] = await Promise.all([
        collect((cursor) => api.listDirectoryProjects!(cursor, active.signal), active.signal),
        collect((cursor) => api.listProjectClients!(cursor, active.signal), active.signal),
        summaries === undefined
          ? Promise.resolve<readonly ProjectBudgetSummary[]>([])
          : summaries({ from: '2000-01-01', to: localDate() }, active.signal).catch(
              // Money columns are an enrichment; losing them must not lose the
              // list.
              () => [] as readonly ProjectBudgetSummary[],
            ),
      ])
      projects = loadedProjects
      clients = loadedClients
      budgets = new Map(loadedBudgets.map((summary) => [summary.project_id, summary]))
      if (currentSession() !== active) return
      populateClientFilter()
      renderList()
    } catch (error) {
      if (handleFailure(error)) return
      listStatus.textContent = messageFor(error)
      listRetry.hidden = false
    }
  }

  const loadAttachmentData = async (active: ActiveSession, projectId: number): Promise<void> => {
    if (api.listDirectoryProjectAttachments === undefined) {
      attachmentStatus.textContent = 'Attachment storage is unavailable in this build.'
      return
    }
    try {
      attachments = await api.listDirectoryProjectAttachments(projectId, active.signal)
      if (currentSession() !== active) return
      attachmentStatus.textContent = `${attachments.length} ${attachments.length === 1 ? 'file' : 'files'} attached.`
      renderAttachments()
    } catch (error) {
      if (handleFailure(error)) return
      attachments = []
      renderAttachments()
      attachmentStatus.textContent = messageFor(error)
    }
  }

  const loadDetail = async (active: ActiveSession): Promise<void> => {
    const projectId = projectIdFromPathname(globalThis.location.pathname)
    if (
      projectId === null ||
      api.getDirectoryProject === undefined ||
      api.listProjectClients === undefined ||
      api.listDirectoryTasks === undefined ||
      api.listProjectTaskAssignments === undefined
    ) {
      detailStatus.textContent = 'Project detail is unavailable in this build.'
      return
    }
    detailStatus.textContent = 'Loading project…'
    detailRetry.hidden = true
    try {
      ;[currentProject, clients, tasks, assignments] = await Promise.all([
        api.getDirectoryProject(projectId, active.signal),
        collect((cursor) => api.listProjectClients!(cursor, active.signal), active.signal),
        collect((cursor) => api.listDirectoryTasks!(cursor, active.signal), active.signal),
        collect(
          (cursor) => api.listProjectTaskAssignments!(projectId, cursor, active.signal),
          active.signal,
        ),
      ])
      if (currentSession() !== active) return
      required<HTMLElement>('[data-project-detail-name]').textContent = projectDisplayName(currentProject)
      detail.hidden = false
      detailStatus.textContent = projectIsActive(currentProject) ? 'Project loaded.' : 'Archived project loaded.'
      renderFacts()
      renderAssignments()
      attachmentForm.hidden = !active.capabilities.canWrite
      await loadAttachmentData(active, projectId)
    } catch (error) {
      if (handleFailure(error)) return
      detail.hidden = true
      detailStatus.textContent = messageFor(error)
      detailRetry.hidden = false
    }
  }

  required<HTMLButtonElement>('[data-project-create]').addEventListener('click', () => openProjectForm(null))
  required<HTMLButtonElement>('[data-project-edit]').addEventListener('click', () => openProjectForm(currentProject))
  required<HTMLButtonElement>('[data-project-archive]').addEventListener('click', () => {
    if (currentProject === null || !projectIsActive(currentProject)) return
    archiveResult.textContent = ''
    archiveDialog.showModal()
  })
  required<HTMLButtonElement>('[data-task-assignment-create]').addEventListener('click', () => openAssignmentForm(null))
  required<HTMLButtonElement>('[data-project-dialog-close]').addEventListener('click', () => projectDialog.close())
  required<HTMLButtonElement>('[data-task-assignment-dialog-close]').addEventListener('click', () => assignmentDialog.close())

  for (const control of document.querySelectorAll<HTMLButtonElement>('[data-project-filter]')) {
    control.addEventListener('click', () => {
      projectFilter = control.dataset.projectFilter === 'all' ? 'all' : 'active'
      for (const candidate of document.querySelectorAll<HTMLButtonElement>('[data-project-filter]')) {
        candidate.setAttribute('aria-pressed', String(candidate === control))
      }
      renderList()
    })
  }
  clientFilter.addEventListener('change', renderList)
  search.addEventListener('input', renderList)
  listRetry.addEventListener('click', () => {
    const active = currentSession()
    if (active !== null) void loadList(active)
  })
  detailRetry.addEventListener('click', () => {
    const active = currentSession()
    if (active !== null) void loadDetail(active)
  })

  projectForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const active = currentSession()
    if (active === null || !active.capabilities.canWrite || mutationPending) return
    const create = editingProjectId === null
    const operation = create ? api.createDirectoryProject : api.updateDirectoryProject
    if (operation === undefined) return
    let payload: Record<string, unknown>
    try {
      payload = projectPayload()
    } catch (error) {
      projectFormResult.textContent = messageFor(error)
      return
    }
    setMutationPending(true)
    projectFormSubmit.disabled = true
    projectFormResult.textContent = create ? 'Adding project…' : 'Saving project…'
    const request = create
      ? api.createDirectoryProject!(payload, active.signal)
      : api.updateDirectoryProject!(editingProjectId!, payload, active.signal)
    void request
      .then(async (saved) => {
        if (currentSession() !== active) return
        projectDialog.close()
        editingProjectId = null
        if (detailPage) {
          currentProject = saved
          await loadDetail(active)
          if (currentSession() === active) detailStatus.textContent = 'Project saved.'
        } else {
          await loadList(active)
          if (currentSession() === active) listStatus.textContent = create ? 'Project added.' : 'Project saved.'
        }
      })
      .catch((error: unknown) => {
        if (!handleFailure(error)) projectFormResult.textContent = messageFor(error)
      })
      .finally(() => {
        if (currentSession() === active) {
          setMutationPending(false)
          projectFormSubmit.disabled = false
        }
      })
  })

  assignmentForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const active = currentSession()
    if (active === null || !active.capabilities.canWrite || mutationPending) return
    const create = editingAssignmentId === null
    const operation = create
      ? api.createProjectTaskAssignment
      : api.updateProjectTaskAssignment
    if (operation === undefined) return
    let payload: Record<string, unknown>
    try {
      payload = assignmentPayload()
    } catch (error) {
      assignmentFormResult.textContent = messageFor(error)
      return
    }
    setMutationPending(true)
    assignmentFormSubmit.disabled = true
    assignmentFormResult.textContent = create ? 'Assigning task…' : 'Saving assignment…'
    const request = create
      ? api.createProjectTaskAssignment!(payload, active.signal)
      : api.updateProjectTaskAssignment!(editingAssignmentId!, payload, active.signal)
    void request
      .then(async () => {
        if (currentSession() !== active) return
        assignmentDialog.close()
        editingAssignmentId = null
        await loadDetail(active)
        if (currentSession() === active) taskStatus.textContent = create ? 'Task assigned.' : 'Task assignment saved.'
      })
      .catch((error: unknown) => {
        if (!handleFailure(error)) assignmentFormResult.textContent = messageFor(error)
      })
      .finally(() => {
        if (currentSession() === active) {
          setMutationPending(false)
          assignmentFormSubmit.disabled = false
        }
      })
  })

  archiveForm.addEventListener('submit', (event) => {
    event.preventDefault()
    if (!confirmedDialogSubmit(event)) {
      archiveDialog.close('cancel')
      return
    }
    const active = currentSession()
    if (
      active === null ||
      !active.capabilities.canWrite ||
      currentProject === null ||
      mutationPending ||
      api.archiveDirectoryProject === undefined
    ) return
    setMutationPending(true)
    required<HTMLButtonElement>('[data-project-archive-confirm]').disabled = true
    archiveResult.textContent = 'Archiving project…'
    void api.archiveDirectoryProject(currentProject.id, active.signal)
      .then(() => {
        if (currentSession() === active) globalThis.location.assign('/projects')
      })
      .catch((error: unknown) => {
        if (!handleFailure(error)) archiveResult.textContent = messageFor(error)
      })
      .finally(() => {
        if (currentSession() === active) {
          setMutationPending(false)
          required<HTMLButtonElement>('[data-project-archive-confirm]').disabled = false
        }
      })
  })

  assignmentArchiveForm.addEventListener('submit', (event) => {
    event.preventDefault()
    if (!confirmedDialogSubmit(event)) {
      assignmentArchiveDialog.close('cancel')
      archivingAssignmentId = null
      return
    }
    const active = currentSession()
    if (
      active === null ||
      !active.capabilities.canWrite ||
      archivingAssignmentId === null ||
      mutationPending ||
      api.archiveProjectTaskAssignment === undefined
    ) return
    setMutationPending(true)
    required<HTMLButtonElement>('[data-task-assignment-archive-confirm]').disabled = true
    assignmentArchiveResult.textContent = 'Archiving task assignment…'
    void api.archiveProjectTaskAssignment(archivingAssignmentId, active.signal)
      .then(async () => {
        if (currentSession() !== active) return
        assignmentArchiveDialog.close()
        archivingAssignmentId = null
        await loadDetail(active)
        if (currentSession() === active) taskStatus.textContent = 'Task assignment archived.'
      })
      .catch((error: unknown) => {
        if (!handleFailure(error)) assignmentArchiveResult.textContent = messageFor(error)
      })
      .finally(() => {
        if (currentSession() === active) {
          setMutationPending(false)
          required<HTMLButtonElement>('[data-task-assignment-archive-confirm]').disabled = false
        }
      })
  })

  attachmentForm.addEventListener('input', () => {
    if (!mutationPending) attachmentCommandId = null
  })
  attachmentForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const active = currentSession()
    if (
      active === null ||
      !active.capabilities.canWrite ||
      currentProject === null ||
      mutationPending ||
      api.uploadDirectoryProjectAttachment === undefined
    ) return
    const file = formField(attachmentForm, 'file')
    if (!(file instanceof HTMLInputElement) || file.files?.[0] === undefined) {
      attachmentStatus.textContent = 'Choose one file to upload.'
      return
    }
    const body = new FormData()
    body.set('file', file.files[0])
    attachmentCommandId ??= `web.project-attachment:${crypto.randomUUID()}`
    setMutationPending(true)
    attachmentSubmit.disabled = true
    attachmentStatus.textContent = 'Uploading file…'
    void api.uploadDirectoryProjectAttachment(
      currentProject.id,
      attachmentCommandId,
      body,
      active.signal,
    )
      .then(async () => {
        if (currentSession() !== active) return
        attachmentCommandId = null
        attachmentForm.reset()
        await loadAttachmentData(active, currentProject!.id)
        if (currentSession() === active) attachmentStatus.textContent = 'File attached.'
      })
      .catch((error: unknown) => {
        if (!handleFailure(error)) attachmentStatus.textContent = messageFor(error)
      })
      .finally(() => {
        if (currentSession() === active) {
          setMutationPending(false)
          attachmentSubmit.disabled = false
        }
      })
  })

  return {
    async activate(identity, signal, onSessionFailure) {
      clearPrivatePresentation()
      resetMutationState()
      const active: ActiveSession = {
        identity,
        capabilities: projectCapabilities(identity),
        signal,
        onSessionFailure,
      }
      session = active
      enableWrites(active.capabilities.canWrite)
      if (signal.aborted) return
      signal.addEventListener(
        'abort',
        () => {
          if (session !== active) return
          session = null
          clearPrivatePresentation()
          resetMutationState()
          enableWrites(false)
        },
        { once: true },
      )
      if (listPage) await loadList(active)
      if (detailPage) await loadDetail(active)
    },
  }
}
