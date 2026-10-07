import { describe, expect, it } from 'vitest'
import type { ThemeDefinition, ThemeSlot } from '../src/index.js'
import {
  assertThemeContrast,
  checkThemeContrast,
  contrastRatio,
  cssCustomProperty,
  precisionContrastRequirements,
  themeManifest,
  themeSchemes,
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
  // `.invoice-state` paints `background: var(--ez-status-bg)`, and the paid
  // tone keeps that band rather than mixing a tint of its own.
  {
    selector: ".invoice-state[data-tone='paid']",
    foreground: 'live_text',
    background: 'status_bg',
  },
  // `.week-cell` paints `background: var(--ez-ground)`.
  {
    selector: '.week-cell[data-cell-state="running"] .cell-status',
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
      ['ink/ground text', 17.06],
      ['muted/ground text', 5.78],
      ['muted/surface text', 5.53],
      ['action/action-fg text', 6.25],
      ['live/ground indicator', 5.02],
      ['band-ink/band text', 17.06],
      ['blue-light/band text', 11.44],
      ['ground/red button label', 6.47],
      ['live-text/ground text', 5.02],
      ['live-text/status-bg text', 4.58],
      ['status-fg/status-bg text', 5.27],
      ['data/surface text', 5.98],
      ['red/ground text', 6.47],
      ['red/surface text', 6.19],
      ['red/status-bg text', 5.91],
      ['amber/ground text', 5.02],
      ['data/ground row action', 6.25],
      ['ink/surface control label', 16.32],
      ['ink/surface-2 text', 15.5],
      ['ink/orange-tint pressed label', 15.38],
      ['ink/row-hover text', 15.38],
      ['data/row-hover row action', 5.63],
      ['ink/money totals figure', 16.01],
      ['ink-2/money totals label', 9.68],
    ])
    expect(results.every((result) => result.passes)).toBe(true)
    expect(() => assertThemeContrast(themeManifest.precision)).not.toThrow()
  })

  it('[unit] holds the dark scheme to the same minimums, pair for pair', () => {
    // The dark scheme paints the same rules, so it owes every pair the light one
    // does -- not a lighter list for the scheme nobody looks at in review.
    const schemes = themeSchemes(themeManifest.precision)
    expect(schemes.map((entry) => entry.scheme)).toEqual(['light', 'dark', 'dim'])
    const dark = schemes[1]!.theme
    const results = checkThemeContrast(dark)
    expect(results.map((result) => [result.name, Number(result.ratio.toFixed(2))])).toEqual([
      ['ink/ground text', 17.6],
      ['muted/ground text', 6.01],
      ['muted/surface text', 5.55],
      ['action/action-fg text', 4.95],
      ['live/ground indicator', 8.28],
      ['band-ink/band text', 18.45],
      ['blue-light/band text', 9.93],
      ['ground/red button label', 6.82],
      ['live-text/ground text', 10.83],
      ['live-text/status-bg text', 9.04],
      ['status-fg/status-bg text', 6.8],
      ['data/surface text', 5.58],
      ['red/ground text', 6.82],
      ['red/surface text', 6.3],
      ['red/status-bg text', 5.69],
      ['amber/ground text', 11.31],
      ['data/ground row action', 6.04],
      ['ink/surface control label', 16.25],
      ['ink/surface-2 text', 15.06],
      ['ink/orange-tint pressed label', 13.99],
      ['ink/row-hover text', 15.1],
      ['data/row-hover row action', 5.18],
      ['ink/money totals figure', 16.13],
      ['ink-2/money totals label', 11.74],
    ])
    expect(results.every((result) => result.passes)).toBe(true)
    expect(() => assertThemeContrast(dark)).not.toThrow()
  })

  it('[unit] holds the dim scheme to the same minimums, pair for pair', () => {
    const dim = themeSchemes(themeManifest.precision).find((entry) => entry.scheme === 'dim')!.theme
    const results = checkThemeContrast(dim)
    expect(results.map((result) => [result.name, Number(result.ratio.toFixed(2))])).toEqual([
      ['ink/ground text', 11.91],
      ['muted/ground text', 6.61],
      ['muted/surface text', 5.88],
      ['action/action-fg text', 4.95],
      ['live/ground indicator', 7.6],
      ['band-ink/band text', 14.18],
      ['blue-light/band text', 7.91],
      ['ground/red button label', 6.97],
      ['live-text/ground text', 9.43],
      ['live-text/status-bg text', 7.19],
      ['status-fg/status-bg text', 6.19],
      ['data/surface text', 5.26],
      ['red/ground text', 6.97],
      ['red/surface text', 6.2],
      ['red/status-bg text', 5.32],
      ['amber/ground text', 9.18],
      ['data/ground row action', 5.92],
      ['ink/surface control label', 10.59],
      ['ink/surface-2 text', 9.67],
      ['ink/orange-tint pressed label', 9.54],
      ['ink/row-hover text', 9.54],
      ['data/row-hover row action', 4.75],
      ['ink/money totals figure', 11.12],
      ['ink-2/money totals label', 8.98],
    ])
    expect(results.every((result) => result.passes)).toBe(true)
  })

  it('[unit] keeps the bands dark in every scheme', () => {
    // The point of `band`: the top bar and the sign-in splash were `ink`, which
    // a dark scheme makes light, so they turned into white strips with dark
    // text. A band that reads as light -- closer to white than to black -- is
    // that regression, in either scheme. In dark it also sits below the ground,
    // so the chrome stays the deepest layer the way it is in light.
    for (const { scheme, theme } of themeSchemes(themeManifest.precision)) {
      const { band, ground } = theme.colors
      expect(contrastRatio(band, '#FFFFFF'), scheme).toBeGreaterThan(contrastRatio(band, '#000000'))
      if (scheme !== 'light') {
        expect(contrastRatio(band, '#FFFFFF'), scheme).toBeGreaterThan(
          contrastRatio(ground, '#FFFFFF'),
        )
      }
    }
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
    // matters: it is only ever the timer's dot, border and inset rule on
    // `ground`, where 3:1 is the honest bar, and the words it would need are
    // `live_text`'s.
    const live = precisionContrastRequirements.filter(
      (requirement) => requirement.foreground === 'live',
    )
    expect(live.map((requirement) => [requirement.background, requirement.minimum])).toEqual([
      ['ground', 3],
    ])

    // The design's own running green, #16A34A, is the case the split exists
    // for: bright enough to mark a running row, too light to be read as words.
    // The shipped green clears both bars; this one clears only the first.
    const designGreen = withColors({ live: '#16A34A' })
    const [asIndicator] = checkThemeContrast(designGreen, [
      { name: 'live/ground', foreground: 'live', background: 'ground', minimum: 3 },
    ])
    const [asBodyText] = checkThemeContrast(designGreen, [
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

  it('[unit] keeps the action colour a fill and writes blue words in data', () => {
    // `action` and `data` are the same blue in the shipped theme, which is
    // exactly what makes one easy to reach for in place of the other. They
    // part in a dark palette: a fill under white text has to be a darker blue
    // than one that is read on a near-black ground. So `action` fills and
    // `data` is the blue that is read, and a text rule in `action` -- right
    // here, unreadable on the first dark instance -- fails now.
    expect(selectorsPaintingTextWith('action', '.x { color: var(--ez-action); }')).toEqual(['.x'])
    expect(selectorsPaintingTextWith('action')).toEqual([])
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
