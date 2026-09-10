import { renderDataTable, type DataColumn } from '../components/data-table.js'
import { sessionPresenter, type SessionPresenter } from '../session.js'
import { EzactoApiError, type GeneralResource, type Whoami } from '@ezacto/client'
import {
  formatTaskRate,
  parseTaskRateCents,
  taskAdminCapabilities,
  taskBoolean,
  taskIsActive,
  taskName,
  taskRateCents,
  taskRateInputValue,
  type TaskAdminApi,
  type TaskAdminCapabilities,
  type TaskAdminFilter,
} from './model.js'

const required = <ElementType extends Element>(selector: string): ElementType => {
  const element = document.querySelector<ElementType>(selector)
  if (element === null) throw new Error(`task admin element missing: ${selector}`)
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

const confirmedDialogSubmit = (event: SubmitEvent): boolean =>
  event.submitter instanceof HTMLButtonElement && event.submitter.value === 'confirm'

interface ActiveSession extends SessionPresenter {
  readonly identity: Whoami
  readonly capabilities: TaskAdminCapabilities
  readonly signal: AbortSignal
}

export interface TaskAdminController {
  activate(
    identity: Whoami,
    signal: AbortSignal,
    onSessionFailure: (error: unknown) => boolean,
  ): Promise<void>
}

export const createTaskAdminController = (
  api: Partial<TaskAdminApi>,
): TaskAdminController => {
  const page = required<HTMLElement>('[data-task-admin-page]')
  const status = required<HTMLElement>('[data-task-list-status]')
  const list = required<HTMLElement>('[data-task-list]')
  const createButton = required<HTMLButtonElement>('[data-task-create]')
  const loadMore = required<HTMLButtonElement>('[data-task-load-more]')
  const search = required<HTMLInputElement>('[data-task-search]')
  const retry = required<HTMLButtonElement>('[data-task-list-retry]')
  const formDialog = required<HTMLDialogElement>('[data-task-form-dialog]')
  const form = required<HTMLFormElement>('[data-task-form]')
  const formTitle = required<HTMLElement>('[data-task-form-title]')
  const formResult = required<HTMLElement>('[data-task-form-result]')
  const formSubmit = required<HTMLButtonElement>('[data-task-form-submit]')
  const dialogClose = required<HTMLButtonElement>('[data-task-dialog-close]')
  const rateField = required<HTMLElement>('[data-task-rate-field]')
  const archiveDialog = required<HTMLDialogElement>('[data-task-archive-dialog]')
  const archiveForm = required<HTMLFormElement>('[data-task-archive-form]')
  const archiveResult = required<HTMLElement>('[data-task-archive-result]')
  const archiveConfirm = required<HTMLButtonElement>('[data-task-archive-confirm]')

  let session: ActiveSession | null = null
  let filter: TaskAdminFilter = 'active'
  let tasks: readonly GeneralResource[] = []
  let nextCursor: string | null = null
  let listGeneration = 0
  let listPendingGeneration: number | null = null
  let mutationPending = false
  let editingTask: GeneralResource | null = null
  let archivingTask: GeneralResource | null = null

  const currentSession = (): ActiveSession | null =>
    session === null || session.signal.aborted ? null : session

  const formControl = (name: string): HTMLInputElement => {
    const control = form.elements.namedItem(name)
    if (!(control instanceof HTMLInputElement)) {
      throw new Error(`task form field missing: ${name}`)
    }
    return control
  }

  const closeDialogs = (): void => {
    if (formDialog.open) formDialog.close()
    if (archiveDialog.open) archiveDialog.close()
  }

  const syncMutationControls = (): void => {
    const active = currentSession()
    const writable = active?.capabilities.canWrite === true
    rateField.hidden = active?.capabilities.canViewRate !== true
    createButton.hidden = !writable
    createButton.disabled = !writable || mutationPending
    for (const control of form.elements) {
      if (
        control instanceof HTMLInputElement ||
        control instanceof HTMLButtonElement
      ) {
        control.disabled = !writable || mutationPending
      }
    }
    dialogClose.disabled = !writable || mutationPending
    for (const control of archiveForm.elements) {
      if (control instanceof HTMLButtonElement) {
        control.disabled = !writable || mutationPending
      }
    }
    archiveConfirm.disabled = !writable || mutationPending
  }

  const clearPrivatePresentation = (): void => {
    listGeneration += 1
    listPendingGeneration = null
    tasks = []
    nextCursor = null
    mutationPending = false
    editingTask = null
    archivingTask = null
    list.replaceChildren()
    form.reset()
    formResult.textContent = ''
    archiveResult.textContent = ''
    search.value = ''
    status.textContent = 'Loading tasks…'
    retry.hidden = true
    loadMore.hidden = true
    loadMore.disabled = false
    list.removeAttribute('aria-busy')
    closeDialogs()
    syncMutationControls()
  }

  /**
   * What the status line says when no filter is narrowing the list. Both the
   * render path and the fetch path need it, and two copies of a sentence like
   * this drift the moment one of them is edited.
   */
  const loadedSummary = (): string =>
    tasks.length === 0
      ? filter === 'active'
        ? 'No active tasks found.'
        : filter === 'archived'
          ? 'No archived tasks found.'
          : 'No tasks found.'
      : `${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'} loaded${nextCursor === null ? '.' : '; more are available.'}`

  const renderList = (): void => {
    const active = currentSession()
    if (active === null) return
    // Tasks arrive a page at a time, so this searches what has been loaded and
    // the status line says so: a name on page two is not missing, it is not here
    // yet, and "load more" is the honest instruction.
    const wanted = search.value.trim().toLocaleLowerCase('en-US')
    const visible = tasks.filter((task) =>
      taskName(task).toLocaleLowerCase('en-US').includes(wanted),
    )
    if (wanted !== '') {
      status.textContent =
        `${visible.length} of ${tasks.length} loaded ${tasks.length === 1 ? 'task matches' : 'tasks match'}` +
        `${nextCursor === null ? '.' : '; load more to search the rest.'}`
    } else {
      // Clearing the box is not a fetch, so loadList never runs and nothing
      // else rewrites this. Without it the live region kept the match count
      // from the search just cleared -- a screen reader hearing "0 of 2 match"
      // while both rows are on screen. Projects and clients rewrite their
      // status on every render; tasks was the one that did not.
      status.textContent = loadedSummary()
    }
    if (visible.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'task-admin-empty'
      empty.textContent =
        wanted !== ''
          ? 'No loaded tasks match that filter.'
          : filter === 'active'
            ? 'No active tasks have been created or imported yet.'
            : filter === 'archived'
              ? 'No tasks are archived.'
              : 'No tasks have been created or imported yet.'
      list.replaceChildren(empty)
      return
    }
    const columns: DataColumn<Readonly<GeneralResource>>[] = [
      { key: 'name', label: 'Task', render: (task) => taskName(task) },
      { key: 'status', label: 'Status', render: (task) => (taskIsActive(task) ? 'Active' : 'Archived') },
      {
        key: 'billable',
        label: 'Billable',
        render: (task) => (taskBoolean(task, 'billable_by_default') ? 'By default' : 'No'),
      },
      {
        key: 'default',
        label: 'New projects',
        render: (task) => (taskBoolean(task, 'is_default') ? 'Added' : 'Optional'),
      },
    ]
    // The rate column is a permission, not a preference — it must not appear at
    // all for someone who cannot view rates.
    if (active.capabilities.canViewRate) {
      columns.push({
        key: 'rate',
        label: 'Rate',
        numeric: true,
        render: (task) => formatTaskRate(taskRateCents(task)),
      })
    }

    list.replaceChildren(
      renderDataTable<Readonly<GeneralResource>>({
        caption: 'Tasks',
        rows: visible,
        rowKey: (task) => String(task.id),
        columns,
        empty: 'No tasks yet.',
        ...(active.capabilities.canWrite
          ? {
              actions: (task) => [
                {
                  label: taskIsActive(task) ? 'Edit' : 'Edit or reactivate',
                  primary: true,
                  disabled: mutationPending,
                  onSelect: () => openForm(task),
                },
                ...(taskIsActive(task)
                  ? [
                      {
                        label: 'Archive',
                        disabled: mutationPending,
                        onSelect: () => {
                          archivingTask = task
                          archiveResult.textContent = ''
                          archiveDialog.showModal()
                          syncMutationControls()
                        },
                      },
                    ]
                  : []),
              ],
            }
          : {}),
      }),
    )
  }

  const setFilter = (next: TaskAdminFilter): void => {
    filter = next
    for (const control of document.querySelectorAll<HTMLButtonElement>('[data-task-filter]')) {
      control.setAttribute('aria-pressed', String(control.dataset.taskFilter === filter))
    }
  }

  const loadList = async (
    active: ActiveSession,
    append = false,
    successMessage?: string,
  ): Promise<void> => {
    if (api.listAdminTasks === undefined) {
      status.textContent = 'Task administration is unavailable in this build.'
      return
    }
    const cursor = append ? nextCursor ?? undefined : undefined
    if (append && cursor === undefined) return
    const requestGeneration = ++listGeneration
    const requestFilter = filter
    listPendingGeneration = requestGeneration
    retry.hidden = true
    loadMore.disabled = true
    list.setAttribute('aria-busy', 'true')
    status.textContent = append ? 'Loading more tasks…' : 'Loading tasks…'
    try {
      const result = await api.listAdminTasks(requestFilter, cursor, active.signal)
      if (
        currentSession() !== active ||
        requestGeneration !== listGeneration ||
        requestFilter !== filter
      ) return
      tasks = append ? [...tasks, ...result.data] : [...result.data]
      nextCursor = result.page.next_cursor
      renderList()
      loadMore.hidden = nextCursor === null
      // An active filter owns the status line -- renderList has just written how
      // much of what is loaded matches -- unless a mutation has its own news.
      if (successMessage !== undefined || search.value.trim() === '') {
        status.textContent = successMessage ?? loadedSummary()
      }
    } catch (error) {
      active.presentFailure(error, () => {
        // Generation and filter are the list's own currency -- a newer request
        // for this same session -- and stay the caller's to check.
        if (requestGeneration !== listGeneration || requestFilter !== filter) return
        status.textContent = messageFor(error)
        retry.hidden = false
        loadMore.hidden = true
      })
    } finally {
      if (currentSession() === active && requestGeneration === listGeneration) {
        listPendingGeneration = null
        list.removeAttribute('aria-busy')
        loadMore.disabled = false
      }
    }
  }

  const openForm = (task: GeneralResource | null): void => {
    const active = currentSession()
    if (active === null || !active.capabilities.canWrite || mutationPending) return
    editingTask = task
    formTitle.textContent = task === null ? 'Add task' : 'Edit task'
    formSubmit.textContent = task === null ? 'Add task' : 'Save task'
    formResult.textContent = ''
    form.reset()
    formControl('name').value = task === null ? '' : taskName(task)
    formControl('billable_by_default').checked =
      task === null ? true : taskBoolean(task, 'billable_by_default')
    formControl('is_default').checked =
      task === null ? false : taskBoolean(task, 'is_default')
    formControl('is_active').checked = task === null || taskIsActive(task)
    formControl('default_hourly_rate').value =
      task === null ? '' : taskRateInputValue(taskRateCents(task))
    formDialog.showModal()
    syncMutationControls()
    formControl('name').focus()
  }

  const formPayload = (): Record<string, unknown> => {
    const active = currentSession()
    if (active === null || !active.capabilities.canWrite) {
      throw new Error('Task write access is required.')
    }
    const name = formControl('name').value.trim()
    if (name === '') throw new Error('Task name is required.')
    const values: Record<string, unknown> = {
      name,
      billable_by_default: formControl('billable_by_default').checked,
      is_default: formControl('is_default').checked,
      is_active: formControl('is_active').checked,
    }
    if (active.capabilities.canViewRate) {
      values.default_hourly_rate_cents = parseTaskRateCents(
        formControl('default_hourly_rate').value,
      )
    }
    if (editingTask === null) return values
    const patch: Record<string, unknown> = {}
    if (name !== taskName(editingTask)) patch.name = name
    for (const field of ['billable_by_default', 'is_default'] as const) {
      if (values[field] !== taskBoolean(editingTask, field)) patch[field] = values[field]
    }
    if (values.is_active !== taskIsActive(editingTask)) patch.is_active = values.is_active
    if (
      active.capabilities.canViewRate &&
      values.default_hourly_rate_cents !== taskRateCents(editingTask)
    ) {
      patch.default_hourly_rate_cents = values.default_hourly_rate_cents
    }
    return patch
  }

  createButton.addEventListener('click', () => openForm(null))
  dialogClose.addEventListener('click', () => {
    if (!mutationPending) {
      editingTask = null
      formDialog.close('cancel')
    }
  })
  formDialog.addEventListener('close', () => {
    if (!mutationPending) editingTask = null
  })

  // Each state is a fresh request, because this list is the one directory of
  // the three that pages from the server rather than holding everything. That
  // is also why its Archived button carries no count while the client and
  // project ones do: the only number available here is how many archived rows
  // have been loaded so far, which grows as you press Load more, and a filter
  // label that changes while you read it is worse than one that stays quiet.
  for (const control of document.querySelectorAll<HTMLButtonElement>('[data-task-filter]')) {
    control.addEventListener('click', () => {
      const next = control.dataset.taskFilter
      if (next !== 'active' && next !== 'archived' && next !== 'all') return
      if (next === filter && listPendingGeneration === null) return
      setFilter(next)
      tasks = []
      nextCursor = null
      list.replaceChildren()
      const active = currentSession()
      if (active !== null) void loadList(active)
    })
  }
  search.addEventListener('input', renderList)

  loadMore.addEventListener('click', () => {
    const active = currentSession()
    if (active !== null && listPendingGeneration === null) void loadList(active, true)
  })
  retry.addEventListener('click', () => {
    const active = currentSession()
    if (active !== null) void loadList(active)
  })

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const active = currentSession()
    if (active === null || !active.capabilities.canWrite || mutationPending) return
    const create = editingTask === null
    if (
      (create && api.createAdminTask === undefined) ||
      (!create && api.updateAdminTask === undefined)
    ) {
      formResult.textContent = 'Task changes are unavailable in this build.'
      return
    }
    let payload: Record<string, unknown>
    try {
      payload = formPayload()
    } catch (error) {
      formResult.textContent = messageFor(error)
      return
    }
    if (!create && Object.keys(payload).length === 0) {
      formResult.textContent = 'No task changes to save.'
      return
    }
    const taskId = editingTask?.id ?? null
    mutationPending = true
    syncMutationControls()
    formResult.textContent = create ? 'Adding task…' : 'Saving task…'
    const request = create
      ? api.createAdminTask!(payload, active.signal)
      : api.updateAdminTask!(taskId!, payload, active.signal)
    void request
      .then(async () => {
        if (currentSession() !== active) return
        mutationPending = false
        editingTask = null
        formDialog.close()
        syncMutationControls()
        await loadList(active, false, create ? 'Task added.' : 'Task saved.')
      })
      .catch((error: unknown) => {
        active.presentFailure(error, () => {
          formResult.textContent = messageFor(error)
        })
      })
      .finally(() => {
        if (currentSession() === active && mutationPending) {
          mutationPending = false
          syncMutationControls()
        }
      })
  })

  archiveForm.addEventListener('submit', (event) => {
    event.preventDefault()
    if (!confirmedDialogSubmit(event)) {
      if (!mutationPending) {
        archivingTask = null
        archiveDialog.close('cancel')
      }
      return
    }
    const active = currentSession()
    const task = archivingTask
    if (
      active === null ||
      !active.capabilities.canWrite ||
      task === null ||
      mutationPending ||
      api.archiveAdminTask === undefined
    ) return
    mutationPending = true
    syncMutationControls()
    archiveResult.textContent = 'Archiving task…'
    void api.archiveAdminTask(task.id, active.signal)
      .then(async () => {
        if (currentSession() !== active) return
        mutationPending = false
        archivingTask = null
        archiveDialog.close()
        syncMutationControls()
        await loadList(active, false, 'Task archived.')
      })
      .catch((error: unknown) => {
        active.presentFailure(error, () => {
          archiveResult.textContent = messageFor(error)
        })
      })
      .finally(() => {
        if (currentSession() === active && mutationPending) {
          mutationPending = false
          syncMutationControls()
        }
      })
  })

  return {
    async activate(identity, signal, onSessionFailure) {
      clearPrivatePresentation()
      setFilter('active')
      const active: ActiveSession = {
        identity,
        capabilities: taskAdminCapabilities(identity),
        signal,
        ...sessionPresenter(() => currentSession() === active, onSessionFailure),
      }
      session = active
      page.hidden = false
      syncMutationControls()
      if (signal.aborted) return
      signal.addEventListener(
        'abort',
        () => {
          if (session !== active) return
          session = null
          clearPrivatePresentation()
        },
        { once: true },
      )
      if (!active.capabilities.canRead) {
        status.textContent =
          identity.authentication.kind === 'token'
            ? 'This API token does not grant project read access.'
            : 'Your profile does not have access to tasks.'
        return
      }
      await loadList(active)
    },
  }
}
