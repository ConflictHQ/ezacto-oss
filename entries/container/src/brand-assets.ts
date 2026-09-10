import type BetterSqlite3 from 'better-sqlite3'
import type { BrandAssetSurface } from '@ezacto/api'
import type { AppEnv } from '../../worker/src/app.js'
import { createContainerBrandAssetStore } from '@ezacto/db'
import { createDiskAttachmentObjectStore } from './disk-attachments.js'

/**
 * The container's brand-mark storage (#489). Metadata in the same SQLite file
 * everything else lives in; bytes on disk, in their own directory rather than
 * mixed into the attachment content store, so an operator looking at a backup
 * can tell a logo from a receipt.
 *
 * The content store is the attachments' own, hardening and all -- it refuses a
 * path with a symbolic link in it and re-checks that what it read hashes to
 * what the key claims. It addresses objects as `sha256/<xx>/<hash>`, so the
 * `brand/` prefix that separates these objects in the Worker's shared bucket is
 * taken off here, where the separation is the directory instead.
 */
const objectKey = (fileKey: string): string => fileKey.replace(/^brand\//u, '')

export const createContainerBrandAssetSurface = async (
  database: BetterSqlite3.Database,
  brandDirectory: string,
): Promise<BrandAssetSurface<AppEnv>> => {
  const store = createContainerBrandAssetStore(database)
  const objects = await createDiskAttachmentObjectStore(brandDirectory)
  return {
    // Fail-open for the same reason the Worker's is: this runs on every page
    // render, and a brand lookup must never be why a page does not render.
    list: async () => {
      try {
        return await store.list()
      } catch {
        return []
      }
    },
    read: async (_env, fileKey) => objects.get(objectKey(fileKey)),
    write: async (_env, input) => {
      await objects.put(objectKey(input.fileKey), input.bytes, input.contentType)
      return store.put({
        slot: input.slot,
        contentHash: input.contentHash,
        fileKey: input.fileKey,
        contentType: input.contentType,
        byteSize: input.bytes.byteLength,
        uploadedByUserId: input.actorUserId,
        now: input.now,
      })
    },
    remove: async (_env, slot) => store.remove(slot),
  }
}
