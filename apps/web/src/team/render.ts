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
  <main class="app-content team-workspace" data-team-list-page${view === 'team-list' ? '' : ' hidden'}>
    <header class="context-row">
      <div><p class="eyebrow">Organize</p><h1>Team</h1></div>
    </header>
    <section class="team-period" aria-label="Utilization period">
      <button type="button" data-team-week-previous aria-label="Previous week">←</button>
      <strong data-team-week-label>—</strong>
      <button type="button" data-team-week-next aria-label="Next week">→</button>
      <button type="button" data-team-week-current>This week</button>
    </section>
    <div class="team-list-toolbar">
      <fieldset aria-label="People status">
        <legend class="visually-hidden">People status</legend>
        <button type="button" data-team-filter="active" aria-pressed="true">Active</button>
        <button type="button" data-team-filter="all" aria-pressed="false">All</button>
      </fieldset>
      <label for="ez-team-search">Find a person
        <input id="ez-team-search" type="search" data-team-search autocomplete="off" placeholder="Name or email">
      </label>
    </div>
    <section class="team-summary" data-team-summary aria-label="Team utilization summary" hidden></section>
    <p class="form-result team-page-status" data-team-list-status role="status" aria-live="polite">Loading team…</p>
    <ol class="team-card-list" data-team-list aria-label="People"></ol>
    <button type="button" data-team-list-retry hidden>Retry loading team</button>
  </main>

  <main class="app-content team-workspace" data-team-person-page${view === 'team-person' ? '' : ' hidden'}>
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

      <section class="team-person-panel" id="team-panel-notifications" role="tabpanel" aria-labelledby="team-tab-notifications" data-team-panel="notifications" hidden>
        <header><div><p class="eyebrow">Reminders</p><h2>Notifications</h2></div></header>
        <form data-team-notifications-form>
          <label class="team-check"><input name="daily_reminder_enabled" type="checkbox">Send a daily time reminder</label>
          <label>Reminder time<input name="reminder_time" type="time"></label>
          <fieldset><legend>Reminder days</legend><div class="team-weekdays">${weekdays.map(([value, label]) => `<label><input type="checkbox" name="reminder_days" value="${value}">${label}</label>`).join('')}</div></fieldset>
          <fieldset><legend>Reminder channels</legend>
            <label class="team-check"><input name="channel_email" type="checkbox">Inbox delivery</label>
            <label class="team-check"><input name="channel_desktop" type="checkbox">Desktop</label>
            <label class="team-check"><input name="channel_slack" type="checkbox">Slack</label>
            <p class="hint" data-team-slack-status>Slack delivery is unavailable because no connector is configured.</p>
          </fieldset>
          <label class="team-check"><input name="include_in_team_reminders" type="checkbox">Include in team reminders</label>
          <label class="team-check"><input name="weekly_digest" type="checkbox">Send weekly digest</label>
          <label class="team-check"><input name="notify_project_deleted" type="checkbox">Notify when an assigned project is deleted</label>
          <p class="form-result" data-team-notifications-result role="status" aria-live="polite"></p>
          <button class="primary-action" type="submit" data-team-notifications-submit>Save notifications</button>
        </form>
      </section>
    </article>
    <button type="button" data-team-person-retry hidden>Retry loading person</button>
  </main>

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
      <header><div><p class="eyebrow">Account status</p><h2 id="team-deactivate-title">Deactivate this person?</h2></div><button type="button" data-team-deactivate-close aria-label="Close">×</button></header>
      <p>They will remain in historical records but cannot track new work.</p>
      <label>Type <strong>DEACTIVATE</strong> to confirm<input name="confirmation" autocomplete="off" required></label>
      <p class="form-result" data-team-deactivate-result role="status" aria-live="polite"></p>
      <div class="team-confirm-actions"><button type="button" data-team-deactivate-cancel>Cancel</button><button class="danger-action" type="submit" data-team-deactivate-confirm>Deactivate person</button></div>
    </form>
  </dialog>`
