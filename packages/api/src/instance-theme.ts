/**
 * The palette an instance wears (#591): the administrator's three routes for
 * setting it, and the stylesheet every browser loads it from.
 *
 * WHY A STYLESHEET AND NOT A `<style>` BLOCK. The shell is served under
 * `style-src 'self' https://fonts.googleapis.com`. That admits no inline style,
 * so a `<style>` block carrying the palette would be dropped by the browser
 * with no error the operator could see -- the instance would simply render the
 * built-in colours and the settings screen would appear to have lied. Adding
 * `'unsafe-inline'` to make one work would spend the entire protection the
 * directive exists for, on a palette. A stylesheet served from this origin is
 * what the policy already allows, and it is how `/assets/ezacto.css` is served.
 *
 * WHY THE CONTRACT IS INJECTED. Which slots exist, what the built-in colours
 * are, and which pairs have to stay legible are the web shell's design tokens.
 * This package does not depend on the shell, and a copy of that list here would
 * be a second source able to drift from the stylesheet a browser actually
 * loads. The entry composes both and passes the contract in.
 */

import type { Context, Hono } from 'hono'
import {
  INSTANCE_THEME_STYLESHEET_PATH,
  instancePaletteStylesheet,
  readInstancePalette,
  type InstancePaletteContract,
} from '@ezacto/core'
import { requireSessionPrincipal } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError, validationError } from './errors.js'
import { readObjectBody } from './resources/support.js'

export interface InstanceThemeRecord {
  palette: Readonly<Record<string, string>>
  updatedAt: string
}

/**
 * Entry-owned and threaded with the request environment, exactly as the brand
 * surface is and for the same reason: the Worker serves the shell from an app
 * built with no runtime services, so a page render is never behind a migration.
 */
export interface InstanceThemeSurface<Bindings extends object> {
  /**
   * Answers `null` for an instance with no palette of its own -- including one
   * whose database has not reached the migration yet. This runs on the page
   * path, where a theme lookup must never be the reason a page fails to render.
   */
  read(env: Bindings): Promise<InstanceThemeRecord | null>
  write(
    env: Bindings,
    input: {
      palette: Readonly<Record<string, string>>
      actorUserId: number
      now: string
    },
  ): Promise<InstanceThemeRecord>
  clear(env: Bindings): Promise<boolean>
}

// Re-exported so a caller wiring the route and a caller linking the stylesheet
// reach the same constant without either depending on the other's package.
export { INSTANCE_THEME_STYLESHEET_PATH }

/** The slot name as the generated stylesheet spells it: `ink_2` is `--ez-ink-2`. */
export const instanceThemeCssVariable = (slot: string): string =>
  `--ez-${slot.replaceAll('_', '-')}`

const assertAdministrator = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): number => {
  const principal = requireSessionPrincipal(context)
  if (principal.profile !== 'administrator') {
    // How the whole instance looks is not a per-user preference. A person who
    // wants the app darker is asking for something this is not.
    throw new ApiError({
      status: 403,
      code: 'profile_forbidden',
      message: 'Only administrators can change the instance theme.',
    })
  }
  return principal.userId
}

const serialize = (record: InstanceThemeRecord | null) =>
  record === null ? null : { palette: record.palette, updated_at: record.updatedAt }

/**
 * A weak-free entity tag over the served bytes.
 *
 * The palette changes rarely and the stylesheet is fetched on every page load,
 * so the response revalidates rather than expiring: a browser that already has
 * the palette spends a 304 on it, and an operator who changes a colour sees it
 * on the next navigation instead of whenever a cache decides to let go.
 */
const entityTag = (body: string): string => {
  let hash = 0x811c9dc5
  for (let index = 0; index < body.length; index += 1) {
    hash ^= body.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `"${body.length.toString(16)}-${hash.toString(16)}"`
}

export const installInstanceThemeRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  options: {
    surface: InstanceThemeSurface<Bindings>
    contract: Readonly<InstancePaletteContract>
    clock(): string
  },
): void => {
  api.get('/settings/theme', async (context) => {
    assertAdministrator(context)
    return context.json(
      { data: serialize(await options.surface.read(context.env)) },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  /**
   * The palette is replaced whole, not patched -- POST for the same reason the
   * brand marks and the QuickBooks settings use it, which is that this surface
   * has no PUT and "set this to that" is spelled POST throughout.
   *
   * Contrast is a property of the palette rather than of any one colour in it,
   * so a request that changed one slot could only be validated against whatever
   * happened to be stored -- and two administrators editing at once would each
   * pass against a palette neither of them ends up with. Sending the whole
   * palette makes the thing validated and the thing stored the same object.
   */
  api.post('/settings/theme', async (context) => {
    const actorUserId = assertAdministrator(context)
    const body = await readObjectBody(context)
    const { palette, errors } = readInstancePalette(body['palette'], options.contract)
    if (errors.length > 0) throw validationError([...errors])
    return context.json(
      {
        data: serialize(
          await options.surface.write(context.env, {
            palette,
            actorUserId,
            now: options.clock(),
          }),
        ),
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  // Back to the built-in theme. This is the way out of a palette an operator
  // has stopped liking, so it is part of the feature and not tidying.
  api.delete('/settings/theme', async (context) => {
    assertAdministrator(context)
    if (!(await options.surface.clear(context.env))) {
      throw new ApiError({
        status: 404,
        code: 'not_found',
        message: 'This instance is already on the built-in theme.',
      })
    }
    return context.body(null, 204, { 'cache-control': 'no-store' })
  })
}

/**
 * The stylesheet itself, outside the API surface and taking no principal.
 *
 * It is linked from the sign-in page, which is fetched by a browser that has no
 * session by definition -- the same reason the brand marks download without
 * one. It reveals the instance's colours, which is what it exists to put on
 * the screen.
 */
export const installInstanceThemeStylesheetRoute = <Bindings extends object>(
  app: Hono<ApiContext<Bindings>>,
  surface: InstanceThemeSurface<Bindings>,
): void => {
  app.get(INSTANCE_THEME_STYLESHEET_PATH, async (context) => {
    const record = await surface.read(context.env)
    const body =
      record === null
        ? ''
        : instancePaletteStylesheet(record.palette, instanceThemeCssVariable)
    const tag = entityTag(body)
    if (context.req.header('if-none-match') === tag) {
      return context.body(null, 304, { etag: tag, 'cache-control': 'public, max-age=0, must-revalidate' })
    }
    return context.body(body, 200, {
      'content-type': 'text/css; charset=utf-8',
      'cache-control': 'public, max-age=0, must-revalidate',
      etag: tag,
      'x-content-type-options': 'nosniff',
    })
  })
}
