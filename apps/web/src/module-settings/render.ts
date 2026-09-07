export const renderModuleSettingsPage = (view?: string): string => `
  <main class="app-content module-settings-workspace" data-module-settings-page${view === 'settings-company' ? '' : ' hidden'}>
    <header class="context-row module-settings-header">
      <div><p class="eyebrow">Settings</p><h1>Company</h1></div>
    </header>
    ${renderSettingsTabs('company')}
    <p class="module-settings-intro">How this instance is configured. Everything here applies to everyone in the organization.</p>
    <section class="settings-section" data-settings-section="modules" aria-labelledby="settings-modules-title">
      <header><h2 id="settings-modules-title">Modules</h2>
      <p>Enable or disable modules for your organization. Disabling a module hides its navigation and returns 404 from its API endpoints. Existing data (submissions, approvals, audit history) is preserved.</p></header>
      <p class="form-result module-settings-status" data-module-settings-status role="status" aria-live="polite">Loading modules…</p>
      <section class="module-settings-list" data-module-settings-list aria-label="Modules"></section>
    </section>
    <section class="settings-section" data-settings-section="time" aria-labelledby="settings-time-title">
      <header><h2 id="settings-time-title">Time tracking</h2>
      <p>How the week grid reads and what a time entry has to say. The notes policy is enforced on every entry, including ones the API writes.</p></header>
      <p class="form-result" data-settings-time-status role="status" aria-live="polite">Loading time tracking settings…</p>
      <dl class="settings-facts" data-settings-time-facts hidden></dl>
      <form class="settings-form" data-note-settings-form hidden>
        <label class="settings-toggle"><input name="required" type="checkbox" data-note-settings-required>Require a note on every time entry</label>
        <label>Minimum note length
          <input name="minimum_length" type="number" min="0" step="1" inputmode="numeric" data-note-settings-minimum required>
        </label>
        <button class="primary-action" type="submit" data-note-settings-submit>Save notes policy</button>
      </form>
      <p class="form-result" data-note-settings-result role="status" aria-live="polite"></p>
    </section>
    <section class="settings-section" data-settings-section="email" aria-labelledby="settings-email-title">
      <header><h2 id="settings-email-title">Email delivery</h2>
      <p>Who this instance sends as, and how that mail has been landing. Transport credentials stay in the deployment; what is shown here is the state they produce.</p></header>
      <p class="form-result" data-settings-email-status role="status" aria-live="polite">Loading email delivery…</p>
      <div class="settings-table" data-settings-sender-identities hidden></div>
      <dl class="settings-facts" data-settings-email-reputation hidden></dl>
    </section>
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
