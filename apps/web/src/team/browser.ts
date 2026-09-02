import {
  EzactoApiError,
  type TeamCatalog,
  type TeamCommandReceipt,
  type TeamNotificationInput,
  type TeamPerson,
  type TeamPersonPatch,
  type TeamPersonSummary,
  type TeamRateInput,
  type UserRate,
  type Whoami,
} from '@ezacto/client'
import {
  parseTeamCapacitySeconds,
  parseTeamMoneyCents,
  ratePeriod,
  shiftTeamDate,
  teamCapabilities,
  teamHours,
  teamMoney,
  teamPersonIdFromPathname,
  teamProfileOptions,
  teamUtilization,
  teamWeekLabel,
  teamWeekRange,
  type TeamCapabilities,
  type TeamDirectoryApi,
} from './model.js'

const required = <ElementType extends Element>(selector: string): ElementType => {
  const element = document.querySelector<ElementType>(selector)
  if (element === null) throw new Error(`team element missing: ${selector}`)
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

const apiErrorCode = (error: unknown): string | null => {
  if (!(error instanceof EzactoApiError) || typeof error.body !== 'object' || error.body === null) {
    return null
  }
  const detail = Reflect.get(error.body, 'error')
  if (typeof detail !== 'object' || detail === null) return null
  const code = Reflect.get(detail, 'code')
  return typeof code === 'string' ? code : null
}

const localDate = (): string => {
  const now = new Date()
  const year = String(now.getFullYear()).padStart(4, '0')
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const commandId = (): string => globalThis.crypto.randomUUID()

const checkbox = (name: string, label: string, checked: boolean): HTMLLabelElement => {
  const wrapper = document.createElement('label')
  wrapper.className = 'team-check'
  const control = document.createElement('input')
  control.type = 'checkbox'
  control.name = name
  control.checked = checked
  wrapper.append(control, document.createTextNode(label))
  return wrapper
}

const formInput = (form: HTMLFormElement, name: string): HTMLInputElement => {
  const value = form.elements.namedItem(name)
  if (!(value instanceof HTMLInputElement)) {
    throw new Error(`team form field missing: ${name}`)
  }
  return value
}

interface ActiveSession {
  readonly identity: Whoami
  readonly capabilities: TeamCapabilities
  readonly signal: AbortSignal
  readonly onSessionFailure: (error: unknown) => boolean
}

export interface TeamDirectoryController {
  activate(
    identity: Whoami,
    signal: AbortSignal,
    onSessionFailure: (error: unknown) => boolean,
  ): Promise<void>
}

export const createTeamDirectoryController = (
  api: Partial<TeamDirectoryApi>,
): TeamDirectoryController => {
  const listPage = document.documentElement.dataset.appView === 'team-list'
  const personPage = document.documentElement.dataset.appView === 'team-person'
  const listPageElement = required<HTMLElement>('[data-team-list-page]')
  const personPageElement = required<HTMLElement>('[data-team-person-page]')
  const listStatus = required<HTMLElement>('[data-team-list-status]')
  const list = required<HTMLOListElement>('[data-team-list]')
  const listRetry = required<HTMLButtonElement>('[data-team-list-retry]')
  const search = required<HTMLInputElement>('[data-team-search]')
  const summary = required<HTMLElement>('[data-team-summary]')
  const weekLabel = required<HTMLElement>('[data-team-week-label]')
  const personStatus = required<HTMLElement>('[data-team-person-status]')
  const personRetry = required<HTMLButtonElement>('[data-team-person-retry]')
  const editor = required<HTMLElement>('[data-team-person-editor]')
  const personName = required<HTMLElement>('[data-team-person-name]')
  const infoForm = required<HTMLFormElement>('[data-team-info-form]')
  const infoResult = required<HTMLElement>('[data-team-info-result]')
  const roles = required<HTMLElement>('[data-team-roles]')
  const departments = required<HTMLElement>('[data-team-departments]')
  const statusDescription = required<HTMLElement>('[data-team-status-description]')
  const statusAction = required<HTMLButtonElement>('[data-team-status-action]')
  const billableSection = required<HTMLElement>('[data-team-billable-section]')
  const costSection = required<HTMLElement>('[data-team-cost-section]')
  const billableRates = required<HTMLElement>('[data-team-billable-rates]')
  const costRates = required<HTMLElement>('[data-team-cost-rates]')
  const projectsForm = required<HTMLFormElement>('[data-team-projects-form]')
  const projects = required<HTMLElement>('[data-team-projects]')
  const projectsResult = required<HTMLElement>('[data-team-projects-result]')
  const permissionsForm = required<HTMLFormElement>('[data-team-permissions-form]')
  const profiles = required<HTMLElement>('[data-team-profiles]')
  const ownerProfileNote = required<HTMLElement>('[data-team-owner-profile-note]')
  const permissionsResult = required<HTMLElement>('[data-team-permissions-result]')
  const notificationsForm = required<HTMLFormElement>('[data-team-notifications-form]')
  const notificationsResult = required<HTMLElement>('[data-team-notifications-result]')
  const slackStatus = required<HTMLElement>('[data-team-slack-status]')
  const rateDialog = required<HTMLDialogElement>('[data-team-rate-dialog]')
  const rateForm = required<HTMLFormElement>('[data-team-rate-form]')
  const rateTitle = required<HTMLElement>('[data-team-rate-title]')
  const rateResult = required<HTMLElement>('[data-team-rate-result]')
  const rateSubmit = required<HTMLButtonElement>('[data-team-rate-submit]')
  const deactivateDialog = required<HTMLDialogElement>('[data-team-deactivate-dialog]')
  const deactivateForm = required<HTMLFormElement>('[data-team-deactivate-form]')
  const deactivateResult = required<HTMLElement>('[data-team-deactivate-result]')

  listPageElement.hidden = !listPage
  personPageElement.hidden = !personPage

  let session: ActiveSession | null = null
  let people: readonly TeamPersonSummary[] = []
  let person: TeamPerson | null = null
  let catalog: TeamCatalog = { roles: [], departments: [], projects: [] }
  let within = localDate()
  let weekStartDay: 'saturday' | 'sunday' | 'monday' = 'monday'
  let filter: 'active' | 'all' = 'active'
  let listGeneration = 0
  let mutationPending = false
  let selectedRateKind: TeamRateInput['kind'] | null = null
  const commandIds = new Map<string, string>()

  const currentSession = (): ActiveSession | null =>
    session === null || session.signal.aborted ? null : session

  const handleFailure = (error: unknown, active: ActiveSession): boolean =>
    currentSession() === active && active.onSessionFailure(error)

  const readDenialMessage = (active: ActiveSession): string =>
    active.identity.authentication.kind === 'token' &&
    !active.identity.authentication.scopes.includes('team:read')
      ? 'This API token does not grant team read access.'
      : 'Your permission profile does not have access to Team.'

  const resetCommand = (key: string): void => {
    if (!mutationPending) commandIds.delete(key)
  }

  const commandFor = (key: string): string => {
    const current = commandIds.get(key)
    if (current !== undefined) return current
    const next = commandId()
    commandIds.set(key, next)
    return next
  }

  const closeDialogs = (): void => {
    if (rateDialog.open) rateDialog.close()
    if (deactivateDialog.open) deactivateDialog.close()
  }

  const lockMutationControls = (): Map<HTMLInputElement | HTMLButtonElement, boolean> => {
    const states = new Map<HTMLInputElement | HTMLButtonElement, boolean>()
    const controls = new Set<HTMLInputElement | HTMLButtonElement>()
    for (const form of [
      infoForm,
      projectsForm,
      permissionsForm,
      notificationsForm,
      rateForm,
      deactivateForm,
    ]) {
      for (const control of form.elements) {
        if (control instanceof HTMLInputElement || control instanceof HTMLButtonElement) {
          controls.add(control)
        }
      }
    }
    controls.add(statusAction)
    for (const control of document.querySelectorAll<HTMLButtonElement>('[data-team-add-rate]')) {
      controls.add(control)
    }
    for (const control of controls) {
      states.set(control, control.disabled)
      control.disabled = true
    }
    return states
  }

  const restoreMutationControls = (
    states: ReadonlyMap<HTMLInputElement | HTMLButtonElement, boolean>,
  ): void => {
    for (const [control, disabled] of states) control.disabled = disabled
  }

  const clearPrivatePresentation = (): void => {
    listGeneration += 1
    people = []
    person = null
    catalog = { roles: [], departments: [], projects: [] }
    mutationPending = false
    selectedRateKind = null
    commandIds.clear()
    list.replaceChildren()
    summary.replaceChildren()
    summary.hidden = true
    editor.hidden = true
    roles.replaceChildren()
    departments.replaceChildren()
    projects.replaceChildren()
    profiles.replaceChildren()
    billableRates.replaceChildren()
    costRates.replaceChildren()
    search.value = ''
    listRetry.hidden = true
    personRetry.hidden = true
    listStatus.textContent = 'Loading team…'
    personStatus.textContent = 'Loading person…'
    personName.textContent = 'Person'
    infoResult.textContent = ''
    projectsResult.textContent = ''
    permissionsResult.textContent = ''
    notificationsResult.textContent = ''
    rateResult.textContent = ''
    deactivateResult.textContent = ''
    closeDialogs()
  }

  const renderSummary = (): void => {
    const capacity = people.reduce((total, value) => total + value.weekly_capacity, 0)
    const tracked = people.reduce((total, value) => total + value.total_seconds, 0)
    const billable = people.reduce((total, value) => total + value.billable_seconds, 0)
    const utilization = capacity === 0 ? null : Math.round((tracked * 1_000_000) / capacity)
    const item = (label: string, value: string): HTMLElement => {
      const result = document.createElement('div')
      const term = document.createElement('span')
      term.textContent = label
      const amount = document.createElement('strong')
      amount.textContent = value
      result.append(term, amount)
      return result
    }
    summary.replaceChildren(
      item('People', String(people.length)),
      item('Capacity', teamHours(capacity)),
      item('Tracked', teamHours(tracked)),
      item('Billable', teamHours(billable)),
      item('Utilization', teamUtilization(utilization)),
    )
    summary.hidden = false
  }

  const personCard = (value: TeamPersonSummary): HTMLLIElement => {
    const item = document.createElement('li')
    item.className = 'team-person-card'
    item.dataset.personId = String(value.id)
    const heading = document.createElement('div')
    heading.className = 'team-person-card-heading'
    const avatar = document.createElement('span')
    avatar.className = 'team-avatar'
    avatar.setAttribute('aria-hidden', 'true')
    avatar.textContent = `${value.first_name.charAt(0)}${value.last_name.charAt(0)}`.toLocaleUpperCase('en-US')
    if (value.avatar_url !== null) {
      avatar.textContent = ''
      const image = document.createElement('img')
      image.src = value.avatar_url
      image.alt = ''
      avatar.append(image)
    }
    const identity = document.createElement('div')
    const link = document.createElement('a')
    link.href = `/team/${value.id}`
    link.textContent = `${value.first_name} ${value.last_name}`
    const metadata = document.createElement('p')
    metadata.textContent = [
      value.is_owner ? 'Owner' : value.profile.replaceAll('_', ' '),
      value.is_contractor ? 'Contractor' : 'Employee',
      value.is_active ? 'Active' : 'Inactive',
      ...(value.running ? ['Timer running'] : []),
    ].join(' · ')
    identity.append(link, metadata)
    heading.append(avatar, identity)

    const utilization = document.createElement('div')
    utilization.className = 'team-utilization'
    const utilizationHeader = document.createElement('div')
    const utilizationLabel = document.createElement('strong')
    utilizationLabel.textContent = teamUtilization(value.utilization_ppm)
    const capacity = document.createElement('span')
    capacity.textContent = `${teamHours(value.total_seconds)} of ${teamHours(value.weekly_capacity)}`
    utilizationHeader.append(utilizationLabel, capacity)
    const bar = document.createElement('progress')
    bar.max = Math.max(1, value.weekly_capacity)
    bar.value = Math.min(value.total_seconds, bar.max)
    bar.setAttribute(
      'aria-label',
      `${value.first_name} ${value.last_name} utilization: ${teamUtilization(value.utilization_ppm)}`,
    )
    const detail = document.createElement('p')
    detail.textContent = `${teamHours(value.billable_seconds)} billable · ${teamHours(value.nonbillable_seconds)} non-billable`
    utilization.append(utilizationHeader, bar, detail)
    item.append(heading, utilization)
    return item
  }

  const renderPeople = (): void => {
    const wanted = search.value.trim().toLocaleLowerCase('en-US')
    const visible = people.filter((value) =>
      `${value.first_name} ${value.last_name} ${value.email ?? ''}`
        .toLocaleLowerCase('en-US')
        .includes(wanted),
    )
    if (visible.length === 0) {
      const empty = document.createElement('li')
      empty.className = 'team-empty'
      empty.textContent =
        people.length === 0
          ? filter === 'active'
            ? 'No active people are available.'
            : 'No people are available.'
          : 'No people match that search.'
      list.replaceChildren(empty)
      return
    }
    list.replaceChildren(...visible.map(personCard))
  }

  const loadPeople = async (active: ActiveSession): Promise<void> => {
    if (!active.capabilities.canRead) {
      listStatus.textContent = readDenialMessage(active)
      list.replaceChildren()
      return
    }
    if (api.listTeamPeople === undefined) {
      listStatus.textContent = 'Team browsing is unavailable in this build.'
      return
    }
    const generation = ++listGeneration
    const range = teamWeekRange(within, weekStartDay)
    weekLabel.textContent = teamWeekLabel(range.from, range.to)
    listStatus.textContent = 'Loading team utilization…'
    listRetry.hidden = true
    list.setAttribute('aria-busy', 'true')
    try {
      const loaded: TeamPersonSummary[] = []
      let cursor: string | undefined
      do {
        active.signal.throwIfAborted()
        const page = await api.listTeamPeople(
          {
            ...range,
            ...(filter === 'active' ? { is_active: true } : {}),
          },
          cursor,
          active.signal,
        )
        loaded.push(...page.data)
        cursor = page.page.next_cursor ?? undefined
      } while (cursor !== undefined)
      if (currentSession() !== active || generation !== listGeneration) return
      people = loaded
      renderSummary()
      renderPeople()
      listStatus.textContent = `${people.length} ${people.length === 1 ? 'person' : 'people'} · ${teamWeekLabel(range.from, range.to)}`
    } catch (error) {
      if (handleFailure(error, active)) return
      if (currentSession() !== active || generation !== listGeneration) return
      listStatus.textContent = messageFor(error)
      listRetry.hidden = false
    } finally {
      if (currentSession() === active && generation === listGeneration) {
        list.removeAttribute('aria-busy')
      }
    }
  }

  const renderRelationOptions = (
    container: HTMLElement,
    name: string,
    available: TeamCatalog['roles'],
    selected: readonly { readonly id: number }[],
  ): void => {
    if (available.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'hint'
      empty.textContent = `No ${name} are configured.`
      container.replaceChildren(empty)
      return
    }
    container.replaceChildren(
      ...available.map((option) => {
        const result = checkbox(name, option.name, selected.some(({ id }) => id === option.id))
        const control = result.querySelector('input')!
        control.value = String(option.id)
        return result
      }),
    )
  }

  const rateTable = (values: readonly UserRate[]): HTMLElement => {
    if (values.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'team-empty'
      empty.textContent = 'No rate history is available.'
      return empty
    }
    const table = document.createElement('table')
    const caption = document.createElement('caption')
    caption.className = 'visually-hidden'
    caption.textContent = 'Effective-dated rate history'
    const head = document.createElement('thead')
    const heading = document.createElement('tr')
    for (const label of ['Period', 'Rate']) {
      const cell = document.createElement('th')
      cell.scope = 'col'
      cell.textContent = label
      heading.append(cell)
    }
    head.append(heading)
    const body = document.createElement('tbody')
    for (const value of values) {
      const row = document.createElement('tr')
      const period = document.createElement('td')
      period.textContent = ratePeriod(value)
      const amount = document.createElement('td')
      amount.textContent = teamMoney(value.amount_cents)
      row.append(period, amount)
      body.append(row)
    }
    table.append(caption, head, body)
    return table
  }

  const renderRates = (active: ActiveSession, value: TeamPerson): void => {
    const billableVisible = value.billable_rates !== undefined
    const costVisible = value.cost_rates !== undefined
    billableSection.hidden = !billableVisible
    costSection.hidden = !costVisible
    required<HTMLElement>('[data-team-rates-redacted]').hidden =
      billableVisible || costVisible
    billableRates.replaceChildren(
      ...(billableVisible ? [rateTable(value.billable_rates ?? [])] : []),
    )
    costRates.replaceChildren(...(costVisible ? [rateTable(value.cost_rates ?? [])] : []))
    const billableAdd = required<HTMLButtonElement>('[data-team-add-rate="billable"]')
    const costAdd = required<HTMLButtonElement>('[data-team-add-rate="cost"]')
    billableAdd.hidden = !active.capabilities.canAppendBillableRate
    billableAdd.disabled = mutationPending || !active.capabilities.canAppendBillableRate
    costAdd.hidden = !active.capabilities.canAppendCostRate
    costAdd.disabled = mutationPending || !active.capabilities.canAppendCostRate
  }

  const renderProjects = (active: ActiveSession, value: TeamPerson): void => {
    const byId = new Map<
      number,
      {
        readonly id: number
        readonly name: string
        readonly code: string
        readonly client_name: string
        readonly is_active: boolean
      }
    >()
    for (const project of catalog.projects) byId.set(project.id, project)
    for (const assignment of value.project_assignments) {
      if (!assignment.is_active) continue
      if (!byId.has(assignment.project_id)) {
        byId.set(assignment.project_id, {
          id: assignment.project_id,
          name: assignment.project_name,
          code: assignment.project_code,
          client_name: assignment.client_name,
          is_active: true,
        })
      }
    }
    const available = [...byId.values()].sort((left, right) =>
      `${left.client_name} ${left.name}`.localeCompare(`${right.client_name} ${right.name}`, 'en-US'),
    )
    if (available.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'team-empty'
      empty.textContent = active.capabilities.canManagePeople
        ? 'No projects are available to assign.'
        : 'No projects are assigned.'
      projects.replaceChildren(empty)
    } else {
      projects.replaceChildren(
        ...available.map((project) => {
          const assignment = value.project_assignments.find(
            (candidate) =>
              candidate.project_id === project.id && candidate.is_active,
          )
          const row = document.createElement('div')
          row.className = 'team-project-assignment'
          const assigned = checkbox(
            `project-${project.id}`,
            `${project.client_name} · ${project.code === '' ? project.name : `[${project.code}] ${project.name}`}${project.is_active ? '' : ' (archived)'}`,
            assignment !== undefined,
          )
          const assignedControl = assigned.querySelector<HTMLInputElement>('input')!
          assignedControl.dataset.teamProjectId = String(project.id)
          const manager = checkbox(
            `manager-${project.id}`,
            'Project manager',
            assignment?.is_project_manager === true,
          )
          const managerControl = manager.querySelector<HTMLInputElement>('input')!
          managerControl.dataset.teamManagerFor = String(project.id)
          const archivedUnavailable = !project.is_active && assignment === undefined
          managerControl.disabled =
            !active.capabilities.canManagePeople ||
            !assignedControl.checked ||
            archivedUnavailable
          assignedControl.disabled =
            !active.capabilities.canManagePeople || archivedUnavailable
          assignedControl.addEventListener('change', () => {
            managerControl.disabled = !active.capabilities.canManagePeople || !assignedControl.checked
            if (!assignedControl.checked) managerControl.checked = false
          })
          row.append(assigned, manager)
          return row
        }),
      )
    }
    const submit = required<HTMLButtonElement>('[data-team-projects-submit]')
    submit.hidden = !active.capabilities.canManagePeople
    submit.disabled = mutationPending || !active.capabilities.canManagePeople
  }

  const renderProfiles = (active: ActiveSession, value: TeamPerson): void => {
    profiles.replaceChildren(
      ...teamProfileOptions.map((profile) => {
        const label = document.createElement('label')
        label.className = 'team-profile-option'
        const input = document.createElement('input')
        input.type = 'radio'
        input.name = 'profile'
        input.value = profile.value
        input.checked = value.profile === profile.value
        input.disabled = value.is_owner || !active.capabilities.canChangeProfile || mutationPending
        const copy = document.createElement('span')
        const title = document.createElement('strong')
        title.textContent = profile.label
        const detail = document.createElement('small')
        detail.textContent = profile.description
        copy.append(title, detail)
        label.append(input, copy)
        return label
      }),
    )
    ownerProfileNote.hidden = !value.is_owner
    const submit = required<HTMLButtonElement>('[data-team-permissions-submit]')
    submit.hidden = value.is_owner || !active.capabilities.canChangeProfile
    submit.disabled = mutationPending || value.is_owner || !active.capabilities.canChangeProfile
    if (!value.is_owner && !active.capabilities.canChangeProfile) {
      permissionsResult.textContent = 'Only an administrator can change permission profiles.'
    }
  }

  const renderNotifications = (value: TeamPerson): void => {
    const preferences = value.notifications
    formInput(notificationsForm, 'daily_reminder_enabled').checked =
      preferences.daily_reminder_enabled
    formInput(notificationsForm, 'reminder_time').value = preferences.reminder_time ?? ''
    for (const day of notificationsForm.querySelectorAll<HTMLInputElement>(
      '[name="reminder_days"]',
    )) {
      day.checked = preferences.reminder_days.includes(
        day.value as TeamNotificationInput['reminder_days'][number],
      )
    }
    formInput(notificationsForm, 'channel_email').checked = preferences.channels.email
    formInput(notificationsForm, 'channel_desktop').checked = preferences.channels.desktop
    const slack = formInput(notificationsForm, 'channel_slack')
    slack.checked = preferences.channels.slack
    slack.disabled = true
    slackStatus.textContent = preferences.channels.slack
      ? 'An inactive Slack preference was imported. Slack remains unavailable because no connector is configured.'
      : 'Slack is unavailable because no connector is configured.'
    formInput(notificationsForm, 'include_in_team_reminders').checked =
      preferences.include_in_team_reminders
    formInput(notificationsForm, 'weekly_digest').checked = preferences.weekly_digest
    formInput(notificationsForm, 'notify_project_deleted').checked =
      preferences.notify_project_deleted
    for (const control of notificationsForm.elements) {
      if (control instanceof HTMLInputElement && control !== slack) {
        control.disabled = true
      }
    }
    const submit = required<HTMLButtonElement>('[data-team-notifications-submit]')
    submit.hidden = true
    submit.disabled = true
  }

  const syncInfoControls = (active: ActiveSession, value: TeamPerson): void => {
    for (const control of infoForm.elements) {
      if (control instanceof HTMLInputElement && control.name !== 'email') {
        control.disabled = !active.capabilities.canManagePeople || mutationPending
      }
    }
    const submit = required<HTMLButtonElement>('[data-team-info-submit]')
    submit.hidden = !active.capabilities.canManagePeople
    submit.disabled = mutationPending || !active.capabilities.canManagePeople
    statusAction.hidden = value.is_owner || !active.capabilities.canManagePeople
    statusAction.disabled = mutationPending || value.is_owner || !active.capabilities.canManagePeople
  }

  const renderPerson = (active: ActiveSession, value: TeamPerson): void => {
    personName.textContent = `${value.first_name} ${value.last_name}`
    formInput(infoForm, 'first_name').value = value.first_name
    formInput(infoForm, 'last_name').value = value.last_name
    formInput(infoForm, 'email').value = value.email ?? ''
    formInput(infoForm, 'telephone').value = value.telephone ?? ''
    formInput(infoForm, 'employee_id').value = value.employee_id ?? ''
    formInput(infoForm, 'timezone').value = value.timezone
    formInput(infoForm, 'weekly_capacity').value = String(value.weekly_capacity / 3_600)
    formInput(infoForm, 'is_contractor').checked = value.is_contractor
    formInput(infoForm, 'has_access_to_all_future_projects').checked =
      value.has_access_to_all_future_projects
    renderRelationOptions(roles, 'role_ids', catalog.roles, value.roles)
    renderRelationOptions(departments, 'department_ids', catalog.departments, value.departments)
    statusDescription.textContent = value.is_owner
      ? 'The organization owner cannot be deactivated.'
      : value.is_active
        ? 'Deactivate access while preserving historical time and expenses.'
        : 'This person is inactive and cannot track new work.'
    statusAction.textContent = value.is_active ? 'Deactivate person' : 'Reactivate person'
    statusAction.className = value.is_active ? 'danger-action' : ''
    syncInfoControls(active, value)
    renderRates(active, value)
    renderProjects(active, value)
    renderProfiles(active, value)
    renderNotifications(value)
    editor.hidden = false
    personStatus.textContent = `${value.is_active ? 'Active' : 'Inactive'} · version ${value.version}`
  }

  const fetchPerson = async (active: ActiveSession): Promise<void> => {
    const id = teamPersonIdFromPathname(globalThis.location.pathname)
    if (id === null) throw new Error('The person URL is invalid.')
    if (api.getTeamPerson === undefined || api.getTeamCatalog === undefined) {
      throw new Error('The person editor is unavailable in this build.')
    }
    const [loaded, loadedCatalog] = await Promise.all([
      api.getTeamPerson(id, active.signal),
      api.getTeamCatalog(active.signal),
    ])
    if (currentSession() !== active) return
    person = loaded
    catalog = loadedCatalog
    renderPerson(active, loaded)
  }

  const loadPerson = async (active: ActiveSession): Promise<boolean> => {
    if (!active.capabilities.canRead) {
      personStatus.textContent = readDenialMessage(active)
      return false
    }
    personStatus.textContent = 'Loading person…'
    personRetry.hidden = true
    editor.setAttribute('aria-busy', 'true')
    try {
      await fetchPerson(active)
      return currentSession() === active
    } catch (error) {
      if (handleFailure(error, active)) return false
      if (currentSession() !== active) return false
      personStatus.textContent = messageFor(error)
      personRetry.hidden = false
      editor.hidden = true
      return false
    } finally {
      if (currentSession() === active) editor.removeAttribute('aria-busy')
    }
  }

  const refreshAfterMutation = async (
    active: ActiveSession,
    receipt: TeamCommandReceipt,
    result: HTMLElement,
    successMessage: string,
  ): Promise<boolean> => {
    if (person !== null) person = { ...person, version: receipt.version }
    try {
      await fetchPerson(active)
      result.textContent = successMessage
      return true
    } catch (error) {
      if (handleFailure(error, active)) return false
      result.textContent = `${successMessage} The updated record could not be reloaded; use Retry loading person.`
      personRetry.hidden = false
      return false
    }
  }

  const handleMutationError = async (
    error: unknown,
    active: ActiveSession,
    key: string,
    result: HTMLElement,
  ): Promise<boolean> => {
    if (handleFailure(error, active)) return false
    if (apiErrorCode(error) === 'state_conflict') {
      commandIds.delete(key)
      const reloaded = await loadPerson(active)
      result.textContent = 'This person changed elsewhere. The latest record is loaded; review and try again.'
      return reloaded
    }
    if (apiErrorCode(error) === 'command_id_reused') commandIds.delete(key)
    result.textContent = messageFor(error)
    return false
  }

  const mutate = async (
    active: ActiveSession,
    key: string,
    result: HTMLElement,
    pendingMessage: string,
    successMessage: string,
    action: (id: string) => Promise<TeamCommandReceipt>,
  ): Promise<void> => {
    if (mutationPending) return
    mutationPending = true
    const disabledStates = lockMutationControls()
    let presentationRefreshed = false
    result.textContent = pendingMessage
    try {
      const receipt = await action(commandFor(key))
      if (currentSession() !== active) return
      commandIds.delete(key)
      presentationRefreshed = await refreshAfterMutation(
        active,
        receipt,
        result,
        successMessage,
      )
    } catch (error) {
      if (currentSession() === active) {
        presentationRefreshed = await handleMutationError(
          error,
          active,
          key,
          result,
        )
      }
    } finally {
      if (currentSession() === active) {
        mutationPending = false
        restoreMutationControls(disabledStates)
        if (presentationRefreshed && person !== null) renderPerson(active, person)
      }
    }
  }

  search.addEventListener('input', renderPeople)
  for (const control of document.querySelectorAll<HTMLButtonElement>('[data-team-filter]')) {
    control.addEventListener('click', () => {
      const active = currentSession()
      const next = control.dataset.teamFilter
      if (active === null || (next !== 'active' && next !== 'all') || next === filter) return
      filter = next
      for (const button of document.querySelectorAll<HTMLButtonElement>('[data-team-filter]')) {
        button.setAttribute('aria-pressed', String(button.dataset.teamFilter === filter))
      }
      void loadPeople(active)
    })
  }
  const moveWeek = (days: number): void => {
    const active = currentSession()
    if (active === null) return
    within = shiftTeamDate(within, days)
    void loadPeople(active)
  }
  required<HTMLButtonElement>('[data-team-week-previous]').addEventListener('click', () =>
    moveWeek(-7),
  )
  required<HTMLButtonElement>('[data-team-week-next]').addEventListener('click', () => moveWeek(7))
  required<HTMLButtonElement>('[data-team-week-current]').addEventListener('click', () => {
    within = localDate()
    const active = currentSession()
    if (active !== null) void loadPeople(active)
  })
  listRetry.addEventListener('click', () => {
    const active = currentSession()
    if (active !== null) void loadPeople(active)
  })
  personRetry.addEventListener('click', () => {
    const active = currentSession()
    if (active !== null) void loadPerson(active)
  })

  const tabs = [...document.querySelectorAll<HTMLButtonElement>('[data-team-tab]')]
  const selectTab = (next: HTMLButtonElement): void => {
    for (const tab of tabs) {
      const selected = tab === next
      tab.setAttribute('aria-selected', String(selected))
      tab.tabIndex = selected ? 0 : -1
      const panel = required<HTMLElement>(`[data-team-panel="${tab.dataset.teamTab}"]`)
      panel.hidden = !selected
    }
  }
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener('click', () => selectTab(tab))
    tab.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      const offset = event.key === 'ArrowRight' ? 1 : -1
      const next = tabs[(index + offset + tabs.length) % tabs.length]!
      selectTab(next)
      next.focus()
    })
  }

  infoForm.addEventListener('input', () => resetCommand('info'))
  infoForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const active = currentSession()
    const current = person
    if (
      active === null ||
      current === null ||
      !active.capabilities.canManagePeople ||
      api.updateTeamPerson === undefined
    ) {
      return
    }
    const firstName = formInput(infoForm, 'first_name').value.trim()
    const lastName = formInput(infoForm, 'last_name').value.trim()
    const timezone = formInput(infoForm, 'timezone').value.trim()
    if (firstName === '' || lastName === '' || timezone === '') {
      infoResult.textContent = 'First name, last name, and timezone are required.'
      return
    }
    let capacity: number
    try {
      capacity = parseTeamCapacitySeconds(formInput(infoForm, 'weekly_capacity').value)
    } catch (error) {
      infoResult.textContent = messageFor(error)
      return
    }
    const selectedIds = (name: string): number[] =>
      [...infoForm.querySelectorAll<HTMLInputElement>(`[name="${name}"]:checked`)].map(
        ({ value }) => Number(value),
      )
    const patch: TeamPersonPatch = {
      expected_version: current.version,
      first_name: firstName,
      last_name: lastName,
      telephone: formInput(infoForm, 'telephone').value.trim() || null,
      employee_id: formInput(infoForm, 'employee_id').value.trim() || null,
      timezone,
      weekly_capacity: capacity,
      is_contractor: formInput(infoForm, 'is_contractor').checked,
      has_access_to_all_future_projects: formInput(
        infoForm,
        'has_access_to_all_future_projects',
      ).checked,
      role_ids: selectedIds('role_ids'),
      department_ids: selectedIds('department_ids'),
    }
    void mutate(active, 'info', infoResult, 'Saving information…', 'Information saved.', (id) =>
      api.updateTeamPerson!(
        current.id,
        id,
        patch,
        active.signal,
      ),
    )
  })

  projectsForm.addEventListener('input', () => resetCommand('projects'))
  projectsForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const active = currentSession()
    const current = person
    if (
      active === null ||
      current === null ||
      !active.capabilities.canManagePeople ||
      api.replaceTeamPersonProjectAssignments === undefined
    ) {
      return
    }
    const assignments = [
      ...projectsForm.querySelectorAll<HTMLInputElement>('[data-team-project-id]:checked'),
    ].map((control) => {
      const projectId = Number(control.dataset.teamProjectId)
      const manager = projectsForm.querySelector<HTMLInputElement>(
        `[data-team-manager-for="${projectId}"]`,
      )
      return { project_id: projectId, is_project_manager: manager?.checked === true }
    })
    void mutate(
      active,
      'projects',
      projectsResult,
      'Saving project assignments…',
      'Project assignments saved.',
      (id) =>
        api.replaceTeamPersonProjectAssignments!(
          current.id,
          id,
          { expected_version: current.version, assignments },
          active.signal,
        ),
    )
  })

  permissionsForm.addEventListener('input', () => resetCommand('permissions'))
  permissionsForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const active = currentSession()
    const current = person
    const selected = permissionsForm.querySelector<HTMLInputElement>('[name="profile"]:checked')
    if (
      active === null ||
      current === null ||
      current.is_owner ||
      !active.capabilities.canChangeProfile ||
      api.updateTeamPerson === undefined ||
      selected === null
    ) {
      return
    }
    const profile = selected.value as TeamPerson['profile']
    void mutate(
      active,
      'permissions',
      permissionsResult,
      'Saving permission profile…',
      'Permission profile saved.',
      (id) =>
        api.updateTeamPerson!(
          current.id,
          id,
          { expected_version: current.version, profile },
          active.signal,
        ),
    )
  })

  const slack = formInput(notificationsForm, 'channel_slack')
  slack.addEventListener('change', () => {
    if (slack.checked) slack.checked = false
    slack.disabled = true
    slackStatus.textContent = 'Slack delivery is unavailable because no connector is configured.'
  })
  notificationsForm.addEventListener('input', () => resetCommand('notifications'))
  notificationsForm.addEventListener('submit', (event) => {
    event.preventDefault()
    notificationsResult.textContent =
      'Notification delivery is not active in this release.'
  })

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-team-add-rate]')) {
    button.addEventListener('click', () => {
      const kind = button.dataset.teamAddRate
      if (kind !== 'billable' && kind !== 'cost') return
      selectedRateKind = kind
      rateForm.reset()
      rateResult.textContent = ''
      formInput(rateForm, 'start_date').max = localDate()
      formInput(rateForm, 'start_date').value = localDate()
      rateTitle.textContent = `Add ${kind} rate`
      rateSubmit.textContent = `Add ${kind} rate`
      rateDialog.showModal()
      formInput(rateForm, 'amount').focus()
    })
  }
  rateForm.addEventListener('input', () => resetCommand(`rate-${selectedRateKind ?? ''}`))
  rateForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const active = currentSession()
    const current = person
    const kind = selectedRateKind
    if (
      active === null ||
      current === null ||
      kind === null ||
      api.appendTeamPersonRate === undefined ||
      (kind === 'billable' && !active.capabilities.canAppendBillableRate) ||
      (kind === 'cost' && !active.capabilities.canAppendCostRate)
    ) {
      return
    }
    const rawStartDate = formInput(rateForm, 'start_date').value
    const startDate = rawStartDate === '' ? null : rawStartDate
    if (startDate !== null && startDate > localDate()) {
      rateResult.textContent = 'Choose an effective date that is not in the future.'
      return
    }
    let amountCents: number
    try {
      amountCents = parseTeamMoneyCents(formInput(rateForm, 'amount').value)
    } catch (error) {
      rateResult.textContent = messageFor(error)
      return
    }
    const key = `rate-${kind}`
    void mutate(active, key, rateResult, 'Adding rate…', `${kind === 'billable' ? 'Billable' : 'Cost'} rate added.`, (id) =>
      api.appendTeamPersonRate!(
        current.id,
        id,
        {
          expected_version: current.version,
          kind,
          amount_cents: amountCents,
          start_date: startDate,
        },
        active.signal,
      ),
    ).then(() => {
      if (rateResult.textContent?.endsWith('rate added.')) rateDialog.close()
    })
  })
  required<HTMLButtonElement>('[data-team-rate-close]').addEventListener('click', () => {
    if (!mutationPending) rateDialog.close()
  })

  statusAction.addEventListener('click', () => {
    const active = currentSession()
    const current = person
    if (active === null || current === null || current.is_owner || mutationPending) return
    if (current.is_active) {
      deactivateForm.reset()
      deactivateResult.textContent = ''
      deactivateDialog.showModal()
      formInput(deactivateForm, 'confirmation').focus()
      return
    }
    if (api.updateTeamPerson === undefined) return
    void mutate(
      active,
      'status',
      infoResult,
      'Reactivating person…',
      'Person reactivated.',
      (id) =>
        api.updateTeamPerson!(
          current.id,
          id,
          { expected_version: current.version, is_active: true },
          active.signal,
        ),
    )
  })
  deactivateForm.addEventListener('input', () => resetCommand('status'))
  deactivateForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const active = currentSession()
    const current = person
    if (
      active === null ||
      current === null ||
      current.is_owner ||
      !current.is_active ||
      api.updateTeamPerson === undefined
    ) {
      return
    }
    if (formInput(deactivateForm, 'confirmation').value !== 'DEACTIVATE') {
      deactivateResult.textContent = 'Type DEACTIVATE exactly to confirm.'
      return
    }
    void mutate(
      active,
      'status',
      deactivateResult,
      'Deactivating person…',
      'Person deactivated.',
      (id) =>
        api.updateTeamPerson!(
          current.id,
          id,
          { expected_version: current.version, is_active: false },
          active.signal,
        ),
    ).then(() => {
      if (person?.is_active === false) deactivateDialog.close()
    })
  })
  for (const selector of ['[data-team-deactivate-close]', '[data-team-deactivate-cancel]']) {
    required<HTMLButtonElement>(selector).addEventListener('click', () => {
      if (!mutationPending) deactivateDialog.close()
    })
  }

  return {
    async activate(identity, signal, onSessionFailure) {
      clearPrivatePresentation()
      const active: ActiveSession = {
        identity,
        capabilities: teamCapabilities(identity),
        signal,
        onSessionFailure,
      }
      session = active
      if (listPage) {
        if (api.getTeamWeekStartDay !== undefined) {
          try {
            weekStartDay = await api.getTeamWeekStartDay(active.signal)
          } catch (error) {
            if (handleFailure(error, active)) return
            listStatus.textContent = messageFor(error)
            listRetry.hidden = false
            return
          }
        }
        await loadPeople(active)
      }
      if (personPage) await loadPerson(active)
    },
  }
}
