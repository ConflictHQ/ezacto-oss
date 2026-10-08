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
  | 'banknote'
  | 'calendar'
  | 'card'
  | 'chart'
  | 'check'
  | 'chevron'
  | 'clock'
  | 'document'
  | 'eye'
  | 'eye-off'
  | 'folder'
  | 'home'
  | 'list'
  | 'magnifier'
  | 'overflow'
  | 'padlock'
  | 'paperclip'
  | 'people'
  | 'person'
  | 'sidebar'
  | 'sign-out'
  | 'sliders'
  | 'sort'

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
 * overflow dots and the list's bullets carry their own `fill`/`stroke`: they
 * are the solid marks in the set, and a presentation attribute on the shape
 * beats the `fill: none` the `<svg>` passes down.
 */
const iconGeometry: Readonly<Record<IconName, readonly IconShape[]>> = {
  // The navigation's marks (the 2026-10 reskin): one per section, so a
  // collapsed sidebar can be read by its icons, and the sidebar's own toggle.
  banknote: [
    { element: 'rect', attributes: { x: '2.25', y: '5.25', width: '15.5', height: '9.5', rx: '1.5' } },
    { element: 'circle', attributes: { cx: '10', cy: '10', r: '2.25' } },
    { element: 'path', attributes: { d: 'M5 8v4M15 8v4' } },
  ],
  calendar: [
    { element: 'rect', attributes: { x: '2.75', y: '4.25', width: '14.5', height: '13', rx: '2' } },
    { element: 'path', attributes: { d: 'M2.75 8.25h14.5M6.75 2.75v3M13.25 2.75v3' } },
  ],
  card: [
    { element: 'rect', attributes: { x: '2.75', y: '4.75', width: '14.5', height: '10.5', rx: '2' } },
    { element: 'path', attributes: { d: 'M2.75 8.75h14.5M5.75 12.25h3' } },
  ],
  chart: [{ element: 'path', attributes: { d: 'M4.75 16.25v-5M10 16.25V4.75M15.25 16.25v-7.5' } }],
  check: [{ element: 'path', attributes: { d: 'm4.25 10.25 3.75 3.75 7.75-8' } }],
  chevron: [{ element: 'path', attributes: { d: 'm7.5 4 6 6-6 6' } }],
  clock: [
    { element: 'circle', attributes: { cx: '10', cy: '10', r: '7.25' } },
    { element: 'path', attributes: { d: 'M10 5.5V10l3 2' } },
  ],
  document: [
    {
      element: 'path',
      attributes: {
        d: 'M11.25 2.75h-5.5a1.5 1.5 0 0 0-1.5 1.5v11.5a1.5 1.5 0 0 0 1.5 1.5h8.5a1.5 1.5 0 0 0 1.5-1.5v-8.5Z',
      },
    },
    { element: 'path', attributes: { d: 'M11.25 2.75v4.5h4.5M7.25 11h5.5M7.25 14h5.5' } },
  ],
  eye: [
    { element: 'path', attributes: { d: 'M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10Z' } },
    { element: 'circle', attributes: { cx: '10', cy: '10', r: '2.5' } },
  ],
  'eye-off': [
    { element: 'path', attributes: { d: 'M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10Z' } },
    { element: 'circle', attributes: { cx: '10', cy: '10', r: '2.5' } },
    { element: 'path', attributes: { d: 'm3.5 3.5 13 13' } },
  ],
  folder: [
    {
      element: 'path',
      attributes: {
        d: 'M2.75 6A1.25 1.25 0 0 1 4 4.75h3.6l1.65 2H16A1.25 1.25 0 0 1 17.25 8v7A1.25 1.25 0 0 1 16 16.25H4A1.25 1.25 0 0 1 2.75 15Z',
      },
    },
  ],
  home: [{ element: 'path', attributes: { d: 'M3.25 9 10 3.5 16.75 9M5 7.75v8.5h10v-8.5M8.5 16.25v-4h3v4' } }],
  list: [
    { element: 'path', attributes: { d: 'M8 5.75h8.25M8 10h8.25M8 14.25h8.25' } },
    {
      element: 'circle',
      attributes: { cx: '4.5', cy: '5.75', r: '1.1', fill: 'currentColor', stroke: 'none' },
    },
    {
      element: 'circle',
      attributes: { cx: '4.5', cy: '10', r: '1.1', fill: 'currentColor', stroke: 'none' },
    },
    {
      element: 'circle',
      attributes: { cx: '4.5', cy: '14.25', r: '1.1', fill: 'currentColor', stroke: 'none' },
    },
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
  people: [
    { element: 'circle', attributes: { cx: '7.5', cy: '7.5', r: '2.75' } },
    {
      element: 'path',
      attributes: { d: 'M2.75 16.25a4.75 4.75 0 0 1 9.5 0M12.5 4.9a2.75 2.75 0 0 1 0 5.2M14.25 11.75a4.75 4.75 0 0 1 3 4.5' },
    },
  ],
  person: [
    { element: 'circle', attributes: { cx: '10', cy: '7', r: '3.25' } },
    { element: 'path', attributes: { d: 'M4.25 16.75a5.75 5.75 0 0 1 11.5 0' } },
  ],
  paperclip: [
    {
      element: 'path',
      attributes: {
        d: 'M17.87 9.21l-7.66 7.66a5 5 0 0 1-7.08-7.08l7.66-7.66a3.33 3.33 0 0 1 4.72 4.72l-7.67 7.66a1.67 1.67 0 0 1-2.36-2.36l7.08-7.07',
      },
    },
  ],
  sidebar: [
    { element: 'rect', attributes: { x: '2.75', y: '3.75', width: '14.5', height: '12.5', rx: '2' } },
    { element: 'path', attributes: { d: 'M7.75 3.75v12.5' } },
  ],
  'sign-out': [
    {
      element: 'path',
      attributes: {
        d: 'M8.25 3.75H5.5A1.5 1.5 0 0 0 4 5.25v9.5a1.5 1.5 0 0 0 1.5 1.5h2.75M12.75 6.75 16 10l-3.25 3.25M16 10H8',
      },
    },
  ],
  sliders: [
    { element: 'path', attributes: { d: 'M3.25 6.25h3M9.75 6.25h7M3.25 13.75h7M13.75 13.75h3' } },
    { element: 'circle', attributes: { cx: '8', cy: '6.25', r: '1.75' } },
    { element: 'circle', attributes: { cx: '12', cy: '13.75', r: '1.75' } },
  ],
  // A sortable column's mark (issue 852): both carets on a column that is not
  // sorted, and the stylesheet quiets the one a sorted column is not running,
  // keyed by the header's own aria-sort -- so the mark cannot disagree with
  // what a reader is told.
  sort: [
    { element: 'path', attributes: { d: 'm6.5 8.25 3.5-3.5 3.5 3.5', 'data-part': 'ascending' } },
    { element: 'path', attributes: { d: 'm6.5 11.75 3.5 3.5 3.5-3.5', 'data-part': 'descending' } },
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
    // appendChild, not append: the worker and container tsconfigs pull in
    // workers-types, where a global `append` resolves to an overload taking
    // string | Response | ReadableStream. apps/web's own tsconfig sees the DOM
    // lib and typechecks clean either way, which is how this reached main.
    element.appendChild(child)
  }
  return element
}
