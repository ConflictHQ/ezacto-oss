/**
 * The operator's module switches as the shell sees them (issue 1254).
 *
 * The server renders `data-<module>-unavailable` on the page for each module the
 * operator switched off, available before cached identity resumes. This is the
 * one place the browser reads it; the API refuses the same calls on its own.
 */
export type OperatorModule = 'sso' | 'backups' | 'invoices' | 'accounting'

export const moduleAvailable = (module: OperatorModule): boolean =>
  !document.documentElement.hasAttribute(`data-${module}-unavailable`)

/** The company settings sections each module owns; a hidden module's sections are withdrawn. */
export const SETTINGS_SECTION_MODULES: Readonly<Record<string, OperatorModule>> = {
  sso: 'sso',
  backup: 'backups',
  integrations: 'accounting',
  invoices: 'invoices',
  reminders: 'invoices',
}

/**
 * Marks the sections of every switched-off module unavailable and withdraws
 * their links from the strip, so the page never lands on one and no request
 * is made for it. Safe to call again. Answers whether it withdrew anything.
 */
export const withdrawUnavailableSettingsSections = (): boolean => {
  let withdrew = false
  for (const [section, module] of Object.entries(SETTINGS_SECTION_MODULES)) {
    if (moduleAvailable(module)) continue
    for (const element of document.querySelectorAll<HTMLElement>(
      `[data-settings-section="${section}"]`,
    )) {
      element.setAttribute('data-settings-unavailable', '')
      withdrew = true
    }
    for (const link of document.querySelectorAll<HTMLElement>(
      `[data-settings-section-link="${section}"]`,
    )) {
      link.hidden = true
    }
  }
  return withdrew
}
