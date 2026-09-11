import { ApiError, type InstanceThemeSurface } from '@ezacto/api'
import { createD1InstanceThemeStore } from '@ezacto/db/d1'
import type { AppEnv, WorkerEnv } from './app.js'

/**
 * The Worker's instance palette (#591), stored in D1 beside the brand marks it
 * is set with.
 *
 * Bindings come off the request environment rather than out of
 * `RuntimeServices`, because the app that renders the shell is built without
 * services at all -- the same reason the brand surface is shaped this way.
 */
const bindings = (env: AppEnv): Partial<WorkerEnv> => env as Partial<WorkerEnv>

export const workerInstanceThemeSurface: InstanceThemeSurface<AppEnv> = {
  /**
   * Answers with no palette rather than throwing. This runs on every page
   * render and on the stylesheet every page links, and the shell is served by a
   * path that has deliberately not run migrations -- so on a database that has
   * not reached 0049 the table is simply not there. A theme lookup is not
   * permitted to be the reason a page fails: the instance renders the built-in
   * colours, which is exactly what it rendered before this feature existed.
   */
  read: async (env) => {
    const database = bindings(env).DB
    if (database === undefined) return null
    try {
      const record = await createD1InstanceThemeStore(database).read()
      return record === null
        ? null
        : { palette: record.palette, updatedAt: record.updatedAt }
    } catch {
      return null
    }
  },

  write: async (env, input) => {
    const database = bindings(env).DB
    if (database === undefined) {
      throw new ApiError({
        status: 503,
        code: 'service_unavailable',
        message: 'Instance theme storage is not configured.',
      })
    }
    const record = await createD1InstanceThemeStore(database).put({
      palette: input.palette,
      updatedByUserId: input.actorUserId,
      now: input.now,
    })
    return { palette: record.palette, updatedAt: record.updatedAt }
  },

  clear: async (env) => {
    const database = bindings(env).DB
    if (database === undefined) {
      throw new ApiError({
        status: 503,
        code: 'service_unavailable',
        message: 'Instance theme storage is not configured.',
      })
    }
    return createD1InstanceThemeStore(database).clear()
  },
}
