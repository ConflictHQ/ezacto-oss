import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'

const script = new URL('../../../scripts/d1ify.py', import.meta.url)

// Verbatim `sqlite3 3.51 .dump` output. Each row is chosen because an obvious
// shortcut in the converter destroys it and nothing complains. Row 1 holds a
// value whose second line begins `COMMIT;`, so a wrapper strip that matches the
// keyword anywhere rather than only at the ends eats it out of the data. Row 2
// holds a backslash beside a CRLF, so a rewriter that turns unistr() into a
// literal without re-escaping, or that normalises line endings on the way
// through, changes the address. Row 3 is the control.
//
// The check is byte equality after a round trip: the converted script is
// executed and the stored addresses compared. That is what makes the shortcuts
// visible, since all three survive a grep for `unistr(` equally well.
const dump = [
  'PRAGMA foreign_keys=OFF;',
  'BEGIN TRANSACTION;',
  'CREATE TABLE clients (id INTEGER PRIMARY KEY, address TEXT NOT NULL);',
  "INSERT INTO clients VALUES(1,unistr('a\\u000aCOMMIT;\\u000ab'));",
  "INSERT INTO clients VALUES(2,unistr('back\\\\slash\\u000d\\u000atail'));",
  "INSERT INTO clients VALUES(3,'plain value');",
  'COMMIT;',
  '',
].join('\n')

// Multi-paragraph notes, LF and CRLF, as `sqlite3 3.51 .dump` writes them: every
// line break, blank lines included, is a \u000a or \u000d\u000a escape inside
// one unistr() call, so the statement is a single line before conversion too.
const remittanceNotes = [
  'Beneficiary: Example Studio LLC',
  '100 Example Street, Example City, EX 00000',
  '',
  'Bank: Example Federal Bank',
  'Account: 000123456789',
  'Routing: 000000000',
  '',
  'Wire: SWIFT EXAMPLEXX, reference the invoice number',
].join('\n')
const remittanceNotesCrlf = remittanceNotes.replaceAll('\n', '\r\n')
const notesInsert = [
  'INSERT INTO recurring_invoices VALUES(1,unistr(' +
    "'Beneficiary: Example Studio LLC\\u000a100 Example Street, Example City, EX 00000" +
    '\\u000a\\u000aBank: Example Federal Bank\\u000aAccount: 000123456789\\u000aRouting: 000000000' +
    "\\u000a\\u000aWire: SWIFT EXAMPLEXX, reference the invoice number'));",
  'INSERT INTO recurring_invoices VALUES(2,unistr(' +
    "'Beneficiary: Example Studio LLC\\u000d\\u000a100 Example Street, Example City, EX 00000" +
    '\\u000d\\u000a\\u000d\\u000aBank: Example Federal Bank\\u000d\\u000aAccount: 000123456789' +
    '\\u000d\\u000aRouting: 000000000\\u000d\\u000a\\u000d\\u000aWire: SWIFT EXAMPLEXX,' +
    " reference the invoice number'));",
]
const notesDump = [
  'PRAGMA foreign_keys=OFF;',
  'BEGIN TRANSACTION;',
  'CREATE TABLE recurring_invoices (id INTEGER PRIMARY KEY, notes_template TEXT NOT NULL);',
  ...notesInsert,
  'COMMIT;',
  '',
].join('\n')

const directories: string[] = []

const convert = async (source: string) => {
  const dir = await mkdtemp(join(tmpdir(), 'ezacto-d1ify-'))
  directories.push(dir)
  const output = join(dir, 'dump.d1.sql')
  const input = join(dir, 'dump.sql')
  await writeFile(input, source)
  const run = spawnSync('python3', [script.pathname, input, output], { encoding: 'utf8' })
  return { run, output, written: existsSync(output) }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('d1ify', () => {
  it('[unit] rewrites unistr() byte for byte and drops only the dump wrapper', async () => {
    const { run, output, written } = await convert(dump)
    expect(run.status).toBe(0)
    expect(written).toBe(true)

    const converted = await readFile(output, 'utf8')
    expect(converted).not.toContain('unistr(')
    expect(converted.split('\n').filter((line) => /^(BEGIN|COMMIT)/u.test(line))).toEqual([])
    expect(converted).toContain('PRAGMA foreign_keys=OFF;')

    const database = new BetterSqlite3(':memory:')
    database.exec(converted)
    const rows = database.prepare('SELECT address FROM clients ORDER BY id').all() as Array<{
      address: string
    }>
    database.close()
    expect(rows.map((row) => row.address)).toEqual([
      'a\nCOMMIT;\nb',
      'back\\slash\r\ntail',
      'plain value',
    ])
  })

  it('[integration] lands multi-paragraph LF and CRLF notes in D1 byte for byte', async () => {
    // A blank line inside a value must never become a line of the converted
    // file, or anything that reads the file a line at a time ends the value
    // there. The D1 here refuses unistr() exactly as the hosted importer does,
    // which is what makes its byte-for-byte answer worth having.
    const { run, output, written } = await convert(notesDump)
    expect(run.status).toBe(0)
    expect(written).toBe(true)
    const converted = await readFile(output, 'utf8')
    const lines = converted.split('\n')
    const inserts = lines.filter((line) => line.startsWith('INSERT INTO recurring_invoices '))
    expect(inserts).toHaveLength(2)
    expect(lines.slice(0, -1)).not.toContain('')
    expect(converted).not.toContain('\r')

    const expected = [
      { id: 1, notes: remittanceNotes },
      { id: 2, notes: remittanceNotesCrlf },
    ].map((row) => ({
      ...row,
      notesHex: Buffer.from(row.notes, 'utf8').toString('hex').toUpperCase(),
    }))
    const select =
      'SELECT id, notes_template AS notes, hex(notes_template) AS notesHex FROM recurring_invoices ORDER BY id'

    const miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: ['DB'],
    })
    try {
      const d1 = await miniflare.getD1Database('DB')
      await d1.exec(converted)
      expect((await d1.prepare(select).all()).results).toEqual(expected)
      await expect(d1.prepare(notesInsert[0]!).run()).rejects.toThrow('unistr')
    } finally {
      await miniflare.dispose()
    }

    const database = new BetterSqlite3(':memory:')
    try {
      database.exec(converted)
      expect(database.prepare(select).all()).toEqual(expected)
    } finally {
      database.close()
    }
  })

  it('[unit] refuses transaction control the dump did not put in its wrapper', async () => {
    const { run, written } = await convert(
      dump.replace('INSERT INTO clients VALUES(3,', 'COMMIT;\nINSERT INTO clients VALUES(3,'),
    )
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('transaction control: COMMIT;')
    expect(written).toBe(false)
  })

  it('[unit] refuses a statement above the 100 KB ceiling before the upload', async () => {
    const { run, written } = await convert(dump.replace('plain value', 'x'.repeat(100_000)))
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain("above D1's 100000-byte statement ceiling")
    expect(written).toBe(false)
  })
})
