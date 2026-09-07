export const renderModuleSettingsPage = (view?: string): string => `
  <main class="app-content module-settings-workspace" data-module-settings-page${view === 'settings-company' ? '' : ' hidden'}>
    <header class="context-row module-settings-header">
      <div><p class="eyebrow">Settings</p><h1>Company</h1></div>
    </header>
    ${renderSettingsTabs('company')}
    <p class="module-settings-intro">Enable or disable modules for your organization. Disabling a module hides its navigation and returns 404 from its API endpoints. Existing data (submissions, approvals, audit history) is preserved.</p>
    <p class="form-result module-settings-status" data-module-settings-status role="status" aria-live="polite">Loading modules…</p>
    <section class="module-settings-list" data-module-settings-list aria-label="Modules"></section>
  </main>
  <main class="app-content module-settings-workspace" data-settings-user-page${view === 'settings-user' ? '' : ' hidden'}>
    <header class="context-row module-settings-header">
      <div><p class="eyebrow">Settings</p><h1>You</h1></div>
    </header>
    ${renderSettingsTabs('user')}
    <p class="module-settings-intro">Your own account. Everything here is yours alone; the company settings beside it apply to everyone.</p>
    <p class="form-result module-settings-status" data-settings-user-status role="status" aria-live="polite">Loading your account…</p>
    <dl class="settings-facts" data-settings-user-facts hidden></dl>
  </main>`

/**
 * Two destinations, not one page with a toggle: which of them you are looking
 * at is a fact worth having in the URL, and the company half is not everyone's
 * to see. The strip is hidden for a viewer with no company access, so it never
 * offers a tab that answers 403.
 */
const renderSettingsTabs = (current: 'user' | 'company'): string =>
  `<nav class="tabstrip settings-tabs" aria-label="Settings" data-settings-tabs>` +
  `<a href="/settings/user"${current === 'user' ? ' aria-current="page"' : ''}>You</a>` +
  `<a href="/settings/company" data-settings-company-tab hidden${current === 'company' ? ' aria-current="page"' : ''}>Company</a>` +
  `</nav>`
