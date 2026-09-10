import { ApiError, type BrandAssetSurface } from '@ezacto/api'
import { createD1BrandAssetStore } from '@ezacto/db/d1'
import type { AppEnv, WorkerEnv } from './app.js'

/**
 * The Worker's brand-mark storage (#489): metadata in D1, bytes in the same R2
 * bucket the attachments use, under their own `brand/` prefix.
 *
 * Bindings are read off the request environment rather than taken from
 * `RuntimeServices`, because the app that renders the shell is built without
 * services at all. `AppEnv` is what a Hono handler sees; the bindings arrive on
 * the same object at runtime and are narrowed here.
 */
const bindings = (env: AppEnv): Partial<WorkerEnv> => env as Partial<WorkerEnv>

const unavailable = (): never => {
  throw new ApiError({
    status: 503,
    code: 'service_unavailable',
    message: 'Brand asset storage is not configured.',
  })
}

export const workerBrandAssetSurface: BrandAssetSurface<AppEnv> = {
  /**
   * Answers with nothing rather than throwing. This runs on every page render,
   * and the shell is served by a path that has deliberately not run migrations,
   * so on a database that has not reached 0045 the table is simply not there
   * yet. A brand lookup is not permitted to be the reason a page fails: the
   * caller falls back to the configured URLs, which is what it would have used
   * before this feature existed.
   */
  list: async (env) => {
    const database = bindings(env).DB
    if (database === undefined) return []
    try {
      return await createD1BrandAssetStore(database).list()
    } catch {
      return []
    }
  },

  read: async (env, fileKey) => {
    const bucket = bindings(env).ATTACHMENTS
    if (bucket === undefined) return null
    const object = await bucket.get(fileKey)
    return object === null ? null : { body: object.body }
  },

  write: async (env, input) => {
    const database = bindings(env).DB
    const bucket = bindings(env).ATTACHMENTS
    if (database === undefined || bucket === undefined) unavailable()
    // The object goes first and is content-addressed, exactly as an
    // attachment's does: a failure after this leaves an unreferenced object for
    // a sweep to collect, where a failure the other way round would leave a row
    // pointing at bytes that were never written.
    await bucket!.put(input.fileKey, input.bytes, {
      httpMetadata: { contentType: input.contentType },
    })
    const stored = await createD1BrandAssetStore(database!).put({
      slot: input.slot,
      contentHash: input.contentHash,
      fileKey: input.fileKey,
      contentType: input.contentType,
      byteSize: input.bytes.byteLength,
      uploadedByUserId: input.actorUserId,
      now: input.now,
    })
    return stored
  },

  /**
   * The row goes; the object stays. Content-addressed bytes may be shared with
   * another slot, and an operator who removes the dark mark has not asked for
   * the light one to break -- so the object is left for a sweep, which is the
   * same trade `attachments.ts` documents.
   */
  remove: async (env, slot) => {
    const database = bindings(env).DB
    if (database === undefined) unavailable()
    return createD1BrandAssetStore(database!).remove(slot)
  },
}
