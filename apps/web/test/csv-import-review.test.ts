import { describe, expect, it } from 'vitest'
import { afterSessionChange, physicalLines, startReview } from '../src/csv-import/review.js'
import { csvPreview } from './support/csv-ui-fixture.js'

describe('immutable CSV preview review', () => {
  it('copies and freezes the reviewed wire receipt', () => {
    const preview = csvPreview(), review = startReview(preview, 'admin:session')
    preview.choices.excluded_lines.push(4)
    expect(review.preview.choices.excluded_lines).toEqual([])
    expect(Object.isFrozen(review.preview.tallies)).toBe(true)
  })
  it('discards review across session or role changes', () => {
    const review = startReview(csvPreview(), 'admin:session')
    expect(afterSessionChange(review, 'admin:session')).toBe(review)
    expect(afterSessionChange(review, 'admin:other')).toBeNull()
    expect(afterSessionChange(review, null)).toBeNull()
  })
  it('keeps rejected rows and file errors explicit in review', () => {
    const preview = csvPreview(); preview.tallies.rejected_row_count = 3; preview.tallies.file_error_count = 1
    expect(startReview(preview, 'a').preview.tallies).toMatchObject({ rejected_row_count: 3, file_error_count: 1 })
  })
  it('canonicalizes physical-line exclusions without accepting headers or unsafe numbers', () => {
    expect(physicalLines('4, 2, 4')).toEqual([2, 4])
    expect(physicalLines('')).toEqual([])
    for (const value of ['1', '-2', '2.5', '2e3', '9007199254740992']) expect(() => physicalLines(value)).toThrow()
  })
})
