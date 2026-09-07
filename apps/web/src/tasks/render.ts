export const renderTaskAdminPage = (view?: string): string => `
  <main class="app-content task-admin-workspace" data-task-admin-page${view === 'task-list' ? '' : ' hidden'}>
    <header class="context-row task-admin-header">
      <div><p class="eyebrow">Work</p><h1>Tasks</h1></div>
      <button class="primary-action" type="button" data-task-create data-task-write data-auth-action hidden disabled>Add task</button>
    </header>
    <p class="task-admin-intro">Manage the account-wide task templates available to projects and time entries.</p>
    <div class="task-admin-toolbar">
      <fieldset aria-label="Task status">
        <legend class="visually-hidden">Task status</legend>
        <button type="button" data-task-filter="active" aria-pressed="true">Active</button>
        <button type="button" data-task-filter="all" aria-pressed="false">All</button>
      </fieldset>
    </div>
    <p class="form-result task-admin-status" data-task-list-status role="status" aria-live="polite">Loading tasks…</p>
    <div class="task-admin-list" data-task-list></div>
    <button type="button" data-task-load-more hidden>Load more tasks</button>
    <button type="button" data-task-list-retry hidden>Retry loading tasks</button>
  </main>
  <dialog class="task-admin-dialog" data-task-form-dialog aria-labelledby="task-form-title">
    <form data-task-form>
      <header>
        <div><p class="eyebrow">Task template</p><h2 id="task-form-title" data-task-form-title>Add task</h2></div>
        <button type="button" data-task-dialog-close aria-label="Close">×</button>
      </header>
      <div class="task-admin-form-body">
        <label for="ez-task-name">Name
          <input id="ez-task-name" name="name" maxlength="255" autocomplete="off" required>
        </label>
        <label data-task-rate-field for="ez-task-rate">Default hourly rate
          <input id="ez-task-rate" name="default_hourly_rate" inputmode="decimal" placeholder="0.00">
          <span class="hint">USD per hour. Leave blank for no default rate.</span>
        </label>
        <label class="task-admin-check"><input name="billable_by_default" type="checkbox">Billable by default</label>
        <label class="task-admin-check"><input name="is_default" type="checkbox">Automatically add to new projects</label>
        <label class="task-admin-check"><input name="is_active" type="checkbox">Active and available for new work</label>
      </div>
      <p class="form-result" data-task-form-result role="status" aria-live="polite"></p>
      <button class="primary-action" type="submit" data-task-form-submit>Save task</button>
    </form>
  </dialog>
  <dialog class="task-admin-dialog task-archive-dialog" data-task-archive-dialog aria-labelledby="task-archive-title">
    <form method="dialog" data-task-archive-form>
      <header>
        <div><p class="eyebrow">Task status</p><h2 id="task-archive-title">Archive this task?</h2></div>
        <button value="cancel" aria-label="Close">×</button>
      </header>
      <p>Archived tasks remain in the All view but are unavailable for new work.</p>
      <p class="form-result" data-task-archive-result role="status" aria-live="polite"></p>
      <div class="task-admin-confirm-actions">
        <button value="cancel">Cancel</button>
        <button class="danger-action" type="submit" value="confirm" data-task-archive-confirm>Archive task</button>
      </div>
    </form>
  </dialog>`
