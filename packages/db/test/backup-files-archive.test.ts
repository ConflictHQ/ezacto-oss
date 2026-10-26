import { describe, expect, it } from 'vitest'
import { backupSha256 } from '@ezacto/core'
import { openBackupArchive } from '../src/backup-archive.js'
const prefix = 'backups/owned/'
const fixture = async (many = 0) => {
  const schema = new TextEncoder().encode('{"tables":[]}'),
    row = new TextEncoder().encode('[[1,null,""]]'),
    blob = new Uint8Array([0, 1, 255])
  const blobHash = await backupSha256(blob)
  const bytes = new Map<string, Uint8Array>([
    ['schema.json', schema],
    ['rows/users/000001.json', row],
    [`attachments/sha256/${blobHash.slice(0, 2)}/${blobHash}`, blob]
  ])
  for (let i = 0; i < many; i++) bytes.set(`rows/items/${String(i).padStart(6, '0')}.json`, row)
  const files = Object.fromEntries(
    await Promise.all(
      [...bytes].map(async ([name, data]) => [
        name,
        { sha256: await backupSha256(data), byte_size: data.length }
      ])
    )
  )
  const manifest = {
    schema_version: 1,
    bundle_version: '0038',
    exported_at: '2026-10-26T00:00:00.000Z',
    tables: {},
    table_count: 0,
    total_rows: 0,
    restore_skips: [],
    files
  }
  const objects = new Map([...bytes].map(([name, data]) => [prefix + name, data]))
  objects.set(prefix + 'RESTORE.md', new TextEncoder().encode('Owned restore instructions'))
  const seal = () => {
    const json = JSON.stringify(manifest)
    objects.set(prefix + 'manifest.json', new TextEncoder().encode(json))
    return { id: 1, status: 'completed' as const, r2_prefix: prefix, manifest_json: json }
  }
  return {
    bytes,
    objects,
    manifest,
    seal,
    source: { get: async (key: string) => objects.get(key) ?? null }
  }
}
const entries = async (stream: ReadableStream<Uint8Array>) => {
  const chunks: Uint8Array[] = []
  for await (const chunk of stream) chunks.push(chunk)
  const all = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0))
  let at = 0
  for (const chunk of chunks) {
    all.set(chunk, at)
    at += chunk.length
  }
  const files = new Map<string, Uint8Array>()
  at = 0
  while (new DataView(all.buffer).getUint32(at, true) === 0x04034b50) {
    const view = new DataView(all.buffer, at)
    const size = view.getUint32(18, true),
      nameLength = view.getUint16(26, true)
    const name = new TextDecoder().decode(all.slice(at + 30, at + 30 + nameLength))
    files.set(name, all.slice(at + 30 + nameLength, at + 30 + nameLength + size))
    at += 30 + nameLength + size
  }
  return files
}
describe('restorable backup ZIP members', () => {
  it('streams schema, typed rows and attachment bytes, with no arbitrary 1000-file cap', async () => {
    const f = await fixture(1001),
      files = await entries(await openBackupArchive(f.seal(), f.source))
    expect(files.size).toBe(f.bytes.size + 2)
    for (const [name, bytes] of f.bytes) expect(files.get(name)).toEqual(bytes)
  })
  it('rejects receipt-size drift before sending that member', async () => {
    const f = await fixture()
    f.manifest.files['schema.json']!.byte_size += 1
    await expect(entries(await openBackupArchive(f.seal(), f.source))).rejects.toMatchObject({
      code: 'checksum_mismatch'
    })
  })
  it('rejects missing bytes and unsafe descriptors', async () => {
    const f = await fixture()
    f.objects.delete(prefix + 'schema.json')
    await expect(entries(await openBackupArchive(f.seal(), f.source))).rejects.toMatchObject({
      code: 'object_missing'
    })
    f.manifest.files['../outside'] = { sha256: 'a'.repeat(64), byte_size: 1 }
    await expect(openBackupArchive(f.seal(), f.source)).rejects.toMatchObject({
      code: 'manifest_mismatch'
    })
  })
})
