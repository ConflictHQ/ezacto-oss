import type { GeneralResource, TimeEntry, TimeEntryInput, TimeEntryPatch } from '@ezacto/client'
import { describe, expect, it, vi } from 'vitest'
import {
  buildWeekGrid,
  formatCellHours,
  parseCellSeconds,
  saveWeekCellWithRetry,
  seedsFromEntries,
  weekDates,
  type DisplayTimeEntry,
  type ShellApi,
  type ShellSnapshot,
} from '../src/index.js'

const timestamp = '2026-08-28T12:00:00.000Z'
const project = (id: number, name: string): GeneralResource => ({
  id,
  name,
  created_at: timestamp,
  updated_at: timestamp,
})
const task = project

const entry = (id: number, overrides: Partial<DisplayTimeEntry> = {}): DisplayTimeEntry => ({
  id,
  user_id: 1,
  project_id: 1,
  task_id: 1,
  spent_date: '2026-08-28',
  seconds: 3_600,
  is_running: false,
  timer_started_at: null,
  notes: null,
  billable: true,
  budgeted: false,
  approval_status: 'unsubmitted',
  is_billed: false,
  is_locked: false,
  created_at: timestamp,
  updated_at: timestamp,
  project_label: 'Northpeak',
  task_label: 'Development',
  ...overrides,
})

const snapshot = (entries: readonly DisplayTimeEntry[]): ShellSnapshot => ({
  entries,
  running: entries.find((item) => item.is_running) ?? null,
  catalog: {
    projects: [project(1, 'Northpeak'), project(2, 'Acme')],
    tasks: [task(1, 'Development'), task(2, 'Design')],
  },
})

const apiFor = (
  entries: TimeEntry[],
): ShellApi & {
  createTimeEntry: ReturnType<typeof vi.fn<ShellApi['createTimeEntry']>>
  updateTimeEntry: ReturnType<typeof vi.fn<ShellApi['updateTimeEntry']>>
  deleteTimeEntry: ReturnType<typeof vi.fn<ShellApi['deleteTimeEntry']>>
} => {
  const createTimeEntry = vi.fn<ShellApi['createTimeEntry']>(async (input: TimeEntryInput) => {
    const created = entry(entries.length + 1, {
      project_id: input.project_id,
      task_id: input.task_id,
      spent_date: input.spent_date ?? '2026-08-28',
      seconds: input.seconds ?? 0,
      notes: input.notes ?? null,
    })
    entries.push(created)
    return created
  })
  const updateTimeEntry = vi.fn<ShellApi['updateTimeEntry']>(
    async (id: number, patch: TimeEntryPatch) => {
      const current = entries.find((item) => item.id === id)
      if (current === undefined) throw new Error('entry not found')
      const updated = { ...current, ...patch }
      entries.splice(entries.indexOf(current), 1, updated)
      return updated
    },
  )
  const deleteTimeEntry = vi.fn<ShellApi['deleteTimeEntry']>(async (id: number) => {
    const index = entries.findIndex((item) => item.id === id)
    if (index === -1) throw new Error('entry not found')
    entries.splice(index, 1)
  })
  return {
    whoami: vi.fn(async () => ({
      user_id: 1,
      profile: 'administrator' as const,
      manager_grants: [],
      authentication: { kind: 'session' as const },
    })),
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
    listProjects: vi.fn(),
    listTasks: vi.fn(),
    listTimeEntries: vi.fn(),
    stopTimeEntry: vi.fn(),
    createTimeEntry,
    updateTimeEntry,
    deleteTimeEntry,
  }
}

describe('timesheet week grid', () => {
  it('[unit] builds Monday-through-Sunday rows, totals, conflicts, and live edges', () => {
    const entries = [
      entry(1, { spent_date: '2026-08-24', seconds: 1_800 }),
      entry(2, { spent_date: '2026-08-28', seconds: 3_600, notes: 'First' }),
      entry(3, { spent_date: '2026-08-28', seconds: 900, notes: 'Second' }),
      entry(4, {
        project_id: 2,
        task_id: 2,
        project_label: 'Acme',
        task_label: 'Design',
        spent_date: '2026-08-30',
        seconds: 1_200,
        is_running: true,
      }),
      entry(5, { spent_date: '2026-08-31', seconds: 99_999 }),
    ]
    const grid = buildWeekGrid(snapshot(entries), '2026-08-28')

    expect(grid.dates).toEqual([
      '2026-08-24',
      '2026-08-25',
      '2026-08-26',
      '2026-08-27',
      '2026-08-28',
      '2026-08-29',
      '2026-08-30',
    ])
    expect(grid.rows).toHaveLength(2)
    expect(grid.rows[0]).toMatchObject({
      projectLabel: 'Acme',
      taskLabel: 'Design',
      totalSeconds: 1_200,
      isRunning: true,
    })
    expect(grid.rows[0]?.cells[6]).toMatchObject({ isRunning: true })
    expect(grid.rows[1]?.cells[4]).toMatchObject({
      totalSeconds: 4_500,
      notes: null,
      isConflict: true,
    })
    expect(grid.dayTotals).toEqual([1_800, 0, 0, 0, 4_500, 0, 1_200])
    expect(grid.totalSeconds).toBe(7_500)
  })

  it('[unit] parses and formats decimal or clock-form hours without ambiguous values', () => {
    expect(weekDates('2026-08-24')).toHaveLength(7)
    expect(parseCellSeconds('1.25')).toBe(4_500)
    expect(parseCellSeconds('1:30')).toBe(5_400)
    expect(parseCellSeconds('')).toBe(0)
    expect(formatCellHours(5_400)).toBe('1.5')
    expect(formatCellHours(0)).toBe('')
    for (const seconds of [1, 59, 60, 3_599, 3_601, 86_399]) {
      expect(parseCellSeconds(formatCellHours(seconds))).toBe(seconds)
    }
    expect(() => parseCellSeconds('1h30m')).toThrow(/decimal hours or H:MM/u)
    expect(() => parseCellSeconds('24:01')).toThrow(/24 hours/u)
  })

  it('[unit] creates, updates, and clears one safe canonical cell', async () => {
    const entries: TimeEntry[] = []
    const api = apiFor(entries)
    const emptyCell = buildWeekGrid(snapshot([]), '2026-08-28', [{ projectId: 1, taskId: 1 }])
      .rows[0]!.cells[4]!

    const created = await saveWeekCellWithRetry(api, emptyCell, '2', 'Built grid')
    expect(created).toMatchObject({
      state: 'saved',
      entry: { seconds: 7_200 },
    })
    expect(api.createTimeEntry).toHaveBeenCalledWith({
      project_id: 1,
      task_id: 1,
      spent_date: '2026-08-28',
      seconds: 7_200,
      notes: 'Built grid',
    })

    const populatedCell = buildWeekGrid(snapshot(entries as DisplayTimeEntry[]), '2026-08-28')
      .rows[0]!.cells[4]!
    await saveWeekCellWithRetry(api, populatedCell, '2:30')
    expect(api.updateTimeEntry).toHaveBeenCalledWith(1, { seconds: 9_000 })

    const updatedCell = buildWeekGrid(snapshot(entries as DisplayTimeEntry[]), '2026-08-28')
      .rows[0]!.cells[4]!
    await saveWeekCellWithRetry(api, updatedCell, '')
    expect(api.deleteTimeEntry).toHaveBeenCalledWith(1)
    expect(entries).toEqual([])
  })

  it('[unit] preserves a failed value in an explicit retry result until it saves', async () => {
    const api = apiFor([])
    api.createTimeEntry
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce(entry(1, { seconds: 2_700 }))
    const cell = buildWeekGrid(snapshot([]), '2026-08-28', [{ projectId: 1, taskId: 1 }]).rows[0]!
      .cells[4]!

    const failed = await saveWeekCellWithRetry(api, cell, '0.75')
    expect(failed).toMatchObject({
      state: 'retry',
      rawValue: '0.75',
      message: 'network unavailable',
    })
    if (failed.state !== 'retry') throw new Error('retry result expected')
    await expect(failed.retry()).resolves.toMatchObject({ state: 'saved' })
    expect(api.createTimeEntry).toHaveBeenCalledTimes(2)
  })

  it('[unit] deduplicates project/task seeds copied from prior entries', () => {
    expect(
      seedsFromEntries([
        { project_id: 1, task_id: 2 },
        { project_id: 1, task_id: 2 },
        { project_id: 2, task_id: 1 },
      ]),
    ).toEqual([
      { projectId: 1, taskId: 2 },
      { projectId: 2, taskId: 1 },
    ])
  })
})
