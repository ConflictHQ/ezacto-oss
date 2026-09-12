import { describe, expect, it } from 'vitest'
import {
  assertThemeContrast,
  checkThemeContrast,
  createThemeRuntime,
  resolveThemes,
  themeManifest,
  type ThemeAttributeTarget,
  type ThemeDefinition,
  type ThemePreferenceStore,
} from '../src/index.js'

class AttributeTarget implements ThemeAttributeTarget {
  readonly attributes = new Map<string, string>()

  setAttribute(name: 'data-ez-theme', value: string): void {
    this.attributes.set(name, value)
  }
}

class PreferenceStore implements ThemePreferenceStore {
  value: string | null

  constructor(initial: string | null) {
    this.value = initial
  }

  read(): string | null {
    return this.value
  }

  write(theme: string | null): void {
    this.value = theme
  }
}

const alternateTheme: ThemeDefinition = {
  ...themeManifest.precision,
  label: 'Deployment theme',
}

const testRegistry: Readonly<Record<'precision' | 'deployment', ThemeDefinition>> = {
  precision: themeManifest.precision,
  deployment: alternateTheme,
}

describe('D16 Precision preference policy', () => {
  it('[e2e:theme-switch] switches the application while documents stay on the org theme', () => {
    const applicationRoot = new AttributeTarget()
    const documentRoot = new AttributeTarget()
    const preference = new PreferenceStore(null)
    const runtime = createThemeRuntime<'precision' | 'deployment'>({
      registry: testRegistry,
      policy: { orgDefaultTheme: 'precision', orgDocumentTheme: 'precision' },
      preference,
      applicationRoot,
      documentRoots: [documentRoot],
    })

    expect(runtime.start()).toEqual({ application: 'precision', document: 'precision' })
    expect(runtime.switchUserTheme('deployment')).toEqual({
      application: 'deployment',
      document: 'precision',
    })
    expect(preference.value).toBe('deployment')
    expect(applicationRoot.attributes.get('data-ez-theme')).toBe('deployment')
    expect(documentRoot.attributes.get('data-ez-theme')).toBe('precision')
  })

  it('[unit] ignores a stale stored preference and validates organization policy', () => {
    expect(
      resolveThemes(testRegistry, {
        orgDefaultTheme: 'precision',
        orgDocumentTheme: 'deployment',
      }, 'removed-theme'),
    ).toEqual({ application: 'precision', document: 'deployment' })

    expect(() =>
      resolveThemes(testRegistry, {
        orgDefaultTheme: 'missing' as 'precision',
        orgDocumentTheme: 'precision',
      }, null),
    ).toThrow('organization default theme is not available: missing')
  })

  it('[unit] passes the Precision AA contrast gate', () => {
    const results = checkThemeContrast(themeManifest.precision)
    expect(results.map(({ name, minimum, passes }) => ({ name, minimum, passes }))).toEqual([
      { name: 'ink/ground text', minimum: 4.5, passes: true },
      { name: 'action/action-fg text', minimum: 4.5, passes: true },
      { name: 'live/ground indicator', minimum: 3, passes: true },
      { name: 'live/ink text', minimum: 4.5, passes: true },
      { name: 'ground/live-text button label', minimum: 4.5, passes: true },
      { name: 'live-text/ground text', minimum: 4.5, passes: true },
      { name: 'live-text/status-bg text', minimum: 4.5, passes: true },
      { name: 'live-text/surface text', minimum: 4.5, passes: true },
      { name: 'red/ground text', minimum: 4.5, passes: true },
      { name: 'red/surface text', minimum: 4.5, passes: true },
      { name: 'data/ground row action', minimum: 4.5, passes: true },
      { name: 'ink/surface control label', minimum: 4.5, passes: true },
      { name: 'ink/surface-2 text', minimum: 4.5, passes: true },
      { name: 'ink/row-hover text', minimum: 4.5, passes: true },
      { name: 'data/row-hover row action', minimum: 4.5, passes: true },
      { name: 'ink/money totals figure', minimum: 4.5, passes: true },
      { name: 'ink-2/money totals label', minimum: 4.5, passes: true },
    ])
    expect(results.map((result) => result.ratio)).toEqual([
      expect.closeTo(18.11, 2),
      expect.closeTo(5.43, 2),
      expect.closeTo(3.58, 2),
      expect.closeTo(5.06, 2),
      expect.closeTo(5.26, 2),
      expect.closeTo(5.26, 2),
      expect.closeTo(4.63, 2),
      expect.closeTo(4.86, 2),
      expect.closeTo(5.46, 2),
      expect.closeTo(5.04, 2),
      expect.closeTo(5.74, 2),
      expect.closeTo(16.74, 2),
      expect.closeTo(15.43, 2),
      expect.closeTo(15.17, 2),
      expect.closeTo(4.81, 2),
      expect.closeTo(17, 2),
      expect.closeTo(10.24, 2),
    ])
    expect(() => assertThemeContrast(themeManifest.precision)).not.toThrow()
  })
})
