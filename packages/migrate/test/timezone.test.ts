// Issue 757. Harvest hands out Rails display names, not IANA zones, and the load
// stored them verbatim. Sixty imported people carried a timezone `Intl` refuses,
// which the tracked-resource repository then had to defend against downstream
// (issue 755). This is the door that should have refused them.

import { describe, expect, it } from 'vitest'
import { normalizeTimezone, usableTimezone } from '../src/timezone.js'

describe('normalizing a source timezone', () => {
  it('[money] maps the Harvest display names that reached production', () => {
    // The exact four that landed on real people, and the four they should have
    // been. "Central America" is Rails' name for the unvarying UTC-6 bloc.
    expect(normalizeTimezone('Central America', 'UTC').timezone).toBe('America/Guatemala')
    expect(normalizeTimezone('Warsaw', 'UTC').timezone).toBe('Europe/Warsaw')
    expect(normalizeTimezone('Pacific Time (US & Canada)', 'UTC').timezone)
      .toBe('America/Los_Angeles')
    expect(normalizeTimezone('Mountain Time (US & Canada)', 'UTC').timezone)
      .toBe('America/Denver')
  })

  it('[money] every name it maps to is one a calendar can build', () => {
    // A table nobody checks rots: Rails still names zones the host tzdata has
    // retired. This walks the whole table rather than trusting it.
    const refused: string[] = []
    for (const display of ['Central America', 'Warsaw', 'Kyiv', 'Rangoon', 'Samoa',
      'Chatham Is.', "Nuku'alofa", 'Srednekolymsk', 'Greenland', 'Mid-Atlantic']) {
      const { timezone, unmapped } = normalizeTimezone(display, 'UTC')
      if (unmapped !== undefined || !usableTimezone(timezone)) refused.push(display)
    }
    expect(refused).toEqual([])
  })

  it('[money] an IANA zone passes through untouched', () => {
    // A Harvest account edited through the API can already hold one, and the
    // display-name table must never shadow it.
    expect(normalizeTimezone('America/Costa_Rica', 'UTC').timezone).toBe('America/Costa_Rica')
    expect(normalizeTimezone('Europe/Warsaw', 'UTC').timezone).toBe('Europe/Warsaw')
  })

  it('[money] refuses what it cannot map, and says which value it dropped', () => {
    // Refusing is the point. Storing it is what caused issue 755.
    expect(normalizeTimezone('Nowhere In Particular', 'America/Costa_Rica')).toEqual({
      timezone: 'America/Costa_Rica',
      unmapped: 'Nowhere In Particular',
    })
  })

  it('[unit] falls back without complaint when the source simply had none', () => {
    // Absent is not the same as wrong: there is nothing to report.
    expect(normalizeTimezone(null, 'America/Costa_Rica')).toEqual({
      timezone: 'America/Costa_Rica',
    })
    expect(normalizeTimezone('   ', 'America/Costa_Rica')).toEqual({
      timezone: 'America/Costa_Rica',
    })
  })

  it('[unit] trims a padded value rather than refusing it', () => {
    expect(normalizeTimezone('  Warsaw  ', 'UTC').timezone).toBe('Europe/Warsaw')
  })

  it('[security] never returns a zone the caller cannot build a calendar on', () => {
    // The whole contract in one line: whatever comes out, `Intl` accepts it --
    // including the fallback, which is the caller's to get right.
    for (const value of ['Central America', 'America/Denver', 'utter nonsense', null, '']) {
      expect(usableTimezone(normalizeTimezone(value, 'UTC').timezone)).toBe(true)
    }
  })
})
