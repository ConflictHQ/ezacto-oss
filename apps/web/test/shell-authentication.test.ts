/** @vitest-environment happy-dom */

import { describe, expect, it, vi } from 'vitest'
import {
  EzactoApiError,
  authenticationError,
  browserApi,
  currentSession,
  deferred,
  desktopInputs,
  edit,
  identity,
  mountShell,
  pendingSubmission,
  principal,
  renderBrowserShell,
  resource,
  secondIdentity,
  secondPrincipal,
  submitSignIn,
  timestamp,
  type AuthPrincipal,
  type GeneralResource,
  type ShellApi,
  type TimesheetSubmission,
  type Whoami,
} from './support/shell-harness.js'

describe('native browser authentication', () => {
  it('[perf] paints from the cached identity instead of waiting on whoami', async () => {
    renderBrowserShell({ sessionCookiePresent: true })
    await mountShell(browserApi())

    // Second navigation: the cache survives it, so nothing waits on whoami.
    renderBrowserShell({ sessionCookiePresent: true, preserveStorage: true })
    const api = browserApi()
    const identityCheck = deferred<Whoami>()
    const revalidating = { ...api, whoami: vi.fn(() => identityCheck.promise) }

    const mounted = mountShell(revalidating)
    await Promise.resolve()

    // Painted before whoami settled, rather than waiting behind the overlay.
    expect(
      document.querySelector<HTMLElement>('[data-current-user-id]')!.textContent,
    ).toBe(String(identity.user_id))

    identityCheck.resolve(identity)
    await mounted
    // Still reconciled against the server.
    expect(revalidating.whoami).toHaveBeenCalled()
  })

  it('[security] drops the cached identity on sign-out', async () => {
    renderBrowserShell({ sessionCookiePresent: true })
    await mountShell(browserApi())
    expect(globalThis.sessionStorage.getItem('ezacto.identity')).not.toBeNull()

    document.querySelector<HTMLButtonElement>('[data-logout]')!.click()
    await vi.waitFor(() => {
      expect(globalThis.sessionStorage.getItem('ezacto.identity')).toBeNull()
    })
  })

  it('[security] keeps the hinted shell inert under an overlay until whoami succeeds', async () => {
    renderBrowserShell({ sessionCookiePresent: true })
    const base = browserApi()
    const identityCheck = deferred<Whoami>()
    const api = { ...base, whoami: vi.fn(() => identityCheck.promise) }

    const mounted = mountShell(api)
    const gateway = document.querySelector<HTMLElement>('[data-auth-gateway]')!
    const overlay = document.querySelector<HTMLElement>('[data-session-check-overlay]')!
    const shell = document.querySelector<HTMLElement>('[data-authenticated-shell]')!

    expect(gateway.hidden).toBe(true)
    expect(overlay.hidden).toBe(false)
    expect(shell.hidden).toBe(false)
    expect(shell.inert).toBe(true)
    expect(shell.getAttribute('aria-busy')).toBe('true')
    expect(base.listProjects).not.toHaveBeenCalled()
    expect(base.listTimeEntries).not.toHaveBeenCalled()
    expect(document.querySelectorAll('[data-auth-action]:not([disabled])')).toHaveLength(0)

    identityCheck.resolve(identity)
    await mounted

    expect(overlay.hidden).toBe(true)
    expect(shell.hidden).toBe(false)
    expect(shell.inert).toBe(false)
    expect(shell.getAttribute('aria-busy')).toBe('false')
    expect(gateway.hidden).toBe(true)
    expect(base.listProjects).toHaveBeenCalledTimes(1)
  })

  it('[security] replaces a hinted shell with sign-in when the cookie is expired', async () => {
    renderBrowserShell({ sessionCookiePresent: true })
    const base = browserApi()
    const api = {
      ...base,
      whoami: vi.fn(async () => {
        throw authenticationError(401, 'authentication_required')
      }),
    }

    await mountShell(api)

    expect(document.querySelector<HTMLElement>('[data-session-check-overlay]')?.hidden).toBe(true)
    expect(document.querySelector<HTMLElement>('[data-auth-gateway]')?.hidden).toBe(false)
    expect(document.querySelector<HTMLElement>('[data-authenticated-shell]')?.hidden).toBe(true)
    expect(document.querySelector<HTMLElement>('[data-authenticated-shell]')?.inert).toBe(true)
    expect(document.querySelector<HTMLInputElement>('[name="email"]')).toBe(document.activeElement)
    expect(base.listProjects).not.toHaveBeenCalled()
    expect(base.listTimeEntries).not.toHaveBeenCalled()
  })

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

  it('[browser][lock-policy] manages organization deadline and manual locks', async () => {
    renderBrowserShell({ view: 'timesheet-approvals' })
    const base = browserApi()
    let policy = {
      auto_lock: true,
      timesheet_deadline: { day: 'monday' as const, time: '17:00' },
      timezone: 'America/New_York',
      week_start_day: 'monday' as const,
      updated_at: timestamp,
    }
    const locks = [
      {
        id: 9,
        kind: 'manual' as const,
        period_start: null,
        period_end: '2026-08-31',
        reason: 'Month-end close',
        locked_by_user_id: 1,
        locked_at: timestamp,
        unlocked_by_user_id: null,
        unlocked_at: null,
        unlock_reason: null,
        active: true,
      },
    ]
    const updateTimesheetLockPolicy = vi.fn(async (input) => {
      policy = {
        ...policy,
        auto_lock: input.auto_lock ?? policy.auto_lock,
        timesheet_deadline: input.timesheet_deadline ?? policy.timesheet_deadline,
        timezone: input.timezone ?? policy.timezone,
        updated_at: timestamp,
      }
      return policy
    })
    const unlockTimesheetLock = vi.fn(async (id, input) => {
      const lock = locks.find((candidate) => candidate.id === id)!
      Object.assign(lock, {
        active: false,
        unlocked_by_user_id: 1,
        unlocked_at: timestamp,
        unlock_reason: input.reason,
      })
      return lock
    })
    const createTimesheetManualLock = vi.fn(async (_commandId, input) => {
      const created = {
        id: 10,
        kind: 'manual' as const,
        period_start: null,
        period_end: input.locked_through,
        reason: input.reason,
        locked_by_user_id: 1,
        locked_at: timestamp,
        unlocked_by_user_id: null,
        unlocked_at: null,
        unlock_reason: null,
        active: true,
      }
      locks.push(created)
      return created
    })
    const api: ShellApi = {
      ...base,
      listTimesheetSubmissions: vi.fn(async () => []),
      listPendingTimesheetSubmissions: vi.fn(async () => ({ submissions: [], nextCursor: null })),
      getTimesheetLockPolicy: vi.fn(async () => policy),
      listTimesheetLocks: vi.fn(async () => locks.filter((lock) => lock.active)),
      updateTimesheetLockPolicy,
      unlockTimesheetLock,
      createTimesheetManualLock,
    }

    await mountShell(api)
    const panel = document.querySelector<HTMLElement>('[data-lock-policy-panel]')!
    expect(panel.hidden).toBe(false)
    expect(document.querySelector<HTMLInputElement>('[data-lock-policy-auto]')?.checked).toBe(
      true,
    )
    expect(panel.textContent).toContain('Month-end close')

    const unlockReason = document.querySelector<HTMLInputElement>(
      '[data-lock-unlock-reason="9"]',
    )!
    unlockReason.value = 'Books reopened'
    document.querySelector<HTMLButtonElement>('[data-lock-id="9"] button')!.click()
    await vi.waitFor(() =>
      expect(unlockTimesheetLock).toHaveBeenCalledWith(
        9,
        { reason: 'Books reopened' },
        expect.any(AbortSignal),
      ),
    )
    await vi.waitFor(() => expect(panel.textContent).not.toContain('Month-end close'))

    const automatic = document.querySelector<HTMLInputElement>('[data-lock-policy-auto]')!
    automatic.checked = false
    document
      .querySelector<HTMLFormElement>('[data-lock-policy-form]')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    // Issue 757. The deadline save no longer carries the organization timezone,
    // so saving a deadline cannot quietly rewrite the zone every entry is filed
    // in -- and the zone is reachable without setting a deadline at all.
    await vi.waitFor(() =>
      expect(updateTimesheetLockPolicy).toHaveBeenCalledWith(
        { auto_lock: false, timesheet_deadline: { day: 'monday', time: '17:00' } },
        expect.any(AbortSignal),
      ),
    )
    await vi.waitFor(() =>
      expect(document.querySelector('[data-lock-policy-result]')?.textContent).toContain(
        'Automatic locking disabled',
      ),
    )

    // The organization timezone is its own setting with its own save.
    document.querySelector<HTMLInputElement>('[data-org-timezone]')!.value =
      'America/Costa_Rica'
    document
      .querySelector<HTMLFormElement>('[data-org-timezone-form]')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() =>
      expect(updateTimesheetLockPolicy).toHaveBeenCalledWith(
        { timezone: 'America/Costa_Rica' },
        expect.any(AbortSignal),
      ),
    )

    document.querySelector<HTMLInputElement>('[data-manual-lock-through]')!.value =
      '2026-09-30'
    document.querySelector<HTMLTextAreaElement>('[data-manual-lock-reason]')!.value =
      'Quarter close'
    document
      .querySelector<HTMLFormElement>('[data-manual-lock-form]')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() =>
      expect(createTimesheetManualLock).toHaveBeenCalledWith(
        expect.any(String),
        { locked_through: '2026-09-30', reason: 'Quarter close' },
        expect.any(AbortSignal),
      ),
    )
    await vi.waitFor(() => expect(panel.textContent).toContain('Quarter close'))
  })

  it('[browser][lock-policy] explicitly reopens an approved timesheet with a reason', async () => {
    renderBrowserShell()
    const base = browserApi()
    let submission: TimesheetSubmission = {
      id: 21,
      user_id: 1,
      user_name: 'Ada Admin',
      period_start: '2026-08-24',
      period_end: '2026-08-30',
      status: 'approved',
      origin: 'native',
      source_status: null,
      source_observed_at: null,
      submitted_by_user_id: 1,
      submitted_at: timestamp,
      reviewed_by_user_id: 1,
      reviewed_at: timestamp,
      rejection_reason: null,
      version: 2,
      entry_count: 1,
      expense_count: 0,
      total_seconds: 3_600,
      billable_seconds: 3_600,
      nonbillable_seconds: 0,
      created_at: timestamp,
      updated_at: timestamp,
    }
    const withdrawTimesheetSubmission = vi.fn(async (_id, input) => {
      submission = {
        ...submission,
        status: 'unsubmitted',
        rejection_reason: input.reason,
        version: submission.version + 1,
      }
      return submission
    })
    const api: ShellApi = {
      ...base,
      listTimesheetSubmissions: vi.fn(async () => [submission]),
      listPendingTimesheetSubmissions: vi.fn(async () => ({ submissions: [], nextCursor: null })),
      withdrawTimesheetSubmission,
    }

    await mountShell(api)
    const reopen = document.querySelector<HTMLButtonElement>('[data-withdraw-timesheet]')!
    expect(reopen.hidden).toBe(false)
    reopen.click()
    expect(document.querySelector<HTMLDialogElement>('[data-withdrawal-dialog]')?.open).toBe(
      true,
    )
    document.querySelector<HTMLTextAreaElement>('[data-withdrawal-reason]')!.value =
      'Correct a late expense'
    document
      .querySelector<HTMLFormElement>('[data-withdrawal-form]')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() =>
      expect(withdrawTimesheetSubmission).toHaveBeenCalledWith(
        21,
        { reason: 'Correct a late expense' },
        expect.any(AbortSignal),
      ),
    )
    await vi.waitFor(() =>
      expect(document.querySelector('[data-timesheet-result]')?.textContent).toContain(
        'Approval withdrawn',
      ),
    )
    expect(reopen.hidden).toBe(true)
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
    project.dispatchEvent(new Event('change', { bubbles: true }))
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

    // The toolbar's own arrow, now the shared period control's: scoped to the
    // week mount because the invoice wizard further down the shell has one too.
    document
      .querySelector<HTMLButtonElement>('[data-week-period] [data-period-previous]')!
      .click()
    await vi.waitFor(() => expect(api.listProjects).toHaveBeenCalledTimes(2))
    const logoutButton = document.querySelector<HTMLButtonElement>('[data-logout]')!
    logoutButton.click()
    expect(document.querySelector<HTMLButtonElement>('[data-command-trigger]')?.disabled).toBe(
      true,
    )
    // The week stepper is the shared control now and builds its own arrows, so
    // it is out of reach of the `[data-auth-action]` sweep that used to disable
    // the two the toolbar served. Signed out, they still have to be dead.
    expect(
      document.querySelector<HTMLButtonElement>('[data-week-period] [data-period-previous]')
        ?.disabled,
    ).toBe(true)
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

  it('[e2e][approvals] confirms a bulk count and keeps a refused selection ticked', async () => {
    renderBrowserShell({ view: 'timesheet-approvals' })
    const base = browserApi()
    let pending = [pendingSubmission(31, 'Maya Member'), pendingSubmission(32, 'Noor Newton')]
    let attempts = 0
    const bulkApproveTimesheetSubmissions = vi.fn(
      async (_commandId: string, input: { submissions: readonly { id: number }[] }) => {
        attempts += 1
        if (attempts === 1) {
          throw new EzactoApiError(
            409,
            {
              error: {
                code: 'state_conflict',
                message: 'A selected timesheet submission changed before it could be approved.',
                fields: [
                  {
                    field: 'submissions[1].id',
                    code: 'state_conflict',
                    message: 'A selected timesheet submission changed before it could be approved.',
                  },
                ],
              },
            },
            null,
          )
        }
        const approved = new Set(input.submissions.map((selection) => selection.id))
        pending = pending.filter((submission) => !approved.has(submission.id))
        return []
      },
    )
    const api: ShellApi = {
      ...base,
      listTimesheetSubmissions: vi.fn(async () => []),
      listPendingTimesheetSubmissions: vi.fn(async () => ({
        submissions: pending,
        nextCursor: null,
      })),
      getTimesheetSubmission: vi.fn(async (id: number) =>
        pending.find((submission) => submission.id === id)!,
      ),
      bulkApproveTimesheetSubmissions,
    }

    await mountShell(api)
    const bulkCount = () => document.querySelector<HTMLElement>('[data-approval-bulk-count]')!
    const confirm = () =>
      document.querySelector<HTMLButtonElement>('[data-approval-bulk-approve]')!
    const select = (id: number) =>
      document.querySelector<HTMLInputElement>(`[data-approval-select="${id}"]`)!

    await vi.waitFor(() => expect(select(31)).not.toBeNull())
    expect(bulkCount().dataset.approvalBulkCount).toBe('0')
    expect(confirm().disabled).toBe(true)

    select(31).click()
    select(32).click()
    expect(bulkCount().dataset.approvalBulkCount).toBe('2')
    expect(confirm().textContent).toBe('Approve 2 selected')

    confirm().click()
    await vi.waitFor(() =>
      expect(bulkApproveTimesheetSubmissions).toHaveBeenCalledWith(
        expect.stringContaining('web.timesheet.bulk-approve:'),
        {
          submissions: [
            { id: 31, expected_version: 0 },
            { id: 32, expected_version: 0 },
          ],
        },
        expect.any(AbortSignal),
      ),
    )
    await vi.waitFor(() =>
      expect(document.querySelector('[data-approval-queue-result]')?.textContent).toContain(
        'Nothing was approved',
      ),
    )
    expect(bulkCount().dataset.approvalBulkCount).toBe('1')
    expect(select(31).checked).toBe(false)
    expect(select(32).checked).toBe(true)

    confirm().click()
    await vi.waitFor(() =>
      expect(bulkApproveTimesheetSubmissions).toHaveBeenLastCalledWith(
        expect.any(String),
        { submissions: [{ id: 32, expected_version: 0 }] },
        expect.any(AbortSignal),
      ),
    )
    await vi.waitFor(() =>
      expect(document.querySelector('[data-approval-queue-result]')?.textContent).toContain(
        '1 timesheet is approved',
      ),
    )
    expect(document.querySelector('[data-approval-select="32"]')).toBeNull()
  })
})
