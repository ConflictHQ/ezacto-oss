/** @vitest-environment happy-dom */

// #933: the Saved tab at /reports/saved, saving the report on screen as a view,
// Save changes on a saved report that is open, and pinned quick links.
import type { SavedReport, Whoami } from '@conflict-hq/ezacto-client'
import { describe, expect, it, vi } from 'vitest'
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

const writeDocument = (path: string, tab: string | null): void => {
  window.history.replaceState(null, '', path)
  document.open()
  document.write(
    renderAppShell({
      environment: 'test',
      release: 'saved-screen-test',
      activeSection: 'Reports',
      view: 'reports',
      tabs: reportKindTabs(tab),
    })
      .replace(/ {2}<link[^>]+(?:fonts\.googleapis|fonts\.gstatic|\/assets\/ezacto\.css)[^>]*>\n/gu, '')
      .replace('  <script type="module" src="/assets/ezacto.js"></script>\n', ''),
  )
  document.close()
}

const view = (overrides: Partial<SavedReport> = {}): SavedReport => ({
  id: 'q3-time',
  name: 'Q3 time by client',
  version: 1,
  fields: [{ id: 'client_name', label: 'Client', visible: true }],
  metrics: ['hours'],
  filters: [],
  group_by: null,
  presentation: { result: 'summary', grouped: false, include_zero_values: false },
  owner: { user_id: 1, name: 'Ada Byron' },
  is_custom: false,
  view: { report: 'time', query: 'from=2026-07-01&to=2026-09-30&tab=client' },
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
const timeReport = {
  from: '2026-07-01', to: '2026-09-30', totals: [], clients: [], projects: [], tasks: [], team: [],
}

const mount = async (
  path: string,
  tab: string | null,
  profile: Whoami['profile'],
  overrides: Partial<ReportWorkspaceApi> = {},
  userId = 1,
): Promise<{ api: Partial<ReportWorkspaceApi>; abort: () => void }> => {
  writeDocument(path, tab)
  const api: Partial<ReportWorkspaceApi> = {
    listReportClients: vi.fn(async () => emptyPage),
    listReportProjects: vi.fn(async () => emptyPage),
    getUninvoicedReport: vi.fn(async () => ({
      from: '2026-08-01', to: '2026-08-31', client_id: null, project_id: null, totals: [], projects: [],
    })),
    getTimeReport: vi.fn(async () => timeReport as never),
    listSavedReports: vi.fn(async () => []),
    ...overrides,
  }
  const session = new AbortController()
  await createReportsController(api).activate(identity(profile, userId), session.signal, () => false)
  return { api, abort: () => session.abort() }
}

const tabLabels = (): string[] =>
  [...document.querySelectorAll<HTMLAnchorElement>('.tabstrip a')]
    .filter((anchor) => (anchor.getAttribute('href') ?? '').startsWith('/reports'))
    .map((anchor) => anchor.textContent ?? '')

const rowButton = (label: string): HTMLButtonElement =>
  [...document.querySelectorAll<HTMLButtonElement>('[data-saved-screen-table] tbody button')]
    .find((candidate) => candidate.textContent === label)!

describe('the Saved tab (#933)', () => {
  it('lists saved views in a table with their report, owner, audience and date, and nothing else', async () => {
    const listSavedReports = vi.fn(async () => [
      view({ pinned: true, shared_with: { users: [], profiles: ['accounting'] } }),
      view({
        id: 'theirs', name: 'Invoiced this year', view: { report: 'invoiced', query: 'from=2026-01-01&to=2026-12-31' },
        owner: { user_id: 7, name: 'Olive Owner' }, owned_by_viewer: false, can_delete: false, shared: true,
      }),
      view({ id: 'builder', name: 'Builder only', view: null, is_custom: true }),
    ])
    await mount('/reports/saved', 'saved', 'accounting', { listSavedReports })

    expect(tabLabels().at(-1)).toBe('Saved')
    expect(document.querySelector('.tabstrip a[href="/reports/saved"]')?.getAttribute('aria-current')).toBe('page')
    expect(document.querySelector<HTMLElement>('[data-report-form]')!.hidden).toBe(true)
    expect(document.querySelector<HTMLElement>('[data-saved-screen]')!.hidden).toBe(false)

    await vi.waitFor(() => expect(document.querySelector('[data-saved-screen-table]')?.textContent).toContain('Q3 time by client'))
    const headers = [...document.querySelectorAll('[data-saved-screen-table] thead th')].map((cell) => cell.textContent?.trim())
    expect(headers.slice(0, 5)).toEqual(['Name', 'Report', 'Owner', 'Shared', 'Updated'])
    const rows = [...document.querySelectorAll('[data-saved-screen-table] tbody tr')].map((row) => row.textContent ?? '')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('Time')
    expect(rows[0]).toContain('Pinned')
    expect(rows[0]).toContain('Shared with 1')
    expect(rows[0]).toContain('2026-10-18')
    expect(rows[1]).toContain('Olive Owner')
    expect(rows[1]).toContain('Shared with you')
    expect(document.querySelector('[data-saved-screen-table]')?.textContent).not.toContain('Builder only')
    // A name opens the report at its own address, pointing back at the saved report.
    const link = document.querySelector<HTMLAnchorElement>('[data-saved-screen-table] tbody a')!
    expect(new URL(link.href, 'https://x.test').pathname).toBe('/reports')
    expect(new URL(link.href, 'https://x.test').searchParams.get('report')).toBe('time')
    expect(new URL(link.href, 'https://x.test').searchParams.get('tab')).toBe('client')
    expect(new URL(link.href, 'https://x.test').searchParams.get('saved')).toBe('q3-time')
  })

  it('offers each row only the actions its viewer is entitled to', async () => {
    const owned = view()
    const sharedWithMe = view({
      id: 'theirs', name: 'Theirs', owner: { user_id: 7, name: 'Olive Owner' }, owned_by_viewer: false,
      can_delete: false, shared: true,
    })
    await mount('/reports/saved', 'saved', 'accounting', { listSavedReports: vi.fn(async () => [owned, sharedWithMe]) })
    await vi.waitFor(() => expect(document.querySelector('[data-saved-screen-table] tbody')?.textContent).toContain('Theirs'))
    const actions = [...document.querySelectorAll('[data-saved-screen-table] tbody tr')].map((row) =>
      [...row.querySelectorAll('button')].map((button) => button.textContent))
    expect(actions[0]).toEqual(['Open', 'Pin', 'Rename', 'Share…', 'Duplicate', 'Delete'])
    expect(actions[1]).toEqual(['Open', 'Pin', 'Duplicate'])
  })

  it('filters by who can see it and by search, asking the API for both', async () => {
    const listSavedReports = vi.fn(async () => [view()])
    await mount('/reports/saved', 'saved', 'accounting', { listSavedReports })
    await vi.waitFor(() => expect(listSavedReports).toHaveBeenCalledWith({ view: 'all' }, expect.anything()))
    document.querySelector<HTMLButtonElement>('[data-saved-screen-view="shared"]')!.click()
    await vi.waitFor(() => expect(listSavedReports).toHaveBeenCalledWith({ view: 'shared' }, expect.anything()))
    expect(document.querySelector('[data-saved-screen-view="shared"]')!.getAttribute('aria-pressed')).toBe('true')
    const search = document.querySelector<HTMLInputElement>('[data-saved-screen-search]')!
    search.value = 'q3'
    search.dispatchEvent(new Event('input'))
    await vi.waitFor(() => expect(listSavedReports).toHaveBeenCalledWith({ view: 'shared', q: 'q3' }, expect.anything()))
  })

  it('renames through a dialog, pins, and deletes only after the dialog is confirmed', async () => {
    const listSavedReports = vi.fn(async () => [view()])
    const updateSavedReport = vi.fn(async (_id: string, input: { name?: string }) => view({ name: input.name ?? '', version: 2 }))
    const pinSavedReport = vi.fn(async () => undefined)
    const deleteSavedReport = vi.fn(async () => undefined)
    await mount('/reports/saved', 'saved', 'accounting', { listSavedReports, updateSavedReport, pinSavedReport, deleteSavedReport })
    await vi.waitFor(() => expect(document.querySelector('[data-saved-screen-table] tbody')?.textContent).toContain('Q3 time'))

    rowButton('Pin').click()
    await vi.waitFor(() => expect(pinSavedReport).toHaveBeenCalledWith('q3-time', expect.anything()))

    // The overflow menu holds the less common actions.
    rowButton('Rename').click()
    const nameDialog = document.querySelector<HTMLDialogElement>('[data-saved-name-dialog]')!
    expect(nameDialog.open).toBe(true)
    const input = document.querySelector<HTMLInputElement>('[data-saved-name-input]')!
    expect(input.value).toBe('Q3 time by client')
    input.value = 'Q3 hours by client'
    document.querySelector<HTMLFormElement>('[data-saved-name-form]')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await vi.waitFor(() => expect(updateSavedReport).toHaveBeenCalledWith('q3-time', { version: 1, name: 'Q3 hours by client' }, expect.anything()))
    await vi.waitFor(() => expect(nameDialog.open).toBe(false))

    rowButton('Delete').click()
    expect(document.querySelector<HTMLDialogElement>('[data-saved-delete-dialog]')!.open).toBe(true)
    expect(deleteSavedReport).not.toHaveBeenCalled()
    document.querySelector<HTMLButtonElement>('[data-saved-delete-confirm]')!.click()
    await vi.waitFor(() => expect(deleteSavedReport).toHaveBeenCalledWith('q3-time', expect.anything()))
  })

  it('opens the same share dialog the library uses', async () => {
    await mount('/reports/saved', 'saved', 'accounting', {
      listSavedReports: vi.fn(async () => [view({ shared_with: { users: [], profiles: ['accounting'] } })]),
    })
    await vi.waitFor(() => expect(document.querySelector('[data-saved-screen-table] tbody')?.textContent).toContain('Q3 time'))
    rowButton('Share…').click()
    expect(document.querySelector<HTMLDialogElement>('[data-saved-share-dialog]')!.open).toBe(true)
    expect(document.querySelector('[data-saved-share-title]')?.textContent).toBe('Share Q3 time by client')
    expect(document.querySelector<HTMLInputElement>('[data-saved-share-roles] input')!.checked).toBe(true)
  })

  it('lets a kind tab leave the Saved tab instead of swapping a report into it', async () => {
    await mount('/reports/saved', 'saved', 'accounting')
    const time = [...document.querySelectorAll<HTMLAnchorElement>('.tabstrip a')].find((a) => a.textContent === 'Time')!
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    time.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(false)
  })

  it('gives a member neither the Saved tab nor a way to save', async () => {
    await mount('/reports?report=my-hours', 'my-hours', 'member')
    expect(tabLabels()).not.toContain('Saved')
    expect(document.querySelector<HTMLElement>('[data-saved-save-open]')!.hidden).toBe(true)
  })

  it('empties the screen and the quick links when the session ends', async () => {
    const { abort } = await mount('/reports/saved', 'saved', 'accounting', { listSavedReports: vi.fn(async () => [view({ pinned: true })]) })
    await vi.waitFor(() => expect(document.querySelector('[data-saved-screen-table]')?.textContent).toContain('Q3 time'))
    abort()
    expect(document.querySelector('[data-saved-screen-table]')?.textContent).toBe('')
    expect(document.querySelector<HTMLElement>('[data-saved-quick-links]')!.hidden).toBe(true)
  })
})

describe('saving the report on screen (#933)', () => {
  const path = '/reports?report=time&from=2026-07-01&to=2026-09-30&tab=clients'

  it('saves the address under a name, private, and shows the page as that saved report', async () => {
    const createReportView = vi.fn(async (input: { name: string }) => view({ name: input.name }))
    await mount(path, 'time', 'accounting', { createReportView })
    const save = document.querySelector<HTMLButtonElement>('[data-saved-save-open]')!
    expect(save.hidden).toBe(false)
    save.click()
    const dialog = document.querySelector<HTMLDialogElement>('[data-saved-name-dialog]')!
    expect(dialog.open).toBe(true)
    expect(document.querySelector('[data-saved-name-hint]')?.textContent).toContain('private to you')

    // A blank name is refused where it is typed.
    const input = document.querySelector<HTMLInputElement>('[data-saved-name-input]')!
    input.value = '   '
    document.querySelector<HTMLFormElement>('[data-saved-name-form]')!.dispatchEvent(new Event('submit', { cancelable: true }))
    expect(createReportView).not.toHaveBeenCalled()
    expect(document.querySelector('[data-saved-name-result]')?.textContent).toContain('name')

    input.value = 'Q3 time by client'
    document.querySelector<HTMLFormElement>('[data-saved-name-form]')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await vi.waitFor(() => expect(createReportView).toHaveBeenCalledTimes(1))
    const sent = createReportView.mock.calls[0]![0] as { name: string; view: { report: string; query: string } }
    expect(sent.name).toBe('Q3 time by client')
    expect(sent.view.report).toBe('time')
    const query = new URLSearchParams(sent.view.query)
    expect(query.get('from')).toBe('2026-07-01')
    expect(query.get('to')).toBe('2026-09-30')
    expect(query.get('tab')).toBe('clients')
    expect(query.has('report')).toBe(false)
    expect(query.has('saved')).toBe(false)

    await vi.waitFor(() => expect(dialog.open).toBe(false))
    expect(document.querySelector('[data-saved-open-name]')?.textContent).toBe('Saved report: Q3 time by client')
    expect(document.querySelector('[data-saved-open-result]')?.textContent).toContain('private to you')
    expect(new URL(window.location.href).searchParams.get('saved')).toBe('q3-time')
  })

  it('says why a save was refused and leaves the dialog open', async () => {
    const createReportView = vi.fn(async () => {
      throw new Error('Name is already used.')
    })
    await mount(path, 'time', 'accounting', { createReportView })
    document.querySelector<HTMLButtonElement>('[data-saved-save-open]')!.click()
    document.querySelector<HTMLFormElement>('[data-saved-name-form]')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await vi.waitFor(() => expect(document.querySelector('[data-saved-name-result]')?.textContent).toContain('already used'))
    expect(document.querySelector<HTMLDialogElement>('[data-saved-name-dialog]')!.open).toBe(true)
    expect(document.querySelector<HTMLButtonElement>('[data-saved-name-submit]')!.disabled).toBe(false)
  })
})

describe('a saved report that is open (#933)', () => {
  const path = '/reports?report=time&from=2026-07-01&to=2026-09-30&tab=clients&saved=q3-time'

  it('names the saved report above the filters and saves changes back to it at its version', async () => {
    const getSavedReport = vi.fn(async () => view({ version: 4 }))
    const updateSavedReport = vi.fn(async () => view({ version: 5 }))
    await mount(path, 'time', 'accounting', { getSavedReport, updateSavedReport })
    await vi.waitFor(() => expect(document.querySelector('[data-saved-open-name]')?.textContent).toBe('Saved report: Q3 time by client'))
    expect(getSavedReport).toHaveBeenCalledWith('q3-time', expect.anything())
    const saveChanges = document.querySelector<HTMLButtonElement>('[data-saved-open-save]')!
    expect(saveChanges.hidden).toBe(false)

    saveChanges.click()
    await vi.waitFor(() => expect(updateSavedReport).toHaveBeenCalledTimes(1))
    const [id, body] = updateSavedReport.mock.calls[0] as unknown as [string, { version: number; view: { report: string; query: string } }]
    expect(id).toBe('q3-time')
    expect(body.version).toBe(4)
    expect(body.view.report).toBe('time')
    expect(new URLSearchParams(body.view.query).get('from')).toBe('2026-07-01')
    expect(new URLSearchParams(body.view.query).has('saved')).toBe(false)
    await vi.waitFor(() => expect(document.querySelector('[data-saved-open-result]')?.textContent).toBe('Changes saved.'))

    // The next save is at the version the last one made.
    await vi.waitFor(() => expect(saveChanges.disabled).toBe(false))
    saveChanges.click()
    await vi.waitFor(() => expect(updateSavedReport).toHaveBeenCalledTimes(2))
    expect((updateSavedReport.mock.calls[1] as unknown as [string, { version: number }])[1].version).toBe(5)
  })

  it('offers no Save changes to someone it was only shared with', async () => {
    const getSavedReport = vi.fn(async () => view({ owned_by_viewer: false, can_delete: false, shared: true }))
    await mount(path, 'time', 'accounting', { getSavedReport }, 2)
    await vi.waitFor(() => expect(document.querySelector('[data-saved-open-name]')?.textContent).toContain('Q3 time by client'))
    expect(document.querySelector<HTMLElement>('[data-saved-open-save]')!.hidden).toBe(true)
  })

  it('says so when the saved report is gone or was never theirs, and still shows the report', async () => {
    const getSavedReport = vi.fn(async () => {
      throw new Error('Not found')
    })
    await mount(path, 'time', 'accounting', { getSavedReport })
    await vi.waitFor(() => expect(document.querySelector('[data-saved-open-name]')?.textContent).toContain('no longer available'))
    expect(document.querySelector<HTMLElement>('[data-saved-open-save]')!.hidden).toBe(true)
    expect(document.querySelector<HTMLElement>('[data-saved-open]')!.hidden).toBe(false)
  })

  it('refuses a stale save with the server reason and keeps Save changes available', async () => {
    const getSavedReport = vi.fn(async () => view())
    const updateSavedReport = vi.fn(async () => {
      throw new Error('the saved report changed; reload before editing')
    })
    await mount(path, 'time', 'accounting', { getSavedReport, updateSavedReport })
    await vi.waitFor(() => expect(document.querySelector<HTMLElement>('[data-saved-open-save]')!.hidden).toBe(false))
    document.querySelector<HTMLButtonElement>('[data-saved-open-save]')!.click()
    await vi.waitFor(() => expect(document.querySelector('[data-saved-open-result]')?.textContent).toContain('reload before editing'))
    expect(document.querySelector<HTMLButtonElement>('[data-saved-open-save]')!.disabled).toBe(false)
  })
})

describe('pinned quick links (#933)', () => {
  it('shows the pinned views, and only those, above a report', async () => {
    await mount('/reports?report=time', 'time', 'accounting', {
      listSavedReports: vi.fn(async () => [
        view({ pinned: true }),
        view({ id: 'loose', name: 'Not pinned' }),
        view({ id: 'builder', name: 'Pinned builder', view: null, pinned: true, is_custom: true }),
      ]),
    })
    await vi.waitFor(() => expect(document.querySelector<HTMLElement>('[data-saved-quick-links]')!.hidden).toBe(false))
    const links = [...document.querySelectorAll<HTMLAnchorElement>('[data-saved-quick-links] a')]
    expect(links.map((link) => link.textContent)).toEqual(['Q3 time by client'])
    expect(new URL(links[0]!.href, 'https://x.test').searchParams.get('saved')).toBe('q3-time')
  })

  it('keeps the strip empty and hidden when nothing is pinned', async () => {
    await mount('/reports?report=time', 'time', 'accounting', { listSavedReports: vi.fn(async () => [view()]) })
    await vi.waitFor(() => expect(document.querySelector('[data-report-status]')?.textContent).not.toBe('Loading report filters…'))
    expect(document.querySelector<HTMLElement>('[data-saved-quick-links]')!.hidden).toBe(true)
  })

  it('shows a view as pinned on the Saved tab once it is pinned there', async () => {
    let pinned = false
    const listSavedReports = vi.fn(async () => [view({ pinned })])
    const pinSavedReport = vi.fn(async () => { pinned = true })
    await mount('/reports/saved', 'saved', 'accounting', { listSavedReports, pinSavedReport })
    await vi.waitFor(() => expect(document.querySelector('[data-saved-screen-table] tbody')?.textContent).toContain('Q3 time'))
    rowButton('Pin').click()
    await vi.waitFor(() => expect(document.querySelector('[data-saved-screen-table] tbody')?.textContent).toContain('Pinned'))
  })
})
