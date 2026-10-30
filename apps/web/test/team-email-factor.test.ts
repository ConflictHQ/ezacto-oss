/** @vitest-environment happy-dom */

import type { TeamCatalog, TeamPerson, Whoami } from '@conflict-hq/ezacto-client'
import { EzactoApiError } from '@conflict-hq/ezacto-client'
import { describe, expect, it, vi } from 'vitest'
import { createTeamDirectoryController } from '../src/team/browser.js'
import type { TeamDirectoryApi } from '../src/team/model.js'
import { renderAppShell } from '../src/index.js'

/**
 * Issue 770: an administrator turns off a person's emailed sign-in code from
 * the person page. The route is audited and refused on the demo; what is
 * asserted here is the screen in front of it.
 */

const timestamp = '2026-10-19T12:00:00.000Z'

const identity = (
  profile: Whoami['profile'] = 'administrator',
  authentication: Whoami['authentication'] = { kind: 'session' },
): Whoami => ({
  user_id: 1,
  profile,
  manager_grants: [],
  authentication,
})

const catalog: TeamCatalog = { roles: [], departments: [], projects: [] }

const person = (): TeamPerson => ({
  id: 7,
  first_name: 'Kai',
  last_name: 'Lost',
  email: 'kai@example.test',
  telephone: null,
  employee_id: null,
  timezone: 'America/Costa_Rica',
  is_contractor: false,
  is_active: true,
  has_access_to_all_future_projects: false,
  weekly_capacity: 126_000,
  profile: 'member',
  is_owner: false,
  avatar_url: null,
  version: 1,
  created_at: timestamp,
  updated_at: timestamp,
  roles: [],
  departments: [],
  project_assignments: [],
  billable_rates: [],
  cost_rates: [],
  notifications: {
    delivery_active: true,
    daily_reminder_enabled: false,
    reminder_time: null,
    reminder_days: [],
    channels: { email: false, desktop: false, slack: false },
    include_in_team_reminders: false,
    weekly_digest: false,
    notify_project_deleted: false,
    updated_at: timestamp,
  },
})

const writeDocument = (demo = false): void => {
  window.history.replaceState(null, '', '/team/7')
  document.open()
  document.write(
    renderAppShell({
      environment: 'test',
      release: 'team-email-factor-test',
      activeSection: 'Team',
      view: 'team-person',
      demo,
    })
      .replace(/ {2}<link[^>]+(?:fonts\.googleapis|fonts\.gstatic|\/assets\/ezacto\.css)[^>]*>\n/gu, '')
      .replace('  <script type="module" src="/assets/ezacto.js"></script>\n', ''),
  )
  document.close()
}

const api = (overrides: Partial<TeamDirectoryApi> = {}): Partial<TeamDirectoryApi> => ({
  getTeamPerson: vi.fn(async () => person()),
  getTeamCatalog: vi.fn(async () => catalog),
  getUserEmailFactor: vi.fn(async () => true),
  disableUserEmailFactor: vi.fn(async () => undefined),
  ...overrides,
})

const section = (): HTMLElement => document.querySelector<HTMLElement>('[data-team-email-factor]')!
const state = (): string =>
  document.querySelector('[data-team-email-factor-state]')?.textContent ?? ''
const off = (): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>('[data-team-email-factor-off]')!
const dialog = (): HTMLDialogElement =>
  document.querySelector<HTMLDialogElement>('[data-team-email-factor-dialog]')!
const result = (): string =>
  document.querySelector('[data-team-email-factor-result]')?.textContent ?? ''

const mount = async (
  teamApi: Partial<TeamDirectoryApi>,
  who: Whoami = identity(),
): Promise<void> => {
  await createTeamDirectoryController(teamApi).activate(who, new AbortController().signal, () => false)
}

const confirm = (): void => {
  document
    .querySelector<HTMLFormElement>('[data-team-email-factor-form]')!
    .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
}

describe('turning off a person’s emailed code from the person page (issue 770)', () => {
  it('shows an administrator that the factor is on, and offers to turn it off', async () => {
    writeDocument()
    const teamApi = api()
    await mount(teamApi)
    await vi.waitFor(() => expect(off().hidden).toBe(false))
    expect(section().hidden).toBe(false)
    expect(state()).toMatch(/^On\./u)
    expect(teamApi.getUserEmailFactor).toHaveBeenCalledWith(7, expect.any(AbortSignal))
  })

  it('says it is off, and offers nothing, when the person has no emailed code', async () => {
    writeDocument()
    await mount(api({ getUserEmailFactor: vi.fn(async () => false) }))
    await vi.waitFor(() => expect(state()).toMatch(/^Off\./u))
    expect(off().hidden).toBe(true)
  })

  it('asks first, and turns nothing off until it is confirmed', async () => {
    writeDocument()
    const disableUserEmailFactor = vi.fn<NonNullable<TeamDirectoryApi['disableUserEmailFactor']>>(
      async () => undefined,
    )
    const getUserEmailFactor = vi
      .fn<NonNullable<TeamDirectoryApi['getUserEmailFactor']>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    await mount(api({ disableUserEmailFactor, getUserEmailFactor }))
    await vi.waitFor(() => expect(off().hidden).toBe(false))

    off().click()
    expect(dialog().open).toBe(true)
    expect(disableUserEmailFactor).not.toHaveBeenCalled()

    // Cancelling changes nothing.
    document.querySelector<HTMLButtonElement>('[data-team-email-factor-cancel]')!.click()
    expect(dialog().open).toBe(false)
    expect(disableUserEmailFactor).not.toHaveBeenCalled()

    off().click()
    confirm()
    await vi.waitFor(() => expect(disableUserEmailFactor).toHaveBeenCalledTimes(1))
    expect(disableUserEmailFactor.mock.calls[0]![0]).toBe(7)
    // The screen then reports what the server now says, not what it hopes.
    await vi.waitFor(() => expect(state()).toMatch(/^Off\./u))
    expect(off().hidden).toBe(true)
    expect(result()).toBe('Emailed code turned off.')
    expect(dialog().open).toBe(false)
  })

  it('keeps the dialog open with the reason when the server refuses', async () => {
    writeDocument()
    const disableUserEmailFactor = vi.fn(async () => {
      throw new EzactoApiError(
        403,
        { error: { code: 'profile_forbidden', message: 'Only administrators can do that.' } },
        null,
      )
    })
    await mount(api({ disableUserEmailFactor }))
    await vi.waitFor(() => expect(off().hidden).toBe(false))
    off().click()
    confirm()
    await vi.waitFor(() =>
      expect(
        document.querySelector('[data-team-email-factor-dialog-result]')?.textContent,
      ).toBe('Only administrators can do that.'),
    )
    expect(dialog().open).toBe(true)
  })

  it('reports that someone got there first when the server says it was not on', async () => {
    writeDocument()
    const getUserEmailFactor = vi
      .fn<NonNullable<TeamDirectoryApi['getUserEmailFactor']>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    const disableUserEmailFactor = vi.fn(async () => {
      throw new EzactoApiError(404, { error: { code: 'not_found', message: 'gone' } }, null)
    })
    await mount(api({ getUserEmailFactor, disableUserEmailFactor }))
    await vi.waitFor(() => expect(off().hidden).toBe(false))
    off().click()
    confirm()
    await vi.waitFor(() => expect(result()).toBe('It was already off.'))
    expect(state()).toMatch(/^Off\./u)
    expect(dialog().open).toBe(false)
  })

  it('[security] is not shown to anyone but an administrator, and asks the server nothing', async () => {
    for (const profile of ['member', 'people_admin', 'project_manager'] as const) {
      writeDocument()
      const teamApi = api()
      await mount(teamApi, identity(profile))
      expect(section().hidden, profile).toBe(true)
      expect(teamApi.getUserEmailFactor, profile).not.toHaveBeenCalled()
    }
  })

  it('[security] is not shown to an API token: the route is session-only', async () => {
    writeDocument()
    const teamApi = api()
    await mount(
      teamApi,
      identity('administrator', { kind: 'token', token_id: 3, scopes: ['team:read'] }),
    )
    expect(section().hidden).toBe(true)
    expect(teamApi.getUserEmailFactor).not.toHaveBeenCalled()
  })

  it('[security] on the public demo, says why and offers no way to turn it off', async () => {
    writeDocument(true)
    const teamApi = api()
    await mount(teamApi)
    await vi.waitFor(() =>
      expect(state()).toBe('Turning off an emailed sign-in code: not available on the public demo.'),
    )
    expect(off().hidden).toBe(true)
    off().click()
    expect(dialog().open).toBe(false)
    expect(teamApi.getUserEmailFactor).not.toHaveBeenCalled()
    expect(teamApi.disableUserEmailFactor).not.toHaveBeenCalled()
  })

  it('says so, in its own place, when the state cannot be read', async () => {
    writeDocument()
    await mount(
      api({
        getUserEmailFactor: vi.fn(async () => {
          throw new Error('offline')
        }),
      }),
    )
    await vi.waitFor(() => expect(state()).toMatch(/could not be loaded/u))
    expect(off().hidden).toBe(true)
    // The rest of the person is still on the screen.
    expect(document.querySelector('[data-team-person-name]')?.textContent).toBe('Kai Lost')
  })

  it('[security] a build without the routes hides the section rather than offering a dead button', async () => {
    writeDocument()
    await mount({
      getTeamPerson: vi.fn(async () => person()),
      getTeamCatalog: vi.fn(async () => catalog),
    })
    expect(section().hidden).toBe(true)
  })
})
