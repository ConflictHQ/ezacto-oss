import type { TimeEntry } from '@ezacto/client'
import { describe, expect, it } from 'vitest'
import {
  formatTimeForClock,
  modeForEntryDraft,
  parseTimeForClock,
} from '../src/components/time-entry-editor.js'

const entry = (startedTime: string | null): TimeEntry =>
  ({
    started_time: startedTime,
    ended_time: startedTime === null ? null : '17:30',
  }) as TimeEntry

describe('time entry editor clock boundary', () => {
  it('round-trips canonical midnight, noon, and evening through the 12-hour UI', () => {
    const cases = [
      ['00:00', '12:00 AM'],
      ['00:05', '12:05 AM'],
      ['12:00', '12:00 PM'],
      ['17:35', '5:35 PM'],
      ['23:59', '11:59 PM'],
    ] as const

    for (const [canonical, displayed] of cases) {
      expect(formatTimeForClock(canonical, '12h')).toBe(displayed)
      expect(parseTimeForClock(displayed, '12h')).toBe(canonical)
    }
  })

  it('keeps canonical HH:MM in the 24-hour UI and rejects non-canonical values', () => {
    expect(formatTimeForClock('09:05', '24h')).toBe('09:05')
    expect(parseTimeForClock('09:05', '24h')).toBe('09:05')
    expect(() => parseTimeForClock('9:05', '24h')).toThrow('canonical HH:MM')
    expect(() => parseTimeForClock('24:00', '24h')).toThrow('canonical HH:MM')
  })

  it('uses the organization mode for new entries and stored timing for edits', () => {
    expect(modeForEntryDraft(null, 'start_end')).toBe('start_end')
    expect(modeForEntryDraft(null, 'duration')).toBe('duration')
    expect(modeForEntryDraft(entry(null), 'start_end')).toBe('duration')
    expect(modeForEntryDraft(entry('09:00'), 'duration')).toBe('start_end')
  })
})
