import { INSTANCE_THEME_STYLESHEET_PATH } from './instance-theme.js'

/**
 * What the standalone portal pages (estimate review, emailed invoice) take of
 * the instance brand (issue 1011). They are light-scheme pages with no staff
 * shell, so they draw the light-ground wordmark, link the instance stylesheet
 * after the built-in one, and carry the favicon, as the shell does.
 *
 * Every field is optional: nothing set renders exactly the page it always was.
 */
export interface PortalBrandChrome {
  /** The `wordmark_light` mark, as the shell resolves it. */
  readonly wordmarkLight?: string
  readonly favicon?: string
  /** Whether the instance has a palette to link. */
  readonly instanceTheme?: boolean
}

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  )

// Same-origin only: these pages are served under `img-src 'self' data:`, so a
// mark hosted elsewhere would render as a broken image. `//host` is excluded.
const sameOrigin = (source: string): boolean =>
  source.startsWith('/') && !source.startsWith('//')

/** Head lines placed after the built-in stylesheet. */
export const portalBrandHead = (chrome: PortalBrandChrome | undefined): string => {
  const favicon = chrome?.favicon
  return (
    (favicon !== undefined && favicon !== '' && sameOrigin(favicon)
      ? `  <link rel="icon" href="${escapeHtml(favicon)}">\n`
      : '') +
    (chrome?.instanceTheme === true
      ? `  <link rel="stylesheet" href="${INSTANCE_THEME_STYLESHEET_PATH}">\n`
      : '')
  )
}

/** The attribute the shell sets when the instance stylesheet is linked. */
export const portalPaletteAttribute = (chrome: PortalBrandChrome | undefined): string =>
  chrome?.instanceTheme === true ? ' data-ez-palette="instance"' : ''

/** The wordmark above the heading, or nothing where none is uploaded. */
export const portalWordmark = (chrome: PortalBrandChrome | undefined, name: string): string => {
  const source = chrome?.wordmarkLight
  return source === undefined || source === '' || !sameOrigin(source)
    ? ''
    : `<img class="brand-mark" src="${escapeHtml(source)}" alt="${escapeHtml(name)}">`
}
