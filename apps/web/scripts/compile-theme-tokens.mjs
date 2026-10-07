import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = resolve(root, 'theme-tokens.json')
const cssPath = resolve(root, 'generated', 'themes.css')
const manifestPath = resolve(root, 'src', 'generated', 'theme-manifest.ts')
/**
 * The palette, flat, for the surfaces that cannot import TypeScript or CSS.
 *
 * Issue 666: one brand, five surfaces, and twenty-five files of hand-written
 * hex outside the one place built to hold it. Mobile, the website, the portal
 * and the extension each copied colours by eye because there was nothing to
 * read -- the source carries a `contract` and per-theme metadata, and the two
 * existing outputs are a stylesheet and a TS module.
 *
 * So this is the boring shape on purpose: slot name to value, one level deep,
 * no comments and no structure to interpret. A file anything with a JSON parser
 * can consume without knowing what a slot is.
 *
 * A theme's dark scheme keeps that shape: it is emitted as a theme of its own,
 * `<name>_dark`, and `dark_themes` says which light theme it belongs to.
 */
const palettePath = resolve(root, 'generated', 'theme-palette.json')
const check = process.argv.includes('--check')

const slots = [
  'ground',
  'surface',
  'border',
  'ink',
  'muted',
  'action',
  'action_fg',
  'live',
  'data',
  'money',
  'status_bg',
  'status_fg',
  'ink_2',
  'orange_tint',
  'blue_light',
  'red',
  'amber',
  'amber_bg',
  'live_text',
  'surface_2',
  'row_hover',
  'band',
  'band_ink',
  'shadow',
]
const fonts = ['display', 'body', 'mono']
const scalars = ['radius']

const fail = (message) => {
  throw new Error(`theme token contract: ${message}`)
}

const object = (value, field) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${field} must be an object`)
  }
  return value
}

const exactArray = (actual, expected, field) => {
  if (!Array.isArray(actual) || JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${field} must equal ${JSON.stringify(expected)}`)
  }
}

const cssName = (name) => name.replaceAll('_', '-')

// 900 is the page title's weight. A family that stops short of it (IBM Plex
// Mono ends at 700) is served what it has: Google Fonts drops a weight a family
// does not carry rather than refusing the whole request.
const fontStylesheet = (theme) => {
  const unique = [...new Set(fonts.map((font) => theme[font]))]
  const families = unique.map(
    (font) => `family=${font.split(' ').join('+')}:wght@400;500;600;700;900`,
  )
  return `https://fonts.googleapis.com/css2?${families.join('&')}&display=swap`
}

const compile = (source) => {
  const rootDocument = object(source, 'document')
  const contract = object(rootDocument.contract, 'contract')
  exactArray(contract.slots, slots, 'contract.slots')
  exactArray(contract.fonts, fonts, 'contract.fonts')
  exactArray(contract.scalars, scalars, 'contract.scalars')
  const themes = object(rootDocument.themes, 'themes')
  const ossThemes = Object.entries(themes).filter(([, theme]) => object(theme, 'theme').tier === 'oss')
  if (ossThemes.length !== 1) fail('exactly one tier=oss theme must be localized')
  const [themeEntry] = ossThemes
  if (themeEntry === undefined) fail('the OSS theme is missing')
  const [name, rawTheme] = themeEntry
  const theme = object(rawTheme, `themes.${name}`)
  if (rootDocument.default_theme !== name || name !== 'precision') {
    fail('precision must be the only OSS theme and the default')
  }
  const allowed = new Set(['label', 'tier', 'dark', ...slots, ...fonts, ...scalars])
  for (const key of Object.keys(theme)) {
    if (!allowed.has(key)) fail(`themes.${name}.${key} is not part of the slot contract`)
  }
  const hexSlots = (palette, field) => {
    for (const slot of slots) {
      if (typeof palette[slot] !== 'string' || !/^#[0-9A-F]{6}$/u.test(palette[slot])) {
        fail(`${field}.${slot} must be an uppercase six-digit hex color`)
      }
    }
  }
  hexSlots(theme, `themes.${name}`)
  // The dark scheme is colours only: type and radius are the theme's in either
  // scheme. Every slot has to be there, because a dark scheme that left one out
  // would paint the light value on a dark ground.
  const dark = object(theme.dark, `themes.${name}.dark`)
  for (const key of Object.keys(dark)) {
    if (!slots.includes(key)) fail(`themes.${name}.dark.${key} is not part of the slot contract`)
  }
  hexSlots(dark, `themes.${name}.dark`)
  for (const font of fonts) {
    if (typeof theme[font] !== 'string' || !/^[A-Za-z0-9 ]{1,100}$/u.test(theme[font])) {
      fail(`themes.${name}.${font} must be a plain font-family name`)
    }
  }
  if (!Number.isInteger(theme.radius) || theme.radius < 0 || theme.radius > 100) {
    fail(`themes.${name}.radius must be an integer from 0 through 100`)
  }
  if (typeof theme.label !== 'string' || theme.label.trim() === '') {
    fail(`themes.${name}.label must be a non-empty string`)
  }

  const slotDeclarations = (palette) =>
    slots.map((slot) => `  --ez-${cssName(slot)}: ${palette[slot]};`)
  const darkDeclarations = ['  color-scheme: dark;', ...slotDeclarations(dark)]
  const selector = `[data-ez-theme=${JSON.stringify(name)}]`
  /*
   * Three blocks. The first is the light scheme, on the root and on anything
   * else wearing the theme -- which is how a document shell keeps the white
   * paper an invoice is printed on while the application around it is dark.
   *
   * The other two are the dark scheme, chosen and inherited. `data-ez-scheme`
   * is the person's choice, which the server renders on the root from their
   * cookie, so it is there before the first paint; `system` hands the choice
   * to the operating system. An instance with a palette of its own
   * (`data-ez-palette`) keeps that palette unless someone asks for dark
   * outright: the palette was checked against the light scheme, and an OS
   * setting is not a request to stop wearing it. The attribute names are
   * `src/theme-preference.ts`'s, and the renderer writes them.
   */
  const css = [
    '/* Generated by scripts/compile-theme-tokens.mjs. Do not edit. */',
    `:root, ${selector} {`,
    '  color-scheme: light;',
    ...slotDeclarations(theme),
    ...fonts.map((font) => `  --ez-font-${font}: ${JSON.stringify(theme[font])};`),
    `  --ez-radius: ${theme.radius}px;`,
    '}',
    `${selector}[data-ez-scheme="dark"] {`,
    ...darkDeclarations,
    '}',
    '@media (prefers-color-scheme: dark) {',
    `  ${selector}[data-ez-scheme="system"]:not([data-ez-palette]) {`,
    ...darkDeclarations.map((line) => `  ${line}`),
    '  }',
    '}',
    '',
  ].join('\n')

  const colors = Object.fromEntries(slots.map((slot) => [slot, theme[slot]]))
  const darkColors = Object.fromEntries(slots.map((slot) => [slot, dark[slot]]))
  const themeFonts = Object.fromEntries(fonts.map((font) => [font, theme[font]]))
  const manifest = [
    '// Generated by scripts/compile-theme-tokens.mjs. Do not edit.',
    `export const generatedDefaultTheme = ${JSON.stringify(name)} as const`,
    'export const generatedThemes = {',
    `  ${JSON.stringify(name)}: {`,
    `    label: ${JSON.stringify(theme.label)},`,
    `    colors: ${JSON.stringify(colors, null, 2).replaceAll('\n', '\n    ')},`,
    `    darkColors: ${JSON.stringify(darkColors, null, 2).replaceAll('\n', '\n    ')},`,
    `    fonts: ${JSON.stringify(themeFonts, null, 2).replaceAll('\n', '\n    ')},`,
    `    radius: ${theme.radius},`,
    `    fontStylesheet: ${JSON.stringify(fontStylesheet(theme))},`,
    '  },',
    '} as const',
    '',
  ].join('\n')
  /**
   * Emitted per theme rather than only for the default, because a surface that
   * hard-codes "the default theme" is the copying this is meant to end -- one
   * level further along.
   *
   * `label` and `tier` are dropped: they describe the theme to an operator and
   * mean nothing to a stylesheet. Everything else is carried as written, so a
   * consumer comparing its own hex against this is comparing like with like.
   */
  const flat = (colours, theme) =>
    Object.fromEntries([
      ...slots.map((slot) => [slot, colours[slot]]),
      ...[...fonts, ...scalars].map((key) => [key, theme[key]]),
    ])
  const palette = {
    $generated: 'apps/web/scripts/compile-theme-tokens.mjs -- do not edit',
    $source: 'apps/web/theme-tokens.json',
    default_theme: source.default_theme,
    contract: { slots, fonts, scalars },
    themes: Object.fromEntries(
      Object.entries(source.themes).flatMap(([name, theme]) => [
        [name, flat(theme, theme)],
        ...(theme.dark === undefined ? [] : [[`${name}_dark`, flat(theme.dark, theme)]]),
      ]),
    ),
    dark_themes: Object.fromEntries(
      Object.entries(source.themes)
        .filter(([, theme]) => theme.dark !== undefined)
        .map(([name]) => [name, `${name}_dark`]),
    ),
  }

  return { css, manifest, palette: `${JSON.stringify(palette, null, 2)}\n` }
}

const source = JSON.parse(await readFile(sourcePath, 'utf8'))
const generated = compile(source)

const emit = async (path, expected) => {
  if (check) {
    const actual = await readFile(path, 'utf8').catch(() => '')
    if (actual !== expected) fail(`${path.slice(root.length + 1)} is stale; run npm run theme:generate`)
    return
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, expected, 'utf8')
}

await Promise.all([
  emit(cssPath, generated.css),
  emit(manifestPath, generated.manifest),
  emit(palettePath, generated.palette),
])
