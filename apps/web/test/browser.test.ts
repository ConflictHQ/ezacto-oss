/** @vitest-environment happy-dom */

import type { GeneralResource, TimeEntry, TimeEntryInput, TimeEntryPatch } from '@ezacto/client'
import { describe, expect, it, vi } from 'vitest'
import { mountShell } from '../src/shell/browser.js'
import { renderAppShell, type ShellApi } from '../src/index.js'

const timestamp = '2026-08-28T12:00:00.000Z'

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
    whoami: vi.fn(async () => undefined),
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

describe('week-grid browser behavior', () => {
  it('[e2e:track-week] preserves keyboard edits, notes, retry, copy, and phone-day writes', async () => {
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
    const saturday = document.querySelector<HTMLInputElement>(
      '[data-day-list] input[data-cell-key="1:1:2026-08-29"]',
    )!
    edit(saturday, '0.25')
    saturday.blur()
    await vi.waitFor(() =>
      expect(api.entries).toContainEqual(
        expect.objectContaining({ spent_date: '2026-08-29', seconds: 900 }),
      ),
    )
  })
})
