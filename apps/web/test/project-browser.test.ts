/** @vitest-environment happy-dom */

import { EzactoApiError, type Attachment, type GeneralResource, type Whoami } from '@ezacto/client'
import { describe, expect, it, vi } from 'vitest'
import { createProjectDirectoryController } from '../src/projects/browser.js'
import type { ProjectDirectoryApi } from '../src/projects/model.js'
import { renderAppShell } from '../src/index.js'

const timestamp = '2026-09-01T12:00:00.000Z'
const client: GeneralResource = {
  id: 3,
  name: 'Acme',
  currency: 'USD',
  is_active: true,
  created_at: timestamp,
  updated_at: timestamp,
}
const project: GeneralResource = {
  id: 7,
  client_id: 3,
  name: 'Launch',
  code: 'WEB',
  is_active: true,
  billing_method: 'time_materials',
  bill_by: 'project',
  hourly_rate_cents: 15_000,
  fee_cents: null,
  budget_by: 'project',
  budget_seconds: 36_000,
  cost_budget_cents: 200_000,
  budget_is_monthly: false,
  cost_budget_include_expenses: true,
  notify_when_over_budget: true,
  over_budget_pct: 80,
  show_budget_to_all: false,
  report_visibility: 'managers',
  starts_on: '2026-09-01',
  ends_on: null,
  notes: 'Administrator-only delivery concern',
  billing_currency: 'USD',
  time_entry_notes_minimum_length: 12,
  created_at: timestamp,
  updated_at: timestamp,
}
const task: GeneralResource = {
  id: 11,
  name: 'Implementation',
  is_active: true,
  billable_by_default: true,
  created_at: timestamp,
  updated_at: timestamp,
}
const assignment: GeneralResource = {
  id: 13,
  project_id: 7,
  task_id: 11,
  is_active: true,
  billable: true,
  hourly_rate_cents: 17_500,
  budget_seconds: 18_000,
  budget_cents: 50_000,
  created_at: timestamp,
  updated_at: timestamp,
}
const attachment: Attachment = {
  id: 17,
  name: 'scope.txt',
  content_hash: 'a'.repeat(64),
  byte_size: 5,
  content_type: 'text/plain',
  uploaded_by_user_id: 1,
  created_at: timestamp,
  updated_at: timestamp,
}

const page = (data: readonly GeneralResource[]) => ({
  data,
  page: { next_cursor: null },
})

const identity = (
  profile: Whoami['profile'],
  manager_grants: readonly string[] = [],
): Whoami => ({
  user_id: 1,
  profile,
  manager_grants: [...manager_grants],
  authentication: { kind: 'session' },
})

const writeDocument = (view: 'project-list' | 'project-detail', pathname: string): void => {
  window.history.replaceState(null, '', pathname)
  document.open()
  document.write(
    renderAppShell({
      environment: 'test',
      release: 'project-browser-test',
      activeSection: 'Projects',
      view,
    })
      .replace(/ {2}<link[^>]+(?:fonts\.googleapis|fonts\.gstatic|\/assets\/ezacto\.css)[^>]*>\n/gu, '')
      .replace('  <script type="module" src="/assets/ezacto.js"></script>\n', ''),
  )
  document.close()
}

const detailApi = (overrides: Partial<ProjectDirectoryApi> = {}): Partial<ProjectDirectoryApi> => ({
  getDirectoryProject: vi.fn(async () => project),
  listProjectClients: vi.fn(async () => page([client])),
  listDirectoryTasks: vi.fn(async () => page([task])),
  listProjectTaskAssignments: vi.fn(async () => page([assignment])),
  listDirectoryProjectAttachments: vi.fn(async () => [attachment]),
  updateDirectoryProject: vi.fn(async (_id, patch) => ({ ...project, ...patch })),
  createProjectTaskAssignment: vi.fn(async (input) => ({ ...assignment, ...input })),
  updateProjectTaskAssignment: vi.fn(async (_id, input) => ({ ...assignment, ...input })),
  archiveProjectTaskAssignment: vi.fn(async () => undefined),
  archiveDirectoryProject: vi.fn(async () => undefined),
  uploadDirectoryProjectAttachment: vi.fn(async () => attachment),
  ...overrides,
})

describe('Projects V1 browser controller', () => {
  it('[security] renders read-only detail without restricted values or mutation controls', async () => {
    writeDocument('project-detail', '/projects/7')
    const api = detailApi()
    const controller = createProjectDirectoryController(api)

    await controller.activate(identity('member'), new AbortController().signal, () => false)

    const facts = document.querySelector('[data-project-facts]')?.textContent ?? ''
    expect(facts).toContain('Acme')
    // The client a project belongs to is the way back to the rest of its work.
    const clientLink = document.querySelector<HTMLAnchorElement>('[data-project-facts] a')
    expect(clientLink?.getAttribute('href')).toBe('/clients/3')
    expect(clientLink?.textContent).toBe('Acme')
    expect(facts).toContain('Hours budget')
    expect(facts).not.toContain('$150.00')
    expect(facts).not.toContain('$2,000.00')
    expect(facts).not.toContain('Administrator-only delivery concern')
    expect(document.querySelector('[data-project-task-assignments]')?.textContent).toContain(
      'Implementation',
    )
    expect(document.querySelector('[data-project-attachments] a')?.getAttribute('href')).toBe(
      '/api/v1/projects/7/attachments/17/content',
    )
    expect(document.querySelector('[data-project-attachment-form]')?.hasAttribute('hidden')).toBe(true)
    expect(
      [...document.querySelectorAll<HTMLElement>('[data-project-write]')].every(
        (element) => element.hidden,
      ),
    ).toBe(true)
    const projectForm = document.querySelector<HTMLFormElement>('[data-project-form]')!
    expect(projectForm.elements.namedItem('notes')).toBeNull()
    expect(projectForm.elements.namedItem('hourly_rate_cents')).toBeNull()
    expect(api.updateDirectoryProject).not.toHaveBeenCalled()
  })

  it('[security] keeps unauthorized money and note fields out of a manager DOM and PATCH', async () => {
    writeDocument('project-detail', '/projects/7')
    const updateDirectoryProject = vi.fn(async (_id, patch) => ({ ...project, ...patch }))
    const api = detailApi({ updateDirectoryProject })
    const controller = createProjectDirectoryController(api)

    await controller.activate(identity('project_manager'), new AbortController().signal, () => false)
    document.querySelector<HTMLButtonElement>('[data-project-edit]')!.click()

    const form = document.querySelector<HTMLFormElement>('[data-project-form]')!
    expect(form.elements.namedItem('hourly_rate_cents')).toBeNull()
    expect(form.elements.namedItem('fee_cents')).toBeNull()
    expect(form.elements.namedItem('cost_budget_cents')).toBeNull()
    expect(form.elements.namedItem('notes')).toBeNull()
    ;(form.elements.namedItem('name') as HTMLInputElement).value = 'Manager update'
    for (const field of ['billing_method', 'bill_by', 'billing_currency']) expect(form.elements.namedItem(field)).toBeNull()
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() => expect(updateDirectoryProject).toHaveBeenCalledTimes(1))
    const payload = updateDirectoryProject.mock.calls[0]![1]
    expect(payload).toMatchObject({
      name: 'Manager update',
      client_id: 3,
      budget_seconds: 36_000,
      time_entry_notes_minimum_length: 12,
    })
    expect(payload).not.toHaveProperty('hourly_rate_cents')
    expect(payload).not.toHaveProperty('fee_cents')
    expect(payload).not.toHaveProperty('cost_budget_cents')
    expect(payload).not.toHaveProperty('notes')
    for (const field of ['billing_method', 'bill_by', 'billing_currency']) expect(payload).not.toHaveProperty(field)
  })

  it('[browser] submits exact authorized project and task-assignment units', async () => {
    writeDocument('project-detail', '/projects/7')
    const updateDirectoryProject = vi.fn(async (_id, patch) => ({ ...project, ...patch }))
    const updateProjectTaskAssignment = vi.fn(async (_id, patch) => ({ ...assignment, ...patch }))
    const api = detailApi({ updateDirectoryProject, updateProjectTaskAssignment })
    const controller = createProjectDirectoryController(api)

    await controller.activate(identity('administrator'), new AbortController().signal, () => false)
    document.querySelector<HTMLButtonElement>('[data-project-edit]')!.click()
    const projectForm = document.querySelector<HTMLFormElement>('[data-project-form]')!
    ;(projectForm.elements.namedItem('hourly_rate_cents') as HTMLInputElement).value = '175.25'
    ;(projectForm.elements.namedItem('cost_budget_cents') as HTMLInputElement).value = '2345.67'
    ;(projectForm.elements.namedItem('budget_seconds') as HTMLInputElement).value = '12.5'
    ;(projectForm.elements.namedItem('notes') as HTMLTextAreaElement).value = 'Updated admin note'
    projectForm.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() => expect(updateDirectoryProject).toHaveBeenCalledTimes(1))
    expect(updateDirectoryProject.mock.calls[0]![1]).toMatchObject({
      hourly_rate_cents: 17_525,
      cost_budget_cents: 234_567,
      budget_seconds: 45_000,
      notes: 'Updated admin note',
    })
    await vi.waitFor(() =>
      expect(document.querySelector('[data-project-detail-status]')?.textContent).toBe('Project saved.'),
    )

    document.querySelector<HTMLButtonElement>('[data-project-task-assignments] button')!.click()
    const taskForm = document.querySelector<HTMLFormElement>('[data-task-assignment-form]')!
    ;(taskForm.elements.namedItem('hourly_rate_cents') as HTMLInputElement).value = '201.01'
    ;(taskForm.elements.namedItem('budget_seconds') as HTMLInputElement).value = '7.25'
    ;(taskForm.elements.namedItem('budget_cents') as HTMLInputElement).value = '999.99'
    taskForm.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() => expect(updateProjectTaskAssignment).toHaveBeenCalledTimes(1))
    expect(updateProjectTaskAssignment.mock.calls[0]![1]).toEqual({
      is_active: true,
      billable: true,
      hourly_rate_cents: 20_101,
      budget_seconds: 26_100,
      budget_cents: 99_999,
    })
  })

  it('[browser] holds follow-up mutation actions until post-save detail hydration finishes', async () => {
    writeDocument('project-detail', '/projects/7')
    let attachmentReads = 0
    let releaseAttachmentRefresh = (attachments: Attachment[]): void => {
      void attachments
    }
    const delayedAttachmentRefresh = new Promise<Attachment[]>((resolve) => {
      releaseAttachmentRefresh = resolve
    })
    const listDirectoryProjectAttachments = vi.fn(() => {
      attachmentReads += 1
      return attachmentReads === 1
        ? Promise.resolve([attachment])
        : delayedAttachmentRefresh
    })
    const updateDirectoryProject = vi.fn(async (_id, patch) => ({ ...project, ...patch }))
    const updateProjectTaskAssignment = vi.fn(async (_id, patch) => ({ ...assignment, ...patch }))
    const controller = createProjectDirectoryController(
      detailApi({
        listDirectoryProjectAttachments,
        updateDirectoryProject,
        updateProjectTaskAssignment,
      }),
    )

    await controller.activate(identity('administrator'), new AbortController().signal, () => false)
    document.querySelector<HTMLButtonElement>('[data-project-edit]')!.click()
    const projectForm = document.querySelector<HTMLFormElement>('[data-project-form]')!
    ;(projectForm.elements.namedItem('notes') as HTMLTextAreaElement).value = 'Hydrated note'
    projectForm.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() => expect(listDirectoryProjectAttachments).toHaveBeenCalledTimes(2))
    const editAssignment = (): HTMLButtonElement =>
      [...document.querySelectorAll<HTMLButtonElement>('[data-project-task-assignments] button')]
        .find((button) => button.textContent === 'Edit')!
    expect(editAssignment().disabled).toBe(true)
    editAssignment().click()
    expect(document.querySelector<HTMLDialogElement>('[data-task-assignment-dialog]')!.open).toBe(
      false,
    )

    releaseAttachmentRefresh([attachment])
    await vi.waitFor(() => expect(editAssignment().disabled).toBe(false))
    editAssignment().click()
    const assignmentForm = document.querySelector<HTMLFormElement>(
      '[data-task-assignment-form]',
    )!
    assignmentForm.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(updateProjectTaskAssignment).toHaveBeenCalledTimes(1))
  })

  it('[browser] inherits and tracks the selected task billable default for a new assignment', async () => {
    writeDocument('project-detail', '/projects/7')
    const nonBillable = { ...task, billable_by_default: false }
    const billable = { ...task, id: 12, name: 'Advisory', billable_by_default: true }
    const createProjectTaskAssignment = vi.fn(async (input) => ({ ...assignment, ...input }))
    const api = detailApi({
      listDirectoryTasks: vi.fn(async () => page([nonBillable, billable])),
      listProjectTaskAssignments: vi.fn(async () => page([])),
      createProjectTaskAssignment,
    })
    const controller = createProjectDirectoryController(api)

    await controller.activate(
      identity('project_manager'),
      new AbortController().signal,
      () => false,
    )
    document.querySelector<HTMLButtonElement>('[data-task-assignment-create]')!.click()
    const form = document.querySelector<HTMLFormElement>('[data-task-assignment-form]')!
    const taskSelect = form.elements.namedItem('task_id') as HTMLSelectElement
    const billableControl = form.elements.namedItem('billable') as HTMLInputElement
    expect(taskSelect.value).toBe('11')
    expect(billableControl.checked).toBe(false)
    taskSelect.value = '12'
    taskSelect.dispatchEvent(new Event('change'))
    expect(billableControl.checked).toBe(true)
    taskSelect.value = '11'
    taskSelect.dispatchEvent(new Event('change'))
    expect(billableControl.checked).toBe(false)
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() => expect(createProjectTaskAssignment).toHaveBeenCalledTimes(1))
    expect(createProjectTaskAssignment.mock.calls[0]![0]).toEqual({
      project_id: 7,
      task_id: 11,
      is_active: true,
      billable: false,
      budget_seconds: null,
    })
  })

  it('[browser] disables assignment creation when every active task is already assigned', async () => {
    writeDocument('project-detail', '/projects/7')
    const controller = createProjectDirectoryController(detailApi())

    await controller.activate(
      identity('project_manager'),
      new AbortController().signal,
      () => false,
    )
    document.querySelector<HTMLButtonElement>('[data-task-assignment-create]')!.click()

    expect(
      document.querySelector<HTMLButtonElement>('[data-task-assignment-form-submit]')!.disabled,
    ).toBe(true)
    expect(document.querySelector('[data-task-assignment-form-result]')?.textContent).toContain(
      'already assigned',
    )
  })

  it('[security] closes every archive cancel control without mutating either resource', async () => {
    writeDocument('project-detail', '/projects/7')
    const archiveDirectoryProject = vi.fn(async () => undefined)
    const archiveProjectTaskAssignment = vi.fn(async () => undefined)
    const api = detailApi({ archiveDirectoryProject, archiveProjectTaskAssignment })
    const controller = createProjectDirectoryController(api)

    await controller.activate(identity('administrator'), new AbortController().signal, () => false)
    const projectDialog = document.querySelector<HTMLDialogElement>('[data-project-archive-dialog]')!
    const projectArchive = document.querySelector<HTMLButtonElement>('[data-project-archive]')!
    for (const cancel of projectDialog.querySelectorAll<HTMLButtonElement>('button[value="cancel"]')) {
      projectArchive.click()
      expect(projectDialog.open).toBe(true)
      cancel.click()
      expect(projectDialog.open).toBe(false)
    }
    expect(archiveDirectoryProject).not.toHaveBeenCalled()

    const assignmentDialog = document.querySelector<HTMLDialogElement>(
      '[data-task-assignment-archive-dialog]',
    )!
    const assignmentArchive = [
      ...document.querySelectorAll<HTMLButtonElement>('[data-project-task-assignments] button'),
    ].find((button) => button.textContent === 'Archive')!
    for (const cancel of assignmentDialog.querySelectorAll<HTMLButtonElement>(
      'button[value="cancel"]',
    )) {
      assignmentArchive.click()
      expect(assignmentDialog.open).toBe(true)
      cancel.click()
      expect(assignmentDialog.open).toBe(false)
    }
    expect(archiveProjectTaskAssignment).not.toHaveBeenCalled()
  })

  it('[browser #486] restores an archived project from the detail header', async () => {
    // 66 of this account's 78 projects arrived archived, and DELETE is Harvest's
    // archive: without this the header offered a one-way door.
    writeDocument('project-detail', '/projects/7')
    let stored: GeneralResource = { ...project, is_active: false }
    const getDirectoryProject = vi.fn(async () => stored)
    const updateDirectoryProject = vi.fn(async (_id: number, patch: Record<string, unknown>) => {
      stored = { ...stored, ...patch }
      return stored
    })
    const archiveDirectoryProject = vi.fn(async () => undefined)
    const api = detailApi({ getDirectoryProject, updateDirectoryProject, archiveDirectoryProject })

    await createProjectDirectoryController(api).activate(
      identity('administrator'),
      new AbortController().signal,
      () => false,
    )

    const archiveAction = document.querySelector<HTMLButtonElement>('[data-project-archive]')!
    const restoreAction = document.querySelector<HTMLButtonElement>('[data-project-restore]')!
    expect(document.querySelector('[data-project-facts]')?.textContent).toContain('Archived')
    expect(archiveAction.hidden).toBe(true)
    expect(restoreAction.hidden).toBe(false)

    restoreAction.click()

    await vi.waitFor(() =>
      expect(updateDirectoryProject).toHaveBeenCalledWith(
        7,
        { is_active: true },
        expect.any(AbortSignal),
      ),
    )
    await vi.waitFor(() =>
      expect(document.querySelector('[data-project-detail-status]')?.textContent).toBe(
        'Project restored.',
      ),
    )
    // The detail is reloaded rather than patched in place, so the Status fact is
    // what the server now holds and not what the click hoped for.
    expect(getDirectoryProject).toHaveBeenCalledTimes(2)
    expect(document.querySelector('[data-project-facts]')?.textContent).not.toContain('Archived')
    expect(
      document.querySelector<HTMLDialogElement>('[data-project-archive-dialog]')!.open,
    ).toBe(false)
    expect(archiveDirectoryProject).not.toHaveBeenCalled()
    expect(archiveAction.hidden).toBe(false)
    expect(restoreAction.hidden).toBe(true)
  })

  it('[browser] drops the Costs column rather than filling it with dashes', async () => {
    // A viewer whose profile cannot see cost gets no cost_cents on any row, so
    // the column would be an em dash in every cell -- which reads as "no cost
    // recorded" rather than "not yours to see".
    writeDocument('project-list', '/projects')
    const controller = createProjectDirectoryController({
      listDirectoryProjects: vi.fn(async () => page([project])),
      listProjectClients: vi.fn(async () => page([client])),
      listProjectBudgetSummaries: vi.fn(async () => [
        { project_id: 7, unit: 'cents' as const, spent_cents: 5000 },
      ]),
    })
    await controller.activate(identity('member'), new AbortController().signal, () => false)

    const headers = [...document.querySelectorAll('[data-project-list] thead th')].map(
      (cell) => cell.textContent,
    )
    expect(headers).not.toContain('Costs')
    expect(headers).toContain('Spent')
  })


  it('[browser] finds a project by its own name and by its client', async () => {
    // Both arrays are already resident before the first row is drawn, which is
    // what makes this a filter rather than a request.
    writeDocument('project-list', '/projects')
    const northpeak: GeneralResource = { ...client, id: 4, name: 'Northpeak' }
    const rebrand: GeneralResource = { ...project, id: 8, name: 'Rebrand', code: null, client_id: 4 }
    const controller = createProjectDirectoryController({
      listDirectoryProjects: vi.fn(async () => page([project, rebrand])),
      listProjectClients: vi.fn(async () => page([client, northpeak])),
    })
    await controller.activate(identity('administrator'), new AbortController().signal, () => false)

    const names = (): string[] =>
      [
        ...document.querySelectorAll<HTMLAnchorElement>(
          '[data-project-list] a[href^="/projects/"]',
        ),
      ].map((link) => link.textContent ?? '')
    const search = document.querySelector<HTMLInputElement>('[data-project-search]')!
    expect(names()).toEqual(['[WEB] Launch', 'Rebrand'])

    search.value = 'rebr'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    expect(names()).toEqual(['Rebrand'])

    // The client band is as often what you remember of a project as its name.
    search.value = 'acme'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    expect(names()).toEqual(['[WEB] Launch'])

    search.value = 'nothing here'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    expect(names()).toEqual([])
    expect(document.querySelector('[data-project-list-status]')?.textContent).toBe(
      'No projects match these filters.',
    )
  })
  it('[browser] keeps the Costs column when a viewer can see cost', async () => {
    writeDocument('project-list', '/projects')
    const controller = createProjectDirectoryController({
      listDirectoryProjects: vi.fn(async () => page([project])),
      listProjectClients: vi.fn(async () => page([client])),
      listProjectBudgetSummaries: vi.fn(async () => [
        { project_id: 7, unit: 'cents' as const, spent_cents: 5000, cost_cents: 2500 },
      ]),
    })
    await controller.activate(identity('administrator'), new AbortController().signal, () => false)

    const headers = [...document.querySelectorAll('[data-project-list] thead th')].map(
      (cell) => cell.textContent,
    )
    expect(headers).toContain('Costs')
  })

  it('[browser] says how many tracked entries are missing from the money totals', async () => {
    // A total that is short by a stated amount is a task. A total that is
    // silently short is a bug report.
    writeDocument('project-list', '/projects')
    const controller = createProjectDirectoryController({
      listDirectoryProjects: vi.fn(async () => page([project])),
      listProjectClients: vi.fn(async () => page([client])),
      listProjectBudgetSummaries: vi.fn(async () => [
        { project_id: 7, unit: 'cents' as const, spent_cents: 5000, unpriced_entry_count: 3 },
      ]),
    })
    await controller.activate(identity('administrator'), new AbortController().signal, () => false)

    const banner = document.querySelector<HTMLElement>('[data-project-quality]')
    expect(banner?.hidden).toBe(false)
    expect(banner?.textContent).toContain('3 tracked entries have no rate')
  })

  it('[browser] formats money in the currency the server resolved, not a guess', async () => {
    // The list used to derive this from the client in its own payload and fall
    // back to USD when the client was missing. A EUR project rendered as
    // dollars, silently, with the right digits and the wrong meaning.
    writeDocument('project-list', '/projects')
    const controller = createProjectDirectoryController({
      listDirectoryProjects: vi.fn(async () => page([project])),
      // Deliberately empty: the client the project belongs to is absent, which
      // is the case the old fallback got wrong.
      listProjectClients: vi.fn(async () => page([])),
      listProjectBudgetSummaries: vi.fn(async () => [
        {
          project_id: 7,
          unit: 'cents' as const,
          spent_cents: 5000,
          currency: 'EUR',
        },
      ]),
    })
    await controller.activate(identity('administrator'), new AbortController().signal, () => false)

    const spent = document.querySelector('[data-project-list] tbody tr[data-row]')?.textContent ?? ''
    expect(spent).toContain('€50.00')
    expect(spent).not.toContain('$50.00')
  })

  it('[browser] filters projects by active state and client', async () => {
    writeDocument('project-list', '/projects')
    const secondClient = { ...client, id: 4, name: 'Beta' }
    const api: Partial<ProjectDirectoryApi> = {
      listDirectoryProjects: vi.fn(async () => page([
        project,
        { ...project, id: 8, client_id: 4, name: 'Archived', is_active: false },
      ])),
      listProjectClients: vi.fn(async () => page([client, secondClient])),
    }
    const controller = createProjectDirectoryController(api)
    await controller.activate(identity('member'), new AbortController().signal, () => false)

    expect(document.querySelectorAll('[data-project-list] tbody tr[data-row]')).toHaveLength(1)
    document.querySelector<HTMLButtonElement>('[data-project-filter="all"]')!.click()
    expect(document.querySelectorAll('[data-project-list] tbody tr[data-row]')).toHaveLength(2)

    // The client is a band above its run of rows, not a column repeated on
    // every one of them.
    const bands = [...document.querySelectorAll('[data-project-list] .data-table-group th')].map(
      (cell) => cell.textContent,
    )
    expect(bands).toHaveLength(2)
    expect(new Set(bands).size).toBe(2)
    // The band names the client, so it is also the way into that client.
    expect(
      [...document.querySelectorAll<HTMLAnchorElement>(
        '[data-project-list] .data-table-group th a',
      )].map((link) => link.getAttribute('href')),
    ).toEqual(['/clients/3', '/clients/4'])
    const filter = document.querySelector<HTMLSelectElement>('[data-project-client-filter]')!
    filter.value = '4'
    filter.dispatchEvent(new Event('change'))
    expect(document.querySelector('[data-project-list]')?.textContent).toContain('Archived')
    expect(document.querySelector('[data-project-list]')?.textContent).not.toContain('Launch')
  })

  it('[security] keeps an ended session\u2019s list failure off the next session\u2019s page', async () => {
    // projects\u2019 handleFailure returned false for a session that had gone,
    // which read at the call site as "not handled -- carry on", so the catch
    // wrote the previous user\u2019s error over a cleared page and offered them a
    // Retry for a request that is not theirs to make.
    writeDocument('project-list', '/projects')
    let failClients: ((error: unknown) => void) | null = null
    const listProjectClients = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          failClients = reject
        }),
    )
    const onSessionFailure = vi.fn(() => false)
    const auth = new AbortController()
    const controller = createProjectDirectoryController({
      listDirectoryProjects: vi.fn(async () => page([project])),
      listProjectClients,
    })

    const activation = controller.activate(identity('administrator'), auth.signal, onSessionFailure)
    await vi.waitFor(() => expect(listProjectClients).toHaveBeenCalledTimes(1))
    auth.abort()
    failClients!(new Error('The client list could not be loaded.'))
    await activation

    expect(document.body.textContent).not.toContain('The client list could not be loaded.')
    expect(document.querySelector('[data-project-list-status]')?.textContent).toBe(
      'Loading projects\u2026',
    )
    expect(document.querySelector<HTMLButtonElement>('[data-project-list-retry]')?.hidden).toBe(true)
    expect(onSessionFailure).not.toHaveBeenCalled()
  })

  it('[security] keeps an ended session\u2019s attachment failure off the next session\u2019s page', async () => {
    writeDocument('project-detail', '/projects/7')
    let failAttachments: ((error: unknown) => void) | null = null
    const listDirectoryProjectAttachments = vi.fn(
      () =>
        new Promise<Attachment[]>((_resolve, reject) => {
          failAttachments = reject
        }),
    )
    const auth = new AbortController()
    const controller = createProjectDirectoryController(
      detailApi({ listDirectoryProjectAttachments }),
    )

    const activation = controller.activate(identity('administrator'), auth.signal, () => false)
    await vi.waitFor(() => expect(listDirectoryProjectAttachments).toHaveBeenCalledTimes(1))
    auth.abort()
    failAttachments!(new Error('The attachment list could not be read.'))
    await activation

    expect(document.querySelector('[data-project-attachment-status]')?.textContent).toBe('')
    expect(document.body.textContent).not.toContain('The attachment list could not be read.')
  })

  it('[security] keeps an ended session\u2019s save failure out of the project dialog', async () => {
    // The `if (!handleFailure(error))` shape: false for a dead session meant
    // the message was painted, and the dialog it lives in is reopened by the
    // next user with the previous one\u2019s failure already in it.
    writeDocument('project-detail', '/projects/7')
    let failSave: ((error: unknown) => void) | null = null
    const updateDirectoryProject = vi.fn(
      () =>
        new Promise<GeneralResource>((_resolve, reject) => {
          failSave = reject
        }),
    )
    const auth = new AbortController()
    const controller = createProjectDirectoryController(detailApi({ updateDirectoryProject }))

    await controller.activate(identity('administrator'), auth.signal, () => false)
    document.querySelector<HTMLButtonElement>('[data-project-edit]')!.click()
    const form = document.querySelector<HTMLFormElement>('[data-project-form]')!
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(updateDirectoryProject).toHaveBeenCalledTimes(1))

    auth.abort()
    failSave!(new Error('Saving the project was refused.'))
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLDialogElement>('[data-project-form-dialog]')?.open).toBe(
        false,
      ),
    )
    await Promise.resolve()
    await Promise.resolve()

    expect(document.querySelector('[data-project-form-result]')?.textContent).not.toContain(
      'Saving the project was refused.',
    )
  })

  it('[security] does not sign the next user out with an ended session\u2019s 401', async () => {
    // The case the null-session tests above cannot reach: somebody has signed
    // in since, so currentSession() is not null, it is *them*. Asking it who to
    // report to handed the previous session\u2019s 401 to the new session\u2019s shell,
    // which did the right thing with a 401 and signed the wrong person out.
    writeDocument('project-list', '/projects')
    let failClients: ((error: unknown) => void) | null = null
    const listProjectClients = vi.fn(() =>
      listProjectClients.mock.calls.length === 1
        ? new Promise<ReturnType<typeof page>>((_resolve, reject) => {
            failClients = reject
          })
        : Promise.resolve(page([client])),
    )
    const controller = createProjectDirectoryController({
      listDirectoryProjects: vi.fn(async () => page([project])),
      listProjectClients,
    })
    const first = new AbortController()

    const activation = controller.activate(identity('administrator'), first.signal, () => false)
    await vi.waitFor(() => expect(listProjectClients).toHaveBeenCalledTimes(1))
    first.abort()

    const second = new AbortController()
    const nextSessionFailure = vi.fn((error: unknown) => {
      if (!(error instanceof EzactoApiError) || error.status !== 401) return false
      second.abort()
      return true
    })
    await controller.activate(identity('member'), second.signal, nextSessionFailure)

    failClients!(new EzactoApiError(401, { error: { message: 'Session expired.' } }, null))
    await activation

    expect(nextSessionFailure).not.toHaveBeenCalled()
    expect(second.signal.aborted).toBe(false)
    expect(document.body.textContent).not.toContain('Session expired.')
  })
})
