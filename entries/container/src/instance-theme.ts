import type BetterSqlite3 from 'better-sqlite3'
import type { InstanceThemeSurface } from '@ezacto/api'
import { createContainerInstanceThemeStore } from '@ezacto/db'
import type { AppEnv } from '../../worker/src/app.js'

/**
 * The container's instance palette (#591), in the same SQLite file everything
 * else lives in.
 *
 * No object store: a palette is a few dozen bytes of JSON, not a file. That is
 * the whole difference between this and the brand marks it is set alongside.
 */
export const createContainerInstanceThemeSurface = (
  database: BetterSqlite3.Database,
): InstanceThemeSurface<AppEnv> => {
  const store = createContainerInstanceThemeStore(database)
  return {
    // Fail-open for the same reason the brand surface is: this runs on every
    // page render and on the stylesheet every page links, and a theme lookup
    // must never be why a page does not render.
    read: async () => {
      try {
        const record = await store.read()
        return record === null
          ? null
          : { palette: record.palette, updatedAt: record.updatedAt }
      } catch {
        return null
      }
    },
    write: async (_env, input) => {
      const record = await store.put({
        palette: input.palette,
        updatedByUserId: input.actorUserId,
        now: input.now,
      })
      return { palette: record.palette, updatedAt: record.updatedAt }
    },
    clear: async () => store.clear(),
  }
}
