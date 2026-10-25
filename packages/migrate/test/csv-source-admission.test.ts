import { expect, it, vi } from 'vitest'
import { MAX_CSV_COLUMNS, MAX_CSV_ROWS, MAX_FIELD_LENGTH, parseCsv, type CsvAdapter } from '../src/csv-contract.js'

const bytes = (text: string) => new TextEncoder().encode(text)
const adapter = () => vi.fn<CsvAdapter>(() => ({
  records: [{ line: 1, fields: ['date', 'person_email', 'client', 'project', 'task', 'hours'] }],
  invalid: [], warnings: [], fileErrors: [],
}))

it('[#1179] refuses excess source rows before any vendor projection work', () => {
  const project = adapter()
  const result = parseCsv(bytes('source\n' + 'x\n'.repeat(MAX_CSV_ROWS + 1)), project)
  expect(result.fileErrors).toEqual([expect.objectContaining({ line: 1, code: 'too_many_rows' })])
  expect(project).not.toHaveBeenCalled()
})

it('[#1179] refuses excess source row columns before they can be discarded', () => {
  const project = adapter()
  const result = parseCsv(bytes('source\n' + Array.from({ length: MAX_CSV_COLUMNS + 1 }, () => 'x').join(',')), project)
  expect(result.fileErrors).toEqual([expect.objectContaining({ line: 2, code: 'too_many_columns' })])
  expect(project).not.toHaveBeenCalled()
})

it('[#1179] bounds even ignored source cells and preserves their physical record line', () => {
  const project = adapter()
  const result = parseCsv(bytes('source\nok\n"multiline\n' + 'x'.repeat(MAX_FIELD_LENGTH) + '"'), project)
  expect(result.fileErrors).toEqual([expect.objectContaining({ line: 3, code: 'field_too_long' })])
  expect(project).not.toHaveBeenCalled()
})

it('[#1179] applies the source field bound to headers and decoded escaped quotes', () => {
  for (const source of ['x'.repeat(MAX_FIELD_LENGTH + 1), 'source\n"' + '""'.repeat(MAX_FIELD_LENGTH + 1) + '"']) {
    const project = adapter()
    expect(parseCsv(bytes(source), project).fileErrors[0]?.code).toBe('field_too_long')
    expect(project).not.toHaveBeenCalled()
  }
})

it('[#1179] admits exact source field, column and row limits', () => {
  const project = adapter()
  const header = Array.from({ length: MAX_CSV_COLUMNS }, (_, index) => 'field' + index).join(',')
  const row = ['x'.repeat(MAX_FIELD_LENGTH), ...Array.from({ length: MAX_CSV_COLUMNS - 1 }, () => 'x')].join(',')
  expect(parseCsv(bytes(header + '\n' + row), project).fileErrors).toEqual([])
  expect(project).toHaveBeenCalledOnce()
  const rowsProject = adapter()
  expect(parseCsv(bytes('source\n' + 'x\n'.repeat(MAX_CSV_ROWS)), rowsProject).fileErrors).toEqual([])
  expect(rowsProject).toHaveBeenCalledOnce()
})
