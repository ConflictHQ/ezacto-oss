/** @vitest-environment happy-dom */

import type { GeneralResource, Whoami } from '@ezacto/client'
import { describe, expect, it, vi } from 'vitest'
import { createTaskAdminController } from '../src/tasks/browser.js'
import type { TaskAdminApi, TaskAdminFilter } from '../src/tasks/model.js'
import { renderAppShell } from '../src/index.js'

const timestamp = '2026-09-02T00:00:00.000Z'
const task = (
  id: number,
  name: string,
  overrides: Record<string, unknown> = {},
): GeneralResource => ({
  id,
  name,
  billable_by_default: true,
  default_hourly_rate_cents: 12_345,
  is_default: false,
  is_active: true,
  created_at: timestamp,
  updated_at: timestamp,
  ...overrides,
})

const identity = (
  profile: Whoami['profile'],
  manager_grants: readonly string[] = [],
  scopes?: readonly ('projects:read' | 'projects:write')[],
): Whoami => ({
  user_id: 1,
  profile,
  manager_grants: [...manager_grants],
  authentication:
    scopes === undefined
      ? { kind: 'session' }
      : { kind: 'token', token_id: 9, scopes: [...scopes] },
})

const page = (data: readonly GeneralResource[], next_cursor: string | null = null) => ({
  data,
  page: { next_cursor },
})

const writeDocument = (): void => {
  window.history.replaceState(null, '', '/tasks')
  document.open()
  document.write(
    renderAppShell({
      environment: 'test',
      release: 'task-browser-test',
      activeSection: 'Tasks',
      view: 'task-list',
    })
      .replace(/ {2}<link[^>]+(?:fonts\.googleapis|fonts\.gstatic|\/assets\/ezacto\.css)[^>]*>\n/gu, '')
      .replace('  <script type="module" src="/assets/ezacto.js"></script>\n', ''),
  )
  document.close()
}

const apiFor = (
  tasks: readonly GeneralResource[],
  overrides: Partial<TaskAdminApi> = {},
): Partial<TaskAdminApi> => ({
  listAdminTasks: vi.fn(async () => page(tasks)),
  createAdminTask: vi.fn(async (input) => task(20, String(input.name), input)),
  updateAdminTask: vi.fn(async (id, input) => ({ ...task(id, 'Updated'), ...input })),
  archiveAdminTask: vi.fn(async () => undefined),
  ...overrides,
})

const submit = (form: HTMLFormElement, submitter?: HTMLButtonElement): void => {
  form.dispatchEvent(
    new SubmitEvent('submit', {
      bubbles: true,
      cancelable: true,
      ...(submitter === undefined ? {} : { submitter }),
    }),
  )
}

const deferred = <T,>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
} => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

describe('Tasks administration browser controller', () => {
  it('[browser] creates and minimally edits exact-cent task defaults', async () => {
    writeDocument()
    const original = task(7, 'Implementation')
    const createAdminTask = vi.fn(async (input) => task(20, String(input.name), input))
    const updateAdminTask = vi.fn(async (_id, input) => ({ ...original, ...input }))
    const api = apiFor([original], { createAdminTask, updateAdminTask })
    const controller = createTaskAdminController(api)

    await controller.activate(identity('administrator'), new AbortController().signal, () => false)
    document.querySelector<HTMLButtonElement>('[data-task-create]')!.click()
    const form = document.querySelector<HTMLFormElement>('[data-task-form]')!
    ;(form.elements.namedItem('name') as HTMLInputElement).value = 'Quality assurance'
    ;(form.elements.namedItem('default_hourly_rate') as HTMLInputElement).value = '123.45'
    ;(form.elements.namedItem('is_default') as HTMLInputElement).checked = true
    submit(form)

    await vi.waitFor(() => expect(createAdminTask).toHaveBeenCalledTimes(1))
    expect(createAdminTask.mock.calls[0]![0]).toEqual({
      name: 'Quality assurance',
      billable_by_default: true,
      default_hourly_rate_cents: 12_345,
      is_default: true,
      is_active: true,
    })
    await vi.waitFor(() =>
      expect(document.querySelector('[data-task-form-dialog]')?.hasAttribute('open')).toBe(false),
    )

    document.querySelector<HTMLButtonElement>('[data-task-list] button')!.click()
    ;(form.elements.namedItem('name') as HTMLInputElement).value = 'Delivery'
    ;(form.elements.namedItem('default_hourly_rate') as HTMLInputElement).value = '125.01'
    submit(form)

    await vi.waitFor(() => expect(updateAdminTask).toHaveBeenCalledTimes(1))
    expect(updateAdminTask).toHaveBeenCalledWith(
      7,
      { name: 'Delivery', default_hourly_rate_cents: 12_501 },
      expect.any(AbortSignal),
    )
    await vi.waitFor(() => expect(form.querySelector('input')?.disabled).toBe(false))
  })

  it('[security] never renders or submits a hidden rate for an ungranted manager', async () => {
    writeDocument()
    const redacted = task(7, 'Implementation')
    delete redacted['default_hourly_rate_cents']
    const updateAdminTask = vi.fn(async (_id, input) => ({ ...redacted, ...input }))
    const api = apiFor([redacted], { updateAdminTask })
    const controller = createTaskAdminController(api)

    await controller.activate(identity('project_manager'), new AbortController().signal, () => false)
    expect(document.querySelector('[data-task-list]')?.textContent).not.toContain('$')
    document.querySelector<HTMLButtonElement>('[data-task-list] button')!.click()
    const form = document.querySelector<HTMLFormElement>('[data-task-form]')!
    const rateField = document.querySelector<HTMLElement>('[data-task-rate-field]')!
    expect(rateField.hidden).toBe(true)
    ;(form.elements.namedItem('default_hourly_rate') as HTMLInputElement).value = '999.99'
    ;(form.elements.namedItem('name') as HTMLInputElement).value = 'Manager update'
    submit(form)

    await vi.waitFor(() => expect(updateAdminTask).toHaveBeenCalledTimes(1))
    expect(updateAdminTask.mock.calls[0]![1]).toEqual({ name: 'Manager update' })
    expect(updateAdminTask.mock.calls[0]![1]).not.toHaveProperty('default_hourly_rate_cents')
  })

  it('[security] gives accounting rate visibility but no mutation controls', async () => {
    writeDocument()
    const createAdminTask = vi.fn()
    const updateAdminTask = vi.fn()
    const archiveAdminTask = vi.fn()
    const controller = createTaskAdminController(
      apiFor([task(7, 'Implementation')], {
        createAdminTask,
        updateAdminTask,
        archiveAdminTask,
      }),
    )

    await controller.activate(identity('accounting'), new AbortController().signal, () => false)

    expect(document.querySelector('[data-task-list]')?.textContent).toContain('$123.45/hour')
    expect(document.querySelector<HTMLButtonElement>('[data-task-create]')?.hidden).toBe(true)
    expect(document.querySelectorAll('[data-task-list] button')).toHaveLength(0)
    expect(createAdminTask).not.toHaveBeenCalled()
    expect(updateAdminTask).not.toHaveBeenCalled()
    expect(archiveAdminTask).not.toHaveBeenCalled()
  })

  it('[security] denies a token without projects:read before issuing a list request', async () => {
    writeDocument()
    const listAdminTasks = vi.fn(async () => page([]))
    const controller = createTaskAdminController({ listAdminTasks })

    await controller.activate(
      identity('administrator', [], ['projects:write']),
      new AbortController().signal,
      () => false,
    )

    expect(listAdminTasks).not.toHaveBeenCalled()
    expect(document.querySelector('[data-task-list-status]')?.textContent).toContain(
      'does not grant project read access',
    )
    expect(document.querySelector<HTMLButtonElement>('[data-task-create]')?.hidden).toBe(true)
  })

  it('[browser] paginates and reloads Active/All from the API', async () => {
    writeDocument()
    const listAdminTasks = vi.fn(
      async (filter: TaskAdminFilter, cursor?: string) =>
        filter === 'all'
          ? page([task(9, 'Archived', { is_active: false })])
          : cursor === undefined
            ? page([task(7, 'First')], 'next-page')
            : page([task(8, 'Second')]),
    )
    const controller = createTaskAdminController(apiFor([], { listAdminTasks }))

    await controller.activate(identity('administrator'), new AbortController().signal, () => false)
    expect(document.querySelector('[data-task-list]')?.textContent).toContain('First')
    document.querySelector<HTMLButtonElement>('[data-task-load-more]')!.click()
    await vi.waitFor(() =>
      expect(document.querySelector('[data-task-list]')?.textContent).toContain('Second'),
    )
    document.querySelector<HTMLButtonElement>('[data-task-filter="all"]')!.click()
    await vi.waitFor(() =>
      expect(document.querySelector('[data-task-list]')?.textContent).toContain('Archived'),
    )
    expect(document.querySelector('[data-task-list]')?.textContent).not.toContain('First')
    expect(listAdminTasks.mock.calls.map(([filter, cursor]) => [filter, cursor])).toEqual([
      ['active', undefined],
      ['active', 'next-page'],
      ['all', undefined],
    ])
  })

  it('[browser] lets a fresh filter response win over a stale in-flight response', async () => {
    writeDocument()
    const active = deferred<ReturnType<typeof page>>()
    const all = deferred<ReturnType<typeof page>>()
    const listAdminTasks = vi.fn((filter: TaskAdminFilter) =>
      filter === 'active' ? active.promise : all.promise,
    )
    const controller = createTaskAdminController(apiFor([], { listAdminTasks }))
    const activation = controller.activate(
      identity('administrator'),
      new AbortController().signal,
      () => false,
    )
    await vi.waitFor(() => expect(listAdminTasks).toHaveBeenCalledTimes(1))
    document.querySelector<HTMLButtonElement>('[data-task-filter="all"]')!.click()
    await vi.waitFor(() => expect(listAdminTasks).toHaveBeenCalledTimes(2))
    all.resolve(page([task(9, 'Archived winner', { is_active: false })]))
    await vi.waitFor(() =>
      expect(document.querySelector('[data-task-list]')?.textContent).toContain('Archived winner'),
    )
    active.resolve(page([task(7, 'Stale active')]))
    await activation

    expect(document.querySelector('[data-task-list]')?.textContent).toContain('Archived winner')
    expect(document.querySelector('[data-task-list]')?.textContent).not.toContain('Stale active')
  })

  it('[browser] locks every form control while saving and restores the failed draft', async () => {
    writeDocument()
    const update = deferred<GeneralResource>()
    const updateAdminTask = vi.fn(() => update.promise)
    const controller = createTaskAdminController(
      apiFor([task(7, 'Implementation')], { updateAdminTask }),
    )
    await controller.activate(identity('administrator'), new AbortController().signal, () => false)
    document.querySelector<HTMLButtonElement>('[data-task-list] button')!.click()
    const form = document.querySelector<HTMLFormElement>('[data-task-form]')!
    ;(form.elements.namedItem('name') as HTMLInputElement).value = 'Failed draft'
    submit(form)
    await vi.waitFor(() => expect(updateAdminTask).toHaveBeenCalledTimes(1))
    expect(
      [...form.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')].every(
        (control) => control.disabled,
      ),
    ).toBe(true)

    update.reject(new Error('Task write was rejected.'))
    await vi.waitFor(() =>
      expect(document.querySelector('[data-task-form-result]')?.textContent).toBe(
        'Task write was rejected.',
      ),
    )
    expect(document.querySelector('[data-task-form-dialog]')?.hasAttribute('open')).toBe(true)
    expect((form.elements.namedItem('name') as HTMLInputElement).value).toBe('Failed draft')
    expect(
      [...form.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')].every(
        (control) => !control.disabled,
      ),
    ).toBe(true)
  })

  it('[security] clears private state and stale mutation state across sessions', async () => {
    writeDocument()
    const update = deferred<GeneralResource>()
    const newSessionList = deferred<ReturnType<typeof page>>()
    let listCalls = 0
    const listAdminTasks = vi.fn(() => {
      listCalls += 1
      return listCalls === 1
        ? Promise.resolve(page([task(7, 'Private first-session task')]))
        : newSessionList.promise
    })
    const updateAdminTask = vi.fn(() => update.promise)
    const controller = createTaskAdminController(
      apiFor([], { listAdminTasks, updateAdminTask }),
    )
    const first = new AbortController()
    await controller.activate(identity('administrator'), first.signal, () => false)
    document.querySelector<HTMLButtonElement>('[data-task-list] button')!.click()
    const form = document.querySelector<HTMLFormElement>('[data-task-form]')!
    ;(form.elements.namedItem('name') as HTMLInputElement).value = 'Pending private update'
    submit(form)
    await vi.waitFor(() => expect(updateAdminTask).toHaveBeenCalledTimes(1))

    first.abort()
    expect(document.querySelector('[data-task-list]')?.textContent).not.toContain('Private')
    expect(document.querySelector('[data-task-form-dialog]')?.hasAttribute('open')).toBe(false)
    const second = controller.activate(
      identity('member'),
      new AbortController().signal,
      () => false,
    )
    expect(document.querySelector('[data-task-list]')?.textContent).not.toContain('Private')
    update.resolve(task(7, 'Stale private response'))
    newSessionList.resolve(page([task(8, 'Second-session task')]))
    await second

    expect(document.querySelector('[data-task-list]')?.textContent).toContain('Second-session task')
    expect(document.querySelector('[data-task-list]')?.textContent).not.toContain('Stale private')
    expect(document.querySelector<HTMLButtonElement>('[data-task-create]')?.hidden).toBe(true)
  })

  it('[browser] archives only from explicit confirmation and refreshes without replay', async () => {
    writeDocument()
    const archiveAdminTask = vi.fn(async () => undefined)
    const listAdminTasks = vi
      .fn()
      .mockResolvedValueOnce(page([task(7, 'Implementation')]))
      .mockRejectedValueOnce(new Error('Refresh failed'))
      .mockResolvedValueOnce(page([]))
    const controller = createTaskAdminController(
      apiFor([], { listAdminTasks, archiveAdminTask }),
    )
    await controller.activate(identity('administrator'), new AbortController().signal, () => false)
    const archiveButton = [...document.querySelectorAll<HTMLButtonElement>('[data-task-list] button')]
      .find((button) => button.textContent === 'Archive')!
    archiveButton.click()
    const archiveForm = document.querySelector<HTMLFormElement>('[data-task-archive-form]')!
    const cancel = [...archiveForm.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.value === 'cancel')!
    submit(archiveForm, cancel)
    expect(archiveAdminTask).not.toHaveBeenCalled()

    archiveButton.click()
    const confirm = document.querySelector<HTMLButtonElement>('[data-task-archive-confirm]')!
    submit(archiveForm, confirm)
    await vi.waitFor(() => expect(archiveAdminTask).toHaveBeenCalledTimes(1))
    await vi.waitFor(() =>
      expect(document.querySelector('[data-task-list-status]')?.textContent).toBe('Refresh failed'),
    )
    document.querySelector<HTMLButtonElement>('[data-task-list-retry]')!.click()
    await vi.waitFor(() => expect(listAdminTasks).toHaveBeenCalledTimes(3))
    expect(archiveAdminTask).toHaveBeenCalledTimes(1)
  })

  it('[security] routes a session failure through the shell and clears on abort', async () => {
    writeDocument()
    const controllerAbort = new AbortController()
    const expired = new Error('expired')
    const onSessionFailure = vi.fn((error: unknown) => {
      if (error !== expired) return false
      controllerAbort.abort()
      return true
    })
    const controller = createTaskAdminController({
      listAdminTasks: vi.fn(async () => {
        throw expired
      }),
    })

    await controller.activate(identity('administrator'), controllerAbort.signal, onSessionFailure)

    expect(onSessionFailure).toHaveBeenCalledWith(expired)
    expect(document.querySelector('[data-task-list]')?.textContent).toBe('')
    expect(document.querySelector<HTMLButtonElement>('[data-task-create]')?.hidden).toBe(true)
  })
})
