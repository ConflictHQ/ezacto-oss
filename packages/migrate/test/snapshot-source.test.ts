import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  asSnapshotSource,
  fileSnapshotSource,
  linesFromStream,
  r2SnapshotSource,
  type SnapshotBucket,
} from '../src/snapshot-source.js'

/**
 * Issue 409. A load reads its snapshot off the operator's own disk, so it lives
 * and dies with the machine that started it. Both sources have to honour the
 * same thing -- lines of one resource from a byte offset -- because that is
 * what the loader checkpoints and resumes from.
 */

let directory: string | null = null

afterEach(async () => {
  if (directory !== null) await rm(directory, { recursive: true, force: true })
  directory = null
})

const ROWS = [
  '{"id":1,"name":"Kestrel Environmental"}',
  '{"id":2,"name":"Northpeak"}',
  '{"id":3,"name":"Halcyon Biolabs"}',
]

const onDisk = async (body: string): Promise<string> => {
  directory = await mkdtemp(join(tmpdir(), 'snapshot-source-'))
  await mkdir(join(directory, 'raw'), { recursive: true })
  await writeFile(join(directory, 'raw', 'clients.jsonl'), body, 'utf8')
  return directory
}

const collect = async (lines: AsyncIterable<string>): Promise<string[]> => {
  const out: string[] = []
  for await (const line of lines) out.push(line)
  return out
}

/** An R2 stand-in that honours a range offset, which is the whole contract. */
const bucket = (body: string, key = 'snapshots/run-1/raw/clients.jsonl'): SnapshotBucket => ({
  get: async (requested, options) => {
    if (requested !== key) return null
    const bytes = new TextEncoder().encode(body).slice(options?.range?.offset ?? 0)
    return {
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          // Deliberately in small pieces: a chunk boundary must be allowed to
          // fall anywhere, including inside a character.
          for (let at = 0; at < bytes.length; at += 7) {
            controller.enqueue(bytes.slice(at, at + 7))
          }
          controller.close()
        },
      }),
    }
  },
})

describe('reading a snapshot from disk (#409)', () => {
  it('[unit] yields every row, and resumes from a byte offset', async () => {
    const body = `${ROWS.join('\n')}\n`
    const source = fileSnapshotSource(await onDisk(body))
    expect(await collect(source.openRaw('clients', 0))).toEqual(ROWS)
    // Resuming past the first row is what the loader's checkpoint asks for.
    const offset = Buffer.byteLength(`${ROWS[0]!}\n`, 'utf8')
    expect(await collect(source.openRaw('clients', offset))).toEqual(ROWS.slice(1))
  })

  it('[unit] names the file it was reading, for an error that can be chased', async () => {
    const source = fileSnapshotSource(await onDisk(''))
    expect(source.describe('clients')).toContain('raw/clients.jsonl')
  })
})

describe('reading the same snapshot from a bucket (#409)', () => {
  it('[unit] yields the same rows as the file, from the same offsets', async () => {
    const body = `${ROWS.join('\n')}\n`
    const source = r2SnapshotSource(bucket(body), 'snapshots/run-1')
    expect(await collect(source.openRaw('clients', 0))).toEqual(ROWS)
    const offset = Buffer.byteLength(`${ROWS[0]!}\n`, 'utf8')
    expect(await collect(source.openRaw('clients', offset))).toEqual(ROWS.slice(1))
  })

  it('[unit] tolerates a trailing line with no newline', async () => {
    // Dropping it would lose the last record of every snapshot whose writer
    // omitted the final newline.
    const source = r2SnapshotSource(bucket(ROWS.join('\n')), 'snapshots/run-1')
    expect(await collect(source.openRaw('clients', 0))).toEqual(ROWS)
  })

  it('[money] refuses a missing object rather than reporting zero rows', async () => {
    // A load that treated an absent snapshot as empty would report success
    // having imported nothing at all.
    const source = r2SnapshotSource(bucket('', 'other/key'), 'snapshots/run-1')
    await expect(collect(source.openRaw('clients', 0))).rejects.toThrow(
      /is not in the snapshot bucket/u,
    )
  })

  it('[unit] tolerates a trailing slash on the prefix', async () => {
    const source = r2SnapshotSource(bucket(`${ROWS[0]!}\n`), 'snapshots/run-1/')
    expect(await collect(source.openRaw('clients', 0))).toEqual([ROWS[0]])
  })
})

describe('splitting a byte stream into lines (#409)', () => {
  it('[unit] never buffers a character across a chunk boundary wrongly', async () => {
    // A chunk boundary can fall inside a UTF-8 sequence. Decoding each chunk
    // alone turns the name it split into a replacement character, and the row
    // still parses -- so the corruption reaches the database looking like data.
    const name = 'Kestrel Environmental — Ståle Ærø 日本'
    const body = `${JSON.stringify({ id: 1, name })}\n`
    const bytes = new TextEncoder().encode(body)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
        controller.close()
      },
    })
    const [line] = await collect(linesFromStream(stream))
    expect((JSON.parse(line!) as { name: string }).name).toBe(name)
    expect(line).not.toContain('�')
  })

  it('[unit] yields nothing for an empty stream rather than one empty line', async () => {
    const stream = new ReadableStream<Uint8Array>({ start: (c) => c.close() })
    expect(await collect(linesFromStream(stream))).toEqual([])
  })
})

describe('the adapter the loader calls through (#409)', () => {
  it('[unit] treats a string as the filesystem, so existing callers are unchanged', async () => {
    const source = asSnapshotSource(await onDisk(`${ROWS[0]!}\n`))
    expect(await collect(source.openRaw('clients', 0))).toEqual([ROWS[0]])
  })

  it('[unit] passes a source through untouched', () => {
    const given = r2SnapshotSource(bucket(''), 'p')
    expect(asSnapshotSource(given)).toBe(given)
  })
})
