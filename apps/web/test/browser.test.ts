/** @vitest-environment happy-dom */

import {
  EzactoApiError,
  type AuthPrincipal,
  type GeneralResource,
  type Session,
  type TimeEntry,
  type TimeEntryInput,
  type TimeEntryPatch,
  type Whoami,
} from '@ezacto/client'
import { describe, expect, it, vi } from 'vitest'
import { mountShell } from '../src/shell/browser.js'
import { renderAppShell, type ShellApi } from '../src/index.js'

const timestamp = '2026-08-28T12:00:00.000Z'

const identity: Whoami = {
  user_id: 1,
  profile: 'administrator',
  manager_grants: [],
  authentication: { kind: 'session' },
}

const principal: AuthPrincipal = {
  status: 'authenticated',
  user_id: identity.user_id,
  profile: identity.profile,
  manager_grants: [],
}

const secondIdentity: Whoami = {
  user_id: 2,
  profile: 'member',
  manager_grants: [],
  authentication: { kind: 'session' },
}

const secondPrincipal: AuthPrincipal = {
  status: 'authenticated',
  user_id: 2,
  profile: 'member',
  manager_grants: [],
}

const currentSession: Session = {
  id: 7,
  created_at: timestamp,
  last_seen_at: timestamp,
  idle_expires_at: timestamp,
  absolute_expires_at: timestamp,
  revoked_at: null,
  revocation_reason: null,
  current: true,
}

const resource = (id: number, name: string): GeneralResource => ({
  id,
  name,
  created_at: timestamp,
  updated_at: timestamp,
})

const timeEntry = (id: number, input: TimeEntryInput): TimeEntry => ({
  id,
  user_id: 1,
  project_id: input.project_id,
  task_id: input.task_id,
  spent_date: input.spent_date ?? '2026-08-28',
  seconds: input.seconds ?? 0,
  is_running: input.seconds === undefined,
  timer_started_at: input.seconds === undefined ? timestamp : null,
  notes: input.notes ?? null,
  billable: true,
  budgeted: false,
  approval_status: 'unsubmitted',
  is_billed: false,
  is_locked: false,
  created_at: timestamp,
  updated_at: timestamp,
})

const browserApi = (): ShellApi & {
  readonly entries: TimeEntry[]
  failNextCreate: boolean
} => {
  const entries = [
    timeEntry(1, {
      project_id: 1,
      task_id: 1,
      spent_date: '2026-08-28',
      seconds: 3_600,
    }),
    timeEntry(2, {
      project_id: 2,
      task_id: 2,
      spent_date: '2026-08-21',
      seconds: 99_999,
    }),
  ]
  const api = {
    entries,
    failNextCreate: false,
    whoami: vi.fn(async () => identity),
    signIn: vi.fn(async () => principal),
    logoutCurrentSession: vi.fn(async () => ({
      ...currentSession,
      current: false,
      revoked_at: timestamp,
      revocation_reason: 'user_revoked' as const,
    })),
    listProjects: vi.fn(async () => ({
      data: [resource(1, 'Northpeak'), resource(2, 'Acme')],
      page: { next_cursor: null },
    })),
    listTasks: vi.fn(async () => ({
      data: [resource(1, 'Development'), resource(2, 'Design')],
      page: { next_cursor: null },
    })),
    listTimeEntries: vi.fn(async (query) =>
      entries.filter((entry) => {
        if (query.is_running === true) return entry.is_running
        if (query.from !== undefined && entry.spent_date < query.from) return false
        if (query.to !== undefined && entry.spent_date > query.to) return false
        return true
      }),
    ),
    createTimeEntry: vi.fn(async (input: TimeEntryInput) => {
      if (api.failNextCreate) {
        api.failNextCreate = false
        throw new Error('network unavailable')
      }
      const created = timeEntry(Math.max(...entries.map((entry) => entry.id)) + 1, input)
      entries.push(created)
      return created
    }),
    updateTimeEntry: vi.fn(async (id: number, patch: TimeEntryPatch) => {
      const current = entries.find((entry) => entry.id === id)
      if (current === undefined) throw new Error('entry not found')
      const updated = { ...current, ...patch, updated_at: timestamp }
      entries.splice(entries.indexOf(current), 1, updated)
      return updated
    }),
    deleteTimeEntry: vi.fn(async (id: number) => {
      const index = entries.findIndex((entry) => entry.id === id)
      if (index === -1) throw new Error('entry not found')
      entries.splice(index, 1)
    }),
    stopTimeEntry: vi.fn(async (id: number) => {
      const current = entries.find((entry) => entry.id === id)
      if (current === undefined) throw new Error('entry not found')
      const stopped = { ...current, is_running: false, timer_started_at: null }
      entries.splice(entries.indexOf(current), 1, stopped)
      return stopped
    }),
  }
  return api
}

const desktopInputs = (): HTMLInputElement[] => [
  ...document.querySelectorAll<HTMLInputElement>('[data-week-grid] input[data-cell-key]'),
]

const edit = (input: HTMLInputElement, value: string): void => {
  input.focus()
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

const renderBrowserShell = (): void => {
  window.history.replaceState(null, '', '/')
  document.open()
  document.write(
    renderAppShell({ environment: 'test', release: 'browser-test' })
      .replace(
        / {2}<link[^>]+(?:fonts\.googleapis|fonts\.gstatic|\/assets\/ezacto\.css)[^>]*>\n/gu,
        '',
      )
      .replace(
        '  <script type="module" src="/assets/ezacto.js"></script>\n',
        '',
      ),
  )
  document.close()
}

const authenticationError = (status: number, code: string): EzactoApiError =>
  new EzactoApiError(
    status,
    { error: { code, message: 'server detail is not rendered', fields: [] } },
    null,
  )

const deferred = <Value>() => {
  let resolve: ((value: Value) => void) | undefined
  let reject: ((error: unknown) => void) | undefined
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return {
    promise,
    resolve: (value: Value) => resolve?.(value),
    reject: (error: unknown) => reject?.(error),
  }
}

const submitSignIn = (email: string, password: string): void => {
  const emailInput = document.querySelector<HTMLInputElement>('[name="email"]')!
  const passwordInput = document.querySelector<HTMLInputElement>('[name="password"]')!
  emailInput.value = email
  passwordInput.value = password
  document
    .querySelector<HTMLFormElement>('[data-sign-in-form]')!
    .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
}

describe('week-grid browser behavior', () => {
  it('[e2e:track-week] preserves keyboard edits, notes, retry, copy, and phone-day writes', async () => {
    renderBrowserShell()
    window.history.replaceState(null, '', '/?week=2026-08-28')
    const api = browserApi()

    await mountShell(api)
    expect(desktopInputs()).toHaveLength(7)
    expect(document.querySelector('[data-session-status]')?.textContent).toContain('Connected')

    const monday = desktopInputs()[0]!
    edit(monday, '1.5')
    monday.blur()
    await vi.waitFor(() =>
      expect(api.entries).toContainEqual(
        expect.objectContaining({ spent_date: '2026-08-24', seconds: 5_400 }),
      ),
    )

    await vi.waitFor(() =>
      expect(
        document.querySelector<HTMLButtonElement>(
          '[data-week-grid] [data-cell-key="1:1:2026-08-24"] .cell-note',
        )?.disabled,
      ).toBe(false),
    )
    const mondayNote = document.querySelector<HTMLButtonElement>(
      '[data-week-grid] [data-cell-key="1:1:2026-08-24"] .cell-note',
    )!
    mondayNote.click()
    expect(document.querySelector<HTMLDialogElement>('[data-note-dialog]')?.open).toBe(
      true,
    )
    const note = document.querySelector<HTMLTextAreaElement>('[data-note-input]')!
    note.value = 'Keyboard-first delivery'
    document
      .querySelector<HTMLFormElement>('[data-note-form]')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(api.updateTimeEntry).toHaveBeenCalled())
    await vi.waitFor(() =>
      expect(api.entries).toContainEqual(
        expect.objectContaining({
          spent_date: '2026-08-24',
          notes: 'Keyboard-first delivery',
        }),
      ),
    )

    const tuesday = desktopInputs()[1]!
    api.failNextCreate = true
    edit(tuesday, '0.75')
    tuesday.blur()
    await vi.waitFor(() =>
      expect(
        document.querySelector<HTMLButtonElement>(
          '[data-week-grid] [data-cell-key="1:1:2026-08-25"] .cell-retry',
        ),
      ).not.toBeNull(),
    )
    document
      .querySelector<HTMLButtonElement>(
        '[data-week-grid] [data-cell-key="1:1:2026-08-25"] .cell-retry',
      )!
      .click()
    await vi.waitFor(() =>
      expect(api.entries).toContainEqual(
        expect.objectContaining({ spent_date: '2026-08-25', seconds: 2_700 }),
      ),
    )

    const wednesday = desktopInputs()[2]!
    edit(wednesday, '0.5')
    wednesday.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    await vi.waitFor(() => {
      expect(api.entries).toContainEqual(
        expect.objectContaining({ spent_date: '2026-08-26', seconds: 1_800 }),
      )
      expect((document.activeElement as HTMLInputElement).dataset.cellKey).toBe('1:1:2026-08-27')
    })

    document.querySelector<HTMLButtonElement>('[data-copy-last-week]')!.click()
    await vi.waitFor(() => expect(desktopInputs()).toHaveLength(14))
    expect(
      document.querySelector<HTMLInputElement>(
        '[data-week-grid] [data-cell-key="2:2:2026-08-28"] input',
      )?.value,
    ).toBe('')

    document.documentElement.dataset.timeView = 'day'
    document.querySelector<HTMLButtonElement>('[data-day-next]')!.click()
    const nextDay = document.querySelector<HTMLInputElement>(
      '[data-day-list] input[data-cell-key^="1:1:"]',
    )!
    const spentDate = nextDay.dataset.cellKey!.split(':').at(-1)!
    edit(nextDay, '0.25')
    nextDay.blur()
    await vi.waitFor(() =>
      expect(api.entries).toContainEqual(
        expect.objectContaining({ spent_date: spentDate, seconds: 900 }),
      ),
    )
  })
})

describe('native browser authentication', () => {
  it.each([
    [401, 'invalid_credentials', 'Email or password is incorrect.'],
    [403, 'email_verification_required', 'Verify your email before signing in.'],
    [429, 'rate_limit_exceeded', 'Too many sign-in attempts. Wait a moment and try again.'],
  ])(
    '[unit] keeps signed-out data closed and renders the safe %s outcome',
    async (status, code, expected) => {
      renderBrowserShell()
      const base = browserApi()
      const api = {
        ...base,
        whoami: vi.fn(async () => {
          throw authenticationError(401, 'authentication_required')
        }),
        signIn: vi.fn(async () => {
          throw authenticationError(status, code)
        }),
      }

      await mountShell(api)

      expect(base.listProjects).not.toHaveBeenCalled()
      expect(base.listTasks).not.toHaveBeenCalled()
      expect(base.listTimeEntries).not.toHaveBeenCalled()
      expect(document.querySelector<HTMLElement>('[data-auth-gateway]')?.hidden).toBe(false)
      expect(document.querySelector<HTMLElement>('[data-authenticated-shell]')?.hidden).toBe(true)
      expect(document.querySelector<HTMLElement>('[data-authenticated-shell]')?.inert).toBe(true)
      expect(document.querySelector<HTMLFormElement>('[data-sign-in-form]')?.hidden).toBe(false)
      expect(document.querySelector<HTMLButtonElement>('[data-command-trigger]')?.disabled).toBe(
        true,
      )

      submitSignIn('owner@example.test', 'do not persist me')
      await vi.waitFor(() =>
        expect(document.querySelector('[data-sign-in-result]')?.textContent).toBe(expected),
      )
      expect(document.querySelector<HTMLInputElement>('[name="password"]')?.value).toBe('')
      expect(document.querySelector<HTMLButtonElement>('[data-sign-in-submit]')?.disabled).toBe(
        false,
      )
      expect(document.body.textContent).not.toContain('server detail is not rendered')
      expect(globalThis.location.href).not.toContain('do%20not%20persist%20me')
      expect(document.documentElement.outerHTML).not.toContain('do not persist me')
    },
  )

  it('[unit] clears the password and blocks a second submit while sign-in is pending', async () => {
    renderBrowserShell()
    const base = browserApi()
    let rejectSignIn: ((error: unknown) => void) | undefined
    const pending = new Promise<AuthPrincipal>((_resolve, reject) => {
      rejectSignIn = reject
    })
    const api = {
      ...base,
      whoami: vi.fn(async () => {
        throw authenticationError(401, 'authentication_required')
      }),
      signIn: vi.fn(() => pending),
    }
    await mountShell(api)

    submitSignIn('owner@example.test', 'one request only')
    submitSignIn('owner@example.test', 'one request only')
    expect(api.signIn).toHaveBeenCalledTimes(1)
    expect(document.querySelector<HTMLButtonElement>('[data-sign-in-submit]')?.disabled).toBe(
      true,
    )
    expect(document.querySelector<HTMLButtonElement>('[data-sign-in-submit]')?.textContent).toBe(
      'Signing in…',
    )
    expect(
      document
        .querySelector<HTMLFormElement>('[data-sign-in-form]')
        ?.getAttribute('aria-busy'),
    ).toBe('true')

    rejectSignIn?.(authenticationError(401, 'invalid_credentials'))
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLInputElement>('[name="password"]')?.value).toBe(''),
    )
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLButtonElement>('[data-sign-in-submit]')?.textContent).toBe(
        'Sign in',
      ),
    )
  })

  it('[security] clears the password before a post-sign-in identity check settles', async () => {
    renderBrowserShell()
    const base = browserApi()
    const identityCheck = deferred<Whoami>()
    let signedIn = false
    const api = {
      ...base,
      whoami: vi.fn(async () => {
        if (!signedIn) throw authenticationError(401, 'authentication_required')
        return identityCheck.promise
      }),
      signIn: vi.fn(async () => {
        signedIn = true
        return principal
      }),
    }
    await mountShell(api)

    submitSignIn('owner@example.test', 'clear before whoami')
    await vi.waitFor(() => expect(api.whoami).toHaveBeenCalledTimes(2))
    expect(document.querySelector<HTMLInputElement>('[name="password"]')?.value).toBe('')
    expect(document.querySelector<HTMLButtonElement>('[data-sign-in-submit]')?.disabled).toBe(
      true,
    )

    identityCheck.resolve(identity)
    await vi.waitFor(() =>
      expect(document.querySelector('[data-current-user-id]')?.textContent).toBe('1'),
    )
    expect(document.querySelector<HTMLElement>('[data-auth-gateway]')?.hidden).toBe(true)
    expect(document.querySelector<HTMLElement>('[data-authenticated-shell]')?.hidden).toBe(false)
    expect(document.querySelector<HTMLElement>('[data-authenticated-shell]')?.inert).toBe(false)
  })

  it('[security] sends a cell retry 401 through the shared signed-out transition', async () => {
    renderBrowserShell()
    const base = browserApi()
    let creates = 0
    const api = {
      ...base,
      createTimeEntry: vi.fn(async () => {
        creates += 1
        if (creates === 1) throw new Error('temporary network failure')
        throw authenticationError(401, 'authentication_required')
      }),
    }
    await mountShell(api)

    const monday = desktopInputs()[0]!
    edit(monday, '0.5')
    monday.blur()
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLButtonElement>('.cell-retry')).not.toBeNull(),
    )
    document.querySelector<HTMLButtonElement>('.cell-retry')!.click()

    await vi.waitFor(() =>
      expect(document.querySelector<HTMLFormElement>('[data-sign-in-form]')?.hidden).toBe(false),
    )
    expect(document.querySelector('[data-session-status]')?.textContent).toContain(
      'session ended',
    )
    expect(document.querySelector('[data-sign-in-result]')?.textContent).toContain(
      'session ended',
    )
    expect(document.querySelector<HTMLButtonElement>('[data-command-trigger]')?.disabled).toBe(
      true,
    )
    expect(desktopInputs()).toHaveLength(0)
  })

  it('[security] sends a command 401 through the shared signed-out transition', async () => {
    renderBrowserShell()
    const base = browserApi()
    let projectLoads = 0
    const api = {
      ...base,
      listProjects: vi.fn(async (cursor?: string) => {
        projectLoads += 1
        if (projectLoads > 1) {
          throw authenticationError(401, 'authentication_required')
        }
        return base.listProjects(cursor)
      }),
    }
    await mountShell(api)

    document.querySelector<HTMLButtonElement>('[data-command-trigger]')!.click()
    const input = document.querySelector<HTMLInputElement>('[name="command"]')!
    input.value = 'log 1h northpeak development'
    document
      .querySelector<HTMLFormElement>('[data-command-form]')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() =>
      expect(document.querySelector<HTMLFormElement>('[data-sign-in-form]')?.hidden).toBe(false),
    )
    expect(document.querySelector('[data-session-status]')?.textContent).toContain(
      'session ended',
    )
    expect(document.querySelector('[data-sign-in-result]')?.textContent).toContain(
      'session ended',
    )
    expect(input.value).toBe('')
  })

  it('[e2e:browser-auth] keeps a valid initial session signed in when week loading fails', async () => {
    renderBrowserShell()
    const base = browserApi()
    let failWeek = true
    const api = {
      ...base,
      listProjects: vi.fn(async (cursor?: string) => {
        if (failWeek) throw new Error('catalog offline')
        return base.listProjects(cursor)
      }),
    }

    await mountShell(api)

    expect(document.querySelector('[data-current-user-id]')?.textContent).toBe('1')
    expect(document.querySelector<HTMLElement>('[data-current-identity]')?.hidden).toBe(false)
    expect(document.querySelector<HTMLFormElement>('[data-sign-in-form]')?.hidden).toBe(true)
    expect(document.querySelector('[data-session-status]')?.textContent).toContain(
      'Signed in, but your week could not load',
    )
    expect(document.querySelector<HTMLButtonElement>('[data-retry-week]')?.hidden).toBe(false)
    expect(document.querySelector<HTMLButtonElement>('[data-command-trigger]')?.disabled).toBe(
      false,
    )

    failWeek = false
    document.querySelector<HTMLButtonElement>('[data-retry-week]')!.click()
    await vi.waitFor(() =>
      expect(document.querySelector('[data-session-status]')?.textContent).toContain('Connected'),
    )
    expect(document.querySelector<HTMLButtonElement>('[data-retry-week]')?.hidden).toBe(true)
  })

  it('[e2e:browser-auth] keeps a new session signed in when its first week load fails', async () => {
    renderBrowserShell()
    const base = browserApi()
    let authenticated = false
    const api = {
      ...base,
      whoami: vi.fn(async () => {
        if (!authenticated) throw authenticationError(401, 'authentication_required')
        return identity
      }),
      signIn: vi.fn(async () => {
        authenticated = true
        return principal
      }),
      listProjects: vi.fn(async () => {
        throw new Error('catalog offline')
      }),
    }

    await mountShell(api)
    submitSignIn('owner@example.test', 'correct horse battery staple')

    await vi.waitFor(() =>
      expect(document.querySelector('[data-session-status]')?.textContent).toContain(
        'Signed in, but your week could not load',
      ),
    )
    expect(document.querySelector('[data-current-user-id]')?.textContent).toBe('1')
    expect(document.querySelector<HTMLElement>('[data-current-identity]')?.hidden).toBe(false)
    expect(document.querySelector<HTMLFormElement>('[data-sign-in-form]')?.hidden).toBe(true)
    expect(document.querySelector('[data-sign-in-result]')?.textContent).toBe('')
  })

  it('[e2e:browser-auth] signs in, shows credential-safe identity, loads the week, and logs out', async () => {
    renderBrowserShell()
    const storage = vi.spyOn(Storage.prototype, 'setItem')
    const href = globalThis.location.href
    const base = browserApi()
    let authenticated = false
    const api = {
      ...base,
      whoami: vi.fn(async () => {
        if (!authenticated) throw authenticationError(401, 'authentication_required')
        return identity
      }),
      signIn: vi.fn(async () => {
        authenticated = true
        return principal
      }),
      logoutCurrentSession: vi.fn(async () => {
        authenticated = false
        return {
          ...currentSession,
          current: false,
          revoked_at: timestamp,
          revocation_reason: 'user_revoked' as const,
        }
      }),
    }

    await mountShell(api)
    expect(base.listProjects).not.toHaveBeenCalled()
    const email = document.querySelector<HTMLInputElement>('[name="email"]')!
    email.focus()
    expect(document.activeElement).toBe(email)

    submitSignIn('owner@example.test', 'correct horse battery staple')
    await vi.waitFor(() =>
      expect(document.querySelector('[data-current-user-id]')?.textContent).toBe('1'),
    )
    expect(document.querySelector('[data-current-profile]')?.textContent).toBe('administrator')
    expect(document.querySelector<HTMLElement>('[data-auth-gateway]')?.hidden).toBe(true)
    expect(document.querySelector<HTMLElement>('[data-authenticated-shell]')?.hidden).toBe(false)
    expect(document.querySelector<HTMLElement>('[data-authenticated-shell]')?.inert).toBe(false)
    expect(document.querySelector<HTMLElement>('[data-current-identity]')?.hidden).toBe(false)
    expect(base.listProjects).toHaveBeenCalledTimes(1)
    expect(base.listTasks).toHaveBeenCalledTimes(1)
    expect(base.listTimeEntries).toHaveBeenCalled()
    expect(document.querySelector<HTMLInputElement>('[name="password"]')?.value).toBe('')
    expect(document.querySelector<HTMLButtonElement>('[data-command-trigger]')?.disabled).toBe(
      false,
    )
    expect(globalThis.location.href).toBe(href)
    expect(storage).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('correct horse battery staple'),
    )
    expect(document.body.textContent).not.toContain('correct horse battery staple')

    const logout = document.querySelector<HTMLButtonElement>('[data-logout]')!
    logout.focus()
    expect(document.activeElement).toBe(logout)
    logout.click()
    await vi.waitFor(() => expect(api.logoutCurrentSession).toHaveBeenCalledTimes(1))
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLFormElement>('[data-sign-in-form]')?.hidden).toBe(false),
    )
    expect(document.querySelector<HTMLElement>('[data-auth-gateway]')?.hidden).toBe(false)
    expect(document.querySelector<HTMLElement>('[data-authenticated-shell]')?.hidden).toBe(true)
    expect(document.querySelector<HTMLElement>('[data-authenticated-shell]')?.inert).toBe(true)
    expect(document.querySelector('[data-session-status]')?.textContent).toContain('Signed out')
    expect(document.querySelector<HTMLButtonElement>('[data-command-trigger]')?.disabled).toBe(
      true,
    )
    storage.mockRestore()
  })

  it('[security] aborts and ignores prior-account work across logout and a different sign-in', async () => {
    renderBrowserShell()
    const stored = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => stored.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => void stored.set(key, value)),
    })
    const base = browserApi()
    const priorAccountProjects = deferred<{
      data: GeneralResource[]
      page: { next_cursor: null }
    }>()
    let account = 1
    let projectLoads = 0
    let priorSignal: AbortSignal | undefined
    const api = {
      ...base,
      whoami: vi.fn(async () => (account === 1 ? identity : secondIdentity)),
      signIn: vi.fn(async () => {
        account = 2
        return secondPrincipal
      }),
      logoutCurrentSession: vi.fn(async () => ({
        ...currentSession,
        current: false,
        revoked_at: timestamp,
        revocation_reason: 'user_revoked' as const,
      })),
      listProjects: vi.fn(async (_cursor?: string, signal?: AbortSignal) => {
        projectLoads += 1
        if (projectLoads === 2) {
          priorSignal = signal
          return priorAccountProjects.promise
        }
        return {
          data: [
            resource(
              1,
              account === 1 ? 'First Account Project' : 'Second Account Project',
            ),
            resource(2, account === 1 ? 'Private First Row' : 'Second Extra Row'),
          ],
          page: { next_cursor: null as null },
        }
      }),
    }

    await mountShell(api)
    expect(document.body.textContent).toContain('First Account Project')

    document.querySelector<HTMLButtonElement>('[data-add-row-trigger]')!.click()
    const project = document.querySelector<HTMLSelectElement>('[data-row-project]')!
    const task = document.querySelector<HTMLSelectElement>('[data-row-task]')!
    project.value = '2'
    task.value = '2'
    document
      .querySelector<HTMLFormElement>('[data-row-form]')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    expect([...stored.keys()]).toContain(
      'ezacto:user:1:week-rows:2026-08-24',
    )

    const command = document.querySelector<HTMLInputElement>('[name="command"]')!
    command.value = 'private first command'
    document.querySelector<HTMLInputElement>('[name="email"]')!.value =
      'first-private@example.test'
    const timerProject = document.querySelector<HTMLInputElement>(
      '[data-timer-form] [name="project"]',
    )!
    timerProject.value = 'private first timer'
    const oldNote = document.querySelector<HTMLButtonElement>('[data-note-cell]')!
    oldNote.click()
    document.querySelector<HTMLTextAreaElement>('[data-note-input]')!.value =
      'private first note'

    document.querySelector<HTMLButtonElement>('[data-week-previous]')!.click()
    await vi.waitFor(() => expect(api.listProjects).toHaveBeenCalledTimes(2))
    const logoutButton = document.querySelector<HTMLButtonElement>('[data-logout]')!
    logoutButton.click()
    expect(document.querySelector<HTMLButtonElement>('[data-command-trigger]')?.disabled).toBe(
      true,
    )
    expect(priorSignal?.aborted).toBe(true)

    await vi.waitFor(() =>
      expect(document.querySelector<HTMLFormElement>('[data-sign-in-form]')?.hidden).toBe(false),
    )
    expect(document.body.textContent).not.toContain('First Account Project')
    expect(command.value).toBe('')
    expect(timerProject.value).toBe('')
    expect(document.querySelector<HTMLTextAreaElement>('[data-note-input]')?.value).toBe('')
    expect(document.querySelectorAll('[data-row-project] option')).toHaveLength(0)
    expect(document.querySelectorAll('dialog[open]')).toHaveLength(0)
    expect(document.querySelector<HTMLInputElement>('[name="email"]')?.value).toBe('')

    submitSignIn('second@example.test', 'second account password')
    await vi.waitFor(() =>
      expect(document.querySelector('[data-current-user-id]')?.textContent).toBe('2'),
    )
    expect(document.body.textContent).toContain('Second Account Project')
    expect(document.body.textContent).not.toContain('Private First Row')
    expect(desktopInputs()).toHaveLength(7)

    priorAccountProjects.resolve({
      data: [resource(1, 'Late First Account Project')],
      page: { next_cursor: null },
    })
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0))
    expect(document.querySelector('[data-current-user-id]')?.textContent).toBe('2')
    expect(document.body.textContent).not.toContain('Late First Account Project')

    document.querySelector<HTMLTextAreaElement>('[data-note-input]')!.value = 'must not save'
    document
      .querySelector<HTMLFormElement>('[data-note-form]')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    expect(base.updateTimeEntry).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
