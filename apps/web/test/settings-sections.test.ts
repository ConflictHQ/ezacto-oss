import { describe, expect, it } from 'vitest'
import {
  COMPANY_SETTINGS_SECTIONS,
  DEFAULT_COMPANY_SETTINGS_SECTION,
  applySettingsSection,
  resolveSettingsSection,
  type SettingsSectionElement,
  type SettingsSectionLink,
} from '../src/settings-sections.js'

const section = (id: string, hidden = true): SettingsSectionElement & { id: string } => ({
  id,
  dataset: { settingsSection: id },
  hidden,
})

const link = (id: string) => {
  let current: string | null = null
  const element: SettingsSectionLink & { current(): string | null } = {
    dataset: { settingsSectionLink: id },
    setAttribute: (_name, value) => {
      current = value
    },
    removeAttribute: () => {
      current = null
    },
    current: () => current,
  }
  return element
}

describe('resolving the section from the hash (issue 800)', () => {
  it('[unit] names the section the hash names', () => {
    expect(resolveSettingsSection('#integrations')).toBe('integrations')
    expect(resolveSettingsSection('#sso')).toBe('sso')
  })

  it('[unit] an empty or unknown hash is the first section, not an error', () => {
    expect(resolveSettingsSection('')).toBe(DEFAULT_COMPANY_SETTINGS_SECTION)
    expect(resolveSettingsSection('#')).toBe(DEFAULT_COMPANY_SETTINGS_SECTION)
    expect(resolveSettingsSection('#renamed-away')).toBe(DEFAULT_COMPANY_SETTINGS_SECTION)
  })

  it('[unit] every section the page renders is one the strip can name', () => {
    const ids = COMPANY_SETTINGS_SECTIONS.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('integrations')
    expect(ids).toContain('payouts')
  })
})

describe('showing one section', () => {
  it('[unit] shows the chosen section, hides the rest, and marks its link current', () => {
    const sections = [section('modules', false), section('email'), section('integrations')]
    const links = [link('modules'), link('email'), link('integrations')]
    applySettingsSection('integrations', sections, links)
    expect(sections.map((entry) => [entry.id, entry.hidden])).toEqual([
      ['modules', true],
      ['email', true],
      ['integrations', false],
    ])
    expect(links.map((entry) => entry.current())).toEqual([null, null, 'page'])
  })

  it('[unit] a section that is unavailable on its own account stays hidden even when chosen', () => {
    const sections = [section('modules'), section('payouts')]
    applySettingsSection('payouts', sections, [], (entry) => entry.dataset.settingsSection === 'payouts')
    expect(sections.map((entry) => entry.hidden)).toEqual([true, true])
  })

  it('[unit] an element without a section id is left alone', () => {
    const stray: SettingsSectionElement = { dataset: {}, hidden: false }
    applySettingsSection('modules', [stray], [])
    expect(stray.hidden).toBe(false)
  })
})
