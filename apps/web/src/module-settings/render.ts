import { renderAccountingProviders, type AccountingProviderAvailability } from '../accounting-providers.js'
import { renderWebhookSettings } from './webhooks-render.js'
import { renderCompanyDataTools } from './data-tools.js'
import { renderEmailSuppressionReview } from './email-suppressions-render.js'
import { renderTimeRoundingSection } from './time-rounding-render.js'
import { renderRetentionSection } from './retention.js'
import { iconMarkup } from '../components/icons.js'
import { demoUnavailable } from '../demo.js'
import { COMPANY_SETTINGS_SECTIONS, USER_SETTINGS_SECTIONS } from '../settings-sections.js'
import { renderNotificationFields } from '../team/notification-fields.js'

/**
 * One link per section, and one section shown at a time (issue 800). The
 * choice lives in the hash, so this is plain anchors: the shell listens for
 * the change and the browser's back button already does the right thing.
 * Payouts starts hidden with its section and is revealed by the controller
 * that knows whether Wise is configured.
 */
const renderCompanySectionStrip = (): string =>
  `<nav class="tabstrip view-switch settings-sections" aria-label="Company settings sections" data-settings-sections>` +
  COMPANY_SETTINGS_SECTIONS.map(
    (section) =>
      `<a href="#${section.id}" data-settings-section-link="${section.id}"${section.id === 'payouts' ? ' hidden' : ''}>${section.label}</a>`,
  ).join('') +
  `</nav>`

const renderUserSectionStrip = (): string =>
  `<nav class="tabstrip view-switch settings-sections" aria-label="Your settings sections" data-settings-user-sections>` +
  USER_SETTINGS_SECTIONS.map(
    (section) => `<a href="#${section.id}" data-settings-user-link="${section.id}">${section.label}</a>`,
  ).join('') +
  `</nav>`

const userPane = (id: string): string => `<div class="settings-user-pane" data-settings-user-pane="${id}" hidden>`

export const renderModuleSettingsPage = (view?: string, providers?: AccountingProviderAvailability): string => `
  <main class="app-content module-settings-workspace page--settings" data-module-settings-page${view === 'settings-company' ? '' : ' hidden'}>
    <header class="context-row module-settings-header">
      <div><p class="eyebrow">Settings</p><h1>Company</h1></div>
    </header>
    ${renderSettingsTabs('company')}
    <p class="module-settings-intro">How this instance is configured. Everything here applies to everyone in the organization.</p>
    ${renderCompanySectionStrip()}
    <section class="settings-section" data-settings-section="modules" aria-labelledby="settings-modules-title">
      <header><h2 id="settings-modules-title">Modules</h2>
      <p>Enable or disable modules for your organization. Disabling a module hides its navigation and returns 404 from its API endpoints. Existing data (submissions, approvals, audit history) is preserved.</p></header>
      <p class="form-result module-settings-status" data-module-settings-status role="status" aria-live="polite">Loading modules…</p>
      <section class="module-settings-list" data-module-settings-list aria-label="Modules"></section>
    </section>
    <section class="settings-section" data-settings-section="sign-in" aria-labelledby="settings-sign-in-title">
      <header><h2 id="settings-sign-in-title">Ways in</h2>
      <p>Which sign-in methods this instance offers. A method needs two things to be live: credentials in the deployment, and your permission here. Switching one off stops its routes, not just its buttons &mdash; anyone part-way through it is turned away. You cannot switch off the last one standing, or the last one you yourself can use.</p></header>
      <p class="form-result" data-settings-sign-in-status role="status" aria-live="polite">Loading sign-in methods&hellip;</p>
      <section class="module-settings-list" data-settings-sign-in-list aria-label="Sign-in methods" hidden></section>
    </section>
    ${renderWebhookSettings()}
    ${renderRetentionSection()}
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
      <p class="form-result" data-note-settings-result role="status" aria-live="polite"></p>${renderTimeRoundingSection()}
    </section>
    <section class="settings-section" data-settings-section="approval" aria-labelledby="settings-approval-title">
      <header><h2 id="settings-approval-title">Automatic approval</h2>
      <p>Off unless you turn it on. When on, a submitted week that nobody has approved or rejected within the number of calendar days you choose is approved for you. The days are counted from the moment the week was submitted, and start again if it is rejected and submitted again. A rejected week is never approved this way, and weeks submitted before you turn this on are left for a person to decide. The system records the decision with the review window and the administrator who authorized the policy. The submitter receives a confirmation; reviewers with email enabled receive a warning before the deadline.</p></header>
      <p class="form-result" data-auto-approval-status role="status" aria-live="polite">Loading automatic approval…</p>
      <form class="settings-form" data-auto-approval-form hidden>
        <label class="settings-toggle"><input name="enabled" type="checkbox" data-auto-approval-enabled>Approve submitted timesheets automatically</label>
        <label>Days to wait before approving
          <input name="window_days" type="number" min="1" max="60" step="1" inputmode="numeric" data-auto-approval-days>
        </label>
        <p class="hint" data-auto-approval-since></p>
        <button class="primary-action" type="submit" data-auto-approval-submit>Save automatic approval</button>
      </form>
      <p class="form-result" data-auto-approval-result role="status" aria-live="polite"></p>
    </section>
    <section class="settings-section" data-settings-section="email" aria-labelledby="settings-email-title">
      <header><div class="settings-section-heading"><h2 id="settings-email-title">Email delivery</h2><button type="button" class="settings-refresh" data-settings-refresh="email">Refresh email delivery</button></div>
      <p>Who this instance sends as, and how that mail has been landing. Transport credentials stay in the deployment; what is shown here is the state they produce.</p></header>
      <p class="form-result" data-settings-email-status role="status" aria-live="polite">Loading email delivery…</p>
      <div class="settings-table" data-settings-sender-identities hidden></div>
      <dl class="settings-facts" data-settings-email-reputation hidden></dl>
      <div class="settings-table" data-settings-email-identities-health hidden></div>
      ${renderEmailSuppressionReview()}
    </section>
    <section class="settings-section" data-settings-section="invoices" aria-labelledby="settings-invoices-title">
      <header><h2 id="settings-invoices-title">Invoices</h2>
      <p>What every invoice prints, and what a new draft starts with. The company name and address print on every invoice when it is sent, existing ones included. The default subject and notes are copied onto each new draft, where they can still be changed. Payment terms are set on each client.</p></header>
      <p class="form-result" data-settings-invoices-status role="status" aria-live="polite">Loading invoice settings…</p>
      <form class="settings-form invoice-defaults-form" data-invoice-defaults-form hidden>
        <p class="hint" data-invoice-defaults-demo hidden>${demoUnavailable('Company information and default values')}</p>
        <h3>Company information</h3>
        <label>Name
          <input name="company_name" data-invoice-defaults-name maxlength="255" autocomplete="organization" required>
        </label>
        <label>Address
          <textarea name="company_address" data-invoice-defaults-address rows="4" maxlength="2000" autocomplete="street-address"></textarea>
        </label>
        <p class="hint">The logo is the light-background wordmark under Brand.</p>
        <h3>Default values</h3>
        <label>Invoice subject
          <input name="subject" data-invoice-defaults-subject maxlength="998" autocomplete="off" aria-describedby="settings-invoice-subject-hint">
        </label>
        <p class="hint" id="settings-invoice-subject-hint" data-invoice-defaults-subject-hint>Filled in for each new draft: <code>%client%</code> is the client's name, <code>%period_month_name%</code> and <code>%period_year%</code> the month the invoice period starts in (a draft with no period uses its issue date), and <code>%project%</code> the project on an invoice for one project, empty otherwise. Everything else stays as written.</p>
        <label>Invoice notes
          <textarea name="notes" data-invoice-defaults-notes rows="9" maxlength="100000"></textarea>
        </label>
        <p class="hint">Printed below the line items: how to pay, bank and wire details, terms. Formatting: <code>*bold*</code> and <code>_italic_</code>.</p>
        <label>Estimate validity, in days
          <input name="estimate_validity_days" type="number" min="1" max="3650" step="1" inputmode="numeric" data-invoice-defaults-estimate-days aria-describedby="settings-estimate-days-hint">
        </label>
        <p class="hint" id="settings-estimate-days-hint">How long a customer can answer an estimate, counted from the day it is first sent. Leave blank for estimates that do not expire. An expiry set on an estimate overrides this.</p>
        <h3>Online invoice</h3>
        <label class="invoice-defaults-check"><input type="checkbox" name="view_receipts" data-invoice-defaults-view-receipts aria-describedby="settings-invoice-view-receipts-hint">Link the invoice online in the email, and record when it is first opened</label>
        <p class="hint" id="settings-invoice-view-receipts-hint">Off, the email is exactly what it is today. On, its &ldquo;View invoice&rdquo; line opens a private page for that email: the invoice, its PDF, and a pay button where online payment is set up. The first time someone opens it, the invoice's History and Settings &rsaquo; Deliveries show when. There is no tracking image, and a mail scanner that only fetches the link does not count. An invoice email goes to everyone on it, so this shows that the email was opened, not by whom.</p>
        <h3 data-invoice-defaults-sending hidden>Sending</h3>
        <label class="invoice-defaults-check" data-invoice-defaults-sending hidden><input type="checkbox" name="attach_pdf" data-invoice-defaults-attach-pdf>Attach the invoice PDF by default</label>
        <label class="invoice-defaults-check" data-invoice-defaults-sending hidden><input type="checkbox" name="attach_journal" data-invoice-defaults-attach-journal>Attach the hours report by default</label>
        <label data-invoice-defaults-journal-detail hidden>Hours report detail
          <select name="journal_level" data-invoice-defaults-journal-level>
            <option value="detailed">Every entry</option>
            <option value="summary">Summary</option>
          </select>
        </label>
        <fieldset class="invoice-defaults-formats" data-invoice-defaults-journal-formats hidden>
          <legend>Hours report files</legend>
          <label class="invoice-defaults-check"><input type="checkbox" name="journal_format" value="pdf">PDF</label>
          <label class="invoice-defaults-check"><input type="checkbox" name="journal_format" value="csv">CSV</label>
          <label class="invoice-defaults-check"><input type="checkbox" name="journal_format" value="xlsx">Excel</label>
        </fieldset>
        <label class="invoice-defaults-check" data-invoice-defaults-sending hidden><input type="checkbox" name="attach_files" data-invoice-defaults-attach-files>Attach invoice files by default</label>
        <label class="invoice-defaults-check" data-invoice-defaults-sending hidden><input type="checkbox" name="append_pdfs" data-invoice-defaults-append-pdfs>Append attached PDFs to the back of the invoice PDF by default</label>
        <p class="hint" data-invoice-defaults-sending hidden>What an invoice's email carries unless its client or the invoice says otherwise. Each invoice can still change these when it is sent.</p>
        <label data-invoice-defaults-always-cc hidden>Always copy these addresses on invoice emails
          <textarea name="always_cc" data-invoice-defaults-always-cc-list rows="3" autocomplete="off" spellcheck="false" aria-describedby="settings-invoice-always-cc-hint"></textarea>
        </label>
        <p class="hint" id="settings-invoice-always-cc-hint" data-invoice-defaults-always-cc hidden>One per line, as <code>email@example.com</code> or <code>Name &lt;email@example.com&gt;</code> &mdash; your own finance mailbox, say. Every invoice email copies them, whoever it goes to; up to 20.</p>
        <button class="primary-action" type="submit" data-invoice-defaults-submit>Save invoice settings</button>
      </form>
      <p class="form-result" data-invoice-defaults-result role="status" aria-live="polite"></p>
    </section>
    <section class="settings-section" data-settings-section="reminders" aria-labelledby="settings-reminders-title">
      <header><h2 id="settings-reminders-title">Payment reminders</h2>
      <p>What an open invoice sends once it is past due, until it is paid, written off or cancelled. This is the default for every invoice sent from now on; an invoice with a policy of its own keeps it. The wording is the reminder template under Templates, and each reminder goes to whoever was sent the invoice.</p></header>
      <p class="form-result" data-settings-reminders-status role="status" aria-live="polite">Loading payment reminders…</p>
      <form class="settings-form" data-reminder-settings-form hidden>
        <label class="settings-toggle"><input name="enabled" type="checkbox" data-reminder-settings-enabled>Send payment reminders for overdue invoices</label>
        <label>First reminder, days after the due date
          <input name="first_after_days" type="number" min="0" max="3650" step="1" inputmode="numeric" data-reminder-settings-first required>
        </label>
        <label>Then every, days
          <input name="every_days" type="number" min="1" max="365" step="1" inputmode="numeric" data-reminder-settings-every required>
        </label>
        <button class="primary-action" type="submit" data-reminder-settings-submit>Save payment reminders</button>
      </form>
      <p class="form-result" data-reminder-settings-result role="status" aria-live="polite"></p>
    </section>
    <section class="settings-section" data-settings-section="notifications" aria-labelledby="settings-notifications-title">
      <header><h2 id="settings-notifications-title">Notifications</h2>
      <p>Mail this instance sends the people who work in it. A project that has &ldquo;Notify when over budget&rdquo; on emails its project managers once each time its budget crosses the threshold set on the project. If a project has no manager with an address, the administrators are told instead, so an alert never goes to nobody.</p></header>
      <p class="form-result" data-settings-notifications-status role="status" aria-live="polite">Loading notification settings…</p>
      <form class="settings-form" data-notification-settings-form hidden>
        <label class="settings-toggle"><input name="budget_alerts_include_admins" type="checkbox" data-notification-settings-admins>Also email administrators when a project goes over budget</label>
        <label>Remind everyone to submit last week's time
          <select name="submission_day" data-notification-settings-day>
            <option value="">Never</option>
            <option value="monday">Monday</option>
            <option value="tuesday">Tuesday</option>
            <option value="wednesday">Wednesday</option>
            <option value="thursday">Thursday</option>
            <option value="friday">Friday</option>
            <option value="saturday">Saturday</option>
            <option value="sunday">Sunday</option>
          </select>
        </label>
        <label>At, on each person's own clock
          <input name="submission_time" type="time" data-notification-settings-time>
        </label>
        <p class="hint">Needs the Approval module. On a Friday to Sunday it is about the week now ending; on a Monday to Thursday, about the week before. Each person can opt out under Settings, and people who approve timesheets can ask for a weekly digest of who has not submitted.</p>
        <button class="primary-action" type="submit" data-notification-settings-submit>Save notification settings</button>
      </form>
      <p class="form-result" data-notification-settings-result role="status" aria-live="polite"></p>
    </section>
    <section class="settings-section" data-settings-section="payouts" data-settings-wise data-settings-unavailable aria-labelledby="settings-wise-title" hidden>
      <header><div class="settings-section-heading"><h2 id="settings-wise-title">Payouts</h2><button type="button" class="settings-refresh" data-settings-refresh="payouts">Refresh</button></div>
      <p>Which Wise profile money leaves from, how many people it can currently pay, and whether Wise can tell this instance what became of a transfer. The token itself stays in the deployment; what is shown here is the state it produces.</p></header>
      <p class="form-result" data-settings-wise-status role="status" aria-live="polite">Loading payout connection…</p>
      <dl class="settings-facts" data-settings-wise-facts hidden></dl>
      <p class="form-result settings-backup-alarm" data-settings-wise-alarm role="status" aria-live="polite" hidden></p>
      <fieldset class="settings-payout-providers" data-settings-payout-providers hidden>
        <legend>Payout providers</legend>
        <p class="hint">Turn a provider on to let people be paid through it. A person can be linked to every provider that is on, and picks one as primary. Turning one off stops new links; destinations already set are kept.</p>
        <label><input type="checkbox" data-settings-provider-toggle="wise"> Wise</label>
        <label><input type="checkbox" data-settings-provider-toggle="deel"> Deel (people are matched by the email they use in Deel)</label>
        <p class="form-result" data-settings-provider-result role="status" aria-live="polite"></p>
      </fieldset>
    </section>
    ${renderCompanyDataTools()}
    <section class="settings-section" data-settings-section="backup" aria-labelledby="settings-backup-title">
      <header><h2 id="settings-backup-title">Backups</h2>
      <p>When this instance last exported itself, and whether the last attempt worked. A backup nobody looks at is a backup nobody knows is broken, which is the state it stays in until it is needed.</p></header>
      <p class="form-result" data-settings-backup-status role="status" aria-live="polite">Loading backup status…</p>
      <p class="form-result settings-backup-alarm" data-settings-backup-alarm role="status" aria-live="polite" hidden></p>
      <dl class="settings-facts" data-settings-backup-facts hidden></dl>
      <div data-backup-offsite-check-row hidden>
        <p class="hint">Scheduled off-site copies protect logical database rows. Attachment bytes require a separate full backup; see RESTORE.md.</p>
        <button class="secondary-action" type="button" data-backup-offsite-check>Check off-site destination</button>
        <p class="form-result" data-backup-offsite-check-result role="status" aria-live="polite"></p>
      </div>
      <div class="settings-form" data-settings-backup-download hidden>
        <p class="hint">The download is a complete copy of the database. It contains password hashes and authenticator seeds, so treat the file and the link like a credential. The link works once and stops working after ten minutes.</p>
        <label data-backup-download-code-row hidden>Verification code
          <input type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="64" data-backup-download-code>
        </label>
        <button class="primary-action" type="button" data-backup-download-mint>Download latest backup</button>
        <p class="form-result" data-backup-download-result role="status" aria-live="polite"></p>
        <label data-backup-download-link-row hidden>Download link
          <input type="text" readonly data-backup-download-link>
        </label>
      </div>
      <div class="activity-log-toolbar" data-settings-backup-controls hidden>
        <label for="ez-backup-status-filter">Result
          <select id="ez-backup-status-filter" data-log-filter="status">
            <option value="" selected>Every result</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="running">Running</option>
          </select>
        </label>
        <label for="ez-backup-trigger-filter">Trigger
          <select id="ez-backup-trigger-filter" data-log-filter="trigger">
            <option value="" selected>Every trigger</option>
            <option value="nightly">Nightly</option>
            <option value="manual">Manual</option>
          </select>
        </label>
        <button type="button" data-log-clear>Clear filters</button>
      </div>
      <p class="form-result" data-settings-backup-runs-status role="status" aria-live="polite"></p>
      <div class="settings-table" data-settings-backup-runs hidden></div>
    </section>
    <section class="settings-section" data-settings-section="brand" aria-labelledby="settings-brand-title">
      <header><h2 id="settings-brand-title">Brand</h2>
      <p>The marks this instance draws on itself and on the documents it sends. An uploaded mark replaces the one configured at deploy time; remove it and the deployment's own setting comes back. PNG, JPEG or WebP up to 512&nbsp;KB &mdash; SVG is not accepted, because it can carry script and these files are served to anyone who opens the sign-in page.</p></header>
      <p class="form-result" data-settings-brand-status role="status" aria-live="polite">Loading brand assets…</p>
      <p class="hint" data-settings-brand-demo hidden>${demoUnavailable('Uploading a mark')}</p>
      <div class="settings-brand-slots" data-settings-brand-slots hidden></div>
      <p class="form-result" data-settings-brand-result role="status" aria-live="polite"></p>
    </section>
    <section class="settings-section" data-settings-section="appearance" aria-labelledby="settings-appearance-title">
      <header><h2 id="settings-appearance-title">Appearance</h2>
      <p>The colours this instance wears, for everyone who uses it. Leave them alone and it looks the way it shipped. Every palette is checked for readability before it is saved &mdash; a colour that would leave text unreadable against what sits behind it is refused, and the message says which one and why.</p>
      <p>These are the light theme, and they are what everyone sees by default, whatever their computer is set to. Somebody who picks Dim or Dark in their own settings sees that built-in theme instead.</p></header>
      <p class="form-result" data-settings-theme-status role="status" aria-live="polite">Loading appearance&hellip;</p>
      <div class="settings-theme" data-settings-theme-slots hidden></div>
      <div class="settings-actions" data-settings-theme-actions hidden>
        <button class="primary-action" type="button" data-theme-save>Save colours</button>
        <button class="editor-secondary" type="button" data-theme-revert>Undo my changes</button>
        <button type="button" class="danger-action" data-theme-reset hidden>Back to the built-in theme</button>
      </div>
      <p class="form-result" data-settings-theme-result role="status" aria-live="polite"></p>
    </section>
    <section class="settings-section" data-settings-section="integrations" aria-labelledby="settings-integrations-title">
      <header><div class="settings-section-heading"><h2 id="settings-integrations-title">Accounting</h2><button type="button" class="settings-refresh" data-settings-refresh="integrations">Refresh</button></div>
      <p>Native accounting and financial integrations available on this deployment. Configuration is separate from an authorized connection. Only an administrator can manage connections.</p></header>
      ${renderAccountingProviders(providers)}
      <div data-accounting-quickbooks${providers?.quickbooks === false ? ' hidden' : ''}>
      <h3>QuickBooks Online</h3>
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
      <div class="settings-form" data-quickbooks-reconcile-panel hidden>
        <p>Compare the invoices here with the QuickBooks company. Differences are listed for you to look at; nothing is changed on either side.</p>
        <button class="editor-secondary" type="button" data-quickbooks-reconcile>Compare with QuickBooks</button>
        <p class="form-result" data-quickbooks-reconcile-result role="status" aria-live="polite"></p>
        <div class="settings-table" data-quickbooks-reconcile-table hidden></div>
      </div>
      </div>
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
  <main class="app-content module-settings-workspace page--settings" data-settings-user-page${view === 'settings-user' ? '' : ' hidden'}>
    <header class="context-row module-settings-header">
      <div><p class="eyebrow">Settings</p><h1>You</h1></div>
    </header>
    ${renderSettingsTabs('user')}
    <p class="module-settings-intro">Your own account. Everything here is yours alone; the company settings beside it apply to everyone.</p>
    ${renderUserSectionStrip()}
    <p class="form-result module-settings-status" data-settings-user-status role="status" aria-live="polite">Loading your account…</p>
    <dl class="settings-facts" data-settings-user-facts hidden></dl>
    ${userPane('reminders')}
    <section class="settings-notifications" data-settings-notifications aria-labelledby="settings-notifications-heading" hidden>
      <h2 id="settings-notifications-heading">Your reminders</h2>
      <p class="hint">Whether and when this instance emails you to log your time, and to submit your week. They are yours to switch off.</p>
      <p class="form-result" data-settings-notifications-status role="status" aria-live="polite">Loading your reminders…</p>
      <form class="team-person-form" data-settings-notifications-form hidden>
        ${renderNotificationFields()}
        <p class="form-result" data-settings-notifications-result role="status" aria-live="polite"></p>
        <button class="primary-action" type="submit" data-settings-notifications-submit>Save my reminders</button>
      </form>
    </section>
    </div>
    ${userPane('payouts')}
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
      <form class="settings-payout-default" data-settings-payout-default-form hidden>
        <label for="ez-settings-payout-default">Pay me through<select id="ez-settings-payout-default" name="default_provider" data-settings-payout-default></select></label>
        <p class="hint">Your default is where every payout to you goes. You can choose any provider you hold an account at; leave it on the organization default to follow the instance.</p>
        <p class="form-result" data-settings-payout-default-result role="status" aria-live="polite"></p>
        <button class="primary-action" type="submit">Save default</button>
      </form>
      <section class="settings-payout-deel" data-settings-payout-deel hidden>
        <h3>Deel</h3>
        <p data-settings-payout-deel-summary></p>
        <button type="button" class="danger-action" data-settings-payout-deel-remove hidden>Remove Deel destination</button>
        <form data-settings-payout-deel-form hidden>
          <p class="hint">If you are paid through Deel, enter the email address you use in Deel. Payouts are matched on it.</p>
          <label for="ez-settings-payout-deel-email">Email in Deel<input id="ez-settings-payout-deel-email" name="email" type="email" autocomplete="email" maxlength="254" required></label>
          <p class="form-result" data-settings-payout-deel-result role="status" aria-live="polite"></p>
          <button class="primary-action" type="submit">Save Deel destination</button>
        </form>
      </section>
    </section>
    </div>
    ${userPane('two-factor')}
    <section class="settings-two-factor" data-settings-2fa aria-labelledby="settings-2fa-heading" hidden>
      <h2 id="settings-2fa-heading">Two-step sign-in</h2>
      <p class="hint">A code on top of your password: from an authenticator app, or sent to your email address. Setting one up has been impossible from inside this app until now, which is awkward for an instance that can require it.</p>
      <p class="form-result" data-settings-2fa-status role="status" aria-live="polite">Loading two-step sign-in…</p>
      <dl class="settings-facts" data-settings-2fa-facts hidden></dl>
      <button type="button" class="primary-action" data-settings-2fa-begin hidden>Set up two-step sign-in</button>
      <div class="settings-2fa-email" data-settings-2fa-email hidden>
        <h3>Emailed code</h3>
        <p class="hint" data-settings-2fa-email-hint>At sign-in with your password, a six-digit code is sent to your email address. It never contains a link. It is weaker than an authenticator app: anyone who holds both your password and your mailbox gets in. Signing in by emailed link or through your identity provider never asks for it.</p>
        <p class="form-result" data-settings-2fa-email-result role="status" aria-live="polite"></p>
        <button type="button" class="primary-action" data-settings-2fa-email-on hidden>Turn on emailed codes</button>
        <button type="button" class="danger-action" data-settings-2fa-email-off hidden>Turn off emailed codes</button>
      </div>
      <div class="settings-2fa-enrolment" data-settings-2fa-enrolment hidden>
        <h3>Add this to your authenticator</h3>
        <p class="hint">Type the key in, or paste the setup link. Both describe the same secret.</p>
        <dl class="settings-facts">
          <div><dt>Key</dt><dd><code data-settings-2fa-secret></code></dd></div>
          <div><dt>Setup link</dt><dd><code data-settings-2fa-uri></code></dd></div>
        </dl>
        <h3>Recovery codes</h3>
        <p class="hint">Shown once, here. Each works exactly one time, and they are the only way back in if you lose the authenticator.</p>
        <ul class="settings-2fa-recovery" data-settings-2fa-recovery></ul>
        <form class="team-person-form" data-settings-2fa-confirm-form>
          <label for="ez-settings-2fa-confirm">Code from the app<input id="ez-settings-2fa-confirm" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" required></label>
          <p class="hint">Nothing changes about signing in until this code is accepted.</p>
          <p class="form-result" data-settings-2fa-confirm-result role="status" aria-live="polite"></p>
          <button class="primary-action" type="submit" data-settings-2fa-confirm-submit>Turn on two-step sign-in</button>
        </form>
      </div>
      <form class="team-person-form" data-settings-2fa-disable-form hidden>
        <label for="ez-settings-2fa-disable">Code from the app<input id="ez-settings-2fa-disable" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" required></label>
        <p class="hint">Turning it off needs a current code, so a borrowed session cannot remove it.</p>
        <p class="form-result" data-settings-2fa-disable-result role="status" aria-live="polite"></p>
        <button class="danger-action" type="submit" data-settings-2fa-disable-submit>Turn off two-step sign-in</button>
      </form>
    </section>
    </div>
    ${userPane('tokens')}
    <section class="settings-tokens" data-settings-tokens aria-labelledby="settings-tokens-heading" hidden>
      <h2 id="settings-tokens-heading">API tokens</h2>
      <p class="hint">Tokens act as you, with only the scopes you tick, and they are how the CLI and anything else outside this app signs in. Issuing one has been a terminal job until now.</p>
      <p class="form-result" data-settings-tokens-status role="status" aria-live="polite">Loading your API tokens…</p>
      <div class="settings-table" data-settings-tokens-table hidden></div>
      <form class="team-person-form" data-settings-token-form>
        <label for="ez-settings-token-name">Name<input id="ez-settings-token-name" name="name" autocomplete="off" maxlength="100" placeholder="Laptop CLI" required aria-describedby="settings-token-name-hint"></label>
        <p class="hint" id="settings-token-name-hint">What it is for, so a token you find later can be revoked without guessing.</p>
        <label for="ez-settings-token-expires">Expires<input id="ez-settings-token-expires" name="expires_at" type="date" aria-describedby="settings-token-expiry-hint"></label>
        <p class="hint" id="settings-token-expiry-hint">Optional. Left blank, a token lasts one year, which is also the longest you can ask for; only an administrator can issue one that lasts longer or never expires.</p>
        <fieldset><legend>Scopes</legend><div class="team-option-grid"><label class="team-check"><input type="checkbox" name="scopes" value="time_entries:read">Read time</label><label class="team-check"><input type="checkbox" name="scopes" value="time_entries:write">Write time</label><label class="team-check"><input type="checkbox" name="scopes" value="projects:read">Read projects</label><label class="team-check"><input type="checkbox" name="scopes" value="projects:write">Write projects</label><label class="team-check"><input type="checkbox" name="scopes" value="clients:read">Read clients</label><label class="team-check"><input type="checkbox" name="scopes" value="clients:write">Write clients</label><label class="team-check"><input type="checkbox" name="scopes" value="invoices:read">Read invoices</label><label class="team-check"><input type="checkbox" name="scopes" value="invoices:write">Write invoices</label><label class="team-check"><input type="checkbox" name="scopes" value="expenses:read">Read expenses</label><label class="team-check"><input type="checkbox" name="scopes" value="expenses:write">Write expenses</label><label class="team-check"><input type="checkbox" name="scopes" value="team:read">Read team</label><label class="team-check"><input type="checkbox" name="scopes" value="schedule:read">Read schedule</label><label class="team-check"><input type="checkbox" name="scopes" value="schedule:write">Write schedule</label><label class="team-check"><input type="checkbox" name="scopes" value="reports:read">Read reports</label></div></fieldset>
        <p class="form-result" data-settings-token-result role="status" aria-live="polite"></p>
        <button class="primary-action" type="submit" data-settings-token-submit>Issue token</button>
      </form>
      <dialog class="settings-token-dialog" data-settings-token-issued aria-labelledby="settings-token-issued-title">
        <form method="dialog">
          <header><div><p class="eyebrow">API token</p><h2 id="settings-token-issued-title">Copy this now</h2></div><button value="close" aria-label="Close">×</button></header>
          <p class="hint">This is the only time the token is shown. It is stored hashed, so nobody — including this instance — can read it back.</p>
          <p class="settings-token-reveal">
            <code data-settings-token-value aria-live="off"></code>
            <button type="button" class="settings-token-eye" data-settings-token-toggle aria-pressed="false" aria-label="Show token">${iconMarkup('eye')}${iconMarkup('eye-off')}</button>
            <button type="button" class="primary-action" data-settings-token-copy>Copy</button>
          </p>
          <p class="form-result" data-settings-token-copied role="status" aria-live="polite"></p>
          <div class="client-confirm-actions"><button type="submit" value="close">Done</button></div>
        </form>
      </dialog>
    </section>
    </div>
    ${userPane('appearance')}
    <section class="settings-density" aria-labelledby="settings-scheme-heading">
      <h2 id="settings-scheme-heading">Theme</h2>
      <p class="hint">Light, a dim slate, dark, or whatever this computer is set to. Yours and this browser's, like row density; invoices and the other documents your clients receive stay on white paper. If this instance has colours of its own, System keeps them, and Dim and Dark switch to the built-in themes.</p>
      <div class="settings-density-choice" role="group" aria-label="Theme">
        <button type="button" data-color-scheme-choice="system" aria-pressed="true">System</button>
        <button type="button" data-color-scheme-choice="light" aria-pressed="false">Light</button>
        <button type="button" data-color-scheme-choice="dim" aria-pressed="false">Dim</button>
        <button type="button" data-color-scheme-choice="dark" aria-pressed="false">Dark</button>
      </div>
    </section>
    <section class="settings-density" aria-labelledby="settings-nav-heading">
      <h2 id="settings-nav-heading">Navigation</h2>
      <p class="hint">A sidebar down the left, or a bar across the top. Yours and this browser's, like the theme. On a narrow screen both fold into the same menu.</p>
      <div class="settings-density-choice" role="group" aria-label="Navigation">
        <button type="button" data-nav-layout-choice="sidebar" aria-pressed="true">Sidebar</button>
        <button type="button" data-nav-layout-choice="topbar" aria-pressed="false">Top bar</button>
      </div>
    </section>
    <section class="settings-density" aria-labelledby="settings-density-heading">
      <h2 id="settings-density-heading">Row density</h2>
      <p class="hint">How much of a table fits on your screen. This is yours and this machine's — nobody else's view changes, and the company setting beside it is unaffected.</p>
      <div class="settings-density-choice" role="group" aria-label="Row density">
        <button type="button" data-density-choice="comfortable" aria-pressed="true">Comfortable</button>
        <button type="button" data-density-choice="compact" aria-pressed="false">Compact</button>
      </div>
    </section>
    <section class="settings-density" aria-labelledby="settings-text-size-heading">
      <h2 id="settings-text-size-heading">Text size</h2>
      <p class="hint">How large the type is, everywhere in the app. Yours and this machine's, like row density; the documents your clients receive are not affected.</p>
      <div class="settings-density-choice" role="group" aria-label="Text size">
        <button type="button" data-text-size-choice="small" aria-pressed="false">Small</button>
        <button type="button" data-text-size-choice="default" aria-pressed="true">Default</button>
        <button type="button" data-text-size-choice="large" aria-pressed="false">Large</button>
        <button type="button" data-text-size-choice="larger" aria-pressed="false">Larger</button>
      </div>
    </section>
    </div>
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
        <input id="ez-activity-type" type="text" list="ez-activity-type-options" placeholder="Every event" autocomplete="off" data-activity-type>
        <datalist id="ez-activity-type-options" data-activity-type-options></datalist>
      </label>
      <label for="ez-activity-actor">Who
        <select id="ez-activity-actor" data-activity-actor>
          <option value="" selected>Anyone</option>
        </select>
      </label>
      <label for="ez-activity-entity">About
        <select id="ez-activity-entity" data-activity-entity>
          <option value="" selected>Anything</option>
        </select>
      </label>
      <label for="ez-activity-entity-id">Record number
        <input id="ez-activity-entity-id" type="number" min="1" step="1" inputmode="numeric" data-activity-entity-id>
      </label>
      <button type="button" data-activity-clear>Clear filters</button>
      <button type="button" data-activity-export>Export CSV</button>
    </div>
    <section class="activity-roll" data-activity-roll hidden>
      <h2>Archive a finished year</h2>
      <p class="module-settings-intro">Entries from a finished year can be moved out of the live log into their own archive table. Nothing is deleted: archived entries stay append-only and still appear here. The archive takes everything recorded up to the moment you roll.</p>
      <div data-activity-roll-years></div>
    </section>
    <p class="form-result module-settings-status" data-activity-log-status role="status" aria-live="polite">Loading activity…</p>
    <div data-activity-log-list></div>
    <p><button type="button" data-activity-more hidden>Load more</button></p>
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
      <div class="activity-log-toolbar" data-email-log-controls>
        <label for="ez-email-log-status-filter">Status
          <select id="ez-email-log-status-filter" data-email-log-status-filter data-log-filter="status">
            <option value="" selected>Every status</option>
            <option value="queued">Queued</option>
            <option value="sent">Sent</option>
            <option value="failed">Failed</option>
            <option value="bounced">Bounced</option>
            <option value="complained">Complained</option>
          </select>
        </label>
        <label for="ez-email-log-kind-filter">Kind
          <select id="ez-email-log-kind-filter" data-log-filter="kind">
            <option value="" selected>Every kind</option>
            <option value="invoice">Invoice</option>
            <option value="invoice_preview">Invoice preview</option>
            <option value="reminder">Reminder</option>
            <option value="thank_you">Thank-you</option>
            <option value="sign_in">Sign-in</option>
            <option value="account">Account mail</option>
          </select>
        </label>
        <label for="ez-email-log-from">From
          <input id="ez-email-log-from" type="date" data-log-filter="from">
        </label>
        <label for="ez-email-log-to">To
          <input id="ez-email-log-to" type="date" data-log-filter="to">
        </label>
        <label for="ez-email-log-q">Recipient
          <input id="ez-email-log-q" type="search" maxlength="200" placeholder="Address or name" data-log-filter="q">
        </label>
        <button type="button" data-log-clear>Clear filters</button>
      </div>
      <p class="form-result module-settings-status" data-email-log-status role="status" aria-live="polite">Loading email…</p>
      <div data-email-log-list></div>
    </section>

    <section class="deliveries-section">
      <h2>Event deliveries</h2>
      <div class="activity-log-toolbar" data-outbox-controls>
        <label for="ez-outbox-status-filter">Status
          <select id="ez-outbox-status-filter" data-outbox-status-filter data-log-filter="status">
            <option value="" selected>Every status</option>
            <option value="pending">Pending</option>
            <option value="processing">Processing</option>
            <option value="delivered">Delivered</option>
            <option value="failed">Failed</option>
          </select>
        </label>
        <label for="ez-outbox-type-filter">Event
          <input id="ez-outbox-type-filter" type="text" maxlength="128" placeholder="invoice.paid" data-log-filter="type">
        </label>
        <label for="ez-outbox-from">From
          <input id="ez-outbox-from" type="date" data-log-filter="from">
        </label>
        <label for="ez-outbox-to">To
          <input id="ez-outbox-to" type="date" data-log-filter="to">
        </label>
        <button type="button" data-log-clear>Clear filters</button>
      </div>
      <p class="form-result module-settings-status" data-outbox-status role="status" aria-live="polite">Loading deliveries…</p>
      <div data-outbox-list></div>
    </section>
  </main>

`
