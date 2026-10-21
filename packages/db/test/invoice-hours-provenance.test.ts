import { expect, it } from 'vitest'
import { invoiceLineTimeOrigins } from '../src/invoice-hours-provenance.js'
const entries = [
  { id: 1, project_id: 1, user_id: 1, task_id: 1, rounded_seconds: 7200 },
  { id: 2, project_id: 1, user_id: 2, task_id: 1, rounded_seconds: 3600 },
  { id: 3, project_id: 2, user_id: 1, task_id: 2, rounded_seconds: 1800 },
]
const lines = [
  { id: 11, position: 0, kind: 'Service', project_id: 1, quantity: 2 },
  { id: 12, position: 1, kind: 'Service', project_id: 1, quantity: 1 },
  { id: 13, position: 2, kind: 'Service', project_id: 2, quantity: 0.5 },
  { id: 14, position: 3, kind: 'Expense', project_id: 1, quantity: 7 },
]
const receipt = (
  request: object = { time_summary_type: 'people' },
  originalLines: object[] = lines,
) => ({
  requestJson: JSON.stringify(request),
  sourceJson: JSON.stringify({ schema_version: 1, time_entries: entries }),
  linesJson: JSON.stringify({ schema_version: 1, lines: originalLines }),
})
it('reconstructs legacy per-person origins from immutable grouping and positions, excluding expenses', () => {
  expect([...invoiceLineTimeOrigins(receipt())]).toEqual([
    [11, [1]],
    [12, [2]],
    [13, [3]],
  ])
})
it.each(['project', 'task'])(
  'reconstructs the original %s grouping without matching descriptions',
  (summary) => {
    const grouped = [
      { ...lines[0], quantity: 3, description: 'Changed names do not matter' },
      { ...lines[2], position: 1 },
    ]
    expect([...invoiceLineTimeOrigins(receipt({ time_summary_type: summary }, grouped))]).toEqual([
      [11, [1, 2]],
      [13, [3]],
    ])
  },
)
it('rejects an uncertain legacy project instead of inventing a per-line match', () => {
  const wrong = lines.map((line) => (line.id === 11 ? { ...line, quantity: 1.99 } : line))
  expect([...invoiceLineTimeOrigins(receipt(undefined, wrong))]).toEqual([[13, [3]]])
})
it('never reconstructs flat band fees as quantities of hours', () => {
  expect(
    invoiceLineTimeOrigins(receipt({ kind: 'banded', time_summary_type: 'people' })).size,
  ).toBe(0)
})
it('uses explicit origins for new banded overage time without attaching fee quantities to time', () => {
  const original = [
    { id: 11, position: 0, kind: 'Service', project_id: 1, quantity: 1 },
    { id: 12, position: 1, kind: 'Service', project_id: 1, quantity: 1, time_entry_ids: [2] },
  ]
  expect([...invoiceLineTimeOrigins(receipt({ kind: 'banded' }, original))]).toEqual([[12, [2]]])
})
it('refuses explicit identities from another project, missing source rows or duplicates', () => {
  const original = [
    { ...lines[0], time_entry_ids: [3] },
    { ...lines[1], time_entry_ids: [1, 1] },
    { ...lines[2], time_entry_ids: [99] },
  ]
  expect(invoiceLineTimeOrigins(receipt({}, original)).size).toBe(0)
})
it('leaves missing or malformed receipts unknown', () => {
  expect(
    invoiceLineTimeOrigins({ requestJson: null, sourceJson: '{broken', linesJson: null }).size,
  ).toBe(0)
})
