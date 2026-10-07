import { describe, expect, it } from 'vitest'
import {
  createNavLayoutRuntime,
  createSidebarRuntime,
  readDisplayPreferences,
  resolveNavLayout,
  resolveSidebarState,
  type NavLayoutTarget,
  type ThemePreferenceStore,
} from '../src/index.js'

class Root implements NavLayoutTarget {
  readonly attributes = new Map<string, string>()

  setAttribute(name: 'data-ez-nav' | 'data-ez-sidebar', value: string): void {
    this.attributes.set(name, value)
  }
}

class Store implements ThemePreferenceStore {
  constructor(public value: string | null) {}

  read(): string | null {
    return this.value
  }

  write(value: string | null): void {
    this.value = value
  }
}

describe('where the navigation sits (the 2026-10 reskin)', () => {
  it('[unit] defaults to the sidebar, and reads anything else it does not know as the sidebar', () => {
    expect(resolveNavLayout('topbar')).toBe('topbar')
    for (const stored of [null, undefined, '', 'sidebar', 'TOPBAR', 'bottom', '"><b>']) {
      expect(resolveNavLayout(stored)).toBe('sidebar')
    }
    expect(resolveSidebarState('collapsed')).toBe('collapsed')
    for (const stored of [null, '', 'expanded', 'half', '<i>']) {
      expect(resolveSidebarState(stored)).toBe('expanded')
    }
  })

  it('[unit] writes the layout to the root and keeps only a departure from the default', () => {
    const root = new Root()
    const store = new Store(null)
    const layout = createNavLayoutRuntime({ store, target: root })

    expect(layout.start()).toBe('sidebar')
    expect(root.attributes.get('data-ez-nav')).toBe('sidebar')

    expect(layout.set('topbar')).toBe('topbar')
    expect(store.value).toBe('topbar')
    expect(root.attributes.get('data-ez-nav')).toBe('topbar')

    // Back to the default is the absence of a choice, so a default that
    // changes later reaches everybody who never made one.
    expect(layout.set('sidebar')).toBe('sidebar')
    expect(store.value).toBeNull()
    expect(root.attributes.get('data-ez-nav')).toBe('sidebar')
  })

  it('[unit] remembers a narrowed sidebar the same way', () => {
    const root = new Root()
    const store = new Store('collapsed')
    const sidebar = createSidebarRuntime({ store, target: root })

    expect(sidebar.start()).toBe('collapsed')
    expect(root.attributes.get('data-ez-sidebar')).toBe('collapsed')
    expect(sidebar.set('expanded')).toBe('expanded')
    expect(store.value).toBeNull()
    expect(root.attributes.get('data-ez-sidebar')).toBe('expanded')
  })

  it('[security] reads all three display cookies, and never one of them as itself', () => {
    expect(
      readDisplayPreferences('ezacto_nav=topbar; ezacto_sidebar=collapsed; ezacto_scheme=dark'),
    ).toEqual({ colorScheme: 'dark', navLayout: 'topbar', sidebar: 'collapsed' })
    expect(readDisplayPreferences(null)).toEqual({
      colorScheme: 'system',
      navLayout: 'sidebar',
      sidebar: 'expanded',
    })
    expect(
      readDisplayPreferences('ezacto_nav="><script>; ezacto_sidebar=\'onload=x'),
    ).toEqual({ colorScheme: 'system', navLayout: 'sidebar', sidebar: 'expanded' })
  })
})
