import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  constants,
} from 'node:fs'
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  stat,
  unlink,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { AttachmentObjectPort } from '@ezacto/api'

const keyPattern = /^sha256\/([0-9a-f]{2})\/([0-9a-f]{64})$/u

const keyParts = (key: string): { prefix: string; hash: string } => {
  const match = keyPattern.exec(key)
  if (match === null || match[1] !== match[2]!.slice(0, 2)) {
    throw new TypeError('attachment object key is invalid')
  }
  return { prefix: match[1], hash: match[2]! }
}

const digest = (bytes: ArrayBuffer | Uint8Array): Buffer =>
  createHash('sha256').update(new Uint8Array(bytes)).digest()

const expectedDigest = (hash: string): Buffer => Buffer.from(hash, 'hex')

const assertContent = (
  bytes: ArrayBuffer | Uint8Array,
  hash: string,
): void => {
  if (!timingSafeEqual(digest(bytes), expectedDigest(hash))) {
    throw new Error('attachment object content does not match its key')
  }
}

const missing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT'

const ensureDirectory = async (
  directory: string,
  expectedRealPath: string,
): Promise<void> => {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const metadata = await lstat(directory)
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    (await realpath(directory)) !== expectedRealPath
  ) {
    throw new TypeError('attachment object path must not contain symbolic links')
  }
}

const readObject = async (path: string): Promise<Buffer> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile()) throw new TypeError('attachment object must be a file')
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

export const createDiskAttachmentObjectStore = async (
  root: string,
): Promise<AttachmentObjectPort> => {
  const expectedRoot = resolve(root)
  await ensureDirectory(root, expectedRoot)
  const metadata = await stat(root)
  if (!metadata.isDirectory()) {
    throw new TypeError('attachment object root must be a directory')
  }

  return {
    async put(key, bytes) {
      const { prefix, hash } = keyParts(key)
      assertContent(bytes, hash)
      const shaDirectory = join(root, 'sha256')
      await ensureDirectory(shaDirectory, join(expectedRoot, 'sha256'))
      const directory = join(shaDirectory, prefix)
      const target = join(directory, hash)
      await ensureDirectory(
        directory,
        join(expectedRoot, 'sha256', prefix),
      )
      const temporary = join(directory, `.${hash}.${randomUUID()}.tmp`)
      const file = await open(temporary, 'wx', 0o600)
      try {
        await file.writeFile(new Uint8Array(bytes))
        await file.sync()
      } finally {
        await file.close()
      }

      let installed = false
      try {
        await link(temporary, target)
        installed = true
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
          throw error
        }
        assertContent(await readObject(target), hash)
      } finally {
        await unlink(temporary).catch((error: unknown) => {
          if (!missing(error)) throw error
        })
      }
      if (installed) {
        const directoryHandle = await open(directory, 'r')
        try {
          await directoryHandle.sync()
        } finally {
          await directoryHandle.close()
        }
      }
    },

    async get(key) {
      const { prefix, hash } = keyParts(key)
      let bytes: Buffer
      try {
        const shaDirectory = join(root, 'sha256')
        await ensureDirectory(shaDirectory, join(expectedRoot, 'sha256'))
        const directory = join(shaDirectory, prefix)
        const directoryMetadata = await lstat(directory)
        if (
          directoryMetadata.isSymbolicLink() ||
          !directoryMetadata.isDirectory() ||
          (await realpath(directory)) !== join(expectedRoot, 'sha256', prefix)
        ) {
          throw new TypeError(
            'attachment object path must not contain symbolic links',
          )
        }
        bytes = await readObject(join(directory, hash))
      } catch (error) {
        if (missing(error)) return null
        throw error
      }
      assertContent(bytes, hash)
      return {
        body: bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer,
      }
    },
  }
}
