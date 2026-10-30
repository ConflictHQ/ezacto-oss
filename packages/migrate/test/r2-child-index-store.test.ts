import { expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { hexToBytes } from '@noble/hashes/utils.js'
import { sha256Hex } from '../src/portable-hash.js'
import { r2ChildIndexStore, type IndexBucket } from '../src/r2-child-index-store.js'
const encoder = new TextEncoder()
interface ObjectValue {
  bytes: Uint8Array<ArrayBuffer>
  checksum: string
  etag: string
}
const fakeBucket = () => {
  const objects = new Map<string, ObjectValue>()
  const bucket: IndexBucket = {
    get: async (key) => {
      const value = objects.get(key)
      return value
        ? {
            size: value.bytes.length,
            etag: value.etag,
            checksums: { sha256: hexToBytes(value.checksum).buffer as ArrayBuffer },
            arrayBuffer: async () => value.bytes.slice().buffer,
          }
        : null
    },
    put: async (key, text, options) => {
      const old = objects.get(key)
      if (options.onlyIf.etagDoesNotMatch === '*' && old) return null
      if (options.onlyIf.etagMatches !== undefined && options.onlyIf.etagMatches !== old?.etag)
        return null
      const bytes = encoder.encode(text),
        checksum = sha256Hex(bytes)
      if (checksum !== options.sha256) throw new Error('Server checksum failed')
      const etag = crypto.randomUUID()
      objects.set(key, { bytes, checksum, etag })
      return { etag }
    },
  }
  return { bucket, objects }
}
it('persists exact bytes, truncation and checkpoint state across independent consumers', async () => {
  const { bucket } = fakeBucket()
  const first = r2ChildIndexStore(bucket, 'migrate/fixture/index')
  await first.exclusive(async () => {
    const file = await first.open('rows.partial', 'create')
    await file.write('naïve', 0)
    await file.truncate(3) // Preserve even a partial UTF-8 byte sequence, not a reencoded string.
    await file.sync()
    await file.close()
    await first.writeText('state.json', '{"rows":1}')
  })
  const second = r2ChildIndexStore(bucket, 'migrate/fixture/index')
  await second.exclusive(async () => {
    expect(await second.readText('state.json')).toBe('{"rows":1}')
    const file = await second.open('rows.partial', 'update')
    expect([...(await file.read(0, 10))]).toEqual([110, 97, 195])
    await file.write('tive', 2)
    await file.close()
    await second.rename('rows.partial', 'rows.idx')
    await second.writeText('state.json', '{"rows":2}')
  })
  const third = r2ChildIndexStore(bucket, 'migrate/fixture/index')
  expect(await third.readText('rows.idx')).toBe('native')
  expect(await third.readText('state.json')).toBe('{"rows":2}')
  await expect(third.open('rows.partial', 'read')).rejects.toMatchObject({ code: 'ENOENT' })
})
it('a crash before the exclusive turn commits leaves the previous complete state intact', async () => {
  const { bucket } = fakeBucket(),
    store = r2ChildIndexStore(bucket, 'migrate/crash/index')
  await store.writeText('state.json', 'before')
  await expect(
    store.exclusive(async () => {
      await store.writeText('state.json', 'after')
      const partial = await store.open('rows.partial', 'create')
      await partial.write('not published', 0)
      await partial.sync()
      await partial.close()
      throw new Error('Forced consumer crash')
    }),
  ).rejects.toThrow('Forced consumer crash')
  const replacement = r2ChildIndexStore(bucket, 'migrate/crash/index')
  expect(await replacement.readText('state.json')).toBe('before')
  await expect(replacement.open('rows.partial', 'read')).rejects.toMatchObject({ code: 'ENOENT' })
})
it('a stale builder cannot replace a newer checkpoint or erase its files', async () => {
  const { bucket } = fakeBucket(),
    first = r2ChildIndexStore(bucket, 'migrate/race/index'),
    second = r2ChildIndexStore(bucket, 'migrate/race/index')
  let entered!: () => void, release!: () => void
  const ready = new Promise<void>((resolve) => {
      entered = resolve
    }),
    pause = new Promise<void>((resolve) => {
      release = resolve
    })
  const loser = first.exclusive(async () => {
    await first.writeText('old.idx', 'loser')
    entered()
    await pause
  })
  await ready
  await second.writeText('new.idx', 'winner')
  release()
  await expect(loser).rejects.toMatchObject({ name: 'R2ChildIndexConflictError' })
  const next = r2ChildIndexStore(bucket, 'migrate/race/index')
  expect(await next.readText('new.idx')).toBe('winner')
  await expect(next.readText('old.idx')).rejects.toMatchObject({ code: 'ENOENT' })
})
it('enforces the whole-directory budget and rejects unsafe paths', async () => {
  const { bucket, objects } = fakeBucket(),
    store = r2ChildIndexStore(bucket, 'migrate/budget/index', { budgetBytes: 6 })
  await expect(
    store.exclusive(async () => {
      await store.writeText('one.idx', '1234')
      await store.writeText('two.idx', '5678')
    }),
  ).rejects.toThrow('memory budget')
  expect(objects.size).toBe(0)
  await expect(store.open('../escape', 'create')).rejects.toThrow('filename')
  expect(() => r2ChildIndexStore(bucket, 'migrate/../escape')).toThrow('prefix')
  expect(() =>
    r2ChildIndexStore(bucket, 'migrate/fixture/index', { budgetBytes: 100 * 1024 * 1024 }),
  ).toThrow('budget')
})
it('refuses changed bytes even when the corrupted object remains parseable JSON', async () => {
  const { bucket, objects } = fakeBucket(),
    store = r2ChildIndexStore(bucket, 'migrate/corrupt/index')
  await store.writeText('state.json', 'before')
  const object = objects.values().next().value!
  object.bytes = encoder.encode(
    new TextDecoder().decode(object.bytes).replace('6265666f7265', '6165666f7265'),
  )
  await expect(
    r2ChildIndexStore(bucket, 'migrate/corrupt/index').readText('state.json'),
  ).rejects.toThrow('checksum')
})
it('standalone file sync/close commits and a read-only handle cannot modify the checkpoint', async () => {
  const { bucket } = fakeBucket(),
    store = r2ChildIndexStore(bucket, 'migrate/file/index')
  const file = await store.open('rows.idx', 'create')
  await file.write('0123456789', 0)
  await file.write('AB', 4)
  await file.truncate(8)
  await file.sync()
  await file.close()
  await file.close()
  const other = r2ChildIndexStore(bucket, 'migrate/file/index'),
    read = await other.open('rows.idx', 'read')
  expect(new TextDecoder().decode(await read.read(2, 20))).toBe('23AB67')
  await expect(read.write('no', 0)).rejects.toThrow('read-only')
  await read.close()
  await other.remove('rows.idx')
  await other.remove('rows.idx')
  await expect(
    r2ChildIndexStore(bucket, 'migrate/file/index').readText('rows.idx'),
  ).rejects.toMatchObject({ code: 'ENOENT' })
})
it('uses real R2 conditional writes and SHA-256 metadata across restarts', async () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    r2Buckets: ['INDEX'],
  })
  try {
    const bucket = await mf.getR2Bucket('INDEX')
    const first = r2ChildIndexStore(bucket as unknown as IndexBucket, 'migrate/native/index')
    await first.exclusive(async () => {
      await first.writeText('rows.idx', 'native R2')
      await first.writeText('state.json', 'complete')
    })
    const second = r2ChildIndexStore(bucket as unknown as IndexBucket, 'migrate/native/index')
    expect(await second.readText('rows.idx')).toBe('native R2')
    expect(await second.readText('state.json')).toBe('complete')
    const object = await bucket.get('migrate/native/index/checkpoint.json')
    expect(object?.checksums.sha256?.byteLength).toBe(32)
  } finally {
    await mf.dispose()
  }
})
it('bundles the actual loader and R2 adapters for a Worker with no Node externals', async () => {
  const output = await build({
    entryPoints: [
      new URL('../src/load-engine.ts', import.meta.url).pathname,
      new URL('../src/r2-snapshot-source.ts', import.meta.url).pathname,
      new URL('../src/r2-child-index-store.ts', import.meta.url).pathname,
    ],
    bundle: true,
    conditions: ['development'],
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outdir: '/unused',
    write: false,
  })
  expect(output.outputFiles).toHaveLength(3)
})
