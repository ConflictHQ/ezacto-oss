/** @vitest-environment happy-dom */

import type {
  TeamCatalog,
  TeamCommandReceipt,
  TeamPerson,
  TeamPersonSummary,
  TeamPersonSummaryPage,
  Whoami,
} from '@ezacto/client'
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
})
