export const renderGithubReaderSettings = (): string => `
  <section class="settings-section" data-settings-section="work-items" aria-labelledby="settings-work-items-title">
    <header><div class="settings-section-heading"><h2 id="settings-work-items-title">Work items</h2><button type="button" class="settings-refresh" data-github-reader-refresh>Refresh GitHub status</button></div>
    <p>Read GitHub issues into the projects and tasks you choose. This connection reads issue metadata; it does not write to GitHub.</p></header>
    <p class="form-result" data-github-reader-status role="status" aria-live="polite">Loading GitHub connection…</p>
    <p class="hint" data-github-reader-setup-return hidden></p>
    <div data-github-reader-content hidden>
      <form class="settings-form" data-github-reader-setup hidden>
        <h3>Create a private GitHub App</h3>
        <label>GitHub organization (optional)<input name="organization" autocomplete="off" maxlength="39" pattern="[A-Za-z0-9][A-Za-z0-9-]*"><span class="hint">Leave blank to create the App under your own GitHub account.</span></label>
        <button type="submit">Review GitHub App setup</button>
      </form>
      <div data-github-reader-manifest-review hidden>
        <h3>Review App permissions</h3>
        <p>GitHub will ask you to create a private App with read access to issues and repository metadata. You choose which repositories it can access when installing it.</p>
        <details><summary>View the exact App manifest</summary><pre data-github-reader-manifest></pre></details>
        <form class="settings-form" method="post" target="_blank" rel="noopener noreferrer" data-github-reader-manifest-form>
          <input type="hidden" name="manifest">
          <label class="settings-toggle"><input type="checkbox" data-github-reader-manifest-reviewed> I reviewed the App permissions and want to continue to GitHub.</label>
          <button type="submit" data-github-reader-manifest-submit disabled>Continue to GitHub</button>
        </form>
      </div>
      <p><a data-github-reader-install hidden target="_blank" rel="noopener noreferrer">Install GitHub App</a></p>
      <form class="settings-form" data-github-reader-mapping hidden>
        <h3>Map a repository</h3>
        <label>GitHub installation<select name="installation" required><option value="">Choose an installation</option></select></label>
        <button type="button" data-github-reader-more-installations hidden>Load more installations</button>
        <label>Repository<select name="repository" required disabled><option value="">Choose an installation first</option></select></label>
        <button type="button" data-github-reader-more-repositories hidden>Load more repositories</button>
        <label>Project<select name="project" required><option value="">Choose a project</option></select></label>
        <label>Task<select name="task" required disabled><option value="">Choose a project first</option></select></label>
        <p class="hint">Only active tasks assigned to the selected project are offered.</p>
        <button type="submit">Save repository mapping</button>
      </form>
      <h3>Repository connections</h3><div data-github-reader-connections></div>
      <button type="button" data-github-reader-sync hidden>Sync GitHub issues now</button>
    </div>
  </section>`
