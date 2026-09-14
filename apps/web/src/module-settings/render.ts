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
    <section class="settings-section" data-settings-section="appearance" aria-labelledby="settings-appearance-title">
      <header><h2 id="settings-appearance-title">Appearance</h2>
      <p>The colours this instance wears, for everyone who uses it. Leave them alone and it looks the way it shipped. Every palette is checked for readability before it is saved &mdash; a colour that would leave text unreadable against what sits behind it is refused, and the message says which one and why.</p></header>
      <p class="form-result" data-settings-theme-status role="status" aria-live="polite">Loading appearance&hellip;</p>
      <div class="settings-theme" data-settings-theme-slots hidden></div>
      <div class="settings-form" data-settings-theme-actions hidden>
        <button class="primary-action" type="button" data-theme-save>Save colours</button>
        <button type="button" data-theme-revert>Undo my changes</button>
        <button type="button" class="danger-action" data-theme-reset hidden>Back to the built-in theme</button>
      </div>
      <p class="form-result" data-settings-theme-result role="status" aria-live="polite"></p>
    </section>
    <section class="settings-section" data-settings-section="integrations" aria-labelledby="settings-integrations-title">
      <header><h2 id="settings-integrations-title">Accounting</h2>
      <p>Invoices raised here are copied into QuickBooks Online, and payments recorded there come back. Your client tree becomes customers and sub-customers, so a subsidiary is filed under its parent rather than beside it. Connecting is a grant over your whole book, so only an administrator can do it.</p></header>
      <p class="form-result" data-settings-quickbooks-status role="status" aria-live="polite">Loading accounting integrations…</p>
      <dl class="settings-facts" data-settings-quickbooks-facts hidden></dl>
      <div class="settings-form" data-settings-quickbooks-actions hidden>
        <button class="primary-action" type="button" data-quickbooks-connect hidden>Connect to QuickBooks</button>
        <label class="settings-toggle" data-quickbooks-payment-row hidden>
          <input type="checkbox" data-quickbooks-allow-payment>Let clients pay mirrored invoices through QuickBooks
        </label>
        <button type="button" class="danger-action" data-quickbooks-disconnect hidden>Disconnect QuickBooks</button>
      </div>
      <p class="form-result" data-settings-quickbooks-result role="status" aria-live="polite"></p>
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
    <section class="settings-payout" data-settings-payout aria-labelledby="settings-payout-heading" hidden>
      <h2 id="settings-payout-heading">Where you are paid</h2>
      <p class="hint" data-settings-payout-unconfigured hidden>Wise is not connected on this instance, so there is nowhere to send a payout yet.</p>
      <p class="form-result" data-settings-payout-status role="status" aria-live="polite">Loading your payout destination…</p>
      <div class="settings-payout-current" data-settings-payout-current hidden>
        <p data-settings-payout-summary></p>
        <p class="hint" data-settings-payout-unverified hidden>Wise has not confirmed this destination resolves. Remove it and add it again.</p>
        <button type="button" class="danger-action" data-settings-payout-remove>Remove destination</button>
      </div>
      <form data-settings-payout-form hidden>
        <p class="hint">Share the Wisetag on your Wise account — or the email address or phone number it is discoverable by. Wise keeps your bank details; this instance never sees them.</p>
        <label for="ez-settings-payout-identifier">Wisetag, email or phone<input id="ez-settings-payout-identifier" name="identifier" autocomplete="off" maxlength="255" placeholder="@yourtag" required aria-describedby="settings-payout-hint"></label>
        <p class="hint" id="settings-payout-hint">Your Wise profile has to be discoverable for this to find it. You can switch that on in Wise, under your Wisetag.</p>
        <label for="ez-settings-payout-currency">Currency<input id="ez-settings-payout-currency" name="currency" autocomplete="off" maxlength="3" minlength="3" placeholder="USD" required></label>
        <p class="form-result" data-settings-payout-result role="status" aria-live="polite"></p>
        <button class="primary-action" type="submit" data-settings-payout-submit>Save payout destination</button>
      </form>
    </section>
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
const renderSettingsTabs = (
  current: 'user' | 'company' | 'activity' | 'templates' | 'roles' | 'deliveries',
): string =>
  `<nav class="tabstrip settings-tabs" aria-label="Settings" data-settings-tabs>` +
  `<a href="/settings/user"${current === 'user' ? ' aria-current="page"' : ''}>You</a>` +
  `<a href="/settings/company" data-settings-company-tab hidden${current === 'company' ? ' aria-current="page"' : ''}>Company</a>` +
  // Behind the same gate as Company. The log names who did what, which is not
  // everyone's to read, and a tab that answers 403 is worse than no tab.
  `<a href="/settings/activity" data-settings-activity-tab hidden${current === 'activity' ? ' aria-current="page"' : ''}>Activity</a>` +
  // Behind the Company gate too: the wording a client receives is company-wide
  // configuration, and the sender identity beside it is deployment setup.
  `<a href="/settings/templates" data-settings-templates-tab hidden${current === 'templates' ? ' aria-current="page"' : ''}>Templates</a>` +
  // Behind the same gate: a role is a fact about people, and the list of them
  // is account-wide configuration rather than daily work.
  `<a href="/settings/roles" data-settings-roles-tab hidden${current === 'roles' ? ' aria-current="page"' : ''}>Roles</a>` +
  // Behind the same gate: what a client was sent, and whether it arrived, is
  // account-wide and names recipients.
  `<a href="/settings/deliveries" data-settings-deliveries-tab hidden${current === 'deliveries' ? ' aria-current="page"' : ''}>Deliveries</a>` +
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

/**
 * What was sent, and what became of it (issue 485).
 *
 * Both tables already existed as endpoints and neither had a screen, which made
 * "did that invoice reach the client" a question answerable only with an API
 * token and a terminal. That is the same shape as the retainer and recurring
 * receipts on issue 485 -- a thing an operator had to go around the product to do --
 * except it applies to every invoice rather than to one retainer.
 *
 * Two tables rather than one, because they answer different questions and fail
 * differently. The email log is what the provider was asked to send and what it
 * said back; the outbox is our own delivery of an event to a subscriber, which
 * is the thing that can be retried. Merging them would put one Retry button
 * beside rows where it means nothing.
 */
export const renderDeliveriesPage = (view?: string): string => `
  <main class="app-content module-settings-workspace page--grid" data-deliveries-page${view === 'settings-deliveries' ? '' : ' hidden'}>
    <header class="context-row module-settings-header">
      <div><p class="eyebrow">Settings</p><h1>Deliveries</h1></div>
    </header>
    ${renderSettingsTabs('deliveries')}
    <p class="module-settings-intro">What this instance sent, and what became of it. Email is what the provider was asked to send; deliveries are events sent to a subscriber, and a failed one can be tried again.</p>

    <section class="deliveries-section">
      <h2>Email</h2>
      <div class="activity-log-toolbar">
        <label for="ez-email-log-status-filter">Status
          <select id="ez-email-log-status-filter" data-email-log-status-filter>
            <option value="" selected>Every status</option>
            <option value="queued">Queued</option>
            <option value="sent">Sent</option>
            <option value="failed">Failed</option>
            <option value="bounced">Bounced</option>
            <option value="complained">Complained</option>
          </select>
        </label>
      </div>
      <p class="form-result module-settings-status" data-email-log-status role="status" aria-live="polite">Loading email…</p>
      <div data-email-log-list></div>
    </section>

    <section class="deliveries-section">
      <h2>Event deliveries</h2>
      <div class="activity-log-toolbar">
        <label for="ez-outbox-status-filter">Status
          <select id="ez-outbox-status-filter" data-outbox-status-filter>
            <option value="" selected>Every status</option>
            <option value="pending">Pending</option>
            <option value="processing">Processing</option>
            <option value="delivered">Delivered</option>
            <option value="failed">Failed</option>
          </select>
        </label>
      </div>
      <p class="form-result module-settings-status" data-outbox-status role="status" aria-live="polite">Loading deliveries…</p>
      <div data-outbox-list></div>
    </section>
  </main>

`
