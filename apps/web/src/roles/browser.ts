import { EzactoApiError, type GeneralResource, type Whoami } from '@conflict-hq/ezacto-client'
import { sessionPresenter, type SessionPresenter } from '../session.js'
import {
  canManageRoles,
  roleHolderCounts,
  roleHolderLabel,
  roleName,
  roleNameTaken,
  type RoleAdminApi,
} from './model.js'

const required = <ElementType extends Element>(selector: string): ElementType => {
  const element = document.querySelector<ElementType>(selector)
  if (element === null) throw new Error(`role admin element missing: ${selector}`)
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
  readonly canWrite: boolean
  readonly signal: AbortSignal
}

export interface RoleAdminController {
  activate(
    identity: Whoami,
    signal: AbortSignal,
    onSessionFailure: (error: unknown) => boolean,
  ): Promise<void>
}

export const createRoleAdminController = (
  api: Partial<RoleAdminApi>,
): RoleAdminController => {
  const status = required<HTMLElement>('[data-role-list-status]')
  const list = required<HTMLUListElement>('[data-role-list]')
  const createButton = required<HTMLButtonElement>('[data-role-create]')
  const retry = required<HTMLButtonElement>('[data-role-list-retry]')
  const formDialog = required<HTMLDialogElement>('[data-role-form-dialog]')
  const form = required<HTMLFormElement>('[data-role-form]')
  const formTitle = required<HTMLElement>('[data-role-form-title]')
  const formResult = required<HTMLElement>('[data-role-form-result]')
  const formSubmit = required<HTMLButtonElement>('[data-role-form-submit]')
  const dialogClose = required<HTMLButtonElement>('[data-role-dialog-close]')
  const deleteDialog = required<HTMLDialogElement>('[data-role-delete-dialog]')
  const deleteForm = required<HTMLFormElement>('[data-role-delete-form]')
  const deleteDetail = required<HTMLElement>('[data-role-delete-detail]')
  const deleteResult = required<HTMLElement>('[data-role-delete-result]')
  const deleteConfirm = required<HTMLButtonElement>('[data-role-delete-confirm]')

  let session: ActiveSession | null = null
  let roles: readonly GeneralResource[] = []
  let holders: ReadonlyMap<number, number> = new Map()
  let mutationPending = false
  let editingRole: GeneralResource | null = null
  let deletingRole: GeneralResource | null = null

  const currentSession = (): ActiveSession | null =>
    session === null || session.signal.aborted ? null : session

  const nameControl = (): HTMLInputElement => {
    const control = form.elements.namedItem('name')
    if (!(control instanceof HTMLInputElement)) {
      throw new Error('role form field missing: name')
    }
    return control
  }

  const closeDialogs = (): void => {
    if (formDialog.open) formDialog.close()
    if (deleteDialog.open) deleteDialog.close()
  }

  const syncMutationControls = (): void => {
    const writable = currentSession()?.canWrite === true
    createButton.hidden = !writable
    createButton.disabled = !writable || mutationPending
    formSubmit.disabled = mutationPending
    deleteConfirm.disabled = mutationPending
  }

  const renderList = (): void => {
    const active = currentSession()
    if (active === null) return
    if (roles.length === 0) {
      const empty = document.createElement('li')
      empty.className = 'project-related-empty'
      empty.textContent = 'No roles are defined.'
      list.replaceChildren(empty)
      return
    }
    list.replaceChildren(
      ...roles.map((role) => {
        const item = document.createElement('li')
        item.className = 'project-task-card'
        item.dataset.roleId = String(role.id)
        const details = document.createElement('div')
        const heading = document.createElement('strong')
        heading.textContent = roleName(role)
        const holderLine = document.createElement('p')
        holderLine.textContent = roleHolderLabel(holders.get(role.id) ?? 0)
        details.append(heading)
        details.append(holderLine)
        item.append(details)
        if (active.canWrite) {
          const actions = document.createElement('div')
          const rename = document.createElement('button')
          rename.type = 'button'
          rename.dataset.roleEdit = String(role.id)
          rename.disabled = mutationPending
          rename.textContent = 'Rename'
          rename.addEventListener('click', () => openForm(role))
          const remove = document.createElement('button')
          remove.type = 'button'
          remove.dataset.roleDelete = String(role.id)
          remove.disabled = mutationPending
          remove.textContent = 'Delete'
          remove.addEventListener('click', () => {
            deletingRole = role
            // Named, because deleting a role detaches it from everybody who
            // holds it -- ON DELETE CASCADE on user_roles -- and how many that
            // is decides whether this is housekeeping or a change to people's
            // records.
            deleteDetail.textContent = `${roleHolderLabel(holders.get(role.id) ?? 0)} Their time entries are untouched.`
            deleteResult.textContent = ''
            deleteDialog.showModal()
          })
          actions.append(rename, remove)
          item.append(actions)
        }
        return item
      }),
    )
  }

  const openForm = (role: GeneralResource | null): void => {
    const active = currentSession()
    if (active === null || !active.canWrite || mutationPending) return
    editingRole = role
    form.reset()
    formTitle.textContent = role === null ? 'Add role' : 'Rename role'
    formSubmit.textContent = role === null ? 'Add role' : 'Save role'
    formResult.textContent = ''
    nameControl().value = role === null ? '' : roleName(role)
    formDialog.showModal()
    nameControl().focus()
  }

  const loadRoles = async (active: ActiveSession): Promise<void> => {
    if (api.listRoles === undefined) {
      status.textContent = 'Role management is unavailable in this build.'
      return
    }
    status.textContent = 'Loading roles…'
    retry.hidden = true
    try {
      const [page, people] = await Promise.all([
        api.listRoles(undefined, active.signal),
        api.listRoleHolders === undefined
          ? Promise.resolve(null)
          : api.listRoleHolders(active.signal),
      ])
      if (currentSession() !== active) return
      roles = page.data
      holders = people === null ? new Map() : roleHolderCounts(people.data)
      renderList()
      status.textContent = `${roles.length} ${roles.length === 1 ? 'role' : 'roles'}.`
    } catch (error) {
      active.presentFailure(error, () => {
        // Cleared rather than left standing: the list belongs to a session that
        // just failed, and a stale one under an error reads as current.
        roles = []
        list.replaceChildren()
        status.textContent = messageFor(error)
        retry.hidden = false
      })
    }
  }

  createButton.addEventListener('click', () => openForm(null))
  dialogClose.addEventListener('click', () => formDialog.close())
  retry.addEventListener('click', () => {
    const active = currentSession()
    if (active !== null) void loadRoles(active)
  })

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const active = currentSession()
    if (active === null || !active.canWrite || mutationPending) return
    const create = editingRole === null
    const operation = create ? api.createRole : api.updateRole
    if (operation === undefined) return
    const name = nameControl().value.trim()
    if (name === '') {
      formResult.textContent = 'A role needs a name.'
      nameControl().focus()
      return
    }
    // roles.name is UNIQUE, so the server refuses this anyway. Saying it here
    // turns a constraint error into a sentence about the name.
    if (roleNameTaken(roles, name, editingRole?.id ?? null)) {
      formResult.textContent = `A role called ${name} already exists.`
      nameControl().focus()
      return
    }
    mutationPending = true
    syncMutationControls()
    formResult.textContent = create ? 'Adding role…' : 'Saving role…'
    const request = create
      ? api.createRole!({ name }, active.signal)
      : api.updateRole!(editingRole!.id, { name }, active.signal)
    void request
      .then(async () => {
        if (currentSession() !== active) return
        formDialog.close()
        editingRole = null
        await loadRoles(active)
        if (currentSession() === active) {
          status.textContent = create ? 'Role added.' : 'Role saved.'
        }
      })
      .catch((error: unknown) => {
        active.presentFailure(error, () => {
          formResult.textContent = messageFor(error)
        })
      })
      .finally(() => {
        if (currentSession() === active) {
          mutationPending = false
          syncMutationControls()
        }
      })
  })

  deleteForm.addEventListener('submit', (event) => {
    event.preventDefault()
    if (!confirmedDialogSubmit(event)) return
    const active = currentSession()
    const role = deletingRole
    if (
      active === null ||
      role === null ||
      !active.canWrite ||
      mutationPending ||
      api.deleteRole === undefined
    ) {
      return
    }
    mutationPending = true
    syncMutationControls()
    deleteResult.textContent = 'Deleting role…'
    void api.deleteRole(role.id, active.signal)
      .then(async () => {
        if (currentSession() !== active) return
        deletingRole = null
        deleteDialog.close()
        await loadRoles(active)
        if (currentSession() === active) status.textContent = 'Role deleted.'
      })
      .catch((error: unknown) => {
        active.presentFailure(error, () => {
          deleteResult.textContent = messageFor(error)
        })
      })
      .finally(() => {
        if (currentSession() === active) {
          mutationPending = false
          syncMutationControls()
        }
      })
  })

  return {
    activate: async (identity, signal, onSessionFailure) => {
      closeDialogs()
      // Every trace of the previous session goes before the next one draws:
      // roles are not money, but who holds them is a fact about people and does
      // not belong to whoever signs in next.
      roles = []
      holders = new Map()
      editingRole = null
      deletingRole = null
      mutationPending = false
      list.replaceChildren()
      const active: ActiveSession = {
        identity,
        canWrite: canManageRoles(identity.profile),
        signal,
        ...sessionPresenter(() => currentSession() === active, onSessionFailure),
      }
      session = active
      syncMutationControls()
      if (signal.aborted) return
      await loadRoles(active)
    },
  }
}
