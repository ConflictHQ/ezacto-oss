import { describe, expect, it } from 'vitest'
import {
  assertThemeContrast,
  browserCookieStore,
  checkThemeContrast,
  COLOR_SCHEME_COOKIE,
  colorSchemeMeta,
  createColorSchemeRuntime,
  createThemeRuntime,
  readCookie,
  readDisplayPreferences,
  resolveColorScheme,
  resolveThemes,
  themeManifest,
  type ColorSchemeTarget,
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
      { name: 'muted/ground text', minimum: 4.5, passes: true },
      { name: 'muted/surface text', minimum: 4.5, passes: true },
      { name: 'action/action-fg text', minimum: 4.5, passes: true },
      { name: 'live/ground indicator', minimum: 3, passes: true },
      { name: 'band-ink/band text', minimum: 4.5, passes: true },
      { name: 'blue-light/band text', minimum: 4.5, passes: true },
      { name: 'ground/red button label', minimum: 4.5, passes: true },
      { name: 'live-text/ground text', minimum: 4.5, passes: true },
      { name: 'live-text/status-bg text', minimum: 4.5, passes: true },
      { name: 'status-fg/status-bg text', minimum: 4.5, passes: true },
      { name: 'data/surface text', minimum: 4.5, passes: true },
      { name: 'red/ground text', minimum: 4.5, passes: true },
      { name: 'red/surface text', minimum: 4.5, passes: true },
      { name: 'red/status-bg text', minimum: 4.5, passes: true },
      { name: 'amber/ground text', minimum: 4.5, passes: true },
      { name: 'data/ground row action', minimum: 4.5, passes: true },
      { name: 'ink/surface control label', minimum: 4.5, passes: true },
      { name: 'ink/surface-2 text', minimum: 4.5, passes: true },
      { name: 'ink/orange-tint pressed label', minimum: 4.5, passes: true },
      { name: 'ink/row-hover text', minimum: 4.5, passes: true },
      { name: 'data/row-hover row action', minimum: 4.5, passes: true },
      { name: 'ink/money totals figure', minimum: 4.5, passes: true },
      { name: 'ink-2/money totals label', minimum: 4.5, passes: true },
    ])
    expect(results.map((result) => result.ratio)).toEqual([
      expect.closeTo(17.06, 2),
      expect.closeTo(5.78, 2),
      expect.closeTo(5.53, 2),
      expect.closeTo(6.25, 2),
      expect.closeTo(5.02, 2),
      expect.closeTo(17.06, 2),
      expect.closeTo(11.44, 2),
      expect.closeTo(6.47, 2),
      expect.closeTo(5.02, 2),
      expect.closeTo(4.58, 2),
      expect.closeTo(5.27, 2),
      expect.closeTo(5.98, 2),
      expect.closeTo(6.47, 2),
      expect.closeTo(6.19, 2),
      expect.closeTo(5.91, 2),
      expect.closeTo(5.02, 2),
      expect.closeTo(6.25, 2),
      expect.closeTo(16.32, 2),
      expect.closeTo(15.5, 2),
      expect.closeTo(15.38, 2),
      expect.closeTo(15.38, 2),
      expect.closeTo(5.63, 2),
      expect.closeTo(16.01, 2),
      expect.closeTo(9.68, 2),
    ])
    expect(() => assertThemeContrast(themeManifest.precision)).not.toThrow()
  })
})

describe('light, dark, or whatever the operating system says (the 2026-10 reskin)', () => {
  class SchemeTarget implements ColorSchemeTarget {
    readonly attributes = new Map<string, string>()

    constructor(private readonly palette = false) {}

    setAttribute(name: 'data-ez-scheme', value: string): void {
      this.attributes.set(name, value)
    }

    hasAttribute(name: 'data-ez-palette'): boolean {
      return name === 'data-ez-palette' && this.palette
    }
  }

  class Meta {
    content = ''

    setAttribute(_name: 'content', value: string): void {
      this.content = value
    }
  }

  /** Enough of `document.cookie` to see what a store writes and reads back. */
  class CookieJar {
    readonly written: string[] = []
    readonly #values = new Map<string, string>()

    get cookie(): string {
      return [...this.#values].map(([name, value]) => `${name}=${value}`).join('; ')
    }

    set cookie(assignment: string) {
      this.written.push(assignment)
      const [pair = ''] = assignment.split(';')
      const separator = pair.indexOf('=')
      const name = pair.slice(0, separator)
      if (/max-age=0(?:;|$)/iu.test(assignment)) this.#values.delete(name)
      else this.#values.set(name, pair.slice(separator + 1))
    }
  }

  it('[unit] follows the system until somebody chooses, and forgets the choice for System', () => {
    const store = new PreferenceStore(null)
    const target = new SchemeTarget()
    const meta = new Meta()
    const runtime = createColorSchemeRuntime({ store, target, meta })

    expect(runtime.start()).toBe('system')
    expect(target.attributes.get('data-ez-scheme')).toBe('system')
    // The OS picks, so the canvas may be either before the stylesheet arrives.
    expect(meta.content).toBe('light dark')

    expect(runtime.set('dark')).toBe('dark')
    expect(store.value).toBe('dark')
    expect(target.attributes.get('data-ez-scheme')).toBe('dark')
    expect(meta.content).toBe('dark')

    // System is the absence of a choice: storing the word would pin a person to
    // whatever their OS said on the day they chose it.
    expect(runtime.set('system')).toBe('system')
    expect(store.value).toBeNull()
    expect(target.attributes.get('data-ez-scheme')).toBe('system')
  })

  it('[unit] reads anything it does not recognise as System', () => {
    expect(resolveColorScheme('dark')).toBe('dark')
    expect(resolveColorScheme('light')).toBe('light')
    for (const stored of [null, undefined, '', 'sepia', 'DARK', '"><script>']) {
      expect(resolveColorScheme(stored)).toBe('system')
    }
  })

  it('[unit] keeps an instance with its own palette on light under System', () => {
    // The palette was checked against the light scheme, and an OS set to dark
    // is not a request to stop wearing it; an explicit Dark still is.
    expect(colorSchemeMeta('system', true)).toBe('light')
    expect(colorSchemeMeta('dark', true)).toBe('dark')
    const meta = new Meta()
    createColorSchemeRuntime({
      store: new PreferenceStore(null),
      target: new SchemeTarget(true),
      meta,
    }).start()
    expect(meta.content).toBe('light')
  })

  it('[security] round-trips the choice through a cookie the server reads back', () => {
    const jar = new CookieJar()
    const store = browserCookieStore(jar, COLOR_SCHEME_COOKIE, true)
    store.write('dark')
    expect(store.read()).toBe('dark')
    expect(jar.written.at(-1)).toBe(
      'ezacto_scheme=dark; Path=/; SameSite=Lax; Secure; Max-Age=31536000',
    )
    // What the server sees is the same header, and it resolves the value
    // against the closed list before it reaches markup.
    expect(readDisplayPreferences(`other=1; ${jar.cookie}`)).toEqual({ colorScheme: 'dark' })
    expect(
      readDisplayPreferences('ezacto_scheme="><script>alert(1)</script>'),
    ).toEqual({ colorScheme: 'system' })

    store.write(null)
    expect(store.read()).toBeNull()
    expect(jar.written.at(-1)).toBe('ezacto_scheme=; Path=/; SameSite=Lax; Secure; Max-Age=0')
    // Plain http (a self-hosted box with no certificate) cannot set a Secure
    // cookie at all, so the flag follows the page.
    browserCookieStore(jar, COLOR_SCHEME_COOKIE, false).write('light')
    expect(jar.written.at(-1)).not.toContain('Secure')
  })

  it('[unit] finds one cookie among many, and nothing that only starts with its name', () => {
    expect(readCookie('a=1; ezacto_scheme=light; b=2', 'ezacto_scheme')).toBe('light')
    expect(readCookie('ezacto_scheme_old=dark', 'ezacto_scheme')).toBeNull()
    expect(readCookie(null, 'ezacto_scheme')).toBeNull()
  })

  it('[unit] never lets a cookie jar that throws break the shell', () => {
    const hostile = {
      get cookie(): string {
        throw new Error('SecurityError')
      },
      set cookie(_value: string) {
        throw new Error('SecurityError')
      },
    }
    const store = browserCookieStore(hostile, COLOR_SCHEME_COOKIE, true)
    expect(store.read()).toBeNull()
    expect(() => store.write('dark')).not.toThrow()
  })
})

