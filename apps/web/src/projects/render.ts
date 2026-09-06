export const renderProjectDirectoryPages = (view?: string): string => `
  <main class="app-content project-workspace" data-project-list-page${view === 'project-list' ? '' : ' hidden'}>
    <header class="context-row">
      <div><p class="eyebrow">Work</p><h1>Projects</h1></div>
      <button class="primary-action" type="button" data-project-create data-project-mutation-action data-project-write data-auth-action hidden disabled>Add project</button>
    </header>
    <p class="project-intro">Find active work by client, or include archived projects for reference.</p>
    <div class="project-list-toolbar">
      <fieldset aria-label="Project status">
        <legend class="visually-hidden">Project status</legend>
        <button type="button" data-project-filter="active" aria-pressed="true">Active</button>
        <button type="button" data-project-filter="all" aria-pressed="false">All</button>
      </fieldset>
      <label for="ez-project-client-filter">Client
        <select id="ez-project-client-filter" data-project-client-filter><option value="">All clients</option></select>
      </label>
    </div>
    <p class="form-result project-page-status" data-project-list-status role="status" aria-live="polite">Loading projects…</p>
    <div data-project-list></div>
    <button type="button" data-project-list-retry hidden>Retry loading projects</button>
  </main>
  <main class="app-content project-workspace" data-project-detail-page${view === 'project-detail' ? '' : ' hidden'}>
    <header class="context-row">
      <div><p class="eyebrow">Projects</p><h1 data-project-detail-name>Project detail</h1></div>
      <div class="project-header-actions">
        <a href="/projects">Back to projects</a>
        <button type="button" data-project-edit data-project-mutation-action data-project-write data-auth-action hidden disabled>Edit</button>
        <button type="button" data-project-archive data-project-mutation-action data-project-write data-auth-action hidden disabled>Archive</button>
      </div>
    </header>
    <p class="form-result project-page-status" data-project-detail-status role="status" aria-live="polite">Loading project…</p>
    <article class="project-detail" data-project-detail hidden>
      <section class="project-facts" aria-labelledby="project-facts-heading">
        <h2 id="project-facts-heading">Project details</h2>
        <dl data-project-facts></dl>
      </section>
      <section class="project-tasks" aria-labelledby="project-tasks-heading">
        <header>
          <div><p class="eyebrow">Time entry</p><h2 id="project-tasks-heading">Assigned tasks</h2></div>
          <button type="button" data-task-assignment-create data-project-mutation-action data-project-write data-auth-action hidden disabled>Assign task</button>
        </header>
        <p class="project-section-status" data-project-tasks-status role="status" aria-live="polite"></p>
        <ul data-project-task-assignments></ul>
      </section>
      <section class="project-attachments" aria-labelledby="project-attachments-heading">
        <header><div><p class="eyebrow">Files</p><h2 id="project-attachments-heading">Attachments</h2></div></header>
        <form data-project-attachment-form hidden>
          <label for="ez-project-attachment">Attach a file
            <input id="ez-project-attachment" name="file" type="file" required>
          </label>
          <button type="submit" data-project-attachment-submit>Upload</button>
          <p class="hint">One file, up to 25 MB.</p>
        </form>
        <p class="project-section-status" data-project-attachment-status role="status" aria-live="polite"></p>
        <ul data-project-attachments></ul>
      </section>
    </article>
    <button type="button" data-project-detail-retry hidden>Retry loading project</button>
  </main>
  <dialog class="project-form-dialog" data-project-form-dialog aria-labelledby="project-form-title">
    <form data-project-form>
      <header><div><p class="eyebrow">Project</p><h2 id="project-form-title" data-project-form-title>Add project</h2></div><button type="button" data-project-dialog-close aria-label="Close">×</button></header>
      <div class="project-form-body" data-project-form-body></div>
      <p class="form-result" data-project-form-result role="status" aria-live="polite"></p>
      <button class="primary-action" type="submit" data-project-form-submit>Save project</button>
    </form>
  </dialog>
  <dialog class="task-assignment-dialog" data-task-assignment-dialog aria-labelledby="task-assignment-title">
    <form data-task-assignment-form>
      <header><div><p class="eyebrow">Project task</p><h2 id="task-assignment-title" data-task-assignment-title>Assign task</h2></div><button type="button" data-task-assignment-dialog-close aria-label="Close">×</button></header>
      <div class="project-form-body" data-task-assignment-form-body></div>
      <p class="form-result" data-task-assignment-form-result role="status" aria-live="polite"></p>
      <button class="primary-action" type="submit" data-task-assignment-form-submit>Save task assignment</button>
    </form>
  </dialog>
  <dialog class="project-archive-dialog" data-project-archive-dialog aria-labelledby="project-archive-title">
    <form method="dialog" data-project-archive-form>
      <header><div><p class="eyebrow">Project status</p><h2 id="project-archive-title">Archive this project?</h2></div><button value="cancel" aria-label="Close">×</button></header>
      <p>Archived projects remain in the All view and are unavailable for new time.</p>
      <p class="form-result" data-project-archive-result role="status" aria-live="polite"></p>
      <div class="project-confirm-actions"><button value="cancel">Cancel</button><button class="danger-action" type="submit" value="confirm" data-project-archive-confirm>Archive project</button></div>
    </form>
  </dialog>
  <dialog class="project-archive-dialog" data-task-assignment-archive-dialog aria-labelledby="task-assignment-archive-title">
    <form method="dialog" data-task-assignment-archive-form>
      <header><div><p class="eyebrow">Project task</p><h2 id="task-assignment-archive-title">Archive this task assignment?</h2></div><button value="cancel" aria-label="Close">×</button></header>
      <p>The task will no longer be available for new time on this project.</p>
      <p class="form-result" data-task-assignment-archive-result role="status" aria-live="polite"></p>
      <div class="project-confirm-actions"><button value="cancel">Cancel</button><button class="danger-action" type="submit" value="confirm" data-task-assignment-archive-confirm>Archive assignment</button></div>
    </form>
  </dialog>`
