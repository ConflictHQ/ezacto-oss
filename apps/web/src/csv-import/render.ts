/** The Clockify-only interface. Private values are inserted as text by the controller. */
export const renderCsvImportPanel = (): string => `
<section class="csv-import" data-csv-import aria-labelledby="csv-import-title">
  <header><h3 id="csv-import-title">Import Clockify time</h3>
    <p>Use a Clockify Detailed report CSV with ISO dates and unrounded HH:MM:SS durations. This imports time and reviewed people, clients, projects, tasks and assignments. Invoices, payments, expenses, attachments, source prices and credentials are excluded.</p>
  </header>
  <p data-csv-status class="form-result" role="status" aria-live="polite">Checking browser import availability…</p>
  <button type="button" data-csv-retry hidden>Retry import availability</button>
  <div data-csv-private hidden>
    <form class="settings-form" data-csv-upload-form>
      <h4>1. Choose the CSV</h4>
      <label>Clockify Detailed CSV<input type="file" name="file" accept=".csv,text/csv" required></label>
      <p class="hint">Maximum 5 MiB. The file stays in private staging. Upload and preview do not create people, clients, projects, tasks, assignments or time.</p>
      <button type="submit" class="primary-action">Upload for review</button>
    </form>
    <div data-csv-run-facts hidden></div>
    <button type="button" data-csv-reload hidden>Reload saved choices and status</button>
    <form class="settings-form" data-csv-source-form hidden>
      <h4>2. Identify this source</h4>
      <label>Clockify workspace identity<input name="workspace" maxlength="255" required autocomplete="off"></label>
      <p class="hint">Use the stable identity of the workspace this export belongs to. This organization keeps one registered dataset; changing a name cannot bypass its sealed import history.</p>
      <label>Exporter timezone<input name="zone" maxlength="100" required autocomplete="off" placeholder="For example, America/Costa_Rica"></label>
      <p class="hint">Enter the IANA timezone used for this export. Dates must be YYYY-MM-DD. Source wall-clock values are interpreted in that zone; your device timezone is not substituted.</p>
      <button type="submit" class="primary-action">Read mapping and preview</button>
    </form>
    <section data-csv-mapping hidden aria-labelledby="csv-mapping-title">
      <h4 id="csv-mapping-title">3. Review destination mappings</h4>
      <p>Review each source within its client and project. Choose exact destination records, or explicitly name new setup. New people remain inactive and receive no invitation.</p>
      <div class="csv-import-kinds" role="group" aria-label="Mapping category">
        <button type="button" data-csv-kind="people" aria-pressed="true">People</button>
        <button type="button" data-csv-kind="clients" aria-pressed="false">Clients</button>
        <button type="button" data-csv-kind="projects" aria-pressed="false">Projects</button>
        <button type="button" data-csv-kind="tasks" aria-pressed="false">Tasks</button>
      </div>
      <p data-csv-catalog-status class="form-result" role="status" aria-live="polite"></p>
      <div data-csv-catalog></div>
      <button type="button" data-csv-catalog-more hidden>Load more source mappings</button>
      <button type="button" class="primary-action" data-csv-save-mapping>Save choices and refresh preview</button>
    </section>
    <section data-csv-review hidden aria-labelledby="csv-review-title">
      <h4 id="csv-review-title">4. Review the immutable selection</h4>
      <div data-csv-preview-facts></div>
      <p>Time is unpriced in this preview. Source monetary values are ignored; the destination’s currencies, assignment billability and current rates determine saved time. Organization currency is not an estimate or a currency conversion.</p>
      <div data-csv-diagnostics>
        <h5>All diagnostics</h5>
        <label>Diagnostic category<select data-csv-error-kind><option value="all">All categories</option><option value="invalid">Invalid</option><option value="unsupported">Unsupported</option><option value="warning">Warnings</option></select></label>
        <p data-csv-errors-status class="form-result" role="status" aria-live="polite"></p>
        <div data-csv-errors></div>
        <button type="button" data-csv-errors-more hidden>Load more diagnostics</button>
        <button type="button" data-csv-download>Download all static diagnostics</button>
      </div>
      <form class="settings-form" data-csv-exclusions-form>
        <label>Excluded physical lines<input name="lines" autocomplete="off" inputmode="numeric" placeholder="For example, 3, 7, 12"></label>
        <p class="hint">File errors cannot be excluded. Every excluded row must be explicitly reviewed. Changing exclusions creates a new preview and clears confirmation.</p>
        <button type="submit" class="primary-action">Review this exact selection</button>
      </form>
      <form class="settings-form" data-csv-confirm-form>
        <p data-csv-confirm-state></p>
        <label class="settings-toggle"><input type="checkbox" name="reviewed">I reviewed this destination, file, dataset, mappings and exact selected rows.</label>
        <label class="settings-toggle" data-csv-ack-exclusions hidden><input type="checkbox" name="exclusions">I reviewed every excluded physical line and accept that this is a partial dataset.</label>
        <label class="settings-toggle" data-csv-ack-difference hidden><input type="checkbox" name="difference">I reviewed the source and destination seconds and their difference, including any imported history.</label>
        <label class="settings-toggle" data-csv-ack-people hidden><input type="checkbox" name="people">I reviewed the new inactive people. No one is invited or activated.</label>
        <button type="submit" class="primary-action" data-csv-apply disabled>Confirm and apply this preview</button>
      </form>
    </section>
    <section data-csv-progress hidden aria-labelledby="csv-progress-title">
      <h4 id="csv-progress-title">Import progress</h4>
      <p data-csv-progress-status class="form-result" role="status" aria-live="polite"></p>
      <div data-csv-progress-facts></div>
      <p>Stopping never rolls back committed time or setup. Only future chunks stop; normal organization work continues.</p>
      <div class="csv-import-actions">
        <button type="button" data-csv-refresh-status>Refresh authoritative status</button>
        <button type="button" data-csv-retry-command hidden>Retry the same unknown command</button>
        <button type="button" data-csv-resume hidden>Review and resume the remaining rows</button>
        <button type="button" data-csv-cancel hidden>Stop future chunks</button>
      </div>
    </section>
    <button type="button" data-csv-purge hidden>Purge staged input and diagnostics</button>
    <p data-csv-retention class="hint"></p>
  </div>
</section>`
