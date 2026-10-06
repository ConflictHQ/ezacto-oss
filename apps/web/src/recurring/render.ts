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
 * a definition stores is editable, including the two keys migrations 0041 and
 * 0044 added: a line's `through` date, and the `installments` total that lets
 * it count itself off in its own text. The editor itself is a page of its own,
 * below; this pane links to it.
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
        <a class="primary-action recurring-new-link" href="/invoices/recurring/new" data-recurring-write data-recurring-new hidden>New recurring invoice</a>
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
          <a class="recurring-edit-link" href="/invoices/recurring" data-recurring-write data-recurring-edit hidden>Edit definition</a>
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
            <div data-recurring-purchase-order-row hidden><dt>Purchase order</dt><dd data-recurring-purchase-order>—</dd></div>
          </dl>
        </section>
        <section class="recurring-files" data-recurring-files aria-labelledby="recurring-files-heading" hidden>
          <h3 id="recurring-files-heading">Attachments</h3>
          <p class="hint">Attached to every invoice this definition issues, until the date set on each.</p>
          <p class="form-result" data-recurring-files-status role="status" aria-live="polite"></p>
          <ul class="recurring-attachment-list" data-recurring-files-list></ul>
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

/**
 * The definition editor, as a page of its own (`/invoices/recurring/new` and
 * `/invoices/recurring/:id/edit`).
 *
 * It was a dialog, and a definition is too much for one: a schedule, two
 * templates, a choice of amount, a band of covered hours with its ceiling, and
 * a table of lines whose every row carries nine fields. At dialog width the
 * table scrolled sideways under its own labels and clipped them at the left.
 * Here every section runs at page width, the lines are a table that reflows to
 * cards on a phone, and Save sits in a band at the foot of the window so it is
 * never below the fold of a long definition.
 *
 * The confirmations stay dialogs on the workspace (issuing and deleting are
 * single questions), and every control keeps the data attribute it had in the
 * dialog: the controller, the tests and the browser suite address the same
 * fields they always did.
 */
export const renderRecurringEditorPage = (view?: string): string => `
  <main class="app-content invoice-workspace editor-page page--settings" data-recurring-editor-page${view === 'invoice-recurring-editor' ? '' : ' hidden'}>
    <header class="context-row editor-page-heading">
      <div><p class="eyebrow" data-recurring-editor-eyebrow>Recurring invoice</p><h1 id="recurring-editor-title" data-recurring-editor-title>New recurring invoice</h1></div>
      <a class="editor-back" href="/invoices/recurring" data-recurring-editor-back>Back to recurring</a>
    </header>
    <p class="form-result invoice-page-status" data-recurring-editor-status role="status" aria-live="polite">Loading the editor…</p>
    <button class="invoice-load-more" type="button" data-recurring-editor-retry hidden>Retry loading</button>
    <form class="editor-form" data-recurring-editor-form aria-labelledby="recurring-editor-title" novalidate hidden>
      <section class="editor-section" aria-labelledby="recurring-editor-schedule-heading">
        <h2 id="recurring-editor-schedule-heading">Client and schedule</h2>
        <div class="editor-grid">
          <div class="editor-field editor-span-2">
            <label>Client<select data-recurring-editor-client required aria-describedby="recurring-editor-client-hint"></select></label>
            <span class="field-hint" id="recurring-editor-client-hint" data-recurring-client-hint hidden>The client cannot change once this definition has raised an invoice.</span>
          </div>
          <label>Next issue<input type="date" data-recurring-editor-next required></label>
          <label>Months between issues<input data-recurring-editor-every inputmode="numeric" pattern="[0-9]+" min="1" step="1" required></label>
          <label>Day of month<input data-recurring-editor-day inputmode="numeric" pattern="[0-9]+" min="1" max="31" step="1" required></label>
          <div class="editor-field">
            <label>Draws from retainer<input data-recurring-editor-retainer inputmode="numeric" pattern="[0-9]*" min="1" step="1" autocomplete="off" aria-describedby="recurring-editor-retainer-hint"></label>
            <span class="field-hint" id="recurring-editor-retainer-hint">Optional. The retainer's id.</span>
          </div>
        </div>
      </section>
      <section class="editor-section" aria-labelledby="recurring-editor-wording-heading">
        <h2 id="recurring-editor-wording-heading">On the invoice</h2>
        <label>Subject<input data-recurring-editor-subject maxlength="2000" autocomplete="off" required></label>
        <label>Notes<textarea data-recurring-editor-notes rows="4"></textarea></label>
        <p class="hint">Subject and notes expand <code>%invoice_issue_month_name%</code>, <code>%invoice_issue_year%</code> and <code>%invoice_issue_date%</code> when the invoice is raised.</p>
        <div class="editor-field">
          <label>Purchase order<input data-recurring-editor-purchase-order maxlength="1000" autocomplete="off" aria-describedby="recurring-editor-purchase-order-hint"></label>
          <span class="field-hint" id="recurring-editor-purchase-order-hint">Copied onto every invoice this definition issues. Change it when the client issues the next purchase order.</span>
        </div>
      </section>
      <section class="editor-section" aria-labelledby="recurring-editor-amount-heading">
        <h2 id="recurring-editor-amount-heading">Amount</h2>
        <fieldset class="editor-choice">
          <legend>Bills</legend>
          <label class="editor-choice-card"><input type="radio" name="recurring-amount-type" value="fixed_lines" data-recurring-editor-type checked><span><strong>The same lines every period</strong><small>A fixed amount, which can also cover a band of tracked hours.</small></span></label>
          <label class="editor-choice-card"><input type="radio" name="recurring-amount-type" value="line_items_import" data-recurring-editor-type><span><strong>Whatever is uninvoiced on some projects</strong><small>Tracked time and expenses, swept when it runs.</small></span></label>
        </fieldset>
        <div class="editor-subsection" data-recurring-editor-import hidden>
          <p class="hint">The amount is not known until it runs. Choose the projects it sweeps and how the lines are summarised.</p>
          <div class="editor-field">
            <label>Projects<select multiple size="6" data-recurring-editor-projects aria-describedby="recurring-editor-projects-hint"></select></label>
            <span class="field-hint" id="recurring-editor-projects-hint">Hold Ctrl, or ⌘ on a Mac, to choose more than one.</span>
          </div>
          <div class="editor-grid">
            <label class="editor-check editor-span-2"><input type="checkbox" data-recurring-editor-time-on>Bill uninvoiced hours</label>
            <label class="editor-span-2">Summarise hours<select data-recurring-editor-time-summary>
              <option value="project">By project</option>
              <option value="task">By task</option>
              <option value="people">By person</option>
              <option value="detailed">In detail</option>
            </select></label>
            <label class="editor-check editor-span-2"><input type="checkbox" data-recurring-editor-expenses-on>Bill uninvoiced expenses</label>
            <label class="editor-span-2">Summarise expenses<select data-recurring-editor-expenses-summary>
              <option value="project">By project</option>
              <option value="category">By category</option>
              <option value="people">By person</option>
              <option value="detailed">In detail</option>
            </select></label>
          </div>
        </div>
      </section>
      <section class="editor-section" data-recurring-editor-band aria-labelledby="recurring-editor-band-heading">
        <h2 id="recurring-editor-band-heading">Covers the time on</h2>
        <p class="hint">Optional. A banded team: the amount stays the same and these projects' hours are claimed by it rather than billed. Leave it empty for an ordinary fixed invoice, which ignores tracked time entirely. Choosing projects makes the hours stop reading as uninvoiced, so they cannot be billed a second time, and records what the flat rate absorbed.</p>
        <div class="editor-field">
          <label>Projects covered<select multiple size="4" data-recurring-editor-claims aria-describedby="recurring-editor-claims-hint"></select></label>
          <span class="field-hint" id="recurring-editor-claims-hint">Hold Ctrl, or ⌘ on a Mac, to choose more than one.</span>
        </div>
        <div class="editor-grid">
          <div class="editor-field editor-span-2">
            <label>Counts<select data-recurring-editor-claim-scope aria-describedby="recurring-editor-claim-scope-hint">
              <option value="billable">Billable hours only</option>
              <option value="tracked">Every hour tracked on those projects</option>
            </select></label>
            <span class="field-hint" id="recurring-editor-claim-scope-hint">Under a flat amount the client bought the period. Count every tracked hour if internal work is logged against the client's project, or the band reads as cheaper to deliver than it was.</span>
          </div>
          <div class="editor-field editor-span-2">
            <label>Warn above<input data-recurring-editor-cost-alert inputmode="decimal" autocomplete="off" placeholder="80" aria-describedby="recurring-editor-cost-alert-hint"></label>
            <span class="field-hint" id="recurring-editor-cost-alert-hint">Optional. Cost as a share of what the band charges, in per cent. Blank uses the organisation default. A period containing an hour with no cost rate reports no ratio at all rather than a lower one.</span>
          </div>
          <label class="editor-span-2">Claims<select data-recurring-editor-claim-mode>
            <option value="all">Every uninvoiced hour on those projects</option>
            <option value="ceiling">Up to a limit, then bill the rest as usual</option>
          </select></label>
        </div>
        <div class="editor-grid editor-subsection" data-recurring-editor-ceiling hidden>
          <label class="editor-span-2">Measured in<select data-recurring-editor-ceiling-unit>
            <option value="time">Hours the band covers</option>
            <option value="money">Value it covers, at list</option>
          </select></label>
          <div class="editor-field editor-span-2">
            <label>Up to<input data-recurring-editor-ceiling-amount inputmode="text" autocomplete="off" aria-describedby="recurring-editor-ceiling-hint"></label>
            <span class="field-hint" id="recurring-editor-ceiling-hint">Hours as <code>400h</code> or <code>1h30m</code>; value in cents.</span>
          </div>
          <p class="hint editor-span-all">The oldest hours are claimed first, and an entry that would straddle the limit is left out whole rather than split. A value limit stops at work with no billable rate instead of treating it as free, so unpriced hours stay billable where somebody can see them.</p>
        </div>
      </section>
      <section class="editor-section" data-recurring-editor-fixed aria-labelledby="recurring-editor-lines-heading">
        <h2 id="recurring-editor-lines-heading">Lines</h2>
        <p class="hint">Unit prices are in cents: <code>450000</code> is 4,500.00. A line with a <em>through</em> date stops appearing once that day has passed. Give it an installment total as well and it can count itself off in its own description with <code>%line_installment_number%</code> and <code>%line_installment_total%</code> — "CREDIT 2 of 4".</p>
        <div class="line-editor recurring-line-editor">
          <div class="line-editor-head" aria-hidden="true"><span>#</span><span>Kind</span><span>Description</span><span>Quantity</span><span>Unit price (cents)</span><span class="line-editor-numeric">Amount</span><span></span></div>
          <div class="line-editor-rows" data-recurring-editor-line-list></div>
        </div>
        <div class="line-editor-foot">
          <button type="button" class="editor-secondary" data-recurring-editor-add-line>Add a line</button>
          <p class="line-editor-total">Each issue bills <strong data-recurring-editor-total>—</strong></p>
        </div>
      </section>
      <section class="editor-section" data-recurring-editor-attachments aria-labelledby="recurring-editor-attachments-heading" hidden>
        <h2 id="recurring-editor-attachments-heading">Attachments</h2>
        <p class="hint">Attached to every invoice this definition issues, until the date you set — a yearly purchase order covers its fiscal year.</p>
        <p class="hint" data-recurring-attachments-unsaved hidden>Save the definition first to attach files.</p>
        <div class="recurring-attachment-upload" data-recurring-attachment-upload hidden>
          <label>File to attach<input type="file" data-recurring-attachment-file></label>
          <button type="button" class="editor-secondary" data-recurring-attachment-submit>Upload</button>
        </div>
        <p class="form-result" data-recurring-attachments-status role="status" aria-live="polite"></p>
        <ul class="recurring-attachment-list" data-recurring-attachments></ul>
      </section>
      <footer class="editor-actions">
        <p class="form-result" data-recurring-editor-result role="status" aria-live="polite"></p>
        <a class="editor-secondary" href="/invoices/recurring" data-recurring-editor-cancel>Cancel</a>
        <button class="primary-action" type="submit" data-recurring-editor-submit>Save definition</button>
      </footer>
    </form>
    <template data-recurring-line-template>
      <fieldset class="line-editor-row" data-recurring-line>
        <legend data-recurring-line-position>Line</legend>
        <span class="line-editor-number" data-recurring-line-number aria-hidden="true"></span>
        <label class="line-editor-kind"><span class="line-editor-label">Kind</span><input data-recurring-line-field="kind" autocomplete="off"></label>
        <label class="line-editor-description"><span class="line-editor-label">Description</span><textarea data-recurring-line-field="description" rows="2"></textarea></label>
        <label class="line-editor-quantity"><span class="line-editor-label">Quantity</span><input data-recurring-line-field="quantity" inputmode="decimal" autocomplete="off"></label>
        <label class="line-editor-price"><span class="line-editor-label">Unit price (cents)</span><input data-recurring-line-field="unitPriceCents" inputmode="numeric" autocomplete="off"></label>
        <p class="line-editor-amount"><span class="line-editor-label">Amount</span><strong data-recurring-line-amount>—</strong></p>
        <button type="button" class="line-editor-remove" data-recurring-line-remove><span aria-hidden="true">×</span><span class="line-editor-remove-text">Remove line</span></button>
        <div class="line-editor-meta recurring-line-meta">
          <label class="line-editor-project">Project<select data-recurring-line-field="projectId"></select></label>
          <label>Through<input type="date" data-recurring-line-field="through"></label>
          <label>Installments<input data-recurring-line-field="installments" inputmode="numeric" min="1" step="1" autocomplete="off"></label>
          <label class="editor-check"><input type="checkbox" data-recurring-line-field="taxed">Tax</label>
          <label class="editor-check"><input type="checkbox" data-recurring-line-field="taxed2">Tax 2</label>
        </div>
      </fieldset>
    </template>
    <dialog class="recurring-confirm-dialog" data-recurring-attachment-remove-confirm aria-labelledby="recurring-attachment-remove-title">
      <form data-recurring-attachment-remove-form>
        <header>
          <div><p class="eyebrow">Attachments</p><h2 id="recurring-attachment-remove-title">Remove this file?</h2></div>
          <button type="button" data-recurring-attachment-remove-cancel aria-label="Close">×</button>
        </header>
        <p data-recurring-attachment-remove-body>It stops going with the invoices this definition issues. Invoices already issued keep their copy.</p>
        <footer>
          <button type="button" data-recurring-attachment-remove-cancel>Cancel</button>
          <button class="danger-action" type="submit" data-recurring-attachment-remove-submit>Remove file</button>
        </footer>
        <p class="form-result" data-recurring-attachment-remove-result role="status" aria-live="polite"></p>
      </form>
    </dialog>
  </main>`
