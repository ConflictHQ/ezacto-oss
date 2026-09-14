import { iconMarkup } from '../components/icons.js'

const weekdays = [
  ['monday', 'Mon'],
  ['tuesday', 'Tue'],
  ['wednesday', 'Wed'],
  ['thursday', 'Thu'],
  ['friday', 'Fri'],
  ['saturday', 'Sat'],
  ['sunday', 'Sun'],
] as const

export const renderTeamPages = (view?: string): string => `
  <main class="app-content team-workspace page--grid" data-team-list-page${view === 'team-list' ? '' : ' hidden'}>
    <header class="context-row">
      <div><p class="eyebrow">Organize</p><h1>Team</h1></div>
      <button class="primary-action" type="button" data-team-person-create hidden disabled>Add person</button>
    </header>
    <section class="team-period" aria-label="Utilization period">
      <button type="button" data-team-week-previous aria-label="Previous week">${iconMarkup('chevron', { direction: 'left' })}</button>
      <strong data-team-week-label>—</strong>
      <button type="button" data-team-week-next aria-label="Next week">${iconMarkup('chevron')}</button>
      <button type="button" data-team-week-current>${iconMarkup('calendar')}This week</button>
    </section>
    <div class="team-list-toolbar">
      <fieldset aria-label="People status">
        <legend class="visually-hidden">People status</legend>
        <button type="button" data-team-filter="active" aria-pressed="true">Active</button>
        <button type="button" data-team-filter="archived" aria-pressed="false">Archived</button>
        <button type="button" data-team-filter="all" aria-pressed="false">All</button>
      </fieldset>
      <label for="ez-team-scope">Show
        <select id="ez-team-scope" data-team-scope>
          <option value="everyone" selected>Everyone</option>
          <option value="employees">Employees</option>
          <option value="contractors">Contractors</option>
        </select>
      </label>
      <label for="ez-team-search">Find a person
        <input id="ez-team-search" type="search" data-team-search autocomplete="off" placeholder="Name or email">
      </label>
    </div>
    <section class="team-summary" data-team-summary aria-label="Team utilization summary" hidden></section>
    <p class="form-result team-page-status" data-team-list-status role="status" aria-live="polite">Loading team…</p>
    <div data-team-list></div>
    <button type="button" data-team-list-retry hidden>Retry loading team</button>
  </main>

  <main class="app-content team-workspace page--grid" data-team-person-page${view === 'team-person' ? '' : ' hidden'}>
    <header class="context-row team-person-header">
      <div><p class="eyebrow">Team</p><h1 data-team-person-name>Person</h1></div>
      <a href="/team">Back to team</a>
    </header>
    <p class="form-result team-page-status" data-team-person-status role="status" aria-live="polite">Loading person…</p>
    <article class="team-person-editor" data-team-person-editor hidden>
      <div class="team-person-tabs" role="tablist" aria-label="Person settings">
        <button type="button" role="tab" id="team-tab-info" aria-controls="team-panel-info" aria-selected="true" data-team-tab="info">Information</button>
        <button type="button" role="tab" id="team-tab-rates" aria-controls="team-panel-rates" aria-selected="false" tabindex="-1" data-team-tab="rates">Rates</button>
        <button type="button" role="tab" id="team-tab-projects" aria-controls="team-panel-projects" aria-selected="false" tabindex="-1" data-team-tab="projects">Projects</button>
        <button type="button" role="tab" id="team-tab-permissions" aria-controls="team-panel-permissions" aria-selected="false" tabindex="-1" data-team-tab="permissions">Permissions</button>
        <button type="button" role="tab" id="team-tab-payout" aria-controls="team-panel-payout" aria-selected="false" tabindex="-1" data-team-tab="payout" hidden>Payout</button>
        <button type="button" role="tab" id="team-tab-notifications" aria-controls="team-panel-notifications" aria-selected="false" tabindex="-1" data-team-tab="notifications">Notifications</button>
      </div>

      <section class="team-person-panel" id="team-panel-info" role="tabpanel" aria-labelledby="team-tab-info" data-team-panel="info">
        <header><div><p class="eyebrow">Person record</p><h2>Information</h2></div></header>
        <form class="team-person-form" data-team-info-form>
          <div class="team-form-pair">
            <label>First name<input name="first_name" autocomplete="given-name" required></label>
            <label>Last name<input name="last_name" autocomplete="family-name" required></label>
          </div>
          <label>Sign-in address<input name="email" type="email" readonly aria-describedby="team-email-hint"></label>
          <p class="hint" id="team-email-hint">Email identity changes are managed by authentication settings.</p>
          <div class="team-form-pair">
            <label>Telephone<input name="telephone" type="tel" autocomplete="tel"></label>
            <label>Employee ID<input name="employee_id" autocomplete="off"></label>
          </div>
          <div class="team-form-pair">
            <label>Timezone<input name="timezone" autocomplete="off" required></label>
            <label>Weekly capacity (hours)<input name="weekly_capacity" type="number" inputmode="decimal" min="0" step="0.25" required></label>
          </div>
          <label class="team-check"><input name="is_contractor" type="checkbox">Contractor</label>
          <label class="team-check"><input name="has_access_to_all_future_projects" type="checkbox">Automatically assign all future projects</label>
          <fieldset><legend>Roles</legend><div class="team-option-grid" data-team-roles></div></fieldset>
          <fieldset><legend>Departments</legend><div class="team-option-grid" data-team-departments></div></fieldset>
          <p class="form-result" data-team-info-result role="status" aria-live="polite"></p>
          <button class="primary-action" type="submit" data-team-info-submit>Save information</button>
        </form>
        <section class="team-status-actions" aria-labelledby="team-status-heading">
          <h3 id="team-status-heading">Account status</h3>
          <p data-team-status-description></p>
          <button type="button" data-team-status-action hidden></button>
        </section>
      </section>

      <section class="team-person-panel" id="team-panel-rates" role="tabpanel" aria-labelledby="team-tab-rates" data-team-panel="rates" hidden>
        <header><div><p class="eyebrow">Effective-dated</p><h2>Rates</h2></div></header>
        <p>Rates are append-only. A new effective date closes the preceding period without rewriting history.</p>
        <p class="hint" data-team-rates-redacted hidden>Rate history is not available to your permission profile.</p>
        <div class="team-rate-columns">
          <section data-team-billable-section><header><h3>Billable rates</h3><button type="button" data-team-add-rate="billable">Add rate</button></header><div data-team-billable-rates></div></section>
          <section data-team-cost-section><header><h3>Cost rates</h3><button type="button" data-team-add-rate="cost">Add rate</button></header><div data-team-cost-rates></div></section>
        </div>
      </section>

      <section class="team-person-panel" id="team-panel-projects" role="tabpanel" aria-labelledby="team-tab-projects" data-team-panel="projects" hidden>
        <header><div><p class="eyebrow">Time access</p><h2>Assigned projects</h2></div></header>
        <p class="hint">Task access follows each project assignment; tasks are not assigned separately here.</p>
        <form data-team-projects-form>
          <div class="team-project-assignment-list" data-team-projects></div>
          <p class="form-result" data-team-projects-result role="status" aria-live="polite"></p>
          <button class="primary-action" type="submit" data-team-projects-submit>Save project assignments</button>
        </form>
      </section>

      <section class="team-person-panel" id="team-panel-permissions" role="tabpanel" aria-labelledby="team-tab-permissions" data-team-panel="permissions" hidden>
        <header><div><p class="eyebrow">Access</p><h2>Permission profile</h2></div></header>
        <form data-team-permissions-form>
          <fieldset><legend>Choose one profile</legend><div class="team-profile-grid" data-team-profiles></div></fieldset>
          <p class="hint" data-team-owner-profile-note hidden>The organization owner is always an administrator. Transfer ownership explicitly before changing this access.</p>
          <p class="form-result" data-team-permissions-result role="status" aria-live="polite"></p>
          <button class="primary-action" type="submit" data-team-permissions-submit>Save permission profile</button>
        </form>
      </section>

      <section class="team-person-panel" id="team-panel-payout" role="tabpanel" aria-labelledby="team-tab-payout" data-team-panel="payout" hidden>
        <header><div><p class="eyebrow">Where money goes</p><h2>Payout destination</h2></div></header>
        <p class="hint" data-team-payout-unconfigured hidden>Wise is not connected on this instance, so there is nowhere to send a payout yet.</p>
        <p class="form-result" data-team-payout-status role="status" aria-live="polite">Loading payout destination…</p>
        <section class="team-payout-current" data-team-payout-current hidden>
          <h3>Set</h3>
          <p data-team-payout-summary></p>
          <p class="hint" data-team-payout-unverified hidden>Wise has not confirmed this destination resolves. Remove it and add it again.</p>
          <button type="button" class="danger-action" data-team-payout-remove>Remove destination</button>
        </section>
        <form class="team-person-form" data-team-payout-form hidden>
          <p>Share the Wisetag on their Wise account — or the email address or phone number that account is discoverable by. Wise keeps the bank details; we never see them.</p>
          <label for="ez-team-payout-identifier">Wisetag, email or phone<input id="ez-team-payout-identifier" name="identifier" autocomplete="off" maxlength="255" placeholder="@theirtag" required aria-describedby="team-payout-hint"></label>
          <p class="hint" id="team-payout-hint">Their Wise profile has to be discoverable for this to find it. They can switch that on in Wise under their Wisetag.</p>
          <label for="ez-team-payout-currency">Currency<input id="ez-team-payout-currency" name="currency" autocomplete="off" maxlength="3" minlength="3" placeholder="USD" required></label>
          <p class="form-result" data-team-payout-result role="status" aria-live="polite"></p>
          <button class="primary-action" type="submit" data-team-payout-submit>Save payout destination</button>
        </form>
      </section>

      <section class="team-person-panel" id="team-panel-notifications" role="tabpanel" aria-labelledby="team-tab-notifications" data-team-panel="notifications" hidden>
        <header><div><p class="eyebrow">Inactive integration</p><h2>Notification preferences</h2></div></header>
        <p class="hint" data-team-notification-status>Notification delivery is not active in this release. These preferences remain off until delivery workers are available.</p>
        <form data-team-notifications-form>
          <label class="team-check"><input name="daily_reminder_enabled" type="checkbox">Daily time reminder preference (inactive)</label>
          <label>Reminder time<input name="reminder_time" type="time"></label>
          <fieldset><legend>Reminder days</legend><div class="team-weekdays">${weekdays.map(([value, label]) => `<label><input type="checkbox" name="reminder_days" value="${value}">${label}</label>`).join('')}</div></fieldset>
          <fieldset><legend>Reminder channels</legend>
            <label class="team-check"><input name="channel_email" type="checkbox">Mail channel preference (inactive)</label>
            <label class="team-check"><input name="channel_desktop" type="checkbox">Desktop preference (inactive)</label>
            <label class="team-check"><input name="channel_slack" type="checkbox">Slack preference (inactive)</label>
            <p class="hint" data-team-slack-status>Slack is also unavailable because no connector is configured.</p>
          </fieldset>
          <label class="team-check"><input name="include_in_team_reminders" type="checkbox">Include in team reminders</label>
          <label class="team-check"><input name="weekly_digest" type="checkbox">Weekly digest preference (inactive)</label>
          <label class="team-check"><input name="notify_project_deleted" type="checkbox">Project-deletion preference (inactive)</label>
          <p class="form-result" data-team-notifications-result role="status" aria-live="polite"></p>
          <button class="primary-action" type="submit" data-team-notifications-submit hidden disabled>Save inactive preferences</button>
        </form>
      </section>
    </article>
    <button type="button" data-team-person-retry hidden>Retry loading person</button>
  </main>

  <dialog class="team-person-dialog" data-team-person-dialog aria-labelledby="team-person-dialog-title">
    <form class="team-person-form" data-team-person-form>
      <header><div><p class="eyebrow">New person</p><h2 id="team-person-dialog-title">Add person</h2></div><button type="button" data-team-person-close aria-label="Close">×</button></header>
      <div class="team-form-pair">
        <label for="ez-team-new-first-name">First name<input id="ez-team-new-first-name" name="first_name" autocomplete="given-name" maxlength="255" required></label>
        <label for="ez-team-new-last-name">Last name<input id="ez-team-new-last-name" name="last_name" autocomplete="family-name" maxlength="255" required></label>
      </div>
      <label for="ez-team-new-email">Sign-in address<input id="ez-team-new-email" name="email" type="email" autocomplete="email" required aria-describedby="team-new-email-hint"></label>
      <p class="hint" id="team-new-email-hint">This address becomes their sign-in identity the moment it is saved, and single sign-on will bind an account to it, so enter one you can vouch for. Nothing is mailed to it yet: tell them their account exists.</p>
      <div class="team-form-pair">
        <label for="ez-team-new-capacity">Weekly capacity (hours)<input id="ez-team-new-capacity" name="weekly_capacity" type="number" inputmode="decimal" min="0" step="0.25" value="35" required></label>
        <label class="team-check"><input name="is_contractor" type="checkbox">Contractor</label>
      </div>
      <div data-team-new-profile-field>
        <label for="ez-team-new-profile">Permission profile<select id="ez-team-new-profile" name="profile" data-team-new-profile></select></label>
        <p class="hint" data-team-new-profile-description></p>
      </div>
      <p class="hint" data-team-new-profile-note hidden>Only an administrator can choose a permission profile. This person joins as a member.</p>
      <p class="hint">Rates, projects, roles and notification preferences are set on the person afterwards.</p>
      <p class="form-result" data-team-person-result role="status" aria-live="polite"></p>
      <button class="primary-action" type="submit" data-team-person-submit>Add person</button>
    </form>
  </dialog>

  <dialog class="team-rate-dialog" data-team-rate-dialog aria-labelledby="team-rate-dialog-title">
    <form data-team-rate-form>
      <header><div><p class="eyebrow">Effective-dated rate</p><h2 id="team-rate-dialog-title" data-team-rate-title>Add rate</h2></div><button type="button" data-team-rate-close aria-label="Close">×</button></header>
      <label>Hourly amount<input name="amount" inputmode="decimal" autocomplete="off" placeholder="125.00" required></label>
      <label>Effective date<input name="start_date" type="date"></label>
      <p class="hint">Clear the effective date only when entering the person's first rate from the beginning.</p>
      <p class="hint">Past entries keep their snapshotted rate. The prior rate period closes the day before this date.</p>
      <p class="form-result" data-team-rate-result role="status" aria-live="polite"></p>
      <button class="primary-action" type="submit" data-team-rate-submit>Add rate</button>
    </form>
  </dialog>

  <dialog class="team-deactivate-dialog" data-team-deactivate-dialog aria-labelledby="team-deactivate-title">
    <form data-team-deactivate-form>
      <header><div><p class="eyebrow">Account status</p><h2 id="team-deactivate-title" data-team-deactivate-heading>Deactivate this person?</h2></div><button type="button" data-team-deactivate-close aria-label="Close">×</button></header>
      <p>They will remain in historical records but cannot track new work, and the same menu puts them back.</p>
      <p class="form-result" data-team-deactivate-result role="status" aria-live="polite"></p>
      <div class="team-confirm-actions"><button type="button" data-team-deactivate-cancel>Cancel</button><button class="danger-action" type="submit" data-team-deactivate-confirm>Deactivate person</button></div>
    </form>
  </dialog>`
