/** @vitest-environment happy-dom */

import { describe, expect, it } from 'vitest'
import { icon, iconMarkup, iconNames, type IconName } from '../src/components/icons.js'

const parse = (markup: string): SVGSVGElement => {
  const host = document.createElement('div')
  host.innerHTML = markup
  const element = host.firstElementChild
  if (element === null) throw new Error('icon markup produced no element')
  return element as unknown as SVGSVGElement
}

const attributeMap = (element: Element): Record<string, string> =>
  Object.fromEntries([...element.attributes].map((attribute) => [attribute.name, attribute.value]))

describe('icon set', () => {
  it('[unit] carries the seven icons the design system names', () => {
    expect(iconNames).toEqual([
      'calendar',
      'chevron',
      'clock',
      'magnifier',
      'overflow',
      'padlock',
      'paperclip',
    ])
  })

  it('[unit] draws every icon in currentColor and nothing else', () => {
    // An icon that hard-codes a hex is an icon that is wrong in one of the two
    // themes, and the contrast gate cannot see it because it is not a token.
    for (const name of iconNames) {
      const element = parse(iconMarkup(name))
      const painted = [element, ...element.querySelectorAll('*')]
        .flatMap((shape) => [...shape.attributes])
        .filter((attribute) => attribute.name === 'fill' || attribute.name === 'stroke')
        .map((attribute) => attribute.value)
      expect(painted.every((value) => value === 'currentColor' || value === 'none'), name).toBe(
        true,
      )
      expect(element.getAttribute('viewBox'), name).toBe('0 0 20 20')
      expect(element.getAttribute('class'), name).toBe('ez-icon')
      expect(element.children.length, name).toBeGreaterThan(0)
    }
  })

  it('[unit] hides an icon that only decorates text already saying the same thing', () => {
    const element = parse(iconMarkup('paperclip'))
    expect(element.getAttribute('aria-hidden')).toBe('true')
    expect(element.getAttribute('focusable')).toBe('false')
    expect(element.hasAttribute('role')).toBe(false)
    expect(element.hasAttribute('aria-label')).toBe(false)
  })

  it('[unit] names an icon that is the whole message, and only that one', () => {
    // The common way to get this wrong is to name everything, which makes a
    // reader announce "image" beside every row action. A named icon is
    // therefore never also hidden — the two are exclusive, not additive.
    const element = parse(iconMarkup('padlock', { label: 'Locked' }))
    expect(element.getAttribute('role')).toBe('img')
    expect(element.getAttribute('aria-label')).toBe('Locked')
    expect(element.hasAttribute('aria-hidden')).toBe(false)
  })

  it('[unit] escapes a label into the markup renderer', () => {
    const markup = iconMarkup('padlock', { label: 'Locked "by" <policy>' })
    expect(markup).toContain('aria-label="Locked &quot;by&quot; &lt;policy&gt;"')
    expect(parse(markup).getAttribute('aria-label')).toBe('Locked "by" <policy>')
  })

  it('[unit] turns the one chevron rather than drawing four', () => {
    expect(parse(iconMarkup('chevron')).hasAttribute('data-direction')).toBe(false)
    expect(parse(iconMarkup('chevron', { direction: 'left' })).getAttribute('data-direction')).toBe(
      'left',
    )
    // One path, whichever way it points: the stylesheet does the turning.
    expect(iconMarkup('chevron', { direction: 'down' }).match(/<path/gu)?.length).toBe(1)
  })

  it('[unit] renders the same icon as markup and as DOM', () => {
    // The shell draws icons as a string and the browser draws them as nodes.
    // Two renderers over one geometry table is the only reason they cannot
    // drift; this is the assertion that says so.
    const cases: readonly [IconName, Parameters<typeof icon>[1]][] = [
      ['clock', undefined],
      ['overflow', {}],
      ['chevron', { direction: 'left' }],
      ['padlock', { label: 'Locked' }],
    ]
    for (const [name, options] of cases) {
      const built = icon(name, options)
      const written = parse(iconMarkup(name, options))
      expect(attributeMap(built as unknown as Element), name).toEqual(attributeMap(written))
      expect(
        [...built.children].map((shape) => [shape.tagName.toLowerCase(), attributeMap(shape)]),
        name,
      ).toEqual(
        [...written.children].map((shape) => [shape.tagName.toLowerCase(), attributeMap(shape)]),
      )
    }
  })

  it('[unit] builds DOM icons in the SVG namespace', () => {
    // `document.createElement('svg')` yields an HTML element that renders
    // nothing at all, and the difference is invisible in a snapshot of markup.
    const element = icon('magnifier')
    expect(element.namespaceURI).toBe('http://www.w3.org/2000/svg')
    for (const shape of element.children)
      expect(shape.namespaceURI).toBe('http://www.w3.org/2000/svg')
  })
})
