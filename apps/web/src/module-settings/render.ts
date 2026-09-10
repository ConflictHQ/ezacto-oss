export const renderModuleSettingsPage = (view?: string): string => `
  <main class="app-content module-settings-workspace page--document" data-module-settings-page${view === 'settings-company' ? '' : ' hidden'}>
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
    <section class="settings-section" data-settings-section="backup" aria-labelledby="settings-backup-title">
      <header><h2 id="settings-backup-title">Backups</h2>
      <p>When this instance last exported itself, and whether the last attempt worked. A backup nobody looks at is a backup nobody knows is broken, which is the state it stays in until it is needed.</p></header>
      <p class="form-result" data-settings-backup-status role="status" aria-live="polite">Loading backup status…</p>
      <p class="form-result settings-backup-alarm" data-settings-backup-alarm role="status" aria-live="polite" hidden></p>
      <dl class="settings-facts" data-settings-backup-facts hidden></dl>
      <div class="settings-table" data-settings-backup-runs hidden></div>
    </section>
    <section class="settings-section" data-settings-section="brand" aria-labelledby="settings-brand-title">
      <header><h2 id="settings-brand-title">Brand</h2>
      <p>The marks this instance draws on itself and on the documents it sends. An uploaded mark replaces the one configured at deploy time; remove it and the deployment's own setting comes back. PNG, JPEG or WebP up to 512&nbsp;KB &mdash; SVG is not accepted, because it can carry script and these files are served to anyone who opens the sign-in page.</p></header>
      <p class="form-result" data-settings-brand-status role="status" aria-live="polite">Loading brand assets…</p>
      <div class="settings-brand-slots" data-settings-brand-slots hidden></div>
      <p class="form-result" data-settings-brand-result role="status" aria-live="polite"></p>
    </section>
    <section class="settings-section" data-settings-section="sso" aria-labelledby="settings-sso-title">
      <header><h2 id="settings-sso-title">SSO provisioning domains</h2>
      <p>Email domains this instance will create an account from on first single sign-on. A domain provisions nobody until its DNS challenge verifies, which is what proves this instance is entitled to the domain.</p></header>
      <p class="form-result" data-settings-sso-status role="status" aria-live="polite">Loading SSO provisioning domains…</p>
      <div class="settings-table" data-settings-sso-domains hidden></div>
      <form class="settings-form" data-sso-domain-form hidden>
        <label>Domain
          <input name="domain" type="text" autocomplete="off" spellcheck="false" placeholder="example.com" data-sso-domain-input required>
        </label>
        <button class="primary-action" type="submit" data-sso-domain-submit>Add domain</button>
      </form>
      <p class="form-result" data-sso-domain-result role="status" aria-live="polite"></p>
    </section>
  </main>
  <main class="app-content module-settings-workspace page--document" data-settings-user-page${view === 'settings-user' ? '' : ' hidden'}>
    <header class="context-row module-settings-header">
      <div><p class="eyebrow">Settings</p><h1>You</h1></div>
    </header>
    ${renderSettingsTabs('user')}
    <p class="module-settings-intro">Your own account. Everything here is yours alone; the company settings beside it apply to everyone.</p>
    <p class="form-result module-settings-status" data-settings-user-status role="status" aria-live="polite">Loading your account…</p>
    <dl class="settings-facts" data-settings-user-facts hidden></dl>
    <section class="settings-density" aria-labelledby="settings-density-heading">
      <h2 id="settings-density-heading">Row density</h2>
      <p class="hint">How much of a table fits on your screen. This is yours and this machine's — nobody else's view changes, and the company setting beside it is unaffected.</p>
      <div class="settings-density-choice" role="group" aria-label="Row density">
        <button type="button" data-density-choice="comfortable" aria-pressed="true">Comfortable</button>
        <button type="button" data-density-choice="compact" aria-pressed="false">Compact</button>
      </div>
    </section>
  </main>`

/**
 * Two destinations, not one page with a toggle: which of them you are looking
 * at is a fact worth having in the URL, and the company half is not everyone's
 * to see. The strip is hidden for a viewer with no company access, so it never
 * offers a tab that answers 403.
 */
const renderSettingsTabs = (current: 'user' | 'company' | 'activity'): string =>
  `<nav class="tabstrip settings-tabs" aria-label="Settings" data-settings-tabs>` +
  `<a href="/settings/user"${current === 'user' ? ' aria-current="page"' : ''}>You</a>` +
  `<a href="/settings/company" data-settings-company-tab hidden${current === 'company' ? ' aria-current="page"' : ''}>Company</a>` +
  // Behind the same gate as Company. The log names who did what, which is not
  // everyone's to read, and a tab that answers 403 is worse than no tab.
  `<a href="/settings/activity" data-settings-activity-tab hidden${current === 'activity' ? ' aria-current="page"' : ''}>Activity</a>` +
  `</nav>`

/**
 * The activity log.
 *
 * Read-only by construction: the table it draws from is append-only at the
 * database level, and retention rolls whole years into their own partition
 * rather than deleting rows, so nothing on this screen can remove anything.
 * Filters narrow what is shown; they never narrow what is kept.
 */
export const renderActivityLogPage = (view?: string): string => `
  <main class="app-content module-settings-workspace page--grid" data-activity-log-page${view === 'settings-activity' ? '' : ' hidden'}>
    <header class="context-row module-settings-header">
      <div><p class="eyebrow">Settings</p><h1>Activity</h1></div>
    </header>
    ${renderSettingsTabs('activity')}
    <p class="module-settings-intro">What happened in this instance, newest first. The log is append-only: filtering changes what you are shown, never what is kept.</p>
    <div class="activity-log-toolbar">
      <label for="ez-activity-from">From
        <input id="ez-activity-from" type="date" data-activity-from>
      </label>
      <label for="ez-activity-to">To
        <input id="ez-activity-to" type="date" data-activity-to>
      </label>
      <label for="ez-activity-type">Event
        <select id="ez-activity-type" data-activity-type>
          <option value="" selected>Every event</option>
        </select>
      </label>
    </div>
    <p class="form-result module-settings-status" data-activity-log-status role="status" aria-live="polite">Loading activity…</p>
    <div data-activity-log-list></div>
  </main>

`
