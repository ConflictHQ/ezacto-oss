import { DEMO_MAIL_NOTE, demoUnavailable } from '../demo.js'
import { invoiceOverflowTransitions } from './model.js'

export const renderInvoicePaymentSection = (): string => `
      <section class="invoice-history invoice-payment-history" aria-labelledby="invoice-payment-heading">
        <header class="invoice-payment-heading">
          <div><h3 id="invoice-payment-heading">Payments</h3><p>Effective payments applied to this invoice.</p></div>
          <button type="button" data-invoice-payment-record data-auth-action disabled>Record payment</button>
        </header>
        <p class="hint" data-invoice-payment-readonly hidden>You have read-only invoice access. Payment changes require the invoices:write scope.</p>
        <p class="form-result" data-invoice-payment-status role="status" aria-live="polite"></p>
        <ul data-invoice-detail-payments></ul>
      </section>`

/**
 * The line items' heading on the detail page. Lines are changed on the edit
 * page, with the rest of the document, so Add line is a way there that opens
 * on a fresh line -- the dialog it used to open was a second editor over the
 * same rows with different save semantics.
 */
export const renderInvoiceLineEditor = (): string => `
      <section class="invoice-line-editor" aria-labelledby="invoice-line-heading">
        <header class="invoice-line-heading">
          <div><h3 id="invoice-line-heading">Line items</h3><p>Free-form work, products, credits, and adjustments on this invoice.</p></div>
          <a class="invoice-line-add" data-invoice-line-add aria-disabled="true" hidden>Add line</a>
        </header>
        <p class="hint" data-invoice-line-readonly hidden>You have read-only invoice access. Line changes require the invoices:write scope.</p>
      </section>`

export const renderInvoicePaymentDialogs = (): string => `
  <dialog class="invoice-payment-dialog" data-invoice-payment-dialog aria-labelledby="invoice-payment-dialog-title">
    <form data-invoice-payment-form novalidate>
      <header><div><p class="eyebrow">Invoice payment</p><h2 id="invoice-payment-dialog-title" data-invoice-payment-dialog-title>Record payment</h2></div><button type="button" data-dialog-close aria-label="Close payment dialog">×</button></header>
      <div class="invoice-payment-amount-fields">
        <label for="ez-invoice-payment-amount">Amount<input id="ez-invoice-payment-amount" name="amount" data-invoice-payment-amount inputmode="decimal" autocomplete="off" min="0.01" step="0.01" required></label>
        <label for="ez-invoice-payment-currency">Currency<input id="ez-invoice-payment-currency" name="currency" data-invoice-payment-currency readonly aria-readonly="true"></label>
      </div>
      <label for="ez-invoice-payment-precision">Payment timing
        <select id="ez-invoice-payment-precision" name="precision" data-invoice-payment-precision>
          <option value="date">Date only</option>
          <option value="timestamp">Exact date and time</option>
        </select>
      </label>
      <label for="ez-invoice-payment-date" data-invoice-payment-date-label>Paid date<input id="ez-invoice-payment-date" name="paid_date" data-invoice-payment-date type="date" required></label>
      <label for="ez-invoice-payment-instant" data-invoice-payment-instant-label hidden>Paid at (your local time)<input id="ez-invoice-payment-instant" name="paid_at" data-invoice-payment-instant type="datetime-local" step="60"></label>
      <label for="ez-invoice-payment-notes">Notes<textarea id="ez-invoice-payment-notes" name="notes" data-invoice-payment-notes rows="4" maxlength="10000"></textarea></label>
      <p class="hint">Records a native manual payment. No email or thank-you message will be sent.</p>
      <p class="form-result" data-invoice-payment-result role="status" aria-live="polite"></p>
      <div class="invoice-payment-dialog-actions"><button type="button" data-dialog-close>Cancel</button><button class="primary-action" type="submit" data-invoice-payment-submit>Record payment</button></div>
    </form>
  </dialog>
  <dialog class="invoice-payment-dialog" data-invoice-payment-delete-dialog aria-labelledby="invoice-payment-delete-title">
    <form data-invoice-payment-delete-form>
      <header><div><p class="eyebrow">Invoice payment</p><h2 id="invoice-payment-delete-title">Delete payment?</h2></div><button type="button" data-dialog-close aria-label="Close delete payment dialog">×</button></header>
      <p>This removes <strong data-invoice-payment-delete-summary></strong> and recalculates the invoice balance and state.</p>
      <p class="form-result" data-invoice-payment-delete-result role="status" aria-live="polite"></p>
      <div class="invoice-payment-dialog-actions"><button type="button" data-dialog-close>Cancel</button><button class="primary-action" type="submit" data-invoice-payment-delete-submit>Delete payment</button></div>
    </form>
  </dialog>`

export const renderInvoiceAttachmentSection = (): string => `
      <section class="invoice-history invoice-attachment-section" aria-labelledby="invoice-attachment-heading">
        <header class="invoice-payment-heading">
          <div><h3 id="invoice-attachment-heading">Attachments</h3><p>Files attached to this invoice.</p></div>
        </header>
        <form class="invoice-attachment-form" data-invoice-attachment-form hidden>
          <input type="file" name="file" aria-label="Choose file">
          <button type="submit" data-invoice-attachment-submit data-auth-action disabled>Upload</button>
        </form>
        <p class="hint" data-invoice-attachment-readonly hidden>You have read-only invoice access. Uploading requires the invoices:write scope.</p>
        <p class="hint" data-invoice-attachment-demo hidden>${demoUnavailable('Uploading a file')}</p>
        <p class="form-result" data-invoice-attachment-status role="status" aria-live="polite"></p>
        <ul data-invoice-attachments></ul>
      </section>`

export const renderInvoiceOverflowMenu = (): string => `
        <div class="invoice-overflow" data-invoice-overflow hidden>
          <button class="invoice-overflow-toggle" type="button" data-invoice-overflow-toggle aria-haspopup="true" aria-expanded="false" aria-controls="ez-invoice-overflow-menu" aria-label="More invoice actions" disabled>…</button>
          <div class="invoice-overflow-menu" id="ez-invoice-overflow-menu" data-invoice-overflow-menu role="menu" hidden>${invoiceOverflowTransitions
            .map(
              (transition) =>
                `<button class="invoice-overflow-item${transition.destructive ? ' invoice-overflow-destructive' : ''}" type="button" role="menuitem" data-invoice-transition="${transition.command}" hidden>${transition.label}</button>`,
            )
            .join('')}</div>
        </div>`

export const renderInvoiceTransitionDialog = (): string => `
  <dialog class="invoice-transition-dialog" data-invoice-transition-dialog aria-labelledby="invoice-transition-title">
    <form data-invoice-transition-form>
      <header><div><p class="eyebrow">Invoice state</p><h2 id="invoice-transition-title" data-invoice-transition-title>Change invoice state</h2></div><button type="button" data-dialog-close aria-label="Close invoice state dialog">×</button></header>
      <p data-invoice-transition-summary></p>
      <p class="hint">The command carries the version this page is showing. If the invoice moved elsewhere it is refused and the latest values are loaded.</p>
      <p class="form-result" data-invoice-transition-result role="status" aria-live="polite"></p>
      <div class="invoice-payment-dialog-actions"><button type="button" data-dialog-close>Cancel</button><button class="primary-action" type="submit" data-invoice-transition-submit>Confirm</button></div>
    </form>
  </dialog>`

export const renderInvoiceComposerDialog = (): string => `
  <dialog class="invoice-composer-dialog" data-invoice-composer-dialog aria-labelledby="invoice-composer-title">
    <form data-invoice-composer-form novalidate>
      <header><div><p class="eyebrow">Invoice message</p><h2 id="invoice-composer-title" data-invoice-composer-title>Send invoice</h2></div><button type="button" data-dialog-close aria-label="Close invoice message composer">×</button></header>
      <p class="hint">Recording the sent status and delivering the email are two different things, so this dialog does both in one order. The message below is always recorded on the invoice; ticking <strong>Also deliver by email</strong> queues the email after it.</p>
      <p class="hint" data-invoice-composer-owed hidden>The sent status is already recorded for this invoice and only the email is left, so nothing here can record a second sent message. Submit to retry that email, or untick <strong>Also deliver by email</strong> to finish without it.</p>
      <div class="invoice-composer-layout">
        <section class="invoice-composer-fields">
          <label for="ez-invoice-recipients">To
            <textarea id="ez-invoice-recipients" name="recipients" data-invoice-composer-recipients rows="2" maxlength="321000" autocomplete="off" required aria-describedby="invoice-recipient-hint"></textarea>
          </label>
          <label for="ez-invoice-cc">Cc
            <textarea id="ez-invoice-cc" name="cc" data-invoice-composer-cc rows="3" maxlength="321000" autocomplete="off" aria-describedby="invoice-recipient-hint"></textarea>
          </label>
          <p class="hint" id="invoice-recipient-hint">One per line: email@example.com or Name &lt;email@example.com&gt;. <span data-invoice-composer-recipients-source></span></p>
          <p class="hint" data-invoice-composer-always-cc hidden></p>
          <label class="invoice-composer-check" data-invoice-composer-copy-label hidden><input name="sendMeACopy" data-invoice-composer-copy type="checkbox"> Always send me a copy of invoice emails <span data-invoice-composer-copy-address></span></label>
          <label for="ez-invoice-message-subject">Subject
            <input id="ez-invoice-message-subject" name="subject" data-invoice-composer-subject maxlength="998" required>
          </label>
          <label for="ez-invoice-message-body">Message
            <textarea id="ez-invoice-message-body" name="body" data-invoice-composer-body rows="7" maxlength="100000" required aria-describedby="invoice-message-hint"></textarea>
          </label>
          <p class="hint" id="invoice-message-hint">Your note, at the top of the email. Below it the email carries the invoice's summary as Harvest sent it: the amount due, a link to pay where there is one, the invoice number and dates, the purchase order, and the payment details from the invoice's notes.</p>
          <label class="invoice-composer-check"><input name="scheduleReminder" data-invoice-composer-reminder-toggle type="checkbox"> Record a planned reminder date</label>
          <label for="ez-invoice-reminder-date" data-invoice-composer-reminder-date-label hidden>Planned reminder date
            <input id="ez-invoice-reminder-date" name="reminderDate" data-invoice-composer-reminder-date type="date">
          </label>
          <label class="invoice-composer-check"><input name="deliver" data-invoice-composer-deliver-toggle type="checkbox" aria-describedby="invoice-deliver-hint"> Also deliver by email</label>
          <p class="hint" id="invoice-deliver-hint">One email from the verified organization sender, To and Cc as listed, with the subject and message above and the attachments chosen below.</p>
          <p class="hint" data-invoice-composer-delivery-unavailable hidden></p>
          <p class="hint" data-invoice-composer-demo hidden>${DEMO_MAIL_NOTE}</p>
          <p class="invoice-composer-no-email" data-invoice-composer-no-email hidden>Nothing will be emailed — this only records the invoice as sent.</p>
          <fieldset class="invoice-composer-attachments" data-invoice-composer-attachments>
            <legend>Attach to the email</legend>
            <label class="invoice-composer-check"><input name="attachPdf" data-invoice-composer-attach-pdf type="checkbox"> Attach a PDF of this invoice</label>
            <label class="invoice-composer-check" data-invoice-composer-append-label hidden><input name="appendPdfs" data-invoice-composer-append type="checkbox"> Append attached PDFs to the back of the invoice PDF</label>
            <div class="invoice-composer-journal">
              <label class="invoice-composer-check"><input name="attachJournal" data-invoice-composer-attach-journal type="checkbox"> Attach the hours report</label>
              <label class="visually-hidden" for="ez-invoice-composer-journal-level">Hours report detail</label>
              <select id="ez-invoice-composer-journal-level" name="journalLevel" data-invoice-composer-journal-level hidden>
                <option value="detailed">Every entry</option>
                <option value="summary">Summary</option>
              </select>
              <fieldset class="invoice-composer-formats" data-invoice-composer-journal-formats hidden>
                <legend class="visually-hidden">Hours report files</legend>
                <label><input type="checkbox" name="journalFormat" value="pdf"> PDF</label>
                <label><input type="checkbox" name="journalFormat" value="csv"> CSV</label>
                <label><input type="checkbox" name="journalFormat" value="xlsx"> Excel</label>
              </fieldset>
            </div>
            <label class="invoice-composer-check" data-invoice-composer-attach-files-label hidden><input name="attachFiles" data-invoice-composer-attach-files type="checkbox"> Attach files added to this invoice</label>
            <p class="hint" data-invoice-composer-attachments-status role="status" aria-live="polite">Attachments go with the email, so they are chosen once it is to be delivered.</p>
          </fieldset>
          <label class="invoice-composer-check" data-invoice-composer-save-default-label hidden><input name="saveDefault" data-invoice-composer-save-default type="checkbox"> Save these recipients and attachments as this client's default</label>
          <div class="invoice-composer-preview-actions" data-invoice-composer-preview-actions hidden>
            <button type="button" data-invoice-composer-preview>Preview</button>
            <button type="button" data-invoice-composer-preview-send>Send a preview to me</button>
          </div>
          <p class="form-result" data-invoice-composer-preview-result role="status" aria-live="polite"></p>
          <section class="invoice-composer-preview" data-invoice-composer-preview-panel aria-labelledby="invoice-preview-title" hidden>
            <h3 id="invoice-preview-title">Preview — nothing has been sent</h3>
            <dl class="invoice-composer-preview-headers">
              <div><dt>From</dt><dd data-invoice-preview-from></dd></div>
              <div><dt>To</dt><dd data-invoice-preview-to></dd></div>
              <div><dt>Cc</dt><dd data-invoice-preview-cc></dd></div>
              <div><dt>Subject</dt><dd data-invoice-preview-subject></dd></div>
            </dl>
            <pre class="invoice-composer-preview-body" data-invoice-preview-text></pre>
            <h4>Attachments</h4>
            <ul data-invoice-preview-attachments></ul>
            <a data-invoice-preview-document hidden>Download the invoice PDF as it would be attached</a>
          </section>
          <label class="invoice-composer-check" data-invoice-composer-confirm-label hidden><input name="confirmed" data-invoice-composer-confirm type="checkbox"> I confirm these recipients and want to send this invoice.</label>
        </section>
        <aside class="invoice-variable-reference" aria-labelledby="invoice-variable-title">
          <h3 id="invoice-variable-title">Template variables</h3>
          <p>Use these anywhere in the subject or message. They are filled in for this invoice when it is sent.</p>
          <dl>
            <div><dt><code>%invoice_number%</code></dt><dd>Invoice number</dd></div>
            <div><dt><code>%company_name%</code></dt><dd>Your company's name</dd></div>
            <div><dt><code>%client_name%</code></dt><dd>The client's name</dd></div>
            <div><dt><code>%invoice_amount%</code></dt><dd>Formatted total</dd></div>
            <div><dt><code>%invoice_due_date%</code></dt><dd>Due date</dd></div>
            <div><dt><code>%invoice_payment_terms%</code></dt><dd>Payment terms, e.g. Net 30</dd></div>
            <div><dt><code>%invoice_purchase_order%</code></dt><dd>Purchase order number</dd></div>
            <div><dt><code>%invoice_issue_month_name%</code></dt><dd>Month of the issue date</dd></div>
            <div><dt><code>%invoice_period%</code></dt><dd>Billing period, e.g. September 2026</dd></div>
            <div><dt><code>%send_weekday%</code></dt><dd>Weekday it is sent, e.g. Friday</dd></div>
            <div><dt><code>%invoice_line_items%</code></dt><dd>The lines, quantity, rate, and amount</dd></div>
          </dl>
        </aside>
      </div>
      <p class="form-result" data-invoice-composer-result role="status" aria-live="polite"></p>
      <div class="invoice-payment-dialog-actions"><button type="button" data-dialog-close>Cancel</button><button class="primary-action" type="submit" data-invoice-composer-submit>Send invoice</button></div>
    </form>
  </dialog>`

/**
 * The invoice editor, as a page of its own (`/invoices/:number/edit`).
 *
 * Modelled on Harvest's Edit invoice: the document's fields at the top, every
 * line editable in place below them, the notes under the lines, and one Save
 * for all of it. The API takes one edit per command, so Save sends the
 * document, the rates and each changed line as a sequence of versioned
 * commands, each under its own held key -- the same commands, keys and version
 * checks the dialogs this replaces used, run in one pass.
 *
 * The field attributes are the edit dialog's, so the page answers to the names
 * it always did.
 */
export const renderInvoiceEditPage = (view?: string): string => `
  <main class="app-content invoice-workspace editor-page page--settings" data-invoice-edit-page${view === 'invoice-edit' ? '' : ' hidden'}>
    <header class="context-row editor-page-heading">
      <div><p class="eyebrow" data-invoice-edit-eyebrow>Invoice</p><h1 id="invoice-edit-title" data-invoice-edit-title>Edit invoice</h1></div>
      <a class="editor-back" href="/invoices" data-invoice-edit-back>Back to the invoice</a>
    </header>
    <p class="form-result invoice-page-status" data-invoice-edit-status role="status" aria-live="polite">Loading invoice…</p>
    <button class="invoice-load-more" type="button" data-invoice-edit-retry hidden>Retry invoice</button>
    <form class="editor-form" data-invoice-edit-form aria-labelledby="invoice-edit-title" novalidate hidden>
      <section class="editor-section" aria-labelledby="invoice-edit-document-heading">
        <h2 id="invoice-edit-document-heading">Invoice details</h2>
        <div class="editor-grid">
          <p class="editor-fact editor-span-2"><span>Invoice for</span><strong data-invoice-edit-client>—</strong></p>
          <label class="editor-span-2" for="ez-invoice-edit-purchase-order">Purchase order
            <input id="ez-invoice-edit-purchase-order" name="purchase_order" data-invoice-edit-purchase-order maxlength="100000" autocomplete="off">
          </label>
          <label for="ez-invoice-edit-issue-date">Issue date
            <input id="ez-invoice-edit-issue-date" name="issue_date" data-invoice-edit-issue-date type="date" required>
          </label>
          <label for="ez-invoice-edit-due-date">Due date
            <input id="ez-invoice-edit-due-date" name="due_date" data-invoice-edit-due-date type="date" required>
          </label>
          <label class="editor-span-2" for="ez-invoice-edit-payment-terms">Payment terms
            <select id="ez-invoice-edit-payment-terms" name="payment_terms" data-invoice-edit-payment-terms><option value="upon_receipt">Upon receipt</option><option value="net_15">Net 15</option><option value="net_30">Net 30</option><option value="net_45">Net 45</option><option value="net_60">Net 60</option><option value="custom">Custom</option></select>
          </label>
          <label class="editor-span-all" for="ez-invoice-edit-subject">Subject
            <input id="ez-invoice-edit-subject" name="subject" data-invoice-edit-subject maxlength="100000" autocomplete="off">
          </label>
        </div>
      </section>
      <section class="editor-section" aria-labelledby="invoice-edit-lines-heading">
        <h2 id="invoice-edit-lines-heading">Line items</h2>
        <p class="hint">Amounts are worked out in exact cents, and the total, balance and payment state are reconciled when you save. A linked project has to be one of this client's.</p>
        <p class="form-result" data-invoice-edit-hours-warning role="status" aria-live="polite" hidden></p>
        <div class="line-editor invoice-line-editor-table">
          <div class="line-editor-head" aria-hidden="true"><span>#</span><span>Item type</span><span>Description</span><span>Quantity</span><span data-invoice-edit-rate-heading>Unit price</span><span class="line-editor-numeric">Amount</span><span></span></div>
          <div class="line-editor-rows" data-invoice-edit-line-list></div>
        </div>
        <div class="line-editor-foot">
          <button type="button" class="editor-secondary" data-invoice-edit-add-line>Add a line</button>
          <p class="line-editor-total">Lines total <strong data-invoice-edit-subtotal>—</strong></p>
        </div>
      </section>
      <section class="editor-section" aria-labelledby="invoice-edit-rates-heading">
        <h2 id="invoice-edit-rates-heading">Tax and discount</h2>
        <div class="editor-grid">
          <label for="ez-invoice-edit-tax">Tax 1 rate (%)
            <input id="ez-invoice-edit-tax" name="tax_rate" data-invoice-edit-tax inputmode="decimal" autocomplete="off">
          </label>
          <label for="ez-invoice-edit-tax2">Tax 2 rate (%)
            <input id="ez-invoice-edit-tax2" name="tax2_rate" data-invoice-edit-tax2 inputmode="decimal" autocomplete="off">
          </label>
          <label for="ez-invoice-edit-discount">Discount rate (%)
            <input id="ez-invoice-edit-discount" name="discount_rate" data-invoice-edit-discount inputmode="decimal" autocomplete="off">
          </label>
        </div>
        <p class="hint">Leave a rate blank for none. The tax rates apply to the lines marked Tax 1 and Tax 2.</p>
      </section>
      <section class="editor-section" aria-labelledby="invoice-edit-notes-heading">
        <h2 id="invoice-edit-notes-heading">Notes</h2>
        <label for="ez-invoice-edit-notes"><span class="visually-hidden">Notes</span>
          <textarea id="ez-invoice-edit-notes" name="notes" data-invoice-edit-notes rows="6" maxlength="100000" aria-describedby="invoice-edit-notes-hint"></textarea>
        </label>
        <p class="hint" id="invoice-edit-notes-hint">Shown on the invoice the client receives. Formatting: <code>*bold*</code> and <code>_italic_</code>.</p>
      </section>
      <footer class="editor-actions">
        <p class="form-result" data-invoice-edit-result role="status" aria-live="polite"></p>
        <a class="editor-secondary" href="/invoices" data-invoice-edit-cancel>Cancel</a>
        <button class="primary-action" type="submit" data-invoice-edit-submit>Save invoice</button>
      </footer>
    </form>
    <template data-invoice-edit-line-template>
      <fieldset class="line-editor-row" data-invoice-edit-line>
        <legend data-invoice-edit-line-position>Line</legend>
        <span class="line-editor-number" data-invoice-edit-line-number aria-hidden="true"></span>
        <label class="line-editor-kind"><span class="line-editor-label">Item type</span><input data-invoice-edit-line-field="kind" maxlength="255" autocomplete="off"></label>
        <label class="line-editor-description"><span class="line-editor-label">Description</span><textarea data-invoice-edit-line-field="description" rows="2" maxlength="100000"></textarea></label>
        <label class="line-editor-quantity"><span class="line-editor-label">Quantity</span><input data-invoice-edit-line-field="quantity" inputmode="decimal" autocomplete="off"></label>
        <label class="line-editor-price"><span class="line-editor-label" data-invoice-edit-line-rate-label>Unit price</span><input data-invoice-edit-line-field="rate" inputmode="decimal" autocomplete="off"></label>
        <p class="line-editor-amount"><span class="line-editor-label">Amount</span><strong data-invoice-edit-line-amount>—</strong></p>
        <button type="button" class="line-editor-remove" data-invoice-edit-line-remove><span aria-hidden="true">×</span><span class="line-editor-remove-text">Remove line</span></button>
        <div class="line-editor-meta invoice-line-meta">
          <label class="line-editor-project">Linked project<select data-invoice-edit-line-field="projectId"></select></label>
          <label class="editor-check"><input type="checkbox" data-invoice-edit-line-field="taxed">Tax 1</label>
          <label class="editor-check"><input type="checkbox" data-invoice-edit-line-field="taxed2">Tax 2</label>
          <p class="hint invoice-hours-line" data-invoice-edit-linked-hours hidden></p>
        </div>
        <p class="line-editor-removed" data-invoice-edit-line-removed hidden><span>This line is removed when you save.</span><button type="button" class="editor-secondary" data-invoice-edit-line-restore>Keep this line</button></p>
      </fieldset>
    </template>
  </main>`
