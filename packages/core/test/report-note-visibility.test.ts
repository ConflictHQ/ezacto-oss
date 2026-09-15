import { describe, expect, it } from 'vitest'
import { previewClientReportNotes, reportNotesForAudience } from '../src/report-note-visibility.js'

const entries = [
  { id: 1, notes: 'Review https://github.example/pull/417 with @alicia on ticket 92', clientVisible: true },
  { id: 2, notes: 'Internal margin concern for Leo Mata', clientVisible: false },
  { id: 3, notes: 'Inherited policy note', clientVisible: null },
] as const

describe('report note visibility', () => {
  it('keeps internal notes internally and removes them from a client render', () => {
    expect(reportNotesForAudience(entries, 'internal', true).map(({ id }) => id)).toEqual([1, 2, 3])
    expect(reportNotesForAudience(entries, 'client', true).map(({ id }) => id)).toEqual([1, 3])
    expect(reportNotesForAudience(entries, 'client', false).map(({ id }) => id)).toEqual([1])
  })

  it('flags risky note content as warnings without blocking the preview', () => {
    const preview = previewClientReportNotes(entries, true, ['Alicia', 'Leo Mata'])
    expect(preview.allowed).toBe(true)
    expect(preview.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ entryId: 1, kind: 'url', match: 'https://github.example/pull/417' }),
      expect.objectContaining({ entryId: 1, kind: 'mention' }),
      expect.objectContaining({ entryId: 1, kind: 'ticket_reference' }),
    ]))
    expect(preview.warnings.some(({ entryId }) => entryId === 2)).toBe(false)
  })
})
