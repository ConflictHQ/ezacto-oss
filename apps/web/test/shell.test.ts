import { describe, expect, it, vi } from 'vitest'
import {
  loadShellSnapshot,
  navigationDestination,
  parseQuickAdd,
  quickAdd,
  renderAppShell,
  renderDataQualityBanner,
  renderDocumentShell,
  runningElapsedSeconds,
  webAssets,
  type ShellApi,
} from '../src/index.js'
import type {
  GeneralResource,
  TimeEntry,
  TimeEntryInput,
  TimeEntryPatch,
  Whoami,
} from '@ezacto/client'

const timestamp = '2026-08-28T12:00:00.000Z'
const identity: Whoami = {
  user_id: 1,
  profile: 'administrator',
  manager_grants: [],
  authentication: { kind: 'session' },
}
const project: GeneralResource = {
  id: 1,
  name: 'Northpeak',
  code: 'northpeak',
  created_at: timestamp,
  updated_at: timestamp,
}
const task: GeneralResource = {
  id: 1,
  name: 'DevOps',
  created_at: timestamp,
  updated_at: timestamp,
}

const entry = (input: TimeEntryInput, id: number): TimeEntry => ({
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

const memoryApi = (): ShellApi & { entries: TimeEntry[] } => {
  const entries: TimeEntry[] = []
  return {
    entries,
    whoami: vi.fn(async () => identity),
    signIn: vi.fn(async () => ({
      status: 'authenticated' as const,
      user_id: 1,
      profile: 'administrator' as const,
      manager_grants: [],
    })),
    logoutCurrentSession: vi.fn(async () => ({
      id: 1,
      created_at: timestamp,
      last_seen_at: timestamp,
      idle_expires_at: timestamp,
      absolute_expires_at: timestamp,
      revoked_at: timestamp,
      revocation_reason: 'user_revoked' as const,
      current: false,
    })),
    listProjects: vi.fn(async () => ({
      data: [project],
      page: { next_cursor: null },
    })),
    listTasks: vi.fn(async () => ({
      data: [task],
      page: { next_cursor: null },
    })),
    listTimeEntries: vi.fn(async (query) =>
      query.is_running === true ? entries.filter((item) => item.is_running) : [...entries],
    ),
    createTimeEntry: vi.fn(async (input) => {
      const created = entry(input, entries.length + 1)
      entries.push(created)
      return created
    }),
    updateTimeEntry: vi.fn(async (id, patch: TimeEntryPatch) => {
      const current = entries.find((item) => item.id === id)
      if (current === undefined) throw new Error('entry not found')
      const updated = { ...current, ...patch, updated_at: timestamp }
      entries.splice(entries.indexOf(current), 1, updated)
      return updated
    }),
    deleteTimeEntry: vi.fn(async (id) => {
      const index = entries.findIndex((item) => item.id === id)
      if (index === -1) throw new Error('entry not found')
      entries.splice(index, 1)
    }),
    stopTimeEntry: vi.fn(async (id) => {
      const current = entries.find((item) => item.id === id)
      if (current === undefined) throw new Error('entry not found')
      const stopped = { ...current, is_running: false, seconds: 60 }
      entries.splice(entries.indexOf(current), 1, stopped)
      return stopped
    }),
  }
}

describe('S-1 through S-5 application shell', () => {
  it('[e2e:track-week] keeps the global timer in desktop and phone shell CSS', () => {
    const html = renderAppShell({
      environment: 'test',
      release: 'abcdef012345',
    })
    expect(html).toContain('data-timer-chip')
    expect(html).toContain('data-timer-dialog')
    expect(html).toContain('data-menu-dialog')
    expect(html).toContain('data-week-grid')
    expect(html).toContain('data-day-list')
    expect(html).toContain('data-copy-last-week')
    expect(html).toContain('data-add-row-trigger')
    expect(html).toContain('data-note-dialog')
    expect(html).toContain('data-sign-in-form')
    expect(html).toContain('method="post" action="/auth/sign-in"')
    expect(html).toContain('autocomplete="username"')
    expect(html).toContain('autocomplete="current-password"')
    expect(html).toContain('data-current-identity')
    expect(html).toContain('data-logout')
    expect(html).toContain('name="viewport"')
    expect(webAssets.stylesheet).toContain('@media (max-width: 720px)')
    expect(webAssets.stylesheet).toContain('.timer-chip {')
    expect(webAssets.stylesheet).not.toMatch(/\.timer-chip\s*\{[^}]*display:\s*none/su)
    expect(webAssets.javascript).toContain('credentials:"same-origin"')
  })

  it('[e2e:phone-week] swaps the seven-day table for a touch-sized day switcher', () => {
    const html = renderAppShell({ environment: 'test', release: 'abcdef012345' })
    expect(html).toContain('class="day-switcher"')
    expect(html).toContain('data-day-previous')
    expect(html).toContain('data-day-next')
    expect(webAssets.stylesheet).toMatch(
      /@media \(max-width: 720px\)[\s\S]*\.week-grid-wrap \{[\s\S]*display: none;/u,
    )
    expect(webAssets.stylesheet).toMatch(
      /@media \(max-width: 720px\)[\s\S]*\.day-list \{[\s\S]*display: block;/u,
    )
    expect(webAssets.stylesheet).toMatch(
      /\.week-actions button,[\s\S]*\.day-switcher button \{[\s\S]*min-height: 44px;/u,
    )
    expect(webAssets.stylesheet).toMatch(
      /@media \(max-width: 720px\)[\s\S]*\.sign-in-form \{[\s\S]*grid-template-columns: 1fr;/u,
    )
    expect(webAssets.stylesheet).toMatch(
      /\.sign-in-form input \{[\s\S]*min-height: 44px;/u,
    )
  })

  it('[acceptance] renders only configured fixed-path OIDC providers with password fallback', () => {
    const configured = renderAppShell({
      environment: 'test',
      release: 'abcdef012345',
      signInProviders: ['google'],
    })
    expect(configured).toContain('data-oidc-provider="google"')
    expect(configured).toContain('href="/auth/oidc/google"')
    expect(configured).toContain('Continue with Google')
    expect(configured).toContain('method="post" action="/auth/sign-in"')
    expect(configured).not.toContain('accounts.google.com')
    expect(configured).not.toContain('client_secret')

    const unavailable = renderAppShell({
      environment: 'test',
      release: 'abcdef012345',
    })
    expect(unavailable).not.toContain('data-oidc-provider')
    expect(unavailable).toContain('data-oidc-unavailable')
    expect(unavailable).toContain('Use your email and password.')
    expect(webAssets.stylesheet).toMatch(/\.oidc-sign-in \{[\s\S]*min-height: 44px;/u)
    expect(webAssets.stylesheet).toMatch(
      /@media \(max-width: 720px\)[\s\S]*\.oidc-entry \{[\s\S]*flex-direction: column;/u,
    )
  })

  it('[unit] resolves K-bar navigation and computes a live timer counter', () => {
    expect(navigationDestination('go reports')).toBe('/reports')
    expect(navigationDestination('GO time')).toBe('/')
    expect(navigationDestination('log 2h northpeak devops')).toBeNull()
    const running = entry({ project_id: 1, task_id: 1 }, 1)
    expect(runningElapsedSeconds(running, new Date('2026-08-28T12:01:30.000Z'))).toBe(90)
  })

  it('[unit] creates an entry and the refreshed week snapshot reflects it', async () => {
    const api = memoryApi()
    expect(parseQuickAdd('log 2h northpeak devops')).toEqual({
      seconds: 7_200,
      project: 'northpeak',
      task: 'devops',
    })

    await quickAdd(api, 'log 2h northpeak devops shipped', new Date(timestamp))
    const snapshot = await loadShellSnapshot(api, new Date(timestamp))

    expect(api.createTimeEntry).toHaveBeenCalledWith({
      project_id: 1,
      task_id: 1,
      spent_date: '2026-08-28',
      seconds: 7_200,
      notes: 'shipped',
    })
    expect(snapshot.entries).toHaveLength(1)
    expect(snapshot.entries[0]).toMatchObject({
      project_label: 'Northpeak',
      task_label: 'DevOps',
      seconds: 7_200,
    })
  })

  it('[unit] renders an escaped DV-11 fix deep-link and rejects external targets', () => {
    const banner = renderDataQualityBanner({
      message: 'Two people are missing <rates>.',
      fixHref: '/settings/team?filter=missing-rates',
      fixLabel: 'Add missing rates',
    })
    expect(banner).toContain('Two people are missing &lt;rates&gt;.')
    expect(banner).toContain('href="/settings/team?filter=missing-rates"')
    expect(() =>
      renderDataQualityBanner({
        message: 'Unsafe',
        fixHref: 'https://example.test',
        fixLabel: 'Leave',
      }),
    ).toThrow('deep links must be same-origin absolute paths')
  })

  it('[unit] renders money artifacts in the chromeless pinned document shell', () => {
    const html = renderDocumentShell('Invoice <123>', '<script>unsafe()</script>')
    expect(html).toContain('data-document-shell')
    expect(html).toContain('data-ez-theme="precision"')
    expect(html).toContain('Invoice &lt;123&gt;')
    expect(html).toContain('&lt;script&gt;unsafe()&lt;/script&gt;')
    expect(html).not.toContain('<script>unsafe()</script>')
  })
})
