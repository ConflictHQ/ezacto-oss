/**
 * Roles, which could be attached to a person and never managed.
 *
 * `team/render.ts` has always rendered a Roles fieldset, so the four migrated
 * roles could be put on somebody. The resource behind it had no screen at all:
 * `listRoles`, `createRole`, `updateRole` and `deleteRole` were reachable with
 * a token and invisible in the app (issue 485, gap 5). Harvest kept this in
 * Manage; it is account-wide configuration rather than daily work, so it sits
 * in Settings beside the other account-wide setup.
 *
 * A role is a name and nothing else -- `roles` is `(id, harvest_id, name)` --
 * so this is a list, a rename and a delete, with no archive flag to offer.
 */
export const renderRoleAdminPage = (view?: string): string => `
  <main class="app-content task-admin-workspace page--grid" data-role-admin-page${view === 'settings-roles' ? '' : ' hidden'}>
    <header class="context-row task-admin-header">
      <div><p class="eyebrow">Settings</p><h1>Roles</h1></div>
      <button class="primary-action" type="button" data-role-create data-role-write data-auth-action hidden disabled>Add role</button>
    </header>
    <p class="task-admin-intro">The roles a person can hold. They label who does what on the detailed time report; they grant nothing.</p>
    <p class="form-result task-admin-status" data-role-list-status role="status" aria-live="polite">Loading roles…</p>
    <ul class="task-admin-list" data-role-list></ul>
    <button type="button" data-role-list-retry hidden>Retry loading roles</button>
  </main>
  <dialog class="task-admin-dialog" data-role-form-dialog aria-labelledby="role-form-title">
    <form data-role-form>
      <header>
        <div><p class="eyebrow">Role</p><h2 id="role-form-title" data-role-form-title>Add role</h2></div>
        <button type="button" data-role-dialog-close aria-label="Close">×</button>
      </header>
      <div class="task-admin-form-body">
        <label for="ez-role-name">Name
          <input id="ez-role-name" name="name" maxlength="255" autocomplete="off" required>
        </label>
      </div>
      <p class="form-result" data-role-form-result role="status" aria-live="polite"></p>
      <button class="primary-action" type="submit" data-role-form-submit>Save role</button>
    </form>
  </dialog>
  <dialog class="task-admin-dialog task-archive-dialog" data-role-delete-dialog aria-labelledby="role-delete-title">
    <form method="dialog" data-role-delete-form>
      <header>
        <div><p class="eyebrow">Role</p><h2 id="role-delete-title">Delete this role?</h2></div>
        <button value="cancel" aria-label="Close">×</button>
      </header>
      <p data-role-delete-detail>Deleting a role takes it off everyone who holds it. Their time entries are untouched.</p>
      <p class="form-result" data-role-delete-result role="status" aria-live="polite"></p>
      <div class="task-admin-confirm-actions">
        <button value="cancel">Cancel</button>
        <button class="danger-action" type="submit" value="confirm" data-role-delete-confirm>Delete role</button>
      </div>
    </form>
  </dialog>`
