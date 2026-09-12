/** @vitest-environment happy-dom */

import type {
  TeamCatalog,
  TeamCommandReceipt,
  TeamPerson,
  TeamPersonSummary,
  TeamPersonSummaryPage,
  Whoami,
} from '@conflict-hq/ezacto-client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTeamDirectoryController } from '../src/team/browser.js'
import type { TeamDirectoryApi } from '../src/team/model.js'
import { renderAppShell } from '../src/index.js'

const timestamp = '2026-09-02T12:00:00.000Z'

const identity = (profile: Whoami['profile'] = 'administrator'): Whoami => ({
  user_id: 1,
  profile,
  manager_grants: [],
  authentication: { kind: 'session' },
})

const catalog: TeamCatalog = {
  roles: [{ id: 1, name: 'Designer' }],
  departments: [{ id: 2, name: 'Delivery' }],
  projects: [
    {
      id: 3,
      name: 'Launch',
      code: 'LCH',
      client_id: 4,
      client_name: 'North Peak',
      is_active: true,
    },
  ],
}

const person = (overrides: Partial<TeamPerson> = {}): TeamPerson => ({
  id: 1,
  first_name: 'Avery',
  last_name: 'Owner',
  email: 'avery@example.test',
  telephone: null,
  employee_id: null,
  timezone: 'America/Costa_Rica',
  is_contractor: false,
  is_active: true,
  has_access_to_all_future_projects: false,
  weekly_capacity: 126_000,
  profile: 'administrator',
  is_owner: false,
  avatar_url: null,
  version: 3,
  created_at: timestamp,
  updated_at: timestamp,
  roles: [{ id: 1, name: 'Designer' }],
  departments: [{ id: 2, name: 'Delivery' }],
  project_assignments: [],
  billable_rates: [
    {
      id: 1,
      user_id: 1,
      amount_cents: 10_000,
      start_date: '2026-01-01',
      end_date: null,
      created_at: timestamp,
      updated_at: timestamp,
    },
  ],
  cost_rates: [],
  notifications: {
    delivery_active: false,
    daily_reminder_enabled: false,
    reminder_time: null,
    reminder_days: [],
    channels: { email: false, desktop: false, slack: false },
    include_in_team_reminders: false,
    weekly_digest: false,
    notify_project_deleted: false,
    updated_at: timestamp,
  },
  ...overrides,
})

const summary = (overrides: Partial<TeamPersonSummary> = {}): TeamPersonSummary => ({
  id: 1,
  first_name: 'Avery',
  last_name: 'Owner',
  email: 'avery@example.test',
  avatar_url: null,
  profile: 'administrator',
  is_owner: true,
  is_contractor: false,
  is_active: true,
  weekly_capacity: 126_000,
  total_seconds: 90_000,
  billable_seconds: 72_000,
  nonbillable_seconds: 18_000,
  utilization_ppm: 714_286,
  running: false,
  ...overrides,
})

const page = (data: readonly TeamPersonSummary[]): TeamPersonSummaryPage => ({
  data: [...data],
  page: { per_page: 200, next_cursor: null },
  links: { self: '/api/v1/team/people', next: null },
})

const receipt = (version: number): TeamCommandReceipt => ({
  target_user_id: 1,
  version,
  resource_id: null,
  occurred_at: timestamp,
})

const writeDocument = (view: 'team-list' | 'team-person'): void => {
  window.history.replaceState(null, '', view === 'team-list' ? '/team' : '/team/1')
  document.open()
  document.write(
    renderAppShell({
      environment: 'test',
      release: 'team-browser-test',
      activeSection: 'Team',
      view,
    })
      .replace(/ {2}<link[^>]+(?:fonts\.googleapis|fonts\.gstatic|\/assets\/ezacto\.css)[^>]*>\n/gu, '')
      .replace('  <script type="module" src="/assets/ezacto.js"></script>\n', ''),
  )
  document.close()
}

const submit = (form: HTMLFormElement): void => {
  form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
}

const formInputValue = (form: HTMLFormElement, name: string): string =>
  (form.elements.namedItem(name) as HTMLInputElement).value

const setField = (form: HTMLFormElement, name: string, value: string): void => {
  ;(form.elements.namedItem(name) as HTMLInputElement).value = value
}

beforeEach(() => {
  vi.useRealTimers()
})

describe('Team browser controller', () => {
  it('loads authoritative utilization and reloads week and Active/All filters', async () => {
    writeDocument('team-list')
    const listTeamPeople = vi.fn(async (filter) =>
      page(filter.is_active === true ? [summary()] : [summary(), summary({ id: 2, first_name: 'Kai', last_name: 'Archive', is_active: false })]),
    )
    const controller = createTeamDirectoryController({ listTeamPeople })

    await controller.activate(identity(), new AbortController().signal, () => false)

    expect(document.querySelector('[data-team-list]')?.textContent).toContain('Avery Owner')
    expect(document.querySelector('[data-team-list]')?.textContent).toContain('71.4%')
    // Hours and capacity are their own columns now, not one line on a card.
    expect(
      document.querySelector('[data-team-list] td[data-column="hours"]')?.textContent,
    ).toBe('25h')
    expect(
      document.querySelector('[data-team-list] td[data-column="capacity"]')?.textContent,
    ).toBe('35h')
    // Every sibling list carries its row actions; this one carried none, so the
    // only way into a person was the name link.
    expect(
      document.querySelector('[data-team-list] tbody tr[data-row] .data-table-action')
        ?.textContent,
    ).toBe('Open')
    expect(listTeamPeople.mock.calls[0]![0]).toMatchObject({ is_active: true })

    document.querySelector<HTMLButtonElement>('[data-team-week-previous]')!.click()
    await vi.waitFor(() => expect(listTeamPeople).toHaveBeenCalledTimes(2))
    expect(listTeamPeople.mock.calls[1]![0].from).not.toBe(listTeamPeople.mock.calls[0]![0].from)

    document.querySelector<HTMLButtonElement>('[data-team-filter="all"]')!.click()
    await vi.waitFor(() => expect(listTeamPeople).toHaveBeenCalledTimes(3))
    expect(listTeamPeople.mock.calls[2]![0]).not.toHaveProperty('is_active')
    await vi.waitFor(() =>
      expect(document.querySelector('[data-team-list]')?.textContent).toContain('Kai Archive'),
    )
  })

  it('asks the server for the archived people, not for everyone', async () => {
    // Active/All left the 46 archived contractors reachable only by reading
    // past the 14 people still here. "Who did we archive" had no answer.
    writeDocument('team-list')
    const listTeamPeople = vi.fn(async (filter) =>
      page(
        filter.is_active === true
          ? [summary()]
          : filter.is_active === false
            ? [summary({ id: 2, first_name: 'Kai', last_name: 'Archive', is_active: false })]
            : [summary(), summary({ id: 2, first_name: 'Kai', last_name: 'Archive', is_active: false })],
      ),
    )
    const controller = createTeamDirectoryController({ listTeamPeople })

    await controller.activate(identity(), new AbortController().signal, () => false)
    expect(listTeamPeople.mock.calls[0]![0]).toMatchObject({ is_active: true })

    document.querySelector<HTMLButtonElement>('[data-team-filter="archived"]')!.click()
    await vi.waitFor(() => expect(listTeamPeople).toHaveBeenCalledTimes(2))
    // is_active: false is the request, not the absence of one -- absence is
    // what "All" sends, and it would answer with the active people too.
    expect(listTeamPeople.mock.calls[1]![0]).toMatchObject({ is_active: false })

    await vi.waitFor(() =>
      expect(document.querySelector('[data-team-list]')?.textContent).toContain('Kai Archive'),
    )
    expect(document.querySelector('[data-team-list]')?.textContent).not.toContain('Avery Owner')
    expect(
      document
        .querySelector('[data-team-filter="archived"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true')
    expect(
      document.querySelector('[data-team-filter="active"]')?.getAttribute('aria-pressed'),
    ).toBe('false')
  })

  it('narrows the roster to one cohort, and the band counts follow', async () => {
    // The old roster had an `Everyone` control beside its Employees (1) /
    // Contractors (16) bands. Ours had the bands and no way to ask for one of
    // them, so "how many contractors" was answerable only by counting rows.
    writeDocument('team-list')
    const listTeamPeople = vi.fn(async () =>
      page([
        summary(),
        summary({ id: 2, first_name: 'Kai', last_name: 'Reyes', is_contractor: true }),
        summary({ id: 3, first_name: 'Nell', last_name: 'Ward', is_contractor: true }),
      ]),
    )
    const controller = createTeamDirectoryController({ listTeamPeople })

    await controller.activate(identity(), new AbortController().signal, () => false)
    await vi.waitFor(() =>
      expect(document.querySelector('[data-team-list]')?.textContent).toContain('Kai Reyes'),
    )
    const list = (): string => document.querySelector('[data-team-list]')?.textContent ?? ''
    expect(list()).toContain('Employees (1)')
    expect(list()).toContain('Contractors (2)')

    const scope = document.querySelector<HTMLSelectElement>('[data-team-scope]')!
    scope.value = 'contractors'
    scope.dispatchEvent(new Event('change'))

    await vi.waitFor(() => expect(list()).not.toContain('Avery Owner'))
    expect(list()).toContain('Kai Reyes')
    expect(list()).toContain('Nell Ward')
    // The band that is left counts what is on screen, and the band that is
    // gone does not linger with a stale number beside it.
    expect(list()).toContain('Contractors (2)')
    expect(list()).not.toContain('Employees (1)')

    scope.value = 'employees'
    scope.dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(list()).toContain('Avery Owner'))
    expect(list()).not.toContain('Kai Reyes')
    expect(list()).toContain('Employees (1)')

    // The count is of what is on screen, not of what was loaded. Search inside
    // a cohort is where the two diverge: three contractors are loaded, one
    // matches, and the band that says (3) is describing a list nobody can see.
    scope.value = 'contractors'
    scope.dispatchEvent(new Event('change'))
    const search = document.querySelector<HTMLInputElement>('[data-team-search]')!
    search.value = 'Kai'
    search.dispatchEvent(new Event('input'))
    await vi.waitFor(() => expect(list()).not.toContain('Nell Ward'))
    expect(list()).toContain('Contractors (1)')

    // A view over rows already in hand -- no second request for a question the
    // page can answer itself.
    expect(listTeamPeople).toHaveBeenCalledTimes(1)
  })

  it('splits billable from non-billable and draws the team one bar', async () => {
    // The band showed Billable and left Non-billable as arithmetic for the
    // reader, with the two inputs a column apart. And every person had a bar
    // while the team had none.
    writeDocument('team-list')
    const listTeamPeople = vi.fn(async () => page([summary()]))
    const controller = createTeamDirectoryController({ listTeamPeople })

    await controller.activate(identity(), new AbortController().signal, () => false)

    const band = document.querySelector('[data-team-summary]')
    expect(band?.textContent).toContain('Non-billable')
    const bar = document.querySelector<HTMLElement>('[data-team-bar]')
    expect(bar).not.toBeNull()
    expect(bar?.getAttribute('aria-label')).toMatch(/billable .* of .* capacity/u)
    // 25h tracked of which 20h billable, against 35h capacity.
    expect(
      bar?.querySelector<HTMLElement>('[data-part="billable"]')?.style.width,
    ).toBe(`${(20 / 35) * 100}%`)
    expect(
      bar?.querySelector<HTMLElement>('[data-part="nonbillable"]')?.style.width,
    ).toBe(`${(5 / 35) * 100}%`)
  })

  it('counts each band and totals its own columns', async () => {
    // The band named the cohort and left its size to be counted by eye, and a
    // cohort you cannot total is a label rather than a section. Old Harvest
    // banded `Employees (1)` / `Contractors (16)`, each with its own numbers.
    writeDocument('team-list')
    const listTeamPeople = vi.fn(async () =>
      page([
        summary(),
        summary({ id: 2, first_name: 'Blake', last_name: 'Reed', is_owner: false }),
        summary({
          id: 3,
          first_name: 'Kai',
          last_name: 'Chen',
          is_owner: false,
          is_contractor: true,
        }),
      ]),
    )
    const controller = createTeamDirectoryController({ listTeamPeople })

    await controller.activate(identity(), new AbortController().signal, () => false)

    expect(
      [...document.querySelectorAll('[data-team-list] tr.data-table-group th')].map(
        (band) => band.textContent,
      ),
    ).toEqual(['Employees (2)', 'Contractors (1)'])
    const totals = [...document.querySelectorAll('[data-team-list] tr.data-table-group-total')]
    expect(totals).toHaveLength(2)
    expect(totals[0]!.querySelector('td[data-column="hours"]')?.textContent).toBe('50h')
    expect(totals[0]!.querySelector('td[data-column="capacity"]')?.textContent).toBe('70h')
    expect(totals[0]!.querySelector('td[data-column="billable"]')?.textContent).toBe('40h')
    expect(totals[1]!.querySelector('td[data-column="hours"]')?.textContent).toBe('25h')
  })

  it('archives a person from the row menu behind a plain confirm', async () => {
    // Archiving somebody was five steps and a typed literal, for a state the
    // same menu puts back. The row carries no version, so the record is read
    // for the one it is on rather than writing blind.
    writeDocument('team-list')
    const listTeamPeople = vi.fn(async () =>
      page([summary({ id: 2, first_name: 'Blake', last_name: 'Reed', is_owner: false })]),
    )
    const getTeamPerson = vi.fn<TeamDirectoryApi['getTeamPerson']>(async () =>
      person({ id: 2, first_name: 'Blake', last_name: 'Reed', version: 7 }),
    )
    const updateTeamPerson = vi.fn<TeamDirectoryApi['updateTeamPerson']>(async () => receipt(8))
    const controller = createTeamDirectoryController({
      listTeamPeople,
      getTeamPerson,
      updateTeamPerson,
    })

    await controller.activate(identity(), new AbortController().signal, () => false)

    const row = document.querySelector<HTMLElement>('[data-team-list] [data-row-key="2"]')!
    const archive = [...row.querySelectorAll('button')].find(
      (button) => button.textContent === 'Archive',
    )!
    expect(archive).toBeDefined()
    archive.click()

    const dialog = document.querySelector<HTMLDialogElement>('[data-team-deactivate-dialog]')!
    expect(dialog.open).toBe(true)
    expect(dialog.querySelector('[data-team-deactivate-heading]')?.textContent).toBe(
      'Archive Blake Reed?',
    )
    // The typed-word gate is gone: there is no field left to fill in.
    expect(dialog.querySelector('input[name="confirmation"]')).toBeNull()

    submit(document.querySelector<HTMLFormElement>('[data-team-deactivate-form]')!)

    await vi.waitFor(() => expect(updateTeamPerson).toHaveBeenCalledTimes(1))
    expect(getTeamPerson.mock.calls[0]![0]).toBe(2)
    expect(updateTeamPerson.mock.calls[0]![0]).toBe(2)
    expect(updateTeamPerson.mock.calls[0]![2]).toEqual({ expected_version: 7, is_active: false })
    await vi.waitFor(() => expect(listTeamPeople).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(dialog.open).toBe(false))
  })

  it('restores an archived person from the row menu without asking', async () => {
    // Restoring takes nothing away, so it does not stop to confirm.
    writeDocument('team-list')
    const listTeamPeople = vi.fn(async () =>
      page([
        summary({ id: 2, first_name: 'Blake', last_name: 'Reed', is_owner: false, is_active: false }),
      ]),
    )
    const getTeamPerson = vi.fn<TeamDirectoryApi['getTeamPerson']>(async () =>
      person({ id: 2, first_name: 'Blake', last_name: 'Reed', is_active: false, version: 4 }),
    )
    const updateTeamPerson = vi.fn<TeamDirectoryApi['updateTeamPerson']>(async () => receipt(5))
    const controller = createTeamDirectoryController({
      listTeamPeople,
      getTeamPerson,
      updateTeamPerson,
    })

    await controller.activate(identity(), new AbortController().signal, () => false)

    const row = document.querySelector<HTMLElement>('[data-team-list] [data-row-key="2"]')!
    expect([...row.querySelectorAll('button')].map((button) => button.textContent)).toContain(
      'Restore',
    )
    ;[...row.querySelectorAll('button')]
      .find((button) => button.textContent === 'Restore')!
      .click()

    await vi.waitFor(() => expect(updateTeamPerson).toHaveBeenCalledTimes(1))
    expect(updateTeamPerson.mock.calls[0]![2]).toEqual({ expected_version: 4, is_active: true })
    expect(document.querySelector<HTMLDialogElement>('[data-team-deactivate-dialog]')?.open).toBe(
      false,
    )
    await vi.waitFor(() =>
      expect(document.querySelector('[data-team-list-status]')?.textContent).toBe(
        'Person restored.',
      ),
    )
  })

  it('does not say a person was restored over a roster that failed to reload', async () => {
    // The roster status change reports through the same reload as the add, and
    // tells the same truth about it: "Person restored." over the page that
    // still shows them archived is the control describing a page that is not
    // there.
    writeDocument('team-list')
    const listTeamPeople = vi.fn(async () => {
      if (listTeamPeople.mock.calls.length > 1) throw new Error('The team could not be loaded.')
      return page([
        summary({ id: 2, first_name: 'Blake', last_name: 'Reed', is_owner: false, is_active: false }),
      ])
    })
    const getTeamPerson = vi.fn<TeamDirectoryApi['getTeamPerson']>(async () =>
      person({ id: 2, first_name: 'Blake', last_name: 'Reed', is_active: false, version: 4 }),
    )
    const updateTeamPerson = vi.fn<TeamDirectoryApi['updateTeamPerson']>(async () => receipt(5))
    const controller = createTeamDirectoryController({
      listTeamPeople,
      getTeamPerson,
      updateTeamPerson,
    })

    await controller.activate(identity(), new AbortController().signal, () => false)

    const row = document.querySelector<HTMLElement>('[data-team-list] [data-row-key="2"]')!
    ;[...row.querySelectorAll('button')]
      .find((button) => button.textContent === 'Restore')!
      .click()

    await vi.waitFor(() => expect(listTeamPeople).toHaveBeenCalledTimes(2))
    await vi.waitFor(() =>
      expect(document.querySelector('[data-team-list-status]')?.textContent).toBe(
        'Person restored. The roster could not be reloaded; use Retry loading team.',
      ),
    )
    expect(document.querySelector<HTMLButtonElement>('[data-team-list-retry]')?.hidden).toBe(false)
  })

  it('keeps the initials when an avatar fails to load', async () => {
    // Imported avatar_urls point at Harvest's CDN and prod's CSP is
    // img-src 'self' data:, so every one of them is blocked. The initials have
    // to survive that, or the whole roster is empty circles.
    writeDocument('team-list')
    const listTeamPeople = vi.fn(async () =>
      page([summary({ avatar_url: 'https://cdn.example.com/blocked.png' })]),
    )
    const controller = createTeamDirectoryController({ listTeamPeople })
    await controller.activate(identity(), new AbortController().signal, () => false)

    const avatar = document.querySelector<HTMLElement>('[data-team-list] .team-avatar')!
    expect(avatar.querySelector('img')).not.toBeNull()
    expect(avatar.textContent).toContain('AO')

    avatar.querySelector('img')!.dispatchEvent(new Event('error'))
    expect(avatar.querySelector('img')).toBeNull()
    expect(avatar.textContent).toContain('AO')
  })

  it('denies a session profile outside team:read without issuing a list request', async () => {
    writeDocument('team-list')
    const listTeamPeople = vi.fn(async () => page([]))
    const controller = createTeamDirectoryController({ listTeamPeople })

    await controller.activate(
      identity('accounting'),
      new AbortController().signal,
      () => false,
    )

    expect(listTeamPeople).not.toHaveBeenCalled()
    expect(document.querySelector('[data-team-list-status]')?.textContent).toContain(
      'permission profile',
    )
    expect(document.querySelector('[data-team-list-status]')?.textContent).not.toContain(
      'API token',
    )
  })

  it('adds a person and re-bands the roster the reader is looking at', async () => {
    // POST /api/v1/users has shipped since the contract did and nothing called
    // it, so a fresh instance had exactly one person in it forever. The bands,
    // their counts and their per-band totals are all derived from the loaded
    // page, so the new person has to arrive through a reload rather than being
    // appended to a table that would then disagree with its own totals.
    writeDocument('team-list')
    const listTeamPeople = vi.fn(async () =>
      listTeamPeople.mock.calls.length === 1
        ? page([summary()])
        : page([
            summary(),
            summary({
              id: 2,
              first_name: 'Blake',
              last_name: 'Reed',
              is_owner: false,
              is_contractor: true,
              weekly_capacity: 72_000,
              total_seconds: 36_000,
              billable_seconds: 36_000,
              nonbillable_seconds: 0,
              utilization_ppm: 500_000,
            }),
          ]),
    )
    const createTeamPerson = vi.fn<TeamDirectoryApi['createTeamPerson']>(async () => ({
      id: 2,
      created_at: timestamp,
      updated_at: timestamp,
    }))
    const controller = createTeamDirectoryController({ listTeamPeople, createTeamPerson })

    await controller.activate(identity(), new AbortController().signal, () => false)

    const trigger = document.querySelector<HTMLButtonElement>('[data-team-person-create]')!
    expect(trigger.hidden).toBe(false)
    trigger.click()

    const dialog = document.querySelector<HTMLDialogElement>('[data-team-person-dialog]')!
    expect(dialog.open).toBe(true)
    const form = document.querySelector<HTMLFormElement>('[data-team-person-form]')!
    setField(form, 'first_name', 'Blake')
    setField(form, 'last_name', 'Reed')
    setField(form, 'email', 'blake@example.test')
    setField(form, 'weekly_capacity', '20')
    ;(form.elements.namedItem('is_contractor') as HTMLInputElement).checked = true
    ;(form.elements.namedItem('profile') as HTMLSelectElement).value = 'project_manager'
    submit(form)

    await vi.waitFor(() => expect(createTeamPerson).toHaveBeenCalledTimes(1))
    // Capacity is stored in seconds; the field is hours, and the two are not
    // the same number.
    expect(createTeamPerson.mock.calls[0]![0]).toEqual({
      first_name: 'Blake',
      last_name: 'Reed',
      email: 'blake@example.test',
      weekly_capacity: 72_000,
      is_contractor: true,
      profile: 'project_manager',
    })
    await vi.waitFor(() => expect(listTeamPeople).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(dialog.open).toBe(false))
    await vi.waitFor(() =>
      expect(
        [...document.querySelectorAll('[data-team-list] tr.data-table-group th')].map(
          (band) => band.textContent,
        ),
      ).toEqual(['Employees (1)', 'Contractors (1)']),
    )
    const totals = [...document.querySelectorAll('[data-team-list] tr.data-table-group-total')]
    expect(totals[1]!.querySelector('td[data-column="capacity"]')?.textContent).toBe('20h')
    expect(totals[1]!.querySelector('td[data-column="hours"]')?.textContent).toBe('10h')
    expect(document.querySelector('[data-team-list-status]')?.textContent).toBe('Blake Reed added.')
  })

  it('leaves the profile out of a people administrator\u2019s request', async () => {
    // POST /api/v1/users refuses `profile` from anybody but an administrator,
    // so offering the field to a people administrator would be a 403 waiting to
    // happen; the record takes the column default instead.
    writeDocument('team-list')
    const listTeamPeople = vi.fn(async () => page([summary()]))
    const createTeamPerson = vi.fn<TeamDirectoryApi['createTeamPerson']>(async () => ({
      id: 2,
      created_at: timestamp,
      updated_at: timestamp,
    }))
    const controller = createTeamDirectoryController({ listTeamPeople, createTeamPerson })

    await controller.activate(identity('people_admin'), new AbortController().signal, () => false)

    document.querySelector<HTMLButtonElement>('[data-team-person-create]')!.click()
    expect(
      document.querySelector<HTMLElement>('[data-team-new-profile-field]')?.hidden,
    ).toBe(true)
    expect(document.querySelector<HTMLElement>('[data-team-new-profile-note]')?.hidden).toBe(false)
    const form = document.querySelector<HTMLFormElement>('[data-team-person-form]')!
    setField(form, 'first_name', 'Blake')
    setField(form, 'last_name', 'Reed')
    setField(form, 'email', 'blake@example.test')
    setField(form, 'weekly_capacity', '35')
    submit(form)

    await vi.waitFor(() => expect(createTeamPerson).toHaveBeenCalledTimes(1))
    expect(Object.keys(createTeamPerson.mock.calls[0]![0])).not.toContain('profile')
  })

  it('offers no add-person control to a profile that cannot write a user', async () => {
    // A project manager may read the roster and may not create anybody on it,
    // which is exactly where the API draws the line.
    writeDocument('team-list')
    const listTeamPeople = vi.fn(async () => page([summary()]))
    const createTeamPerson = vi.fn<TeamDirectoryApi['createTeamPerson']>(async () => ({
      id: 2,
      created_at: timestamp,
      updated_at: timestamp,
    }))
    const controller = createTeamDirectoryController({ listTeamPeople, createTeamPerson })

    await controller.activate(
      identity('project_manager'),
      new AbortController().signal,
      () => false,
    )

    expect(document.querySelector<HTMLButtonElement>('[data-team-person-create]')?.hidden).toBe(
      true,
    )
    expect(createTeamPerson).not.toHaveBeenCalled()
  })

  it('does not say a person was added over a roster that failed to reload', async () => {
    // The person is created and the roster reload that puts them on the page
    // fails: writing "Blake Reed added." over the failure told the operator the
    // page in front of them contains the person it does not contain, and left
    // Retry loading team sitting there with a success line above it.
    writeDocument('team-list')
    const listTeamPeople = vi.fn(async () => {
      if (listTeamPeople.mock.calls.length === 1) return page([summary()])
      throw new Error('The team could not be loaded.')
    })
    const createTeamPerson = vi.fn<TeamDirectoryApi['createTeamPerson']>(async () => ({
      id: 2,
      created_at: timestamp,
      updated_at: timestamp,
    }))
    const controller = createTeamDirectoryController({ listTeamPeople, createTeamPerson })

    await controller.activate(identity(), new AbortController().signal, () => false)

    document.querySelector<HTMLButtonElement>('[data-team-person-create]')!.click()
    const form = document.querySelector<HTMLFormElement>('[data-team-person-form]')!
    setField(form, 'first_name', 'Blake')
    setField(form, 'last_name', 'Reed')
    setField(form, 'email', 'blake@example.test')
    setField(form, 'weekly_capacity', '20')
    submit(form)

    await vi.waitFor(() => expect(listTeamPeople).toHaveBeenCalledTimes(2))
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLDialogElement>('[data-team-person-dialog]')?.open).toBe(
        false,
      ),
    )
    expect(document.querySelector('[data-team-list-status]')?.textContent).toBe(
      'Blake Reed added. The roster could not be reloaded; use Retry loading team.',
    )
    expect(document.querySelector<HTMLButtonElement>('[data-team-list-retry]')?.hidden).toBe(false)
    // The roster still shows the page from before the person existed, which is
    // exactly what the message now says.
    expect(document.querySelectorAll('[data-team-list] tr[data-row-key]')).toHaveLength(1)
  })

  it('keeps the add-person form locked until the roster it writes to has reloaded', async () => {
    // Unlocking on the write alone re-armed the submit button while the reload
    // was still in flight, and the dialog is still open and still filled in:
    // an operator who presses Add person again gets a second person.
    writeDocument('team-list')
    let releaseReload: (() => void) | null = null
    const listTeamPeople = vi.fn(async () => {
      if (listTeamPeople.mock.calls.length === 1) return page([summary()])
      await new Promise<void>((resolve) => {
        releaseReload = resolve
      })
      return page([summary(), summary({ id: 2, first_name: 'Blake', last_name: 'Reed' })])
    })
    const createTeamPerson = vi.fn<TeamDirectoryApi['createTeamPerson']>(async () => ({
      id: 2,
      created_at: timestamp,
      updated_at: timestamp,
    }))
    const controller = createTeamDirectoryController({ listTeamPeople, createTeamPerson })

    await controller.activate(identity(), new AbortController().signal, () => false)

    const trigger = document.querySelector<HTMLButtonElement>('[data-team-person-create]')!
    trigger.click()
    const form = document.querySelector<HTMLFormElement>('[data-team-person-form]')!
    setField(form, 'first_name', 'Blake')
    setField(form, 'last_name', 'Reed')
    setField(form, 'email', 'blake@example.test')
    setField(form, 'weekly_capacity', '20')
    submit(form)

    await vi.waitFor(() => expect(listTeamPeople).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(releaseReload).not.toBeNull())
    expect(document.querySelector<HTMLDialogElement>('[data-team-person-dialog]')?.open).toBe(true)

    submit(form)
    await Promise.resolve()
    expect(createTeamPerson).toHaveBeenCalledTimes(1)
    expect(document.querySelector<HTMLButtonElement>('[data-team-person-submit]')?.disabled).toBe(
      true,
    )
    expect(trigger.disabled).toBe(true)

    releaseReload!()
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLDialogElement>('[data-team-person-dialog]')?.open).toBe(
        false,
      ),
    )
    expect(createTeamPerson).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-team-list-status]')?.textContent).toBe('Blake Reed added.')
    expect(document.querySelector<HTMLButtonElement>('[data-team-person-submit]')?.disabled).toBe(
      false,
    )
  })

  it('[security] keeps an ended session\u2019s add-person failure off the next session\u2019s page', async () => {
    // The add-person write is a call site like every other one, and it reports
    // its failure through the session that made it. This is the test that says
    // so, and it is why the team controller keeps no private failure helper
    // alive for createPerson.
    writeDocument('team-list')
    let failCreate: ((error: unknown) => void) | null = null
    const createTeamPerson = vi.fn<TeamDirectoryApi['createTeamPerson']>(
      () =>
        new Promise((_resolve, reject) => {
          failCreate = reject
        }),
    )
    const listTeamPeople = vi.fn(async () => page([summary()]))
    const controller = createTeamDirectoryController({ listTeamPeople, createTeamPerson })
    const first = new AbortController()
    const firstSessionFailure = vi.fn(() => false)

    await controller.activate(identity(), first.signal, firstSessionFailure)
    document.querySelector<HTMLButtonElement>('[data-team-person-create]')!.click()
    const form = document.querySelector<HTMLFormElement>('[data-team-person-form]')!
    setField(form, 'first_name', 'Blake')
    setField(form, 'last_name', 'Reed')
    setField(form, 'email', 'blake@example.test')
    setField(form, 'weekly_capacity', '20')
    submit(form)
    await vi.waitFor(() => expect(createTeamPerson).toHaveBeenCalledTimes(1))

    first.abort()
    await controller.activate(identity(), new AbortController().signal, () => false)
    failCreate!(new Error('Adding the person was refused.'))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(firstSessionFailure).not.toHaveBeenCalled()
    expect(document.querySelector('[data-team-person-result]')?.textContent).toBe('')
    expect(document.body.textContent).not.toContain('Adding the person was refused.')
  })

  it('renders exactly six permission profiles and disables owner profile and deactivation', async () => {
    writeDocument('team-person')
    const owner = person({ is_owner: true })
    const controller = createTeamDirectoryController({
      getTeamPerson: vi.fn(async () => owner),
      getTeamCatalog: vi.fn(async () => catalog),
    })

    await controller.activate(identity(), new AbortController().signal, () => false)

    const radios = [
      ...document.querySelectorAll<HTMLInputElement>('[data-team-profiles] input[type="radio"]'),
    ]
    expect(radios).toHaveLength(6)
    expect(radios.map(({ value }) => value)).toEqual([
      'member',
      'project_manager',
      'people_admin',
      'accounting',
      'executive_manager',
      'administrator',
    ])
    expect(radios.every(({ disabled }) => disabled)).toBe(true)
    expect(document.querySelector<HTMLButtonElement>('[data-team-permissions-submit]')?.hidden).toBe(true)
    expect(document.querySelector<HTMLButtonElement>('[data-team-status-action]')?.hidden).toBe(true)
    expect(document.querySelector('[data-team-owner-profile-note]')?.textContent).toContain(
      'always an administrator',
    )
  })

  it('clears private person state on auth abort and ignores a late reload', async () => {
    writeDocument('team-person')
    let resolveLate: ((value: TeamPerson) => void) | null = null
    let lateRequestReturned = false
    const late = new Promise<TeamPerson>((resolve) => {
      resolveLate = resolve
    })
    const loaded = person({
      telephone: '555-0100',
      employee_id: 'PRIVATE-42',
      project_assignments: [
        {
          id: 10,
          project_id: 3,
          project_name: 'Launch',
          project_code: 'LCH',
          client_id: 4,
          client_name: 'North Peak',
          is_active: true,
          is_project_manager: true,
          use_default_rates: true,
          budget_seconds: null,
          updated_at: timestamp,
        },
      ],
      cost_rates: [
        {
          id: 2,
          user_id: 1,
          amount_cents: 7_500,
          start_date: '2026-01-01',
          end_date: null,
          created_at: timestamp,
          updated_at: timestamp,
        },
      ],
    })
    const getTeamPerson = vi.fn(async () => {
      if (getTeamPerson.mock.calls.length === 1) return loaded
      const value = await late
      lateRequestReturned = true
      return value
    })
    const auth = new AbortController()
    const controller = createTeamDirectoryController({
      getTeamPerson,
      getTeamCatalog: vi.fn(async () => catalog),
    })

    await controller.activate(identity(), auth.signal, () => false)

    expect(document.querySelector('[data-team-person-name]')?.textContent).toBe('Avery Owner')
    expect(document.querySelector('[data-team-projects]')?.textContent).toContain('Launch')
    expect(document.querySelector('[data-team-billable-rates]')?.textContent).toContain(
      '100.00/hour',
    )
    expect(document.querySelector('[data-team-cost-rates]')?.textContent).toContain('75.00/hour')
    const info = document.querySelector<HTMLFormElement>('[data-team-info-form]')!
    expect(formInputValue(info, 'email')).toBe('avery@example.test')
    expect(formInputValue(info, 'telephone')).toBe('555-0100')

    document.querySelector<HTMLButtonElement>('[data-team-add-rate="billable"]')!.click()
    const rate = document.querySelector<HTMLFormElement>('[data-team-rate-form]')!
    ;(rate.elements.namedItem('amount') as HTMLInputElement).value = '999.99'
    document.querySelector<HTMLButtonElement>('[data-team-person-retry]')!.click()
    await vi.waitFor(() => expect(getTeamPerson).toHaveBeenCalledTimes(2))

    auth.abort()

    const editor = document.querySelector<HTMLElement>('[data-team-person-editor]')!
    expect(editor.hidden).toBe(true)
    expect(editor.hasAttribute('aria-busy')).toBe(false)
    expect(document.querySelector('[data-team-person-name]')?.textContent).toBe('Person')
    expect(formInputValue(info, 'first_name')).toBe('')
    expect(formInputValue(info, 'last_name')).toBe('')
    expect(formInputValue(info, 'email')).toBe('')
    expect(formInputValue(info, 'telephone')).toBe('')
    expect(formInputValue(info, 'employee_id')).toBe('')
    expect(document.querySelector('[data-team-projects]')?.textContent).toBe('')
    expect(document.querySelector('[data-team-profiles]')?.textContent).toBe('')
    expect(document.querySelector('[data-team-billable-rates]')?.textContent).toBe('')
    expect(document.querySelector('[data-team-cost-rates]')?.textContent).toBe('')
    expect((rate.elements.namedItem('amount') as HTMLInputElement).value).toBe('')
    expect(document.querySelector<HTMLDialogElement>('[data-team-rate-dialog]')?.open).toBe(false)

    resolveLate!(person({ first_name: 'Late', last_name: 'Secret' }))
    await vi.waitFor(() => expect(lateRequestReturned).toBe(true))
    await Promise.resolve()
    expect(editor.hidden).toBe(true)
    expect(document.querySelector('[data-team-person-name]')?.textContent).toBe('Person')
    expect(document.body.textContent).not.toContain('Late Secret')
  })

  it('captures every information edit before pending-state rerendering', async () => {
    writeDocument('team-person')
    const updateTeamPerson = vi.fn<TeamDirectoryApi['updateTeamPerson']>(
      async () => receipt(4),
    )
    const controller = createTeamDirectoryController({
      getTeamPerson: vi.fn(async () => person()),
      getTeamCatalog: vi.fn(async () => catalog),
      updateTeamPerson,
    })
    await controller.activate(identity(), new AbortController().signal, () => false)

    const form = document.querySelector<HTMLFormElement>('[data-team-info-form]')!
    ;(form.elements.namedItem('telephone') as HTMLInputElement).value = '555-0100'
    ;(form.elements.namedItem('employee_id') as HTMLInputElement).value = 'E-42'
    ;(form.elements.namedItem('has_access_to_all_future_projects') as HTMLInputElement).checked = true
    document.querySelector<HTMLInputElement>('[name="role_ids"]')!.checked = false
    submit(form)

    await vi.waitFor(() => expect(updateTeamPerson).toHaveBeenCalledTimes(1))
    expect(updateTeamPerson.mock.calls[0]![2]).toMatchObject({
      expected_version: 3,
      telephone: '555-0100',
      employee_id: 'E-42',
      has_access_to_all_future_projects: true,
      role_ids: [],
    })
  })

  it('renders notification delivery as inactive and never saves delivery promises', async () => {
    writeDocument('team-person')
    const updateTeamPersonNotifications = vi.fn<
      TeamDirectoryApi['updateTeamPersonNotifications']
    >(async () => receipt(4))
    const controller = createTeamDirectoryController({
      getTeamPerson: vi.fn(async () =>
        person({
          notifications: {
            ...person().notifications,
            channels: { email: true, desktop: false, slack: true },
          },
        }),
      ),
      getTeamCatalog: vi.fn(async () => catalog),
      updateTeamPersonNotifications,
    })
    await controller.activate(identity('people_admin'), new AbortController().signal, () => false)

    const form = document.querySelector<HTMLFormElement>('[data-team-notifications-form]')!
    submit(form)
    expect(updateTeamPersonNotifications).not.toHaveBeenCalled()
    expect(document.querySelector('[data-team-notification-status]')?.textContent).toContain(
      'delivery is not active',
    )
    expect(
      [...form.querySelectorAll<HTMLInputElement>('input')].every((input) => input.disabled),
    ).toBe(true)
    submit(form)
    expect(updateTeamPersonNotifications).not.toHaveBeenCalled()
  })

  it('[e2e:rate-change] retries one idempotent command and displays the server-closed prior period', async () => {
    writeDocument('team-person')
    let current = person()
    let attempts = 0
    const appendTeamPersonRate = vi.fn(async (_id, _commandId, input) => {
      attempts += 1
      if (attempts === 1) throw new Error('Connection interrupted')
      current = person({
        version: 4,
        billable_rates: [
          {
            ...current.billable_rates![0]!,
            end_date: '2026-08-31',
          },
          {
            id: 2,
            user_id: 1,
            amount_cents: input.amount_cents,
            start_date: input.start_date,
            end_date: null,
            created_at: timestamp,
            updated_at: timestamp,
          },
        ],
      })
      return receipt(4)
    })
    const controller = createTeamDirectoryController({
      getTeamPerson: vi.fn(async () => current),
      getTeamCatalog: vi.fn(async () => catalog),
      appendTeamPersonRate,
    })
    await controller.activate(identity(), new AbortController().signal, () => false)

    document.querySelector<HTMLButtonElement>('[data-team-add-rate="billable"]')!.click()
    const form = document.querySelector<HTMLFormElement>('[data-team-rate-form]')!
    ;(form.elements.namedItem('amount') as HTMLInputElement).value = '125.01'
    ;(form.elements.namedItem('start_date') as HTMLInputElement).value = '2026-09-01'
    submit(form)
    await vi.waitFor(() => expect(document.querySelector('[data-team-rate-result]')?.textContent).toBe('Connection interrupted'))

    submit(form)
    await vi.waitFor(() => expect(appendTeamPersonRate).toHaveBeenCalledTimes(2))
    expect(appendTeamPersonRate.mock.calls[0]![1]).toBe(appendTeamPersonRate.mock.calls[1]![1])
    expect(appendTeamPersonRate.mock.calls[1]![2]).toEqual({
      expected_version: 3,
      kind: 'billable',
      amount_cents: 12_501,
      start_date: '2026-09-01',
    })
    await vi.waitFor(() => {
      const rates = document.querySelector('[data-team-billable-rates]')?.textContent ?? ''
      expect(rates).toContain('2026-01-01 – 2026-08-31')
      expect(rates).toContain('2026-09-01 – Ongoing')
      expect(rates).toContain('125.01/hour')
    })
  })

  it('replaces project assignments at the displayed version without inventing task assignment', async () => {
    writeDocument('team-person')
    const replaceTeamPersonProjectAssignments = vi.fn<
      TeamDirectoryApi['replaceTeamPersonProjectAssignments']
    >(async () => receipt(4))
    const controller = createTeamDirectoryController({
      getTeamPerson: vi.fn(async () => person()),
      getTeamCatalog: vi.fn(async () => catalog),
      replaceTeamPersonProjectAssignments,
    })
    await controller.activate(identity('people_admin'), new AbortController().signal, () => false)

    expect(document.querySelector('[data-team-panel="projects"]')?.textContent).toContain(
      'Task access follows each project assignment',
    )
    document.querySelector<HTMLInputElement>('[data-team-project-id="3"]')!.click()
    document.querySelector<HTMLInputElement>('[data-team-manager-for="3"]')!.click()
    submit(document.querySelector<HTMLFormElement>('[data-team-projects-form]')!)

    await vi.waitFor(() => expect(replaceTeamPersonProjectAssignments).toHaveBeenCalledTimes(1))
    expect(replaceTeamPersonProjectAssignments.mock.calls[0]![2]).toEqual({
      expected_version: 3,
      assignments: [{ project_id: 3, is_project_manager: true }],
    })
    expect(replaceTeamPersonProjectAssignments.mock.calls[0]![1]).toMatch(/^[\w.:-]+$/u)
  })

  it('keeps inactive assignment history unchecked and prevents new archived-project selection', async () => {
    writeDocument('team-person')
    const replaceTeamPersonProjectAssignments = vi.fn<
      TeamDirectoryApi['replaceTeamPersonProjectAssignments']
    >(async () => receipt(4))
    const controller = createTeamDirectoryController({
      getTeamPerson: vi.fn(async () =>
        person({
          project_assignments: [
            {
              id: 10,
              project_id: 3,
              project_name: 'Launch',
              project_code: 'LCH',
              client_id: 4,
              client_name: 'North Peak',
              is_active: false,
              is_project_manager: true,
              use_default_rates: true,
              budget_seconds: null,
              updated_at: timestamp,
            },
            {
              id: 11,
              project_id: 5,
              project_name: 'Legacy',
              project_code: 'OLD',
              client_id: 4,
              client_name: 'North Peak',
              is_active: true,
              is_project_manager: false,
              use_default_rates: true,
              budget_seconds: null,
              updated_at: timestamp,
            },
          ],
        }),
      ),
      getTeamCatalog: vi.fn(async () => ({
        ...catalog,
        projects: [
          ...catalog.projects,
          {
            id: 5,
            name: 'Legacy',
            code: 'OLD',
            client_id: 4,
            client_name: 'North Peak',
            is_active: false,
          },
          {
            id: 6,
            name: 'Closed',
            code: 'CLOSED',
            client_id: 4,
            client_name: 'North Peak',
            is_active: false,
          },
        ],
      })),
      replaceTeamPersonProjectAssignments,
    })
    await controller.activate(identity('people_admin'), new AbortController().signal, () => false)

    const inactiveHistory = document.querySelector<HTMLInputElement>('[data-team-project-id="3"]')!
    const preservedArchived = document.querySelector<HTMLInputElement>('[data-team-project-id="5"]')!
    const unavailableArchived = document.querySelector<HTMLInputElement>('[data-team-project-id="6"]')!
    expect(inactiveHistory.checked).toBe(false)
    expect(preservedArchived.checked).toBe(true)
    expect(preservedArchived.disabled).toBe(false)
    expect(unavailableArchived.checked).toBe(false)
    expect(unavailableArchived.disabled).toBe(true)

    submit(document.querySelector<HTMLFormElement>('[data-team-projects-form]')!)
    await vi.waitFor(() => expect(replaceTeamPersonProjectAssignments).toHaveBeenCalledTimes(1))
    expect(replaceTeamPersonProjectAssignments.mock.calls[0]![2].assignments).toEqual([
      { project_id: 5, is_project_manager: false },
    ])
  })

  it('does not present inactive assignment history as a project to a read-only manager', async () => {
    writeDocument('team-person')
    const controller = createTeamDirectoryController({
      getTeamPerson: vi.fn(async () => {
        const value = person({
          project_assignments: [
            {
              id: 10,
              project_id: 3,
              project_name: 'Former assignment',
              project_code: 'OLD',
              client_id: 4,
              client_name: 'North Peak',
              is_active: false,
              is_project_manager: false,
              use_default_rates: true,
              budget_seconds: null,
              updated_at: timestamp,
            },
          ],
        })
        delete value.billable_rates
        delete value.cost_rates
        return value
      }),
      getTeamCatalog: vi.fn(async () => ({ roles: [], departments: [], projects: [] })),
    })
    await controller.activate(
      identity('project_manager'),
      new AbortController().signal,
      () => false,
    )

    expect(document.querySelector('[data-team-projects]')?.textContent).toContain(
      'No projects are assigned',
    )
    expect(document.querySelectorAll('[data-team-project-id]')).toHaveLength(0)
  })
  it('[security] keeps an ended session\u2019s week-start failure off the next session\u2019s page', async () => {
    // The confirmed instance from #382: activate() read the week start, the
    // session ended while the request was in flight, and the catch wrote the
    // error into a page that already belonged to whoever signed in next --
    // Retry button and all, offering them a request they cannot make.
    writeDocument('team-list')
    let failWeekStart: ((error: unknown) => void) | null = null
    const getTeamWeekStartDay = vi.fn(
      () =>
        new Promise<'monday'>((_resolve, reject) => {
          failWeekStart = reject
        }),
    )
    const onSessionFailure = vi.fn(() => false)
    const auth = new AbortController()
    const controller = createTeamDirectoryController({
      getTeamWeekStartDay,
      listTeamPeople: vi.fn(async () => page([summary()])),
    })

    const activation = controller.activate(identity(), auth.signal, onSessionFailure)
    await vi.waitFor(() => expect(getTeamWeekStartDay).toHaveBeenCalledTimes(1))
    auth.abort()
    failWeekStart!(new Error('The week start day could not be read.'))
    await activation

    expect(document.body.textContent).not.toContain('The week start day could not be read.')
    expect(document.querySelector('[data-team-list-status]')?.textContent).toBe('Loading team\u2026')
    expect(document.querySelector<HTMLButtonElement>('[data-team-list-retry]')?.hidden).toBe(true)
    // A stale 401 must not reach the shell either: the session it would end is
    // no longer the one that made the request.
    expect(onSessionFailure).not.toHaveBeenCalled()
  })

  it('[security] does not tell the next session that the previous one\u2019s edit was saved', async () => {
    // refreshAfterMutation awaits fetchPerson, which guards its own paints and
    // returns normally when the session has moved on. The success line was
    // written regardless, so the next user read "Information saved." about an
    // edit that was not theirs.
    writeDocument('team-person')
    let releaseReload: ((value: TeamPerson) => void) | null = null
    let reloadReturned = false
    const getTeamPerson = vi.fn(async () => {
      if (getTeamPerson.mock.calls.length === 1) return person()
      const value = await new Promise<TeamPerson>((resolve) => {
        releaseReload = resolve
      })
      reloadReturned = true
      return value
    })
    const updateTeamPerson = vi.fn<TeamDirectoryApi['updateTeamPerson']>(async () => receipt(4))
    const auth = new AbortController()
    const controller = createTeamDirectoryController({
      getTeamPerson,
      getTeamCatalog: vi.fn(async () => catalog),
      updateTeamPerson,
    })

    await controller.activate(identity(), auth.signal, () => false)
    submit(document.querySelector<HTMLFormElement>('[data-team-info-form]')!)
    await vi.waitFor(() => expect(updateTeamPerson).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(getTeamPerson).toHaveBeenCalledTimes(2))

    auth.abort()
    releaseReload!(person({ first_name: 'Late', last_name: 'Secret' }))
    await vi.waitFor(() => expect(reloadReturned).toBe(true))
    await Promise.resolve()
    await Promise.resolve()

    expect(document.querySelector('[data-team-info-result]')?.textContent).toBe('')
    expect(document.body.textContent).not.toContain('Information saved.')
    expect(document.body.textContent).not.toContain('Late Secret')
    expect(document.querySelector<HTMLButtonElement>('[data-team-person-retry]')?.hidden).toBe(true)
  })
})
