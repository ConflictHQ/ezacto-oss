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
import type { GeneralResource, TimeEntry, TimeEntryInput } from '@ezacto/client'

const timestamp = '2026-08-28T12:00:00.000Z'
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
    whoami: vi.fn(async () => undefined),
    listProjects: vi.fn(async () => ({
      data: [project],
      page: { next_cursor: null },
    })),
    listTasks: vi.fn(async () => ({
      data: [task],
      page: { next_cursor: null },
    })),
    listTimeEntries: vi.fn(async (query) =>
      query.is_running === true
        ? entries.filter((item) => item.is_running)
        : [...entries],
    ),
    createTimeEntry: vi.fn(async (input) => {
      const created = entry(input, entries.length + 1)
      entries.push(created)
      return created
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
    expect(html).toContain('name="viewport"')
    expect(webAssets.stylesheet).toContain('@media (max-width: 720px)')
    expect(webAssets.stylesheet).toContain('.timer-chip {')
    expect(webAssets.stylesheet).not.toMatch(
      /\.timer-chip\s*\{[^}]*display:\s*none/su,
    )
  })

  it('[unit] resolves K-bar navigation and computes a live timer counter', () => {
    expect(navigationDestination('go reports')).toBe('/reports')
    expect(navigationDestination('GO time')).toBe('/')
    expect(navigationDestination('log 2h northpeak devops')).toBeNull()
    const running = entry({ project_id: 1, task_id: 1 }, 1)
    expect(
      runningElapsedSeconds(running, new Date('2026-08-28T12:01:30.000Z')),
    ).toBe(90)
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
    const html = renderDocumentShell(
      'Invoice <123>',
      '<script>unsafe()</script>',
    )
    expect(html).toContain('data-document-shell')
    expect(html).toContain('data-ez-theme="precision"')
    expect(html).toContain('Invoice &lt;123&gt;')
    expect(html).toContain('&lt;script&gt;unsafe()&lt;/script&gt;')
    expect(html).not.toContain('<script>unsafe()</script>')
  })
})
