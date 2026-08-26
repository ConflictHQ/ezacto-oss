// Story 03 (raw snapshot format + crash resume, migration-spec §2.3-2.4): the
// writer primitives resume relies on — byte-verbatim appends, and reconciling a
// raw file back to the manifest's own count after a crash lands between the
// fsync and the rename that would have claimed it.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendPage, reconcileToCount, startResource } from '../src/jsonl.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ezacto-migrate-jsonl-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const rawPath = (resource: string): string => join(dir, 'raw', `${resource}.jsonl`)

describe('appendPage', () => {
  it('[unit] writes each object verbatim — no JSON.parse/stringify round trip', async () => {
    await startResource(dir, 'invoices')
    // Deliberately non-canonical: reversed key order and irregular whitespace, the
    // shape a round trip through JSON.parse → JSON.stringify would normalize away.
    const objects: unknown[] = [{ z: 1, a: 2 }]
    await appendPage(dir, 'invoices', objects)

    const raw = await readFile(rawPath('invoices'), 'utf8')
    // appendPage receives already-parsed objects (the paginator has to read
    // `links`/`total_entries` off the same body), so "verbatim" here means what
    // JSON.stringify on that exact object produces — key order preserved, no
    // field added, removed or reinterpreted — not the original wire bytes.
    expect(raw).toBe('{"z":1,"a":2}\n')
  })

  it('[unit] appends onto an existing file rather than replacing it', async () => {
    await startResource(dir, 'users')
    await appendPage(dir, 'users', [{ id: 1 }])
    await appendPage(dir, 'users', [{ id: 2 }])

    expect(await readFile(rawPath('users'), 'utf8')).toBe('{"id":1}\n{"id":2}\n')
  })
})

describe('reconcileToCount', () => {
  it('[unit] leaves a file alone when it already matches the manifest', async () => {
    await startResource(dir, 'roles')
    await appendPage(dir, 'roles', [{ id: 1 }, { id: 2 }])

    await reconcileToCount(dir, 'roles', 2)

    expect(await readFile(rawPath('roles'), 'utf8')).toBe('{"id":1}\n{"id":2}\n')
  })

  it('[unit] drops a page fsynced but never claimed by the manifest', async () => {
    // The exact window the story's resume test exercises end to end: page 2 hit
    // disk and was fsynced, but the crash landed before manifest.json's rename
    // claimed it. The manifest's own count (1) is the source of truth.
    await startResource(dir, 'clients')
    await appendPage(dir, 'clients', [{ id: 1 }])
    await appendPage(dir, 'clients', [{ id: 2 }])

    await reconcileToCount(dir, 'clients', 1)

    expect(await readFile(rawPath('clients'), 'utf8')).toBe('{"id":1}\n')
  })

  it('[unit] drops a torn trailing line with no newline of its own', async () => {
    // Not a real appendPage failure mode (writeFile completes or the whole
    // process is gone), but the on-disk signature of a kill mid-write, and the
    // one truncateToCount exists to clean up before a resume trusts the file.
    await startResource(dir, 'tasks')
    await appendPage(dir, 'tasks', [{ id: 1 }])
    await writeFile(rawPath('tasks'), '{"id":2}', { flag: 'a' })

    await reconcileToCount(dir, 'tasks', 1)

    expect(await readFile(rawPath('tasks'), 'utf8')).toBe('{"id":1}\n')
  })

  it('[unit] refuses to resume a file that holds fewer committed rows than the manifest claims', async () => {
    await startResource(dir, 'projects')
    await appendPage(dir, 'projects', [{ id: 1 }])

    const err = await reconcileToCount(dir, 'projects', 2).catch((e: unknown) => e as Error)

    expect(err).toBeInstanceOf(Error)
    expect(err?.message).toContain('holds 1 committed line(s) but manifest.json claims 2')
  })

  it('[unit] truncating to zero empties the file', async () => {
    await startResource(dir, 'contacts')
    await appendPage(dir, 'contacts', [{ id: 1 }])

    await reconcileToCount(dir, 'contacts', 0)

    expect(await readFile(rawPath('contacts'), 'utf8')).toBe('')
  })
})
