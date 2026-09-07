import { describe, expect, it } from 'vitest'
import {
  canonicalDate,
  formatDuration,
  localDate,
  parseDuration,
  weekRange,
} from '../src/time.js'

describe('CLI time values', () => {
  it('[unit] parses compact hour/minute durations to exact seconds', () => {
    expect(parseDuration('2h')).toBe(7200)
    expect(parseDuration('90m')).toBe(5400)
    expect(parseDuration('1h30m')).toBe(5400)
    expect(parseDuration('1.5h')).toBe(5400)
    expect(formatDuration(5400)).toBe('1:30')
    expect(formatDuration(3661)).toBe('1:01:01')
  })

  it('[unit] renders a correction as a negative duration, not as no value', () => {
    // Formatting the magnitude and restoring the sign, rather than flooring a
    // negative: Math.floor(-1800 / 3600) is -1, which would print -1:30 for
    // half an hour back.
    expect(formatDuration(-1800)).toBe('-0:30')
    expect(formatDuration(-5400)).toBe('-1:30')
    expect(formatDuration(-3661)).toBe('-1:01:01')
    expect(formatDuration(Number.NaN)).toBe('—')
  })

  it.each(['', '2', 'soon', '0h', '-1h', '0.001h'])(
    '[unit] rejects invalid or sub-second duration %j',
    (value) => expect(() => parseDuration(value)).toThrow(/duration/),
  )

  it('[unit] validates real calendar dates and uses local calendar components', () => {
    expect(canonicalDate('2026-08-28')).toBe('2026-08-28')
    expect(() => canonicalDate('2026-02-29')).toThrow(/invalid date/)
    expect(localDate(new Date(2026, 7, 28, 23, 59))).toBe('2026-08-28')
  })

  it('[unit] finds deterministic Monday–Sunday week boundaries', () => {
    expect(weekRange('2026-08-28')).toEqual({
      from: '2026-08-24',
      to: '2026-08-30',
      dates: [
        '2026-08-24',
        '2026-08-25',
        '2026-08-26',
        '2026-08-27',
        '2026-08-28',
        '2026-08-29',
        '2026-08-30',
      ],
    })
  })
})
