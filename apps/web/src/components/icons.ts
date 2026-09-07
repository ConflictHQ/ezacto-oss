/**
 * The one icon set.
 *
 * Old Harvest carried a small set of line icons that were load-bearing rather
 * than decorative — a paperclip meant "there is a receipt on this row", a
 * padlock meant "you cannot edit this". ezacto had one `<svg>` in the whole
 * shell (the avatar placeholder) and made do with literal glyphs everywhere
 * else: `←`/`→` for the week stepper, `⌘K` for the command trigger, `…` for a
 * row's overflow. A glyph is whatever the reader's font decides it is, and it
 * cannot be sized or aligned with the text beside it.
 *
 * Three constraints shaped this:
 *
 * - **Inline, never a font or a request.** The worker serves one stylesheet and
 *   one script. An icon font would be a third asset and a flash of missing
 *   glyphs before it lands; a sprite fetched over the network is the same
 *   problem with an extra failure mode. The geometry is in the bundle.
 * - **`currentColor`, never a colour of its own.** An icon inherits the colour
 *   of the text it sits with, so it survives a theme swap, a hover state and a
 *   disabled control without a second definition anywhere.
 * - **Named or hidden, never "image".** An icon that carries the whole message
 *   takes `label` and is announced. An icon decorating text that already says
 *   the same thing takes no label and is hidden. Getting that backwards makes
 *   a reader announce "image" beside every row action, which is worse than the
 *   glyphs this replaces.
 *
 * The geometry is a table rather than markup because it is rendered twice: as
 * a string by the server-rendered shell, and as DOM by the browser code that
 * builds tables and lists. One table means the two cannot drift.
 *
 * See screens/HRVST10/OLD-UI-ANALYSIS.md §2, and item 5 of ezacto-oss 292.
 */

export type IconName =
  | 'calendar'
  | 'chevron'
  | 'clock'
  | 'magnifier'
  | 'overflow'
  | 'padlock'
  | 'paperclip'

/**
 * The chevron is drawn once, pointing right, and turned by CSS. Four separate
 * paths would be four things to keep the same weight.
 */
export type IconDirection = 'down' | 'left' | 'right' | 'up'

interface IconShape {
  readonly element: 'circle' | 'path' | 'rect'
  readonly attributes: Readonly<Record<string, string>>
}

/**
 * Drawn on a 20-unit grid at 1.5 stroke, which the stylesheet paints. The
 * overflow dots carry their own `fill`/`stroke`: they are the one solid mark in
 * the set, and a presentation attribute on the shape beats the `fill: none` the
 * `<svg>` passes down.
 */
const iconGeometry: Readonly<Record<IconName, readonly IconShape[]>> = {
  calendar: [
    { element: 'rect', attributes: { x: '2.75', y: '4.25', width: '14.5', height: '13', rx: '2' } },
    { element: 'path', attributes: { d: 'M2.75 8.25h14.5M6.75 2.75v3M13.25 2.75v3' } },
  ],
  chevron: [{ element: 'path', attributes: { d: 'm7.5 4 6 6-6 6' } }],
  clock: [
    { element: 'circle', attributes: { cx: '10', cy: '10', r: '7.25' } },
    { element: 'path', attributes: { d: 'M10 5.5V10l3 2' } },
  ],
  magnifier: [
    { element: 'circle', attributes: { cx: '8.75', cy: '8.75', r: '5' } },
    { element: 'path', attributes: { d: 'm12.4 12.4 4.35 4.35' } },
  ],
  overflow: [
    {
      element: 'circle',
      attributes: { cx: '4.5', cy: '10', r: '1.5', fill: 'currentColor', stroke: 'none' },
    },
    {
      element: 'circle',
      attributes: { cx: '10', cy: '10', r: '1.5', fill: 'currentColor', stroke: 'none' },
    },
    {
      element: 'circle',
      attributes: { cx: '15.5', cy: '10', r: '1.5', fill: 'currentColor', stroke: 'none' },
    },
  ],
  padlock: [
    { element: 'rect', attributes: { x: '3.75', y: '8.75', width: '12.5', height: '8.5', rx: '2' } },
    { element: 'path', attributes: { d: 'M6.75 8.75V6.25a3.25 3.25 0 0 1 6.5 0v2.5' } },
  ],
  paperclip: [
    {
      element: 'path',
      attributes: {
        d: 'M17.87 9.21l-7.66 7.66a5 5 0 0 1-7.08-7.08l7.66-7.66a3.33 3.33 0 0 1 4.72 4.72l-7.67 7.66a1.67 1.67 0 0 1-2.36-2.36l7.08-7.07',
      },
    },
  ],
}

export const iconNames = Object.keys(iconGeometry).sort() as readonly IconName[]

export interface IconOptions {
  /**
   * The icon's accessible name. Supply it only when the icon is the whole
   * message — a padlock standing in for the word "Locked". Leave it off when a
   * control already names itself (`aria-label` on the button) or when the icon
   * sits beside the text it illustrates; the icon is then hidden from the
   * reader, because announcing it twice is noise.
   */
  readonly label?: string
  /** Which way a directional icon points. Defaults to how it is drawn. */
  readonly direction?: IconDirection
}

/**
 * Shared by both renderers so a named icon and a hidden one cannot be described
 * differently depending on which side of the wire drew it. `focusable="false"`
 * matches the avatar already in the shell: without it an inline `<svg>` is a
 * tab stop in some engines.
 */
const iconAttributes = (
  name: IconName,
  options: IconOptions,
): Readonly<Record<string, string>> => ({
  class: 'ez-icon',
  'data-icon': name,
  viewBox: '0 0 20 20',
  focusable: 'false',
  ...(options.direction === undefined ? {} : { 'data-direction': options.direction }),
  ...(options.label === undefined
    ? { 'aria-hidden': 'true' }
    : { role: 'img', 'aria-label': options.label }),
})

/**
 * Deliberately local. The shell's renderer imports this module, so importing
 * its escaper back would be a cycle for the sake of five replacements.
 */
const escapeAttribute = (value: string): string =>
  value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  )

const serializeAttributes = (attributes: Readonly<Record<string, string>>): string =>
  Object.entries(attributes)
    .map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`)
    .join('')

/** For the server-rendered shell, which builds its HTML as a string. */
export const iconMarkup = (name: IconName, options: IconOptions = {}): string =>
  `<svg${serializeAttributes(iconAttributes(name, options))}>` +
  iconGeometry[name]
    .map((shape) => `<${shape.element}${serializeAttributes(shape.attributes)}/>`)
    .join('') +
  '</svg>'

const svgNamespace = 'http://www.w3.org/2000/svg'

/** For browser code that builds rows, cells and lists as DOM. */
export const icon = (name: IconName, options: IconOptions = {}): SVGSVGElement => {
  const element = document.createElementNS(svgNamespace, 'svg')
  for (const [key, value] of Object.entries(iconAttributes(name, options)))
    element.setAttribute(key, value)
  for (const shape of iconGeometry[name]) {
    const child = document.createElementNS(svgNamespace, shape.element)
    for (const [key, value] of Object.entries(shape.attributes)) child.setAttribute(key, value)
    element.append(child)
  }
  return element
}
