import { renderDataTable, type CellContent } from '../components/data-table.js'
import { moneyText } from '../money-display.js'
import { EzactoApiError, type ExpenseCategory, type Whoami } from '@conflict-hq/ezacto-client'
import {
  expenseCategoryCanWrite,
  expenseCategoryFilterFromUrl,
  expenseCategoryFilterUrl,
  expenseCategoryInput,
  expenseCategoryMode,
  expenseCategoryPatch,
  expenseCategoryPricingLabel,
  type ExpenseCategoryDirectoryApi,
  type ExpenseCategoryFilter,
  type ExpenseCategoryFormValues,
} from './model.js'

const required = <ElementType extends Element>(selector: string): ElementType => {
  const item = document.querySelector<ElementType>(selector)
  if (item === null) throw new Error(`expense category element missing: ${selector}`)
  return item
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
    if (error.status === 401) return 'Your session ended. Sign in again to continue.'
    if (error.status === 403) return 'You do not have access to expense categories.'
  }
  return error instanceof Error ? error.message : 'The category request could not be completed.'
}

const formField = (
  form: HTMLFormElement,
  name: string,
): HTMLInputElement | HTMLSelectElement => {
  const field = form.elements.namedItem(name)
  if (!(field instanceof HTMLInputElement) && !(field instanceof HTMLSelectElement)) {
    throw new Error(`expense category form field missing: ${name}`)
  }
  return field
}

const formValues = (form: HTMLFormElement): ExpenseCategoryFormValues => {
  const mode = formField(form, 'mode').value
  if (mode !== 'direct' && mode !== 'unit') throw new Error('Choose a valid entry method.')
  return {
    name: formField(form, 'name').value,
    mode,
    unitName: formField(form, 'unit_name').value,
    unitPriceCents: formField(form, 'unit_price_cents').value,
  }
}

interface ActiveSession {
  readonly identity: Whoami
  readonly signal: AbortSignal
  readonly onSessionFailure: (error: unknown) => boolean
}

export interface ExpenseCategoryDirectoryController {
  activate(
    identity: Whoami,
    signal: AbortSignal,
    onSessionFailure: (error: unknown) => boolean,
  ): Promise<void>
}

export const createExpenseCategoryDirectoryController = (
  api: Partial<ExpenseCategoryDirectoryApi>,
): ExpenseCategoryDirectoryController => {
  const isPage = document.documentElement.dataset.appView === 'expense-categories'
  const page = required<HTMLElement>('[data-expense-categories-page]')
  const content = required<HTMLElement>('[data-expense-category-content]')
  const moduleUnavailable = required<HTMLElement>(
    '[data-expense-category-module-unavailable]',
  )
  const status = required<HTMLElement>('[data-expense-category-status]')
  const list = required<HTMLElement>('[data-expense-category-list]')
  const loadMore = required<HTMLButtonElement>('[data-expense-category-load-more]')
  const retry = required<HTMLButtonElement>('[data-expense-category-retry]')
  const createForm = required<HTMLFormElement>('[data-expense-category-create-form]')
  const createUnitFields = required<HTMLElement>(
    '[data-expense-category-create-unit-fields]',
  )
  const createSubmit = required<HTMLButtonElement>(
    '[data-expense-category-create-submit]',
  )
  const createResult = required<HTMLElement>('[data-expense-category-create-result]')
  const editDialog = required<HTMLDialogElement>('[data-expense-category-edit-dialog]')
  const editForm = required<HTMLFormElement>('[data-expense-category-edit-form]')
  const editUnitFields = required<HTMLElement>('[data-expense-category-edit-unit-fields]')
  const editSubmit = required<HTMLButtonElement>('[data-expense-category-edit-submit]')
  const editResult = required<HTMLElement>('[data-expense-category-edit-result]')
  const archiveDialog = required<HTMLDialogElement>(
    '[data-expense-category-archive-dialog]',
  )
  const archiveForm = required<HTMLFormElement>('[data-expense-category-archive-form]')
  const archiveConfirm = required<HTMLButtonElement>(
    '[data-expense-category-archive-confirm]',
  )
  const archiveResult = required<HTMLElement>('[data-expense-category-archive-result]')
  const filterButtons = [
    ...document.querySelectorAll<HTMLButtonElement>('[data-expense-category-filter]'),
  ]
  page.hidden = !isPage

  let activeSession: ActiveSession | null = null
  let filter: ExpenseCategoryFilter = 'active'
  let categories: readonly ExpenseCategory[] = []
  let nextCursor: string | null = null
  let listGeneration = 0
  let listPending = false
  let mutationPending = false
  let editingId: number | null = null
  let archivingId: number | null = null

  const current = (): ActiveSession | null =>
    activeSession === null || activeSession.signal.aborted ? null : activeSession

  const canWrite = (session = current()): boolean =>
    session !== null && expenseCategoryCanWrite(session.identity)

  const closeDialogs = (): void => {
    if (editDialog.open) editDialog.close()
    if (archiveDialog.open) archiveDialog.close()
  }

  const resetForms = (): void => {
    createForm.reset()
    editForm.reset()
    editingId = null
    archivingId = null
    createResult.textContent = ''
    editResult.textContent = ''
    archiveResult.textContent = ''
  }

  const syncMode = (form: HTMLFormElement, fields: HTMLElement): void => {
    const unit = formField(form, 'mode').value === 'unit'
    fields.hidden = !unit
    formField(form, 'unit_name').required = unit
    formField(form, 'unit_price_cents').required = unit
  }

  const syncFilters = (): void => {
    for (const button of filterButtons) {
      button.setAttribute(
        'aria-pressed',
        String(button.dataset.expenseCategoryFilter === filter),
      )
    }
  }

  const syncPending = (): void => {
    loadMore.disabled = listPending
    retry.disabled = listPending
    const writesEnabled = canWrite() && !mutationPending
    for (const item of document.querySelectorAll<HTMLElement>('[data-expense-category-write]')) {
      item.hidden = !canWrite()
    }
    for (const form of [createForm, editForm]) {
      for (const field of [...form.elements]) {
        if (
          field instanceof HTMLInputElement ||
          field instanceof HTMLSelectElement ||
          field instanceof HTMLButtonElement
        ) {
          field.disabled = !writesEnabled
        }
      }
    }
    createSubmit.disabled = !writesEnabled
    editSubmit.disabled = !writesEnabled
    archiveConfirm.disabled = !writesEnabled
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      '[data-expense-category-mutation]',
    )) {
      button.disabled = !writesEnabled
    }
  }

  const clearPrivatePresentation = (): void => {
    listGeneration += 1
    categories = []
    nextCursor = null
    listPending = false
    mutationPending = false
    list.replaceChildren()
    list.removeAttribute('aria-busy')
    status.textContent = 'Loading categories…'
    loadMore.hidden = true
    retry.hidden = true
    content.hidden = false
    moduleUnavailable.hidden = true
    closeDialogs()
    resetForms()
    syncMode(createForm, createUnitFields)
    syncMode(editForm, editUnitFields)
    syncPending()
  }

  const showModuleUnavailable = (): void => {
    categories = []
    nextCursor = null
    list.replaceChildren()
    list.removeAttribute('aria-busy')
    status.textContent = 'The expenses module is not enabled for this organization.'
    retry.hidden = true
    loadMore.hidden = true
    closeDialogs()
    content.hidden = true
    moduleUnavailable.hidden = false
  }

  const renderList = (): void => {
    if (categories.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'expense-category-empty'
      empty.textContent =
        filter === 'active'
          ? 'No active expense categories. An administrator can create the first one.'
          : 'No expense categories have been created or imported yet.'
      list.replaceChildren(empty)
      status.textContent = empty.textContent
      return
    }
    list.replaceChildren(
      renderDataTable<ExpenseCategory>({
        caption: 'Expense categories',
        rows: categories,
        rowKey: (category) => String(category.id),
        empty: 'No expense categories yet.',
        columns: [
          { key: 'name', label: 'Category', render: (category) => category.name },
          {
            key: 'pricing',
            label: 'Pricing',
            render: (category): CellContent => {
              const label = expenseCategoryPricingLabel(category)
              // A priced category states a unit price, and the unit it is per
              // is part of the price rather than a separate fact -- so the
              // phrase masks whole. The other two labels ("Amount entered on
              // each expense", "Incomplete unit pricing") name a configuration
              // and carry no figure at all.
              const priced =
                category.unit_name !== null && category.unit_price_cents !== null
              return priced ? moneyText(label) : label
            },
          },
          {
            key: 'status',
            label: 'Status',
            render: (category) => {
              if (category.is_active) return 'Active'
              const pill = document.createElement('span')
              pill.className = 'expense-status-pill'
              pill.textContent = 'Archived'
              return pill
            },
          },
        ],
        ...(canWrite()
          ? {
              actions: (category) => [
                {
                  label: 'Edit',
                  primary: true,
                  disabled: mutationPending,
                  dataset: { expenseCategoryMutation: '' },
                  onSelect: () => openEdit(category),
                },
                // Archiving takes a category away from every expense form, so it
                // stops to confirm. Restoring puts one back and takes nothing
                // away, so it does not -- the same reading of the same pair of
                // states the team roster's Archive/Restore menu already takes.
                category.is_active
                  ? {
                      label: 'Archive',
                      disabled: mutationPending,
                      dataset: { expenseCategoryMutation: '' },
                      onSelect: () => {
                        archivingId = category.id
                        archiveResult.textContent = ''
                        archiveDialog.showModal()
                      },
                    }
                  : {
                      label: 'Restore',
                      disabled: mutationPending,
                      dataset: { expenseCategoryMutation: '' },
                      onSelect: () => {
                        void restore(category)
                      },
                    },
              ],
            }
          : {}),
      }),
    )
    status.textContent = `${categories.length} ${categories.length === 1 ? 'category' : 'categories'} loaded${nextCursor === null ? '.' : '; more are available.'}`
  }

  const openEdit = (category: ExpenseCategory): void => {
    if (!canWrite()) return
    editingId = category.id
    editResult.textContent = ''
    formField(editForm, 'name').value = category.name
    formField(editForm, 'mode').value = expenseCategoryMode(category)
    formField(editForm, 'unit_name').value = category.unit_name ?? ''
    formField(editForm, 'unit_price_cents').value =
      category.unit_price_cents === null ? '' : String(category.unit_price_cents)
    syncMode(editForm, editUnitFields)
    editDialog.showModal()
    formField(editForm, 'name').focus()
  }

  const loadPage = async (reset: boolean): Promise<void> => {
    const session = current()
    if (session === null) return
    if (api.listDirectoryExpenseCategories === undefined) {
      list.replaceChildren()
      list.removeAttribute('aria-busy')
      status.textContent = 'Expense categories are unavailable in this build.'
      retry.hidden = true
      loadMore.hidden = true
      return
    }
    const generation = reset ? ++listGeneration : listGeneration
    const cursor = reset ? undefined : nextCursor ?? undefined
    if (!reset && nextCursor === null) return
    if (reset) {
      categories = []
      nextCursor = null
      list.replaceChildren()
    }
    listPending = true
    list.setAttribute('aria-busy', 'true')
    status.textContent = reset ? 'Loading categories…' : 'Loading more categories…'
    retry.hidden = true
    loadMore.hidden = true
    syncPending()
    try {
      const response = await api.listDirectoryExpenseCategories(
        filter === 'active',
        cursor,
        session.signal,
      )
      if (current() !== session || generation !== listGeneration) return
      const merged = new Map<number, ExpenseCategory>()
      for (const category of reset ? response.data : [...categories, ...response.data]) {
        merged.set(category.id, category)
      }
      categories = [...merged.values()]
      nextCursor = response.page.next_cursor
      renderList()
      loadMore.hidden = nextCursor === null
    } catch (error) {
      if (current() !== session || generation !== listGeneration) return
      if (session.onSessionFailure(error)) return
      if (apiErrorCode(error) === 'module_disabled') {
        showModuleUnavailable()
        return
      }
      list.replaceChildren()
      status.textContent = messageFor(error)
      retry.hidden = false
      loadMore.hidden = true
    } finally {
      if (current() === session && generation === listGeneration) {
        listPending = false
        list.removeAttribute('aria-busy')
        syncPending()
      }
    }
  }

  // The list's own status change, so it reports through the page status rather
  // than a dialog result: there is no dialog to read one in. The reload is what
  // says the category is back -- an active filter is the whole evidence that a
  // restored category can be picked again.
  const restore = async (category: ExpenseCategory): Promise<void> => {
    const session = current()
    if (
      session === null ||
      !canWrite(session) ||
      mutationPending ||
      api.updateDirectoryExpenseCategory === undefined
    ) return
    mutationPending = true
    status.textContent = 'Restoring category…'
    syncPending()
    try {
      await api.updateDirectoryExpenseCategory(
        category.id,
        { is_active: true },
        session.signal,
      )
      if (current() !== session) return
      await loadPage(true)
      if (current() === session) status.textContent = 'Category restored.'
    } catch (error) {
      if (current() !== session) return
      if (session.onSessionFailure(error)) return
      if (apiErrorCode(error) === 'module_disabled') {
        showModuleUnavailable()
        return
      }
      status.textContent =
        apiErrorCode(error) === 'profile_forbidden'
          ? 'Only administrators can manage expense categories.'
          : messageFor(error)
    } finally {
      if (current() === session) {
        mutationPending = false
        syncPending()
      }
    }
  }

  const applyLocation = (): void => {
    if (current() === null) return
    filter = expenseCategoryFilterFromUrl(new URL(globalThis.location.href))
    syncFilters()
    void loadPage(true)
  }

  for (const button of filterButtons) {
    button.addEventListener('click', () => {
      const next = button.dataset.expenseCategoryFilter
      if (next !== 'active' && next !== 'all') return
      if (next !== filter) globalThis.history.pushState(null, '', expenseCategoryFilterUrl(next))
      filter = next
      syncFilters()
      void loadPage(true)
    })
  }

  formField(createForm, 'mode').addEventListener('change', () => {
    syncMode(createForm, createUnitFields)
    createResult.textContent = ''
  })
  formField(editForm, 'mode').addEventListener('change', () => {
    syncMode(editForm, editUnitFields)
    editResult.textContent = ''
  })

  createForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const session = current()
    if (
      session === null ||
      !canWrite(session) ||
      mutationPending ||
      api.createDirectoryExpenseCategory === undefined
    ) return
    let input
    try {
      input = expenseCategoryInput(formValues(createForm))
    } catch (error) {
      createResult.textContent = messageFor(error)
      return
    }
    mutationPending = true
    createResult.textContent = 'Creating category…'
    syncPending()
    api
      .createDirectoryExpenseCategory(input, session.signal)
      .then(async () => {
        if (current() !== session) return
        createForm.reset()
        syncMode(createForm, createUnitFields)
        await loadPage(true)
        if (current() === session) createResult.textContent = 'Category created.'
      })
      .catch((error: unknown) => {
        if (current() !== session) return
        if (session.onSessionFailure(error)) return
        if (apiErrorCode(error) === 'module_disabled') {
          showModuleUnavailable()
          return
        }
        createResult.textContent =
          apiErrorCode(error) === 'profile_forbidden'
            ? 'Only administrators can manage expense categories.'
            : messageFor(error)
      })
      .finally(() => {
        if (current() === session) {
          mutationPending = false
          syncPending()
        }
      })
  })

  editForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const session = current()
    const categoryId = editingId
    if (
      session === null ||
      !canWrite(session) ||
      categoryId === null ||
      mutationPending ||
      api.updateDirectoryExpenseCategory === undefined
    ) return
    let patch
    try {
      patch = expenseCategoryPatch(formValues(editForm))
    } catch (error) {
      editResult.textContent = messageFor(error)
      return
    }
    mutationPending = true
    editResult.textContent = 'Saving category…'
    syncPending()
    api
      .updateDirectoryExpenseCategory(categoryId, patch, session.signal)
      .then(async () => {
        if (current() !== session) return
        editingId = null
        editDialog.close()
        await loadPage(true)
      })
      .catch((error: unknown) => {
        if (current() !== session) return
        if (session.onSessionFailure(error)) return
        if (apiErrorCode(error) === 'module_disabled') {
          showModuleUnavailable()
          return
        }
        editResult.textContent =
          apiErrorCode(error) === 'profile_forbidden'
            ? 'Only administrators can manage expense categories.'
            : messageFor(error)
      })
      .finally(() => {
        if (current() === session) {
          mutationPending = false
          syncPending()
        }
      })
  })

  archiveForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const confirmed =
      event.submitter instanceof HTMLButtonElement && event.submitter.value === 'confirm'
    if (!confirmed) {
      archivingId = null
      archiveDialog.close()
      return
    }
    const session = current()
    const categoryId = archivingId
    if (
      session === null ||
      !canWrite(session) ||
      categoryId === null ||
      mutationPending ||
      api.archiveDirectoryExpenseCategory === undefined
    ) return
    mutationPending = true
    archiveResult.textContent = 'Archiving category…'
    syncPending()
    api
      .archiveDirectoryExpenseCategory(categoryId, session.signal)
      .then(async () => {
        if (current() !== session) return
        archivingId = null
        archiveDialog.close()
        await loadPage(true)
      })
      .catch((error: unknown) => {
        if (current() !== session) return
        if (session.onSessionFailure(error)) return
        if (apiErrorCode(error) === 'module_disabled') {
          showModuleUnavailable()
          return
        }
        archiveResult.textContent =
          apiErrorCode(error) === 'profile_forbidden'
            ? 'Only administrators can manage expense categories.'
            : messageFor(error)
      })
      .finally(() => {
        if (current() === session) {
          mutationPending = false
          syncPending()
        }
      })
  })

  loadMore.addEventListener('click', () => {
    if (!listPending) void loadPage(false)
  })
  retry.addEventListener('click', () => {
    if (!listPending) void loadPage(true)
  })

  return {
    async activate(identity, signal, onSessionFailure) {
      if (!isPage) return
      const session = { identity, signal, onSessionFailure }
      activeSession = session
      filter = expenseCategoryFilterFromUrl(new URL(globalThis.location.href))
      clearPrivatePresentation()
      syncFilters()
      syncPending()
      globalThis.addEventListener('popstate', applyLocation, { signal })
      signal.addEventListener(
        'abort',
        () => {
          if (activeSession !== session) return
          activeSession = null
          clearPrivatePresentation()
          for (const item of document.querySelectorAll<HTMLElement>(
            '[data-expense-category-write]',
          )) item.hidden = true
          status.textContent = 'Sign in to view expense categories.'
        },
        { once: true },
      )
      await loadPage(true)
    },
  }
}
