/** @vitest-environment happy-dom */

// #933: the saved reports library shares with named people and with roles,
// shows an administrator the reports that are not theirs, and lets only the
// owner or an administrator delete -- through a dialog, not confirm().
import type { GeneralResource, SavedReport, Whoami } from '@conflict-hq/ezacto-client'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createReportsController } from '../src/reports/browser.js'
import type { ReportWorkspaceApi } from '../src/reports/model.js'
import { renderAppShell, reportKindTabs } from '../src/index.js'

const timestamp = '2026-10-18T12:00:00.000Z'
const identity = (profile: Whoami['profile'], userId = 1): Whoami => ({
  user_id: userId,
  profile,
  manager_grants: [],
  authentication: { kind: 'session' },
})

const writeDocument = (): void => {
  const path = '/reports?report=uninvoiced&from=2026-08-01&to=2026-08-31'
  window.history.replaceState(null, '', path)
  document.open()
  document.write(
    renderAppShell({
      environment: 'test',
      release: 'saved-sharing-test',
      activeSection: 'Reports',
      view: 'reports',
      tabs: reportKindTabs('uninvoiced'),
    })
      .replace(/ {2}<link[^>]+(?:fonts\.googleapis|fonts\.gstatic|\/assets\/ezacto\.css)[^>]*>\n/gu, '')
      .replace('  <script type="module" src="/assets/ezacto.js"></script>\n', ''),
  )
  document.close()
}

const person = (id: number, first: string, last: string): GeneralResource => ({
  id,
  first_name: first,
  last_name: last,
  is_active: true,
  created_at: timestamp,
  updated_at: timestamp,
})

const saved = (overrides: Partial<SavedReport> = {}): SavedReport => ({
  id: 'client-hours',
  name: 'Client hours',
  version: 1,
  fields: [{ id: 'client_name', label: 'Client', visible: true }],
  metrics: ['hours'],
  filters: [],
  group_by: { dimension: 'client' },
  presentation: { result: 'summary', grouped: true, include_zero_values: false },
  owner: { user_id: 1, name: 'Ada Byron' },
  is_custom: true,
  view: null,
  pinned: false,
  shared: false,
  shared_with: { users: [], profiles: [] },
  owned_by_viewer: true,
  can_delete: true,
  created_at: timestamp,
  updated_at: timestamp,
  ...overrides,
})

const emptyPage = { data: [], page: { next_cursor: null } }

const mount = async (
  profile: Whoami['profile'],
  reports: readonly SavedReport[],
  overrides: Partial<ReportWorkspaceApi> = {},
): Promise<void> => {
  writeDocument()
  const api: Partial<ReportWorkspaceApi> = {
    listReportClients: vi.fn(async () => emptyPage),
    listReportProjects: vi.fn(async () => emptyPage),
    getUninvoicedReport: vi.fn(async () => ({
      from: '2026-08-01', to: '2026-08-31', client_id: null, project_id: null, totals: [], projects: [],
    })),
    listSavedReports: vi.fn(async () => reports),
    ...overrides,
  }
  const session = new AbortController()
  await createReportsController(api).activate(identity(profile), session.signal, () => false)
  document.querySelector<HTMLButtonElement>('[data-saved-reports-open]')!.click()
  await vi.waitFor(() => expect(document.querySelector('[data-saved-list]')?.textContent).toContain('Client hours'))
}

const buttons = (): string[] =>
  [...document.querySelectorAll<HTMLButtonElement>('[data-saved-list] article button')]
    .filter((button) => !button.hidden)
    .map((button) => button.textContent ?? '')

const button = (label: string): HTMLButtonElement =>
  [...document.querySelectorAll<HTMLButtonElement>('[data-saved-list] article button')]
    .find((candidate) => candidate.textContent === label)!

describe('saved report sharing screen (#933)', () => {
  it('lets the owner share with a role and a named person and take either back', async () => {
    const shareSavedReportWithRole = vi.fn(async () => undefined)
    const unshareSavedReportWithRole = vi.fn(async () => undefined)
    const shareSavedReport = vi.fn(async () => undefined)
    const unshareSavedReport = vi.fn(async () => undefined)
    const listDirectoryUsers = vi.fn(async () => ({
      data: [person(1, 'Ada', 'Byron'), person(2, 'Grace', 'Hopper'), person(3, 'Alan', 'Turing')],
      page: { next_cursor: null },
    }))
    await mount(
      'accounting',
      [saved({ shared_with: { users: [{ user_id: 3, name: 'Alan Turing' }], profiles: ['accounting'] } })],
      { shareSavedReportWithRole, unshareSavedReportWithRole, shareSavedReport, unshareSavedReport, listDirectoryUsers },
    )
    expect(document.querySelector('[data-saved-list]')?.textContent).toContain('Shared with 2')

    button('Share').click()
    const dialog = document.querySelector<HTMLDialogElement>('[data-saved-share-dialog]')!
    expect(dialog.open).toBe(true)
    await vi.waitFor(() => expect(listDirectoryUsers).toHaveBeenCalled())
    const roleBoxes = [...document.querySelectorAll<HTMLInputElement>('[data-saved-share-roles] input')]
    expect(roleBoxes.map((box) => box.checked)).toEqual([true, false])
    expect(document.querySelector('[data-saved-share-people]')?.textContent).toContain('Alan Turing')

    // The picker leaves out the owner and anyone already shared with.
    await vi.waitFor(() =>
      expect([...document.querySelectorAll<HTMLOptionElement>('[data-saved-share-person] option')].map((o) => o.textContent))
        .toEqual(['Grace Hopper']))

    roleBoxes[1]!.checked = true
    roleBoxes[1]!.dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(shareSavedReportWithRole).toHaveBeenCalledWith('client-hours', 'executive_manager', expect.anything()))
    await vi.waitFor(() => expect(document.querySelector('[data-saved-share-result]')?.getAttribute('aria-busy')).toBe('false'))
    roleBoxes[0]!.checked = false
    roleBoxes[0]!.dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(unshareSavedReportWithRole).toHaveBeenCalledWith('client-hours', 'accounting', expect.anything()))

    await vi.waitFor(() => expect(document.querySelector('[data-saved-share-result]')?.getAttribute('aria-busy')).toBe('false'))
    document.querySelector<HTMLButtonElement>('[data-saved-share-add]')!.click()
    await vi.waitFor(() => expect(shareSavedReport).toHaveBeenCalledWith('client-hours', 2, expect.anything()))
    await vi.waitFor(() => expect(document.querySelector('[data-saved-share-people]')?.textContent).toContain('Grace Hopper'))

    document.querySelector<HTMLButtonElement>('[aria-label="Stop sharing with Alan Turing"]')!.click()
    await vi.waitFor(() => expect(unshareSavedReport).toHaveBeenCalledWith('client-hours', 3, expect.anything()))
    await vi.waitFor(() => expect(document.querySelector('[data-saved-share-people]')?.textContent).not.toContain('Alan Turing'))
  })

  it('puts a role back on the screen when the server refuses the change', async () => {
    const shareSavedReportWithRole = vi.fn(async () => {
      throw new Error('Report not found.')
    })
    await mount('accounting', [saved()], { shareSavedReportWithRole })
    button('Share').click()
    const box = document.querySelectorAll<HTMLInputElement>('[data-saved-share-roles] input')[1]!
    box.checked = true
    box.dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(document.querySelector('[data-saved-share-result]')?.textContent).toContain('Report not found'))
    expect(box.checked).toBe(false)
  })

  it('shows an administrator a private report that is not theirs, to open or delete but not to share', async () => {
    await mount('administrator', [
      saved({ owner: { user_id: 7, name: 'Olive Owner' }, owned_by_viewer: false, can_delete: true }),
    ])
    expect(document.querySelector('[data-saved-list]')?.textContent).toContain('Visible to you as an administrator')
    expect(buttons()).toEqual(['Client hours', 'Pin', 'Duplicate', 'Delete'])
  })

  it('gives someone it was shared with no way to delete, share or edit it', async () => {
    await mount('accounting', [
      saved({ owner: { user_id: 7, name: 'Olive Owner' }, owned_by_viewer: false, can_delete: false, shared: true }),
    ])
    expect(document.querySelector('[data-saved-list]')?.textContent).toContain('Shared with you')
    expect(buttons()).toEqual(['Client hours', 'Pin', 'Duplicate'])
  })

  it('confirms a delete in a dialog and does nothing when it is cancelled', async () => {
    const deleteSavedReport = vi.fn(async () => undefined)
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    onTestFinished(() => { vi.unstubAllGlobals() })
    await mount('accounting', [saved()], { deleteSavedReport })

    button('Delete').click()
    const dialog = document.querySelector<HTMLDialogElement>('[data-saved-delete-dialog]')!
    expect(dialog.open).toBe(true)
    expect(document.querySelector('[data-saved-delete-title]')?.textContent).toBe('Delete Client hours?')
    document.querySelector<HTMLButtonElement>('button[data-saved-delete-cancel]:not([aria-label])')!.click()
    expect(dialog.open).toBe(false)
    expect(deleteSavedReport).not.toHaveBeenCalled()

    button('Delete').click()
    document.querySelector<HTMLButtonElement>('[data-saved-delete-confirm]')!.click()
    await vi.waitFor(() => expect(deleteSavedReport).toHaveBeenCalledWith('client-hours', expect.anything()))
    expect(confirm).not.toHaveBeenCalled()
  })
})

it('keeps a reopened sharing dialog independent of a delayed earlier change', async () => {
  const completions: Array<() => void> = []
  const shareSavedReportWithRole = vi.fn(() => new Promise<void>(resolve => completions.push(resolve)))
  await mount('accounting', [saved()], { shareSavedReportWithRole })
  button('Share').click()
  const result = document.querySelector<HTMLElement>('[data-saved-share-result]')!
  const chooseRole = () => {
    const box = document.querySelectorAll<HTMLInputElement>('[data-saved-share-roles] input')[1]!
    box.checked = true
    box.dispatchEvent(new Event('change'))
    return box
  }
  const first = chooseRole()
  expect(first.disabled).toBe(true)
  expect(result.getAttribute('aria-busy')).toBe('true')
  first.dispatchEvent(new Event('change'))
  expect(shareSavedReportWithRole).toHaveBeenCalledTimes(1)
  document.querySelector<HTMLButtonElement>('[data-saved-share-close]')!.click()
  button('Share').click()
  const second = chooseRole()
  expect(shareSavedReportWithRole).toHaveBeenCalledTimes(2)
  completions[0]!()
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(second.disabled).toBe(true)
  expect(result.getAttribute('aria-busy')).toBe('true')
  expect(result.textContent).toContain('Updating sharing')
  completions[1]!()
  await vi.waitFor(() => expect(result.getAttribute('aria-busy')).toBe('false'))
  expect(second.disabled).toBe(false)
  expect(result.textContent).toContain('Shared with')
})
