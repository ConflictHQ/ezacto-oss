/** @vitest-environment happy-dom */
import { URL as NodeURL } from 'node:url'
import { readFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { collectControlStyles } from '../e2e/control-style-audit.js'
import { controlAuditScreens } from '../e2e/control-style-screens.js'

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})
it.each([
  {
    html: '<a href="/">Owned</a>',
    font: 'Google Sans Flex',
    color: 'rgb(0, 0, 238)',
    border: 'none',
    reasons: ['ua-link-color'],
  },
  {
    html: '<button>Owned</button>',
    font: 'Arial',
    color: 'rgb(0, 0, 0)',
    border: 'outset',
    reasons: ['non-theme-font', 'ua-button-edge'],
  },
  {
    html: '<input>',
    font: 'Times New Roman',
    color: 'rgb(0, 0, 0)',
    border: 'inset',
    reasons: ['non-theme-font', 'ua-field-edge'],
  },
  {
    html: '<table><tbody></tbody></table>',
    font: 'Google Sans Flex',
    color: 'rgb(26, 26, 46)',
    border: 'none',
    reasons: ['ua-table-spacing'],
  },
  {
    html: '<button>Owned</button>',
    font: 'Google Sans Flex',
    color: 'rgb(26, 26, 46)',
    border: 'solid',
    reasons: [],
  },
])(
  'detects the actual default signature without mounting a shell: $html',
  (fixture) => {
    document.body.innerHTML = fixture.html
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 100,
      height: 44,
      top: 0,
      left: 0,
      right: 100,
      bottom: 44,
      toJSON: () => ({}),
    })
    vi.spyOn(window, 'getComputedStyle').mockImplementation((node) =>
      node === document.documentElement
        ? ({
            getPropertyValue: (name: string) =>
              name === '--ez-font-body' ? 'Google Sans Flex' : '',
          } as unknown as CSSStyleDeclaration)
        : ({
            fontFamily: fixture.font,
            color: fixture.color,
            borderTopStyle: fixture.border,
            borderCollapse: 'separate',
            borderSpacing: '2px',
          } as CSSStyleDeclaration),
    )
    expect(collectControlStyles()[0]?.reasons).toEqual(fixture.reasons)
  },
)
it('never inventories text, hrefs, form values, hidden controls or credentials', () => {
  document.body.innerHTML =
    '<a href="/private?token=SECRET">SECRET</a><input value="SECRET"><button hidden>SECRET</button>'
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    width: 100,
    height: 44,
    top: 0,
    left: 0,
    right: 100,
    bottom: 44,
    toJSON: () => ({}),
  })
  const result = collectControlStyles()
  expect(result).toHaveLength(2)
  expect(JSON.stringify(result)).not.toContain('SECRET')
})
it('keeps the browser audit manifest complete as native shell views are added', async () => {
  const renderer = await readFile(
    new NodeURL('../src/shell/render.ts', import.meta.url),
    'utf8',
  )
  const union = renderer.split('readonly view?:')[1]!.split('/**')[0]!
  const views = [...union.matchAll(/'([^']+)'/g)].map((match) => match[1])
  expect(controlAuditScreens.map(([screen]) => screen).sort()).toEqual(
    views.sort(),
  )
})

it('checks the native file picker decoration independently of its themed input', () => {
  document.body.innerHTML = '<input type="file">'
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    width: 100,
    height: 44,
    top: 0,
    left: 0,
    right: 100,
    bottom: 44,
    toJSON: () => ({}),
  })
  vi.spyOn(window, 'getComputedStyle').mockImplementation((node, pseudo) =>
    node === document.documentElement
      ? ({
          getPropertyValue: () => 'Google Sans Flex',
        } as unknown as CSSStyleDeclaration)
      : ({
          fontFamily: pseudo ? 'Arial' : 'Google Sans Flex',
          color: 'rgb(0, 0, 0)',
          borderTopStyle: pseudo ? 'outset' : 'solid',
        } as CSSStyleDeclaration),
  )
  expect(collectControlStyles().map((node) => node.reasons)).toEqual([
    [],
    ['non-theme-font', 'ua-button-edge'],
  ])
})
it('detects partially reset standalone targets while preserving native checkbox geometry', () => {
  document.body.innerHTML =
    '<button>Owned</button><input type="email"><a class="primary-action" href="/">Owned</a><input type="checkbox">'
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    width: 100,
    height: 20,
    top: 0,
    left: 0,
    right: 100,
    bottom: 20,
    toJSON: () => ({}),
  })
  vi.spyOn(window, 'getComputedStyle').mockImplementation((node) =>
    node === document.documentElement
      ? ({
          getPropertyValue: () => 'Google Sans Flex',
        } as unknown as CSSStyleDeclaration)
      : ({
          fontFamily: 'Google Sans Flex',
          color: 'rgb(37, 79, 232)',
          borderTopStyle: 'solid',
          minHeight: 'auto',
        } as CSSStyleDeclaration),
  )
  expect(
    collectControlStyles({ standalone: true }).map((node) => node.reasons),
  ).toEqual([
    ['standalone-target-below-44'],
    ['standalone-target-below-44'],
    ['standalone-target-below-44'],
    [],
  ])
  expect(
    collectControlStyles().every((node) => node.reasons.length === 0),
  ).toBe(true)
})
