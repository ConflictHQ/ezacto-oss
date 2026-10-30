export const renderGithubPublicationSettings = (): string => `
  <section data-github-publications aria-labelledby="github-publication-title">
    <h3 id="github-publication-title">Publish time notes to GitHub</h3>
    <p>Publication is off by default. Enable a connection, then review each time entry before allowing its date and duration to appear as a GitHub issue comment. Notes, rates and amounts are not included.</p>
    <p data-gh-pub-status class="form-result" role="status" aria-live="polite"></p>
    <div data-gh-pub-content hidden>
      <button type="button" data-gh-pub-refresh>Refresh publication status</button>
      <div data-gh-pub-policies></div>
      <form class="settings-form" data-gh-pub-preview-form>
        <label>Time entry<select data-gh-pub-candidate required><option value="">Choose a linked time entry</option></select></label>
        <button type="submit">Preview comment</button>
      </form>
      <div data-gh-pub-preview hidden>
        <p data-gh-pub-preview-text></p>
        <label class="settings-toggle"><input type="checkbox" data-gh-pub-consent> I reviewed this destination, date and duration and allow this entry to be published and kept in sync.</label>
        <button type="button" data-gh-pub-publish disabled>Allow this time note</button>
      </div>
      <div data-gh-pub-rows></div>
    </div>
  </section>`
