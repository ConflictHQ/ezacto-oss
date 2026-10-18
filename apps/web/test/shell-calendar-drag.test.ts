/** @vitest-environment happy-dom */

import { describe, expect, it, vi } from 'vitest'
import {
  browserApi,
  mountShell,
  renderBrowserShell,
  timeEntry,
} from './support/shell-harness.js'

/**
 * Issue 943: the calendar wired into the Time screen, in a duration
 * organization -- the case where the clock is new. What the calendar creates
 * carries its start and end; nothing else in the organization changes.
 */

const day = '2026-08-27'

const timedApi = () => {
  const api = browserApi()
  api.entries.push(
    timeEntry(10, {
      project_id: 2,
      task_id: 2,
      spent_date: day,
      started_time: '09:00',
      ended_time: '10:00',
    }),
  )
  return api
}

const mountCalendar = async (api = timedApi()) => {
  renderBrowserShell()
  document.documentElement.dataset.timeView = 'calendar'
  await mountShell(api)
  await vi.waitFor(() => expect(document.querySelector('[data-calendar-block="10"]')).not.toBeNull())
  return api
}

const key = (target: Element, name: string): void => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }))
}

describe('the calendar on the Time screen (issue 943)', () => {
  it('opens in Week, switches to Day, and remembers the choice for the server to render', async () => {
    await mountCalendar()
    expect(document.querySelector('.cal')!.getAttribute('data-layout')).toBe('week')
    document.querySelector<HTMLButtonElement>('[data-calendar-layout-choice="day"]')!.click()
    expect(document.documentElement.dataset.ezTimeLayout).toBe('day')
    expect(document.cookie).toContain('ezacto_time_layout=day')
    expect(document.querySelector('.cal')!.getAttribute('data-layout')).toBe('day')
    document.querySelector<HTMLButtonElement>('[data-calendar-layout-choice="week"]')!.click()
    expect(document.querySelector('.cal')!.getAttribute('data-layout')).toBe('week')
  })

  it('creates a timed entry in a duration organization, prefilled and saved with Enter in Notes', async () => {
    const api = await mountCalendar()
    const cursor = document.querySelector<HTMLElement>(`[data-calendar-cursor="${day}"]`)!
    cursor.click()
    const dialog = document.querySelector<HTMLDialogElement>('[data-entry-dialog]')!
    expect(dialog.dataset.entryContext).toBe('calendar')
    // The most recent entry (the 28th, Northpeak) sets project and task; the
    // span is the one that was drawn.
    expect(document.querySelector<HTMLSelectElement>('[data-entry-project]')!.value).toContain(
      'Northpeak',
    )
    expect(document.querySelector<HTMLInputElement>('[data-entry-start]')!.value).toBe('9:00 AM')
    expect(document.querySelector<HTMLInputElement>('[data-entry-end]')!.value).toBe('10:00 AM')
    const notes = document.querySelector<HTMLTextAreaElement>('[data-entry-note-input]')!
    expect(document.activeElement).toBe(notes)
    expect(document.querySelector('[data-calendar-draft]')).not.toBeNull()
    notes.value = 'Overlaps the standup'
    notes.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(api.createTimeEntry).toHaveBeenCalledTimes(1))
    const sent = vi.mocked(api.createTimeEntry).mock.calls[0]![0]
    expect(sent).toMatchObject({
      spent_date: day,
      started_time: '09:00',
      ended_time: '10:00',
      notes: 'Overlaps the standup',
    })
    // The overlap with the 09:00 entry is accepted, not refused.
    expect(sent).not.toHaveProperty('seconds')
    await vi.waitFor(() => expect(dialog.open).toBe(false))
    expect(document.querySelector('[data-calendar-draft]')).toBeNull()
  })

  it('discards the draft when the editor is closed without saving', async () => {
    const api = await mountCalendar()
    document.querySelector<HTMLElement>(`[data-calendar-cursor="${day}"]`)!.click()
    const dialog = document.querySelector<HTMLDialogElement>('[data-entry-dialog]')!
    expect(document.querySelector('[data-calendar-draft]')).not.toBeNull()
    dialog.close()
    expect(document.querySelector('[data-calendar-draft]')).toBeNull()
    expect(api.createTimeEntry).not.toHaveBeenCalled()
  })

  it('saves a keyboard move as the entry’s new day and times', async () => {
    const api = await mountCalendar()
    const block = document.querySelector<HTMLElement>('[data-calendar-block="10"]')!
    key(block, 'ArrowDown')
    key(block, 'ArrowDown')
    key(block, 'Enter')
    await vi.waitFor(() => expect(api.updateTimeEntry).toHaveBeenCalledTimes(1))
    expect(api.updateTimeEntry).toHaveBeenCalledWith(
      10,
      { spent_date: day, started_time: '09:30', ended_time: '10:30' },
      expect.any(AbortSignal),
    )
  })

  it('shows an entry with only hours in the band above the clock, with its hours', async () => {
    await mountCalendar()
    // Entry 1 is an hour on the 28th with no clock time.
    const chip = document.querySelector<HTMLElement>('[data-calendar-chip="1"]')!
    expect(chip.textContent).toContain('1')
    expect(document.querySelector('[data-calendar-block="1"]')).toBeNull()
  })
})
