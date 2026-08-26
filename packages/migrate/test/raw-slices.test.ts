// The property these guard is migration-spec §2.3: "one Harvest object per line,
// verbatim, unmodified". A test that compares parsed values cannot see a writer
// that rewrote every byte it was allowed to, so these compare text.

import { describe, expect, it } from 'vitest'
import { collapseBetweenTokens, sliceCollection, spansLines } from '../src/raw-slices.js'

const envelope = (inner: string): string =>
  `{"page":1,"total_entries":2,"clients":[${inner}],"links":{"next":null}}`

describe('sliceCollection [unit]', () => {
  it('[unit] returns the source text of each record, not a re-serialization', () => {
    const a = '{"id":9007199254740993,"hours":8.00,"rate":1e2}'
    const b = '{"z":1,"a":2}'
    expect(sliceCollection(envelope(`${a},${b}`), 'clients')).toEqual([a, b])
  })

  it('[unit] the values a round trip destroys survive it', () => {
    const wire = '{"id":9007199254740993,"x":0.1000000000000000055511151231257827,"s":"caf\\u00e9"}'
    const [slice] = sliceCollection(envelope(wire), 'clients') as string[]
    expect(slice).toBe(wire)
    // what the old writer would have produced instead
    expect(JSON.stringify(JSON.parse(wire))).not.toBe(wire)
  })

  it('[unit] a nested object carrying the same key is not mistaken for the envelope', () => {
    const rec = '{"id":1,"clients":[{"id":99}]}'
    expect(sliceCollection(envelope(rec), 'clients')).toEqual([rec])
  })

  it('[unit] braces and brackets inside strings do not end a record', () => {
    const rec = '{"note":"a } b ] c , d","id":2}'
    expect(sliceCollection(envelope(rec), 'clients')).toEqual([rec])
  })

  it('[unit] an escaped quote inside a string does not end it', () => {
    const rec = '{"note":"she said \\"] , {\\" and stopped","id":3}'
    expect(sliceCollection(envelope(rec), 'clients')).toEqual([rec])
  })

  it('[unit] an empty collection yields no records', () => {
    expect(sliceCollection('{"clients":[],"links":{}}', 'clients')).toEqual([])
  })

  it('[unit] a missing or non-array collection is null, not a guess', () => {
    expect(sliceCollection('{"links":{}}', 'clients')).toBeNull()
    expect(sliceCollection('{"clients":{"id":1}}', 'clients')).toBeNull()
  })

  it('[unit] an unterminated array is null rather than a truncated list', () => {
    expect(sliceCollection('{"clients":[{"id":1},', 'clients')).toBeNull()
  })
})

describe('pretty-printed bodies [unit]', () => {
  const pretty = `{\n  "clients": [\n    {\n      "id": 1,\n      "amount": 10.00\n    }\n  ],\n  "links": {}\n}`

  it('[unit] a record spanning lines is detected, since JSONL cannot hold it', () => {
    const [slice] = sliceCollection(pretty, 'clients') as string[]
    expect(spansLines(slice)).toBe(true)
  })

  it('[unit] collapsing removes only whitespace between tokens, never inside values', () => {
    const [slice] = sliceCollection(pretty, 'clients') as string[]
    const flat = collapseBetweenTokens(slice)
    expect(flat).toBe('{"id":1,"amount":10.00}')
    // the literal is preserved: 10.00 did not become 10
    expect(flat).toContain('10.00')
    expect(spansLines(flat)).toBe(false)
  })

  it('[unit] whitespace inside a string literal is untouched', () => {
    expect(collapseBetweenTokens('{ "a" : "keep  these\\tspaces" }')).toBe(
      '{"a":"keep  these\\tspaces"}',
    )
  })
})
