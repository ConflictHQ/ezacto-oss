import type { SignInMethodState } from '@ezacto/api'
import { createSignInMethodRepository } from '@ezacto/db/d1'
import type { AppEnv, WorkerEnv } from './app.js'

/**
 * Which ways in the sign-in card may offer, on the path that has no services.
 *
 * The shell HTML is served by an app built without `RuntimeServices` -- it is
 * not a data request, so nothing constructs them and nothing runs migrations.
 * That is the same constraint the brand-mark lookup lives under, and this
 * follows it exactly: read the binding off the request environment, and answer
 * with nothing rather than throwing.
 *
 * Answering with nothing means every configured method renders, which is how
 * the page behaved before the setting existed. That is the right way to fail
 * here: the routes enforce the setting independently, so a page that offers one
 * method too many is a bad answer, while a page that offers none is a locked
 * door.
 */
const bindings = (env: AppEnv): Partial<WorkerEnv> => env as Partial<WorkerEnv>

export interface SignInMethodSurface {
  read(env: AppEnv): Promise<readonly SignInMethodState[] | null>
}

export const workerSignInMethodSurface: SignInMethodSurface = {
  read: async (env) => {
    const database = bindings(env).DB
    if (database === undefined) return null
    try {
      return await createSignInMethodRepository(database).list()
    } catch {
      // A database that has not reached 0085 has no column to read, and a
      // sign-in page is not permitted to fail over a setting.
      return null
    }
  },
}
