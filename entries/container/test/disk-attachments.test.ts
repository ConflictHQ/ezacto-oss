import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDiskAttachmentObjectStore } from '../src/disk-attachments.js'

const directories: string[] = []
const temporary = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'ezacto-objects-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

const fixture = (text: string) => {
  const bytes = new TextEncoder().encode(text)
  const hash = createHash('sha256').update(bytes).digest('hex')
  return {
    bytes: bytes.buffer,
    key: `sha256/${hash.slice(0, 2)}/${hash}`,
    hash,
  }
}

describe('disk attachment object store', () => {
  it('[unit] atomically persists and repeats content-addressed objects', async () => {
    const root = await temporary()
    const store = await createDiskAttachmentObjectStore(root)
    const object = fixture('durable attachment')
    await Promise.all([
      store.put(object.key, object.bytes, 'text/plain'),
      store.put(object.key, object.bytes, 'text/plain'),
    ])

    const restored = await store.get(object.key)
    expect(restored).not.toBeNull()
    expect(await new Response(restored!.body).text()).toBe('durable attachment')
  })

  it('[security] rejects traversal and bytes that do not match the key', async () => {
    const store = await createDiskAttachmentObjectStore(await temporary())
    const object = fixture('expected')
    await expect(
      store.put('../outside', object.bytes, 'text/plain'),
    ).rejects.toThrow('key is invalid')
    await expect(
      store.put(object.key, fixture('different').bytes, 'text/plain'),
    ).rejects.toThrow('does not match')
  })

  it('[security] never follows a pre-existing prefix or target symlink', async () => {
    const root = await temporary()
    const outside = await temporary()
    const object = fixture('do not redirect')
    await mkdir(join(root, 'sha256'))
    await symlink(outside, join(root, 'sha256', object.hash.slice(0, 2)))
    const store = await createDiskAttachmentObjectStore(root)
    await expect(
      store.put(object.key, object.bytes, 'text/plain'),
    ).rejects.toThrow('symbolic links')

    const secondRoot = await temporary()
    const secondStore = await createDiskAttachmentObjectStore(secondRoot)
    const directory = join(
      secondRoot,
      'sha256',
      object.hash.slice(0, 2),
    )
    await mkdir(directory, { recursive: true })
    const outsideFile = join(outside, 'outside-file')
    await writeFile(outsideFile, new Uint8Array(object.bytes))
    await symlink(outsideFile, join(directory, object.hash))
    await expect(secondStore.get(object.key)).rejects.toThrow()
  })
})
