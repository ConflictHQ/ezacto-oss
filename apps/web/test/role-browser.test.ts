/** @vitest-environment happy-dom */

import type { GeneralResource, Whoami } from '@conflict-hq/ezacto-client'
import { describe, expect, it, vi } from 'vitest'
import { createRoleAdminController } from '../src/roles/browser.js'
import type { RoleAdminApi } from '../src/roles/model.js'
import { renderAppShell } from '../src/index.js'

const timestamp = '2026-09-11T00:00:00.000Z'

const role = (id: number, name: string): GeneralResource =>
  ({ id, name, created_at: timestamp, updated_at: timestamp }) as unknown as GeneralResource

const person = (id: number, roleIds: readonly number[]): GeneralResource =>
  ({ id, role_ids: [...roleIds] }) as unknown as GeneralResource

const identity = (profile: Whoami['profile']): Whoami => ({
  user_id: 1,
  profile,
  manager_grants: [],
  authentication: { kind: 'session' },
})

const page = (data: readonly GeneralResource[]) => ({
  data,
  page: { next_cursor: null },
})

const writeDocument = (): void => {
  window.history.replaceState(null, '', '/settings/roles')
  document.open()
  document.write(
    renderAppShell({
      environment: 'test',
      release: 'role-browser-test',
      activeSection: 'Settings',
      view: 'settings-roles',
    })
      .replace(/ {2}<link[^>]+>\n/gu, '')
      .replace('  <script type="module" src="/assets/ezacto.js"></script>\n', ''),
  )
  document.close()
}

const baseApi = (overrides: Partial<RoleAdminApi> = {}): Partial<RoleAdminApi> => ({
  listRoles: vi.fn(async () => page([role(1, 'Designer'), role(2, 'Engineer')])),
  listRoleHolders: vi.fn(async () => page([person(1, [1, 2]), person(2, [2])])),
  createRole: vi.fn(async (input) => ({ id: 3, ...input }) as GeneralResource),
  updateRole: vi.fn(async (id, input) => ({ id, ...input }) as GeneralResource),
  deleteRole: vi.fn(async () => undefined),
  ...overrides,
})

const cards = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('[data-role-list] [data-role-id]'),
]

describe('role admin controller', () => {
  it('[browser #485] lists the roles and says how many people hold each', async () => {
    writeDocument()
    await createRoleAdminController(baseApi()).activate(
      identity('administrator'),
      new AbortController().signal,
      () => false,
    )

    // Counted before anything is read off them, so an empty fixture cannot
    // satisfy the assertions below by finding nothing wrong.
    expect(cards()).toHaveLength(2)
    expect(cards()[0]!.textContent).toContain('Designer')
    // Holder counts are what make a delete a decision rather than a click.
    expect(cards()[0]!.textContent).toContain('1 person holds this role.')
    expect(cards()[1]!.textContent).toContain('2 people hold this role.')
    expect(document.querySelector('[data-role-list-status]')?.textContent).toBe('2 roles.')
  })

  it('[security] shows no write control to a profile the route would refuse', async () => {
    writeDocument()
    const api = baseApi()
    await createRoleAdminController(api).activate(
      identity('member'),
      new AbortController().signal,
      () => false,
    )

    // The list is readable -- who holds which role is not a secret -- but every
    // control that would 403 is absent rather than present and failing.
    expect(cards()).toHaveLength(2)
    expect(document.querySelector<HTMLButtonElement>('[data-role-create]')?.hidden).toBe(true)
    expect(document.querySelector('[data-role-edit]')).toBeNull()
    expect(document.querySelector('[data-role-delete]')).toBeNull()
    expect(api.updateRole).not.toHaveBeenCalled()
    expect(api.deleteRole).not.toHaveBeenCalled()
  })

  it('[browser #485] refuses a duplicate name before it reaches the unique constraint', async () => {
    writeDocument()
    const api = baseApi()
    await createRoleAdminController(api).activate(
      identity('administrator'),
      new AbortController().signal,
      () => false,
    )

    document.querySelector<HTMLButtonElement>('[data-role-create]')!.click()
    const form = document.querySelector<HTMLFormElement>('[data-role-form]')!
    const name = form.elements.namedItem('name') as HTMLInputElement
    // Same role, different case: SQLite's UNIQUE would let this through, and a
    // list with Designer and designer in it is the same role twice.
    name.value = 'designer'
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))

    expect(api.createRole).not.toHaveBeenCalled()
    expect(document.querySelector('[data-role-form-result]')?.textContent).toContain(
      'already exists',
    )

    name.value = 'Producer'
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(api.createRole).toHaveBeenCalled())
    expect(vi.mocked(api.createRole!).mock.calls[0]![0]).toEqual({ name: 'Producer' })
  })

  it('[browser #485] names what a delete detaches before it happens', async () => {
    writeDocument()
    const api = baseApi()
    await createRoleAdminController(api).activate(
      identity('administrator'),
      new AbortController().signal,
      () => false,
    )

    // Engineer, held by two people: deleting it takes it off both, because
    // user_roles cascades.
    cards()[1]!.querySelector<HTMLButtonElement>('[data-role-delete]')!.click()
    const dialog = document.querySelector<HTMLDialogElement>('[data-role-delete-dialog]')!
    expect(dialog.open).toBe(true)
    expect(document.querySelector('[data-role-delete-detail]')?.textContent).toContain(
      '2 people hold this role.',
    )

    // Cancelling is not deleting.
    const form = document.querySelector<HTMLFormElement>('[data-role-delete-form]')!
    const cancel = new SubmitEvent('submit', {
      bubbles: true,
      cancelable: true,
      submitter: document.createElement('button'),
    })
    form.dispatchEvent(cancel)
    expect(api.deleteRole).not.toHaveBeenCalled()
  })

  it('[security] clears the previous account’s roles before the next one draws', async () => {
    writeDocument()
    const first = new AbortController()
    await createRoleAdminController(
      baseApi({ listRoles: vi.fn(async () => page([role(9, 'First Account Role')])) }),
    ).activate(identity('administrator'), first.signal, () => false)
    expect(document.body.textContent).toContain('First Account Role')

    first.abort()
    const second = new AbortController()
    await createRoleAdminController(
      baseApi({
        listRoles: vi.fn(async () => page([role(8, 'Second Account Role')])),
        listRoleHolders: vi.fn(async () => page([])),
      }),
    ).activate(identity('administrator'), second.signal, () => false)

    expect(document.body.textContent).toContain('Second Account Role')
    expect(document.body.textContent).not.toContain('First Account Role')
  })
})
