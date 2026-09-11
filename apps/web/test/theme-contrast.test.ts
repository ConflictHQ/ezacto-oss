import { describe, expect, it } from 'vitest'
import type { ThemeDefinition, ThemeSlot } from '../src/index.js'
import {
  assertThemeContrast,
  checkThemeContrast,
  contrastRatio,
  cssCustomProperty,
  precisionContrastRequirements,
  themeManifest,
  webAssets,
} from '../src/index.js'

const withColors = (overrides: Partial<Record<ThemeSlot, string>>): ThemeDefinition => ({
  ...themeManifest.precision,
  colors: { ...themeManifest.precision.colors, ...overrides },
})

// The rules in the shipped stylesheet that paint *text* in a palette slot, with
// the surface each one lands on. `border-color` and `background` uses are not
// here: those are the non-text role, and the lookbehind below keeps them out.
const stylesheet = webAssets.stylesheet.replace(/\/\*[\s\S]*?\*\//gu, '')
const selectorsPaintingTextWith = (slot: ThemeSlot, css = stylesheet): string[] => {
  const declaration = new RegExp(
    `(?<![-\\w])color:\\s*var\\(${cssCustomProperty(slot)}\\)\\s*(?:!important\\s*)?;`,
    'u',
  )
  return css
    .split('}')
    .filter((block) => declaration.test(block))
    .map((block) => {
      const head = block.slice(0, block.lastIndexOf('{'))
      return head
        .slice(head.lastIndexOf('{') + 1)
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .join(' ')
    })
}

// Every place the live hue is read as words, and the background rule that puts
// it there. The gate is only worth its exit code if this and the requirement
// table describe the same UI, so the test walks it both ways: the stylesheet
// holds exactly these rules, and each of them has a 4.5:1 row behind it.
const liveTextRules: readonly {
  selector: string
  foreground: ThemeSlot
  background: ThemeSlot
}[] = [
  // `.auth-splash` paints `background: var(--ez-ink)`.
  { selector: '.auth-splash-copy .eyebrow', foreground: 'live', background: 'ink' },
  // The `$` toggle when money is hidden. Its base rule paints
  // `background: var(--ez-surface)`; the border keeps the live hue as an
  // indicator and only the label is certified here.
  {
    selector: ".money-toggle[aria-pressed='true']",
    foreground: 'live_text',
    background: 'surface',
  },
  // `.timesheet-status` paints `background: var(--ez-status-bg)`.
  {
    selector: '.timesheet-status [data-timesheet-rejection-reason]',
    foreground: 'live_text',
    background: 'status_bg',
  },
  // `.week-cell` paints `background: var(--ez-ground)`.
  {
    selector: '.week-cell[data-cell-state="running"] .cell-status',
    foreground: 'live_text',
    background: 'ground',
  },
  {
    selector:
      '.week-cell[data-cell-state="retry"] .cell-status, ' +
      '.week-cell[data-cell-state="conflict"] .cell-status',
    foreground: 'live_text',
    background: 'ground',
  },
]

describe('D16 theme AA contrast gate', () => {
  it('[unit] computes the WCAG ratio from relative luminance', () => {
    // The two anchors the formula has to reproduce, plus a mid-tone the
    // gamma expansion would get wrong if it were a plain divide by 255.
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 6)
    expect(contrastRatio('#16794A', '#16794A')).toBeCloseTo(1, 6)
    expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(4.478, 3)
    expect(() => contrastRatio('#FFF', '#000000')).toThrow(/invalid RGB color/u)
  })

  it('[unit] holds the shipped precision palette to its stated minimums', () => {
    const results = checkThemeContrast(themeManifest.precision)
    expect(results.map((result) => [result.name, Number(result.ratio.toFixed(2))])).toEqual([
      ['ink/ground text', 18.11],
      ['action/action-fg text', 5.43],
      ['live/ground indicator', 3.58],
      ['live/ink text', 5.06],
      ['ground/live-text button label', 5.26],
      ['live-text/ground text', 5.26],
      ['live-text/status-bg text', 4.63],
      ['live-text/surface text', 4.86],
      ['red/ground text', 5.46],
      ['red/surface text', 5.04],
      ['data/ground row action', 5.74],
      ['ink/surface control label', 16.74],
      ['ink/surface-2 text', 15.43],
      ['ink/row-hover text', 15.17],
      ['data/row-hover row action', 4.81],
    ])
    expect(results.every((result) => result.passes)).toBe(true)
    expect(() => assertThemeContrast(themeManifest.precision)).not.toThrow()
  })

  it('[unit] holds the hover tint to every colour the row keeps while hovered', () => {
    // A row hover repaints the whole row, so it is not enough for the cell text
    // to clear the tint: the actions the hover reveals are painted in `data`,
    // and the gate already answers for those against `ground`. Both surfaces a
    // row action can sit on therefore need a row, or hovering would be the one
    // state nothing measured.
    const rowHover = precisionContrastRequirements.filter(
      (requirement) => requirement.background === 'row_hover',
    )
    expect(rowHover.map((requirement) => requirement.foreground)).toEqual(['ink', 'data'])
    expect(rowHover.every((requirement) => requirement.minimum === 4.5)).toBe(true)

    // The tint is a hover affordance, so an unreadably faint one fails as a
    // near-miss rather than as an obvious bug: it has to be distinguishable
    // from the unhovered ground it replaces.
    expect(
      contrastRatio(themeManifest.precision.colors.row_hover, themeManifest.precision.colors.ground),
    ).toBeGreaterThan(1.1)
  })

  it('[unit] fails the build when a token pair drops below its minimum', () => {
    // A body-text ink lightened to the point where it is no longer readable on
    // ground: the regression the CI gate exists to catch.
    const washedOut = withColors({ ink: '#9AA0A8' })
    const [inkOnGround] = checkThemeContrast(washedOut)
    expect(inkOnGround?.passes).toBe(false)
    expect(() => assertThemeContrast(washedOut)).toThrow(/ink\/ground text: 2\.64 < 4\.5/u)
  })

  it('[unit] carries the threshold per requirement, not one bar for everything', () => {
    // AA is 4.5:1 for body text but 3:1 for large text and non-text
    // indicators, so the bar is data on each requirement. `live` is why that
    // matters and also why one row is not enough: it is the timer marker on
    // `ground`, where 3:1 is the honest bar, and it is the splash eyebrow on
    // `ink`, where the bar is 4.5:1. Both roles, both rows.
    const live = precisionContrastRequirements.filter(
      (requirement) => requirement.foreground === 'live',
    )
    expect(live.map((requirement) => [requirement.background, requirement.minimum])).toEqual([
      ['ground', 3],
      ['ink', 4.5],
    ])

    const [asIndicator] = checkThemeContrast(themeManifest.precision, [
      { name: 'live/ground', foreground: 'live', background: 'ground', minimum: 3 },
    ])
    const [asBodyText] = checkThemeContrast(themeManifest.precision, [
      { name: 'live/ground', foreground: 'live', background: 'ground', minimum: 4.5 },
    ])
    expect(asIndicator?.passes).toBe(true)
    expect(asBodyText?.passes).toBe(false)
    expect(asIndicator?.ratio).toBe(asBodyText?.ratio)
  })

  it('[unit] answers for every rule that paints text in the live hue', () => {
    // The gate reads a table, and a table can drift from the stylesheet it
    // claims to describe — which is how `live` came to be certified at 3:1
    // while it was setting `color` on prose. Pin the rules, so a new text use
    // of a 3:1 slot fails here rather than shipping under a green check.
    //
    // The scan has to see a declaration however it is written. The stylesheet
    // already carries `!important` colours, and a text rule that reached for
    // one would otherwise walk straight past this guard.
    expect(selectorsPaintingTextWith('live', '.x { color: var(--ez-live) !important; }')).toEqual([
      '.x',
    ])
    expect(selectorsPaintingTextWith('live', '.x { border-color: var(--ez-live); }')).toEqual([])

    for (const slot of ['live', 'live_text'] as const) {
      expect(selectorsPaintingTextWith(slot)).toEqual(
        liveTextRules
          .filter((rule) => rule.foreground === slot)
          .map((rule) => rule.selector),
      )
    }

    for (const rule of liveTextRules) {
      const requirement = precisionContrastRequirements.find(
        (candidate) =>
          candidate.foreground === rule.foreground && candidate.background === rule.background,
      )
      expect(requirement?.minimum, `${rule.selector} paints text`).toBe(4.5)
      expect(
        contrastRatio(
          themeManifest.precision.colors[rule.foreground],
          themeManifest.precision.colors[rule.background],
        ),
        rule.selector,
      ).toBeGreaterThanOrEqual(4.5)
    }
  })
})

describe('the two copies of the WCAG arithmetic', () => {
  it('[unit] agree, so a palette is readable by one standard and not two', async () => {
    // `scripts/check-theme-contrast.mjs` imports the shell's copy directly so
    // the CI gate needs no build step, which is why this file does not simply
    // import `@ezacto/core`'s. What duplication risks is the two disagreeing
    // about whether a palette is readable -- the shipped theme held to one and
    // an operator's palette to the other -- so they are held to each other
    // here, across the range rather than on a lucky pair.
    const { contrastRatio: shared } = await import('@ezacto/core')
    const samples = [
      '#000000', '#FFFFFF', '#1D1D1D', '#282828', '#F4F4F4', '#DB394C',
      '#16794A', '#14161A', '#676C74', '#F1B34A', '#2F5AE0', '#7F7F7F',
    ]
    for (const first of samples) {
      for (const second of samples) {
        expect(shared(first, second)).toBeCloseTo(contrastRatio(first, second), 12)
      }
    }
  })

  it('[unit] reject the same malformed input', async () => {
    const { contrastRatio: shared } = await import('@ezacto/core')
    for (const bad of ['#abc', 'red', '', '#GGGGGG']) {
      expect(() => contrastRatio(bad, '#FFFFFF')).toThrow()
      expect(() => shared(bad, '#FFFFFF')).toThrow()
    }
  })
})
