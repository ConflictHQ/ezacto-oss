import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { InstancePaletteContract } from '@ezacto/core'
import {
  installInstanceThemeRoutes,
  installInstanceThemeStylesheetRoute,
  instanceThemeCssVariable,
  type InstanceThemeSurface,
} from '../src/instance-theme.js'
import { errorResponse } from '../src/errors.js'

type Principal = { userId: number; profile: string } | null

const updatedAt = '2026-09-11T12:00:00.000Z'

/**
 * A stand-in for the shell's tokens, for the same reason the core test uses
 * one: these tests are about the routes, and pinning them to the shipped
 * palette would turn a retuned brand colour into a failure here.
 */
const contract: InstancePaletteContract = {
  slots: ['ground', 'surface', 'ink', 'muted', 'action', 'action_fg', 'ink_2'],
  base: {
    ground: '#FFFFFF',
    surface: '#F5F6F7',
    ink: '#14161A',
    muted: '#676C74',
    action: '#16794A',
    action_fg: '#FFFFFF',
    ink_2: '#3A3D42',
  },
  requirements: [
    { name: 'ink/ground text', foreground: 'ink', background: 'ground', minimum: 4.5 },
  ],
}

const dark = { ground: '#1D1D1D', surface: '#282828', ink: '#F4F4F4' }

const surface = (
  overrides: Partial<InstanceThemeSurface<object>> = {},
): InstanceThemeSurface<object> => ({
  read: vi.fn(async () => ({ palette: dark, updatedAt })),
  write: vi.fn(async () => ({ palette: dark, updatedAt })),
  clear: vi.fn(async () => true),
  ...overrides,
})

const app = (
  themeSurface: InstanceThemeSurface<object>,
  principal: Principal = { userId: 1, profile: 'administrator' },
) => {
  const instance = new Hono<{ Bindings: object; Variables: Record<string, unknown> }>()
  instance.use('*', async (context, next) => {
    if (principal !== null) {
      context.set('principal', {
        ...principal,
        authentication: { kind: 'session', sessionId: 'session-1' },
      })
    }
    await next()
  })
  instance.onError((error, context) => errorResponse(error, context as never))
  installInstanceThemeRoutes(instance as never, {
    surface: themeSurface,
    contract,
    clock: () => updatedAt,
  })
  installInstanceThemeStylesheetRoute(instance as never, themeSurface)
  return instance
}

const post = (instance: ReturnType<typeof app>, body: unknown) =>
  instance.request('/settings/theme', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })

describe('reading the instance theme', () => {
  it('[api] answers the stored palette', async () => {
    const response = await app(surface()).request('/settings/theme')
    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: { palette: Record<string, string> } }
    expect(body.data.palette).toEqual(dark)
  })

  it('[api] answers null for an instance on the built-in theme', async () => {
    const response = await app(surface({ read: vi.fn(async () => null) })).request(
      '/settings/theme',
    )
    expect(response.status).toBe(200)
    expect((await response.json()) as unknown).toEqual({ data: null })
  })
})

describe('setting the instance theme', () => {
  it('[api] stores a palette that passes the contrast rule', async () => {
    const themeSurface = surface()
    const response = await post(app(themeSurface), { palette: dark })
    expect(response.status).toBe(200)
    expect(vi.mocked(themeSurface.write).mock.calls[0]?.[1]).toEqual({
      palette: dark,
      actorUserId: 1,
      now: updatedAt,
    })
  })

  it('[security] refuses a palette that would make the app unreadable', async () => {
    // A dark ground with the built-in ink left on it. The request is refused
    // rather than stored, so the instance that would have been unreadable never
    // exists.
    const themeSurface = surface()
    const response = await post(app(themeSurface), { palette: { ground: '#1D1D1D' } })
    expect(response.status).toBe(422)
    expect(themeSurface.write).not.toHaveBeenCalled()
    const body = (await response.json()) as {
      error: { fields: { field: string; code: string }[] }
    }
    // A 422 has to name the field at fault, which for a palette is the slot.
    expect(body.error.fields[0]?.field).toBe('palette.ground')
    expect(body.error.fields[0]?.code).toBe('contrast')
  })

  it('[api] names the slot when a colour is malformed', async () => {
    const response = await post(app(surface()), { palette: { ground: 'red' } })
    expect(response.status).toBe(422)
    const body = (await response.json()) as {
      error: { fields: { field: string; code: string }[] }
    }
    expect(body.error.fields[0]?.field).toBe('palette.ground')
    expect(body.error.fields[0]?.code).toBe('invalid_color')
  })

  it('[api] refuses a request with no palette in it', async () => {
    const response = await post(app(surface()), {})
    expect(response.status).toBe(422)
  })

  it('[api] takes an empty palette as a way back to the built-in theme', async () => {
    const themeSurface = surface()
    expect((await post(app(themeSurface), { palette: {} })).status).toBe(200)
    expect(vi.mocked(themeSurface.write).mock.calls[0]?.[1]?.palette).toEqual({})
  })
})

describe('who may change how the instance looks', () => {
  it('[security] only an administrator may read, set or clear it', async () => {
    // How the whole instance looks is not a per-user preference, and the read
    // is gated with the writes because it is the administrator's settings
    // screen rather than anything the app renders from.
    for (const profile of ['member', 'project_manager', 'accounting', 'executive_manager']) {
      const themeSurface = surface()
      const instance = app(themeSurface, { userId: 2, profile })
      expect((await instance.request('/settings/theme')).status).toBe(403)
      expect((await post(instance, { palette: dark })).status).toBe(403)
      expect(
        (await instance.request('/settings/theme', { method: 'DELETE' })).status,
      ).toBe(403)
      expect(themeSurface.write).not.toHaveBeenCalled()
      expect(themeSurface.clear).not.toHaveBeenCalled()
    }
  })

  it('[security] an API token cannot change the instance theme', async () => {
    const themeSurface = surface()
    const instance = new Hono<{ Bindings: object; Variables: Record<string, unknown> }>()
    instance.use('*', async (context, next) => {
      context.set('principal', {
        userId: 1,
        profile: 'administrator',
        authentication: { kind: 'api_token', tokenId: 7 },
      })
      await next()
    })
    instance.onError((error, context) => errorResponse(error, context as never))
    installInstanceThemeRoutes(instance as never, {
      surface: themeSurface,
      contract,
      clock: () => updatedAt,
    })

    const response = await instance.request('/settings/theme', {
      method: 'POST',
      body: JSON.stringify({ palette: dark }),
      headers: { 'content-type': 'application/json' },
    })
    expect(response.status).toBe(403)
    expect(themeSurface.write).not.toHaveBeenCalled()
  })
})

describe('clearing the instance theme', () => {
  it('[api] returns to the built-in theme', async () => {
    const response = await app(surface()).request('/settings/theme', { method: 'DELETE' })
    expect(response.status).toBe(204)
  })

  it('[api] says so when there was no palette to clear', async () => {
    const response = await app(surface({ clear: vi.fn(async () => false) })).request(
      '/settings/theme',
      { method: 'DELETE' },
    )
    expect(response.status).toBe(404)
  })
})

describe('the served stylesheet', () => {
  it('[api] serves the palette as CSS custom properties', async () => {
    const response = await app(surface()).request('/assets/instance-theme.css')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/css; charset=utf-8')
    const body = await response.text()
    expect(body).toContain('--ez-ground: #1D1D1D;')
    expect(body).toContain('--ez-ink: #F4F4F4;')
  })

  it('[security] takes no session, because the sign-in page links it', async () => {
    // The browser fetching this has none by definition -- the same reason the
    // brand marks download without one.
    const response = await app(surface(), null).request('/assets/instance-theme.css')
    expect(response.status).toBe(200)
  })

  it('[api] is empty rather than absent for an unthemed instance', async () => {
    const response = await app(surface({ read: vi.fn(async () => null) })).request(
      '/assets/instance-theme.css',
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('')
  })

  it('[api] revalidates, and answers 304 to a browser that has this palette', async () => {
    // Fetched on every page load, so the common case should cost a 304 rather
    // than the body; and it revalidates rather than expiring, so a changed
    // colour appears on the next navigation.
    const instance = app(surface())
    const first = await instance.request('/assets/instance-theme.css')
    expect(first.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
    const tag = first.headers.get('etag')
    expect(tag).not.toBeNull()

    const second = await instance.request('/assets/instance-theme.css', {
      headers: { 'if-none-match': tag! },
    })
    expect(second.status).toBe(304)
  })

  it('[api] changes its entity tag when the palette changes', async () => {
    const first = await app(surface()).request('/assets/instance-theme.css')
    const second = await app(
      surface({ read: vi.fn(async () => ({ palette: { action: '#0B5E37' }, updatedAt })) }),
    ).request('/assets/instance-theme.css')
    expect(second.headers.get('etag')).not.toBe(first.headers.get('etag'))
  })

  it('[security] refuses to let a stored non-colour reach the stylesheet', async () => {
    // The route validates on the way in and the schema guards the column, so
    // this should be unreachable. It is asserted anyway because this is the one
    // path that puts stored text into a document a browser parses as CSS.
    const response = await app(
      surface({
        read: vi.fn(async () => ({
          palette: { ground: '#1D1D1D', ink: 'red; } body { display: none } a {' },
          updatedAt,
        })),
      }),
    ).request('/assets/instance-theme.css')
    const body = await response.text()
    expect(body).toContain('--ez-ground: #1D1D1D;')
    expect(body).not.toContain('display: none')
  })
})

describe('the css variable name', () => {
  it('[unit] spells an underscored slot the way the generated stylesheet does', () => {
    expect(instanceThemeCssVariable('ink_2')).toBe('--ez-ink-2')
    expect(instanceThemeCssVariable('ground')).toBe('--ez-ground')
  })
})
