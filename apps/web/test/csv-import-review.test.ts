import { describe, expect, it } from 'vitest'
import { csvPreview as preview } from './support/csv-ui-fixture.js'
import { afterSessionChange, applyCommand, blockers, physicalLines, startReview } from '../src/csv-import/review.js'
import { cancelNotice } from '../src/csv-import/contract.js'


const actor = 'administrator:2:session-generation-1'
const commandId = '00000000-0000-4000-8000-000000000001'

describe('actual CSV preview review binding', () => {
  it('requires review, destination difference and inactive-person acknowledgements', () => {
    const review = startReview(preview(), actor)
    expect(blockers(review)).toHaveLength(3)
    expect(() => applyCommand(review, commandId)).toThrow()
    review.reviewed = review.destinationDifference = review.newPeople = true
    expect(blockers(review)).toEqual([])
    expect(applyCommand(review, commandId)).toEqual({ preview_id: review.preview.preview_id, command_id: commandId, version: 2,
      expected_selected_rows: 2, expected_source_seconds: 7201, expected_destination_seconds: 7200,
      acknowledge_exclusions: false, acknowledge_destination_difference: true, acknowledge_new_people: true })
  })
  it('never turns remaining rejected rows into an implicit partial import', () => {
    const data = preview(); data.tallies.rejected_row_count = 1
    const review = startReview(data, actor); review.reviewed = review.exclusions = review.destinationDifference = review.newPeople = true
    expect(blockers(review).join(' ')).toContain('Resolve or explicitly exclude all 1 rejected rows')
    expect(() => applyCommand(review, commandId)).toThrow()
  })
  it('requires exact reviewed exclusions on the replacement preview and resets all acknowledgements', () => {
    const data = preview(); data.choices.excluded_lines = [3]; data.tallies.file_rows = 3
    const review = startReview(data, actor); review.reviewed = review.destinationDifference = review.newPeople = true
    expect(blockers(review).join(' ')).toContain('1 excluded physical lines')
    review.exclusions = true
    expect(applyCommand(review, commandId).acknowledge_exclusions).toBe(true)
    expect(startReview(data, actor)).toMatchObject({ reviewed: false, exclusions: false, destinationDifference: false, newPeople: false })
  })
  it('binds a private immutable copy rather than the caller’s mutable payload', () => {
    const data = preview(), review = startReview(data, actor)
    data.tallies.selected_rows = 999; data.choices.excluded_lines.push(7)
    expect(review.preview.tallies.selected_rows).toBe(2)
    expect(review.preview.choices.excluded_lines).toEqual([])
    expect(Object.isFrozen(review.preview.tallies)).toBe(true)
  })
  it('uses a fresh version only for an explicitly new resume command', () => {
    const review = startReview(preview(), actor); review.reviewed = review.destinationDifference = review.newPeople = true
    const original = applyCommand(review, commandId)
    const resumed = applyCommand(review, '00000000-0000-4000-8000-000000000002', 9)
    expect(resumed.version).toBe(9)
    expect(original.version).toBe(2)
    expect(resumed.preview_id).toBe(original.preview_id)
    expect(resumed.expected_source_seconds).toBe(original.expected_source_seconds)
  })
  it('discards review on changed user, role or session generation', () => {
    const review = startReview(preview(), actor)
    expect(afterSessionChange(review, actor)).toBe(review)
    for (const changed of [null, 'member:2:session-generation-1', 'administrator:2:session-generation-2', 'administrator:3:session-generation-1']) expect(afterSessionChange(review, changed)).toBeNull()
  })
  it('keeps file errors and an empty selection blocked despite acknowledgements', () => {
    const data = preview(); data.tallies.file_error_count = 1; data.tallies.selected_rows = 0
    const review = startReview(data, actor); review.reviewed = review.exclusions = review.destinationDifference = review.newPeople = true
    expect(blockers(review)).toHaveLength(2)
  })
  it('parses explicit physical data lines without accepting headers, ranges or lossy numbers', () => {
    expect(physicalLines('7, 2, 7, 12')).toEqual([2, 7, 12])
    expect(physicalLines('')).toEqual([])
    for (const invalid of ['1', '0', '2-7', '2,,3', '2.5', '9007199254740992']) expect(() => physicalLines(invalid)).toThrow()
  })
  it('never labels a committed stop as rollback', () => {
    expect(cancelNotice(7, 3)).toContain('7 committed time rows and 3 created setup records remain')
    expect(cancelNotice(7, 3)).toContain('Nothing was rolled back')
  })
})
