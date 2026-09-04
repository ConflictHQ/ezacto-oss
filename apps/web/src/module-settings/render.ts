export const renderModuleSettingsPage = (view?: string): string => `
  <main class="app-content module-settings-workspace" data-module-settings-page${view === 'module-settings' ? '' : ' hidden'}>
    <header class="context-row module-settings-header">
      <div><p class="eyebrow">Settings</p><h1>Modules</h1></div>
      <a href="/">Back to time</a>
    </header>
    <p class="module-settings-intro">Enable or disable modules for your organization. Disabling a module hides its navigation and returns 404 from its API endpoints. Existing data (submissions, approvals, audit history) is preserved.</p>
    <p class="form-result module-settings-status" data-module-settings-status role="status" aria-live="polite">Loading modules…</p>
    <section class="module-settings-list" data-module-settings-list aria-label="Modules"></section>
  </main>`
