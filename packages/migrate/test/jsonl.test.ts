// Story 03 (raw snapshot format + crash resume, migration-spec §2.3-2.4): the
// writer primitives resume relies on — byte-verbatim appends, and reconciling a
// raw file back to the manifest's own count after a crash lands between the
// fsync and the rename that would have claimed it.

import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendPage,
  mergeIncremental,
  reconcileToCount,
  reconcileToFile,
  startResource,
} from '../src/jsonl.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ezacto-migrate-jsonl-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const rawPath = (resource: string): string => join(dir, 'raw', `${resource}.jsonl`)
const stagePath = (resource: string): string => `${rawPath(resource)}.incoming`
const exists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  )

describe('appendPage', () => {
  // The old version of this test asserted `JSON.stringify` of its own input, so it
  // could not fail for the property it named. appendPage now takes wire bytes, and
  // this asserts them: bytes in, same bytes out.
  it('[unit] writes the record bytes exactly as given, byte for byte', async () => {
    await startResource(dir, 'invoices')
    // every value here is destroyed by a JSON.parse -> JSON.stringify round trip
    const wire = [
      '{"id":9007199254740993,"hours":8.00,"rate":1e2,"x":0.1000000000000000055511151231257827}',
      '{"z":1,"a":2}',
    ]
    await appendPage(dir, 'invoices', wire)

    const raw = await readFile(rawPath('invoices'), 'utf8')
    expect(raw).toBe(`${wire[0]}\n${wire[1]}\n`)
    // and the id really would not have survived the other way
    expect(String(JSON.parse(wire[0]).id)).toBe('9007199254740992')
  })

  it('[unit] appends onto an existing file rather than replacing it', async () => {
    await startResource(dir, 'users')
    await appendPage(
      dir,
      'users',
      [{ id: 1 }].map((o) => JSON.stringify(o)),
    )
    await appendPage(
      dir,
      'users',
      [{ id: 2 }].map((o) => JSON.stringify(o)),
    )

    expect(await readFile(rawPath('users'), 'utf8')).toBe('{"id":1}\n{"id":2}\n')
  })
})

describe('reconcileToCount', () => {
  it('[unit] leaves a file alone when it already matches the manifest', async () => {
    await startResource(dir, 'roles')
    await appendPage(
      dir,
      'roles',
      [{ id: 1 }, { id: 2 }].map((o) => JSON.stringify(o)),
    )

    await reconcileToCount(dir, 'roles', 2)

    expect(await readFile(rawPath('roles'), 'utf8')).toBe('{"id":1}\n{"id":2}\n')
  })

  it('[unit] drops a page fsynced but never claimed by the manifest', async () => {
    // The exact window the story's resume test exercises end to end: page 2 hit
    // disk and was fsynced, but the crash landed before manifest.json's rename
    // claimed it. The manifest's own count (1) is the source of truth.
    await startResource(dir, 'clients')
    await appendPage(
      dir,
      'clients',
      [{ id: 1 }].map((o) => JSON.stringify(o)),
    )
    await appendPage(
      dir,
      'clients',
      [{ id: 2 }].map((o) => JSON.stringify(o)),
    )

    await reconcileToCount(dir, 'clients', 1)

    expect(await readFile(rawPath('clients'), 'utf8')).toBe('{"id":1}\n')
  })

  it('[unit] drops a torn trailing line with no newline of its own', async () => {
    // Not a real appendPage failure mode (writeFile completes or the whole
    // process is gone), but the on-disk signature of a kill mid-write, and the
    // one truncateToCount exists to clean up before a resume trusts the file.
    await startResource(dir, 'tasks')
    await appendPage(
      dir,
      'tasks',
      [{ id: 1 }].map((o) => JSON.stringify(o)),
    )
    await writeFile(rawPath('tasks'), '{"id":2}', { flag: 'a' })

    await reconcileToCount(dir, 'tasks', 1)

    expect(await readFile(rawPath('tasks'), 'utf8')).toBe('{"id":1}\n')
  })

  it('[unit] refuses to resume a file that holds fewer committed rows than the manifest claims', async () => {
    await startResource(dir, 'projects')
    await appendPage(
      dir,
      'projects',
      [{ id: 1 }].map((o) => JSON.stringify(o)),
    )

    const err = await reconcileToCount(dir, 'projects', 2).catch((e: unknown) => e as Error)

    expect(err).toBeInstanceOf(Error)
    expect(err?.message).toContain('holds 1 committed line(s) but manifest.json claims 2')
  })

  it('[unit] truncating to zero empties the file', async () => {
    await startResource(dir, 'contacts')
    await appendPage(
      dir,
      'contacts',
      [{ id: 1 }].map((o) => JSON.stringify(o)),
    )

    await reconcileToCount(dir, 'contacts', 0)

    expect(await readFile(rawPath('contacts'), 'utf8')).toBe('')
  })
})

describe('reconcileToCount over a file larger than one read chunk', () => {
  // The file this runs on for a multi-year account is hundreds of megabytes —
  // past Node's maximum string length (536,870,888 chars) long before it is past
  // the disk, and reading it in threw `RangeError: Invalid string length` before
  // any of the checks above could run. Which made the snapshots that most need
  // resuming the ones that could not be resumed at all. 4000 rows is several
  // 64 KiB reads: enough to walk the chunk boundaries the scan now works in.
  it('[unit] counts and cuts by scanning, across chunk boundaries', async () => {
    await startResource(dir, 'time_entries')
    const rows = Array.from({ length: 4000 }, (_, i) =>
      JSON.stringify({ id: i, notes: 'x'.repeat(60) }),
    )
    await appendPage(dir, 'time_entries', rows)
    const whole = await readFile(rawPath('time_entries'), 'utf8')
    expect(whole.length).toBeGreaterThan(1 << 16)

    await reconcileToCount(dir, 'time_entries', 3999)

    const cut = await readFile(rawPath('time_entries'), 'utf8')
    expect(cut.split('\n').slice(0, -1)).toHaveLength(3999)
    expect(cut).toBe(whole.slice(0, cut.length))
  })
})

describe('reconcileToFile', () => {
  // The incremental half of the same window. mergeIncremental commits the merged
  // file with a rename and the record claims its length at the manifest write
  // after it, so a kill in between leaves rows on disk that `count` does not know
  // about. Unlike a full sweep's unclaimed page there is no cursor left to
  // re-fetch them from — they are merged and durable — so the manifest is the
  // side that gets corrected.
  it('[unit] adopts merged rows the manifest never claimed, without cutting them', async () => {
    await startResource(dir, 'clients')
    await appendPage(
      dir,
      'clients',
      [{ id: 1 }].map((o) => JSON.stringify(o)),
    )
    await appendPage(
      dir,
      'clients',
      [{ id: 2 }].map((o) => JSON.stringify(o)),
    )

    expect(await reconcileToFile(dir, 'clients', 1)).toBe(2)

    expect(await readFile(rawPath('clients'), 'utf8')).toBe('{"id":1}\n{"id":2}\n')
  })

  it('[unit] counts committed lines only, never a torn trailing write', async () => {
    await startResource(dir, 'tasks')
    await appendPage(
      dir,
      'tasks',
      [{ id: 1 }].map((o) => JSON.stringify(o)),
    )
    await writeFile(rawPath('tasks'), '{"id":2}', { flag: 'a' })

    expect(await reconcileToFile(dir, 'tasks', 1)).toBe(1)
  })

  // Nothing here removes a row, so a file short of what the manifest claims is
  // rows lost after an fsync promised them. Adopting the smaller number would
  // leave the snapshot agreeing with itself about an account it no longer holds.
  it('[unit] refuses a file holding fewer committed rows than the manifest claims', async () => {
    await startResource(dir, 'projects')
    await appendPage(
      dir,
      'projects',
      [{ id: 1 }].map((o) => JSON.stringify(o)),
    )

    const outcome = await reconcileToFile(dir, 'projects', 2).catch((e: unknown) => e as Error)

    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toContain(
      'holds 1 committed line(s) but manifest.json claims 2',
    )
  })

  // Same reason reconcileToCount scans: the resource whose merge is most likely
  // to be interrupted is the one whose file is too big to be a JS string at all.
  it('[unit] counts by scanning, across chunk boundaries', async () => {
    await startResource(dir, 'time_entries')
    const rows = Array.from({ length: 4000 }, (_, i) =>
      JSON.stringify({ id: i, notes: 'x'.repeat(60) }),
    )
    await appendPage(dir, 'time_entries', rows)
    expect((await readFile(rawPath('time_entries'), 'utf8')).length).toBeGreaterThan(1 << 16)

    expect(await reconcileToFile(dir, 'time_entries', 3999)).toBe(4000)
  })
})

describe('mergeIncremental', () => {
  // An `updated_since` pass returns fresher copies of rows the snapshot already
  // holds. Appended, they are a second line per changed row — and a second parent
  // id for any child step fanning out over the resource.
  it('[unit] a changed row replaces its older copy in place, and a new row lands at the end', async () => {
    await startResource(dir, 'invoices')
    await appendPage(
      dir,
      'invoices',
      [
        { id: 1, n: 'old' },
        { id: 2, n: 'two' },
      ].map((o) => JSON.stringify(o)),
    )
    await appendPage(
      dir,
      'invoices',
      [
        { id: 1, n: 'new' },
        { id: 3, n: 'three' },
      ].map((o) => JSON.stringify(o)),
      true,
    )

    expect(await mergeIncremental(dir, 'invoices')).toBe(3)

    // Position matters: a resumed child fan-out skips forward through this file
    // in order, so a changed parent moved to the end would take every parent
    // behind it out of the sweep.
    expect((await readFile(rawPath('invoices'), 'utf8')).split('\n').slice(0, -1)).toEqual([
      '{"id":1,"n":"new"}',
      '{"id":2,"n":"two"}',
      '{"id":3,"n":"three"}',
    ])
    // …and the staged rows are gone, so a later pass cannot merge them twice.
    expect(await exists(stagePath('invoices'))).toBe(false)
  })

  it('[unit] a pass that staged nothing leaves the file untouched', async () => {
    await startResource(dir, 'users')
    await appendPage(
      dir,
      'users',
      [{ id: 1 }].map((o) => JSON.stringify(o)),
    )
    await startResource(dir, 'users', true)

    expect(await mergeIncremental(dir, 'users')).toBeNull()

    expect(await readFile(rawPath('users'), 'utf8')).toBe('{"id":1}\n')
    expect(await exists(stagePath('users'))).toBe(false)
  })

  it('[unit] a full sweep discards rows staged by an incremental pass that never merged', async () => {
    await startResource(dir, 'clients')
    await appendPage(
      dir,
      'clients',
      [{ id: 1 }].map((o) => JSON.stringify(o)),
    )
    await appendPage(
      dir,
      'clients',
      [{ id: 1, n: 'half a pass' }].map((o) => JSON.stringify(o)),
      true,
    )

    // What the step does when it decides to sweep the resource in full instead.
    await startResource(dir, 'clients')

    expect(await exists(stagePath('clients'))).toBe(false)
    expect(await readFile(rawPath('clients'), 'utf8')).toBe('')
  })
})
