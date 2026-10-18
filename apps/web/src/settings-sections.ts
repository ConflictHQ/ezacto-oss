/**
 * The company settings page, one section at a time.
 *
 * Ten sections shipped as one scroll, and an operator looking for the
 * accounting connection scrolled past the module toggles, the sign-in methods,
 * the time policy, the mail senders and the backups to reach it (issue 800).
 * The sections stay in the document -- every controller finds its elements by
 * attribute at construction and would break if they came and went -- and only
 * one is shown. Which one is a fact worth having in the URL, so it lives in the
 * hash: a section can be linked, and the browser's back button works.
 */

export interface SettingsSection {
  readonly id: string
  readonly label: string
}

export const COMPANY_SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: 'modules', label: 'Modules' },
  { id: 'sign-in', label: 'Ways in' },
  { id: 'erasure', label: 'Erasure and retention' },
  { id: 'time', label: 'Time' },
  { id: 'email', label: 'Email' },
  { id: 'invoices', label: 'Invoices' },
  { id: 'reminders', label: 'Reminders' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'payouts', label: 'Payouts' },
  { id: 'backup', label: 'Backups' },
  { id: 'brand', label: 'Brand' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'integrations', label: 'Accounting' },
  { id: 'sso', label: 'SSO' },
]

export const DEFAULT_COMPANY_SETTINGS_SECTION = COMPANY_SETTINGS_SECTIONS[0]!.id

/**
 * The section a hash names, or the first where it names none. Unknown hashes
 * are the default rather than an error: a link to a section that was renamed
 * still opens the page.
 */
export const resolveSettingsSection = (
  hash: string | null | undefined,
  sections: readonly SettingsSection[] = COMPANY_SETTINGS_SECTIONS,
): string => {
  // A location a test has replaced with a plain object has no hash at all;
  // that is the default too, not a crash in a listener.
  const wanted = (typeof hash === 'string' ? hash : '').replace(/^#/u, '')
  return sections.some((section) => section.id === wanted)
    ? wanted
    : (sections[0]?.id ?? DEFAULT_COMPANY_SETTINGS_SECTION)
}

export interface SettingsSectionElement {
  readonly dataset: { readonly settingsSection?: string }
  hidden: boolean
}

export interface SettingsSectionLink {
  readonly dataset: { readonly settingsSectionLink?: string }
  setAttribute(name: 'aria-current', value: string): void
  removeAttribute(name: 'aria-current'): void
}

/**
 * Shows one section and marks its link current. A section hidden for its own
 * reasons -- Payouts stays hidden until Wise is configured -- keeps that: this
 * only ever hides the others, and the section's own controller decides whether
 * the chosen one is visible.
 */
export const applySettingsSection = <Section extends SettingsSectionElement>(
  current: string,
  sections: Iterable<Section>,
  links: Iterable<SettingsSectionLink>,
  ownHidden: (section: Section) => boolean = () => false,
): void => {
  for (const section of sections) {
    const id = section.dataset.settingsSection
    if (id === undefined) continue
    section.hidden = id !== current || ownHidden(section)
  }
  for (const link of links) {
    if (link.dataset.settingsSectionLink === current) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  }
}
