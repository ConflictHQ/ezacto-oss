/**
 * The recurring pane behind the Invoices strip's second tab.
 *
 * It replaces the labelled empty state that shipped with the strip, which said
 * of itself that `/api/v1/recurring-invoices` already served it and this screen
 * did not read it yet. It does now.
 *
 * List and detail live in one route, `/invoices/recurring`, with `?definition=`
 * naming the open one -- the same shape the retainers pane next door uses for
 * `?retainer=`. Every value is filled in by the controller, so the markup
 * states nothing it has not read.
 *
 * The issue button is the reason the screen exists rather than a report would
 * do. It is a confirmed action: a recurring invoice is a document that goes to
 * a client, and a button that raises one on a single click is a button someone
 * will press by accident.
 *
 * The editor is the second reason. `POST`, `PATCH` and `DELETE` on this
 * resource have been served since the API shipped and no screen called any of
 * them, so the three live definitions on this account were loaded by a script
 * and one of them was corrected in production by hand-written SQL. Everything
 * a definition stores is editable here, including the two keys migrations 0041
 * and 0044 added: a line's `through` date, and the `installments` total that
 * lets it count itself off in its own text.
 */

export const renderRecurringPage = (view?: string): string => `
  <main class="app-content invoice-workspace recurring-workspace page--grid" data-invoice-recurring-page${view === 'invoice-recurring' ? '' : ' hidden'}>
    <header class="context-row">
      <div><p class="eyebrow">Money</p><h1>Recurring</h1></div>
    </header>
    <section data-recurring-list-view aria-labelledby="recurring-list-heading">
      <h2 class="visually-hidden" id="recurring-list-heading">Recurring invoices</h2>
      <p class="invoice-intro">Standing instructions that raise an invoice on a cadence. Open one to see what it will bill for, and issue the period it is due.</p>
      <div class="recurring-toolbar">
        <label class="visually-hidden" for="ez-recurring-search">Search recurring invoices</label>
        <input id="ez-recurring-search" type="search" data-recurring-search placeholder="Search by client or subject" autocomplete="off">
        <button class="primary-action" type="button" data-recurring-write data-recurring-new hidden>New recurring invoice</button>
      </div>
      <p class="form-result invoice-page-status" data-recurring-list-status role="status" aria-live="polite">Loading recurring invoices…</p>
      <div data-recurring-list></div>
      <div class="recurring-actions">
        <button class="invoice-load-more" type="button" data-recurring-load-more hidden>Load more recurring invoices</button>
        <button class="invoice-load-more" type="button" data-recurring-list-retry hidden>Retry loading recurring invoices</button>
      </div>
    </section>
    <section class="recurring-detail" data-recurring-detail-view hidden aria-labelledby="recurring-detail-heading">
      <div class="recurring-detail-heading">
        <div>
          <p class="eyebrow" data-recurring-detail-client>Recurring</p>
          <h2 id="recurring-detail-heading" data-recurring-detail-title>Recurring invoice</h2>
        </div>
        <div class="recurring-detail-actions">
          <button type="button" data-recurring-write data-recurring-edit hidden>Edit definition</button>
          <button type="button" data-recurring-write data-recurring-delete hidden>Delete definition</button>
          <a class="recurring-detail-back" href="/invoices/recurring" data-recurring-back>Back to recurring</a>
        </div>
      </div>
      <p class="form-result invoice-page-status" data-recurring-detail-status role="status" aria-live="polite">Loading recurring invoice…</p>
      <div class="recurring-actions">
        <button class="invoice-load-more" type="button" data-recurring-detail-retry hidden>Retry loading this definition</button>
      </div>
      <div data-recurring-detail-body hidden>
        <dl class="recurring-facts">
          <div><dt>Client</dt><dd data-recurring-client>—</dd></div>
          <div><dt>Cadence</dt><dd data-recurring-cadence>—</dd></div>
          <div><dt>Next issue</dt><dd data-recurring-next>—</dd></div>
          <div><dt>Status</dt><dd data-recurring-due>—</dd></div>
          <div><dt>Bills</dt><dd data-recurring-basis>—</dd></div>
          <div><dt>Amount</dt><dd data-recurring-amount>—</dd></div>
          <div data-recurring-retainer-row hidden><dt>Draws from</dt><dd data-recurring-retainer>—</dd></div>
        </dl>
        <section class="recurring-issue" aria-labelledby="recurring-issue-heading">
          <h3 id="recurring-issue-heading">Issue this period</h3>
          <p class="hint" data-recurring-issue-hint>Raises the invoice this definition is due for and moves the cadence on. Nothing is sent to the client.</p>
          <button class="primary-action" type="button" data-recurring-issue disabled>Issue invoice</button>
          <p class="form-result" data-recurring-issue-result role="status" aria-live="polite"></p>
          <a class="recurring-issued-link" data-recurring-issued-link href="/invoices" hidden>Open the invoice</a>
        </section>
        <section class="recurring-config" aria-labelledby="recurring-config-heading">
          <h3 id="recurring-config-heading">What it bills</h3>
          <p class="hint" data-recurring-config-hint>—</p>
          <div data-recurring-config></div>
        </section>
        <section class="recurring-templates" aria-labelledby="recurring-templates-heading">
          <h3 id="recurring-templates-heading">On the invoice</h3>
          <dl class="recurring-facts">
            <div><dt>Subject</dt><dd data-recurring-subject>—</dd></div>
            <div><dt>Notes</dt><dd data-recurring-notes>—</dd></div>
          </dl>
        </section>
      </div>
    </section>
    <dialog class="recurring-confirm-dialog" data-recurring-confirm aria-labelledby="recurring-confirm-title">
      <form data-recurring-confirm-form method="dialog">
        <header>
          <div><p class="eyebrow">Money</p><h2 id="recurring-confirm-title">Issue this invoice?</h2></div>
          <button type="button" data-recurring-confirm-cancel aria-label="Close">×</button>
        </header>
        <p data-recurring-confirm-body>This raises a draft invoice and moves the cadence on.</p>
        <footer>
          <button type="button" data-recurring-confirm-cancel>Cancel</button>
          <button class="primary-action" type="submit" data-recurring-confirm-submit>Issue invoice</button>
        </footer>
      </form>
    </dialog>
    <dialog class="recurring-editor-dialog" data-recurring-editor aria-labelledby="recurring-editor-title">
      <form class="recurring-editor-form" data-recurring-editor-form novalidate>
        <header>
          <div><p class="eyebrow">Money</p><h2 id="recurring-editor-title" data-recurring-editor-title>New recurring invoice</h2></div>
          <button type="button" data-recurring-editor-cancel aria-label="Close">×</button>
        </header>
        <div class="recurring-editor-grid">
          <label>Client<select data-recurring-editor-client required></select>
            <span class="field-hint" data-recurring-client-hint hidden>The client cannot change once this definition has raised an invoice.</span>
          </label>
          <label>Months between issues<input data-recurring-editor-every inputmode="numeric" pattern="[0-9]+" min="1" step="1" required></label>
          <label>Day of month<input data-recurring-editor-day inputmode="numeric" pattern="[0-9]+" min="1" max="31" step="1" required></label>
          <label>Next issue<input type="date" data-recurring-editor-next required></label>
          <label>Draws from retainer <span class="hint">Optional. The retainer's id.</span><input data-recurring-editor-retainer inputmode="numeric" pattern="[0-9]*" min="1" step="1" autocomplete="off"></label>
        </div>
        <label>Subject<input data-recurring-editor-subject maxlength="2000" autocomplete="off" required></label>
        <label>Notes<textarea data-recurring-editor-notes rows="3"></textarea></label>
        <p class="hint">Subject and notes expand <code>%invoice_issue_month_name%</code>, <code>%invoice_issue_year%</code> and <code>%invoice_issue_date%</code> when the invoice is raised.</p>
        <label>Bills<select data-recurring-editor-type>
          <option value="fixed_lines">The same lines every period</option>
          <option value="line_items_import">Whatever is uninvoiced on some projects</option>
        </select></label>
        <section class="recurring-editor-lines" data-recurring-editor-fixed aria-labelledby="recurring-editor-lines-heading">
          <h3 id="recurring-editor-lines-heading">Fixed lines</h3>
          <p class="hint">A line with a <em>through</em> date stops appearing once that day has passed. Give it an installment total as well and it can count itself off in its own description with <code>%line_installment_number%</code> and <code>%line_installment_total%</code> — "CREDIT 2 of 4".</p>
          <div data-recurring-editor-line-list></div>
          <button type="button" data-recurring-editor-add-line>Add a line</button>
          <label>Covers the time on <span class="hint">Optional. A banded team: the amount stays the same and these projects' hours are claimed by it rather than billed.</span><select multiple size="4" data-recurring-editor-claims></select></label>
          <p class="hint">Leave this empty for an ordinary fixed invoice, which ignores tracked time entirely. Choosing projects makes the hours stop reading as uninvoiced, so they cannot be billed a second time, and records what the flat rate absorbed.</p>
        </section>
        <section class="recurring-editor-import" data-recurring-editor-import hidden aria-labelledby="recurring-editor-import-heading">
          <h3 id="recurring-editor-import-heading">Uninvoiced work</h3>
          <p class="hint">The amount is not known until it runs. Choose the projects it sweeps and how the lines are summarised.</p>
          <label>Projects<select multiple size="6" data-recurring-editor-projects></select></label>
          <label class="recurring-editor-check"><input type="checkbox" data-recurring-editor-time-on>Bill uninvoiced hours</label>
          <label>Summarise hours<select data-recurring-editor-time-summary>
            <option value="project">By project</option>
            <option value="task">By task</option>
            <option value="people">By person</option>
            <option value="detailed">In detail</option>
          </select></label>
          <label class="recurring-editor-check"><input type="checkbox" data-recurring-editor-expenses-on>Bill uninvoiced expenses</label>
          <label>Summarise expenses<select data-recurring-editor-expenses-summary>
            <option value="project">By project</option>
            <option value="category">By category</option>
            <option value="people">By person</option>
            <option value="detailed">In detail</option>
          </select></label>
        </section>
        <footer>
          <button type="button" data-recurring-editor-cancel>Cancel</button>
          <button class="primary-action" type="submit" data-recurring-editor-submit>Save definition</button>
        </footer>
        <p class="form-result" data-recurring-editor-result role="status" aria-live="polite"></p>
      </form>
    </dialog>
    <template data-recurring-line-template>
      <fieldset class="recurring-editor-line" data-recurring-line>
        <legend data-recurring-line-position>Line</legend>
        <label>Kind<input data-recurring-line-field="kind" autocomplete="off"></label>
        <label>Description<input data-recurring-line-field="description" autocomplete="off"></label>
        <label>Project<select data-recurring-line-field="projectId"></select></label>
        <label>Quantity<input data-recurring-line-field="quantity" inputmode="decimal" autocomplete="off"></label>
        <label>Unit price (cents)<input data-recurring-line-field="unitPriceCents" inputmode="numeric" autocomplete="off"></label>
        <label>Through <span class="hint">Optional. The last issue this line appears on.</span><input type="date" data-recurring-line-field="through"></label>
        <label>Installments <span class="hint">Optional. Needs a through date.</span><input data-recurring-line-field="installments" inputmode="numeric" min="1" step="1" autocomplete="off"></label>
        <label class="recurring-editor-check"><input type="checkbox" data-recurring-line-field="taxed">Tax</label>
        <label class="recurring-editor-check"><input type="checkbox" data-recurring-line-field="taxed2">Tax 2</label>
        <button type="button" data-recurring-line-remove>Remove line</button>
      </fieldset>
    </template>
    <dialog class="recurring-confirm-dialog" data-recurring-delete-confirm aria-labelledby="recurring-delete-title">
      <form data-recurring-delete-form>
        <header>
          <div><p class="eyebrow">Money</p><h2 id="recurring-delete-title">Delete this definition?</h2></div>
          <button type="button" data-recurring-delete-cancel aria-label="Close">×</button>
        </header>
        <p data-recurring-delete-body>Nothing it has already raised is touched. It simply stops raising anything more.</p>
        <footer>
          <button type="button" data-recurring-delete-cancel>Cancel</button>
          <button class="primary-action" type="submit" data-recurring-delete-submit>Delete definition</button>
        </footer>
        <p class="form-result" data-recurring-delete-result role="status" aria-live="polite"></p>
      </form>
    </dialog>
  </main>`
