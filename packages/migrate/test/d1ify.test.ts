import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
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
