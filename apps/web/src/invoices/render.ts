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

export const renderInvoiceLineEditor = (): string => `
      <section class="invoice-line-editor" aria-labelledby="invoice-line-heading">
        <header class="invoice-line-heading">
          <div><h3 id="invoice-line-heading">Line items</h3><p>Free-form work, products, credits, and adjustments on this invoice.</p></div>
          <button type="button" data-invoice-line-add data-auth-action disabled>Add line</button>
        </header>
        <p class="hint" data-invoice-line-readonly hidden>You have read-only invoice access. Line changes require the invoices:write scope.</p>
        <p class="form-result" data-invoice-line-status role="status" aria-live="polite"></p>
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

export const renderInvoiceLineDialogs = (): string => `
  <dialog class="invoice-line-dialog" data-invoice-line-dialog aria-labelledby="invoice-line-dialog-title">
    <form data-invoice-line-form novalidate>
      <header><div><p class="eyebrow">Invoice line</p><h2 id="invoice-line-dialog-title" data-invoice-line-dialog-title>Add line item</h2></div><button type="button" data-dialog-close aria-label="Close invoice line dialog">×</button></header>
      <label for="ez-invoice-line-kind">Item type
        <input id="ez-invoice-line-kind" name="kind" data-invoice-line-kind maxlength="255" autocomplete="off" required>
      </label>
      <label for="ez-invoice-line-description">Description
        <textarea id="ez-invoice-line-description" name="description" data-invoice-line-description rows="4" maxlength="100000"></textarea>
      </label>
      <div class="invoice-line-number-fields">
        <label for="ez-invoice-line-quantity">Quantity
          <input id="ez-invoice-line-quantity" name="quantity" data-invoice-line-quantity inputmode="decimal" autocomplete="off" maxlength="1000" required>
        </label>
        <label for="ez-invoice-line-rate"><span data-invoice-line-rate-label>Rate</span>
          <input id="ez-invoice-line-rate" name="rate" data-invoice-line-rate inputmode="decimal" autocomplete="off" required>
        </label>
      </div>
      <fieldset class="invoice-line-tax-fields">
        <legend>Taxes</legend>
        <label><input name="taxed" data-invoice-line-taxed type="checkbox"> Apply tax 1</label>
        <label><input name="taxed2" data-invoice-line-taxed2 type="checkbox"> Apply tax 2</label>
      </fieldset>
      <p class="invoice-line-preview">Line amount <strong data-invoice-line-preview>—</strong></p>
      <p class="hint">The amount is calculated in exact cents and the invoice total, balance, and payment state are reconciled together.</p>
      <p class="form-result" data-invoice-line-result role="status" aria-live="polite"></p>
      <div class="invoice-payment-dialog-actions"><button type="button" data-dialog-close>Cancel</button><button class="primary-action" type="submit" data-invoice-line-submit>Add line</button></div>
    </form>
  </dialog>
  <dialog class="invoice-line-dialog" data-invoice-line-delete-dialog aria-labelledby="invoice-line-delete-title">
    <form data-invoice-line-delete-form>
      <header><div><p class="eyebrow">Invoice line</p><h2 id="invoice-line-delete-title">Delete line item?</h2></div><button type="button" data-dialog-close aria-label="Close delete line dialog">×</button></header>
      <p>This removes <strong data-invoice-line-delete-summary></strong> and recalculates the invoice total, balance, and payment state.</p>
      <p class="form-result" data-invoice-line-delete-result role="status" aria-live="polite"></p>
      <div class="invoice-payment-dialog-actions"><button type="button" data-dialog-close>Cancel</button><button class="primary-action" type="submit" data-invoice-line-delete-submit>Delete line</button></div>
    </form>
  </dialog>`

export const renderInvoiceEditDialog = (): string => `
  <dialog class="invoice-line-dialog" data-invoice-edit-dialog aria-labelledby="invoice-edit-dialog-title">
    <form data-invoice-edit-form novalidate>
      <header><div><p class="eyebrow">Invoice</p><h2 id="invoice-edit-dialog-title">Edit invoice</h2></div><button type="button" data-dialog-close aria-label="Close invoice edit dialog">×</button></header>
      <label for="ez-invoice-edit-subject">Subject
        <input id="ez-invoice-edit-subject" name="subject" data-invoice-edit-subject maxlength="100000" autocomplete="off">
      </label>
      <label for="ez-invoice-edit-purchase-order">Purchase order
        <input id="ez-invoice-edit-purchase-order" name="purchase_order" data-invoice-edit-purchase-order maxlength="100000" autocomplete="off">
      </label>
      <div class="invoice-line-number-fields">
        <label for="ez-invoice-edit-issue-date">Issue date
          <input id="ez-invoice-edit-issue-date" name="issue_date" data-invoice-edit-issue-date type="date" required>
        </label>
        <label for="ez-invoice-edit-due-date">Due date
          <input id="ez-invoice-edit-due-date" name="due_date" data-invoice-edit-due-date type="date" required>
        </label>
      </div>
      <label for="ez-invoice-edit-payment-terms">Payment terms
        <select id="ez-invoice-edit-payment-terms" name="payment_terms" data-invoice-edit-payment-terms><option value="upon_receipt">Upon receipt</option><option value="net_15">Net 15</option><option value="net_30">Net 30</option><option value="net_45">Net 45</option><option value="net_60">Net 60</option><option value="custom">Custom</option></select>
      </label>
      <label for="ez-invoice-edit-tax">Tax 1 rate (%)
        <input id="ez-invoice-edit-tax" name="tax_rate" data-invoice-edit-tax inputmode="decimal" autocomplete="off">
      </label>
      <label for="ez-invoice-edit-tax2">Tax 2 rate (%)
        <input id="ez-invoice-edit-tax2" name="tax2_rate" data-invoice-edit-tax2 inputmode="decimal" autocomplete="off">
      </label>
      <label for="ez-invoice-edit-discount">Discount rate (%)
        <input id="ez-invoice-edit-discount" name="discount_rate" data-invoice-edit-discount inputmode="decimal" autocomplete="off">
      </label>
      <p class="hint">Leave a rate blank for none. Rates apply to the lines already marked taxed and are saved as a separate command from the document fields.</p>
      <p class="form-result" data-invoice-edit-result role="status" aria-live="polite"></p>
      <div class="invoice-payment-dialog-actions"><button type="button" data-dialog-close>Cancel</button><button class="primary-action" type="submit" data-invoice-edit-submit>Save invoice</button></div>
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
        <p class="form-result" data-invoice-attachment-status role="status" aria-live="polite"></p>
        <ul data-invoice-attachments></ul>
      </section>`

export const renderInvoiceComposerDialog = (): string => `
  <dialog class="invoice-composer-dialog" data-invoice-composer-dialog aria-labelledby="invoice-composer-title">
    <form data-invoice-composer-form novalidate>
      <header><div><p class="eyebrow">Invoice message</p><h2 id="invoice-composer-title" data-invoice-composer-title>Mark invoice sent</h2></div><button type="button" data-dialog-close aria-label="Close invoice message composer">×</button></header>
      <p class="hint">This records the sent status and message details. It does not deliver email or a PDF.</p>
      <div class="invoice-composer-layout">
        <section class="invoice-composer-fields">
          <label for="ez-invoice-recipients">Recipients
            <textarea id="ez-invoice-recipients" name="recipients" data-invoice-composer-recipients rows="3" maxlength="321000" autocomplete="off" required aria-describedby="invoice-recipient-hint"></textarea>
          </label>
          <p class="hint" id="invoice-recipient-hint">One per line: email@example.com or Name &lt;email@example.com&gt;.</p>
          <label for="ez-invoice-message-subject">Subject
            <input id="ez-invoice-message-subject" name="subject" data-invoice-composer-subject maxlength="100000" required>
          </label>
          <label for="ez-invoice-message-body">Message
            <textarea id="ez-invoice-message-body" name="body" data-invoice-composer-body rows="8" maxlength="100000" required></textarea>
          </label>
          <label class="invoice-composer-check"><input name="scheduleReminder" data-invoice-composer-reminder-toggle type="checkbox"> Record a planned reminder date</label>
          <label for="ez-invoice-reminder-date" data-invoice-composer-reminder-date-label hidden>Planned reminder date
            <input id="ez-invoice-reminder-date" name="reminderDate" data-invoice-composer-reminder-date type="date">
          </label>
        </section>
        <aside class="invoice-variable-reference" aria-labelledby="invoice-variable-title">
          <h3 id="invoice-variable-title">Template variables</h3>
          <p>Use these anywhere in the subject or message. They are replaced before the record is saved.</p>
          <dl>
            <div><dt><code>%invoice_id%</code></dt><dd>Invoice record ID</dd></div>
            <div><dt><code>%invoice_number%</code></dt><dd>Display number</dd></div>
            <div><dt><code>%invoice_amount%</code></dt><dd>Formatted total</dd></div>
            <div><dt><code>%invoice_due_date%</code></dt><dd>Due date</dd></div>
          </dl>
        </aside>
      </div>
      <p class="form-result" data-invoice-composer-result role="status" aria-live="polite"></p>
      <div class="invoice-payment-dialog-actions"><button type="button" data-dialog-close>Cancel</button><button class="primary-action" type="submit" data-invoice-composer-submit>Mark sent</button></div>
    </form>
  </dialog>`

export const renderInvoiceDeliveryDialog = (): string => `
  <dialog class="invoice-composer-dialog" data-invoice-delivery-dialog aria-labelledby="invoice-delivery-title">
    <form data-invoice-delivery-form novalidate>
      <header><div><p class="eyebrow">External delivery</p><h2 id="invoice-delivery-title">Send invoice?</h2></div><button type="button" data-dialog-close aria-label="Close delivery dialog">×</button></header>
      <p>This will send the current invoice from the verified organization sender to every recipient below.</p>
      <p class="hint">Delivery is queued after confirmation. No PDF is attached or claimed.</p>
      <label for="ez-invoice-delivery-recipients">Recipients
        <textarea id="ez-invoice-delivery-recipients" name="recipients" data-invoice-delivery-recipients rows="4" maxlength="321000" autocomplete="off" required aria-describedby="invoice-delivery-recipient-hint"></textarea>
      </label>
      <p class="hint" id="invoice-delivery-recipient-hint">One per line: email@example.com or Name &lt;email@example.com&gt;.</p>
      <label class="invoice-composer-check"><input name="confirmed" data-invoice-delivery-confirm type="checkbox" required> I confirm these recipients and want to send this invoice.</label>
      <p class="form-result" data-invoice-delivery-result role="status" aria-live="polite"></p>
      <div class="invoice-payment-dialog-actions"><button type="button" data-dialog-close>Cancel</button><button class="primary-action" type="submit" data-invoice-delivery-submit>Send invoice</button></div>
    </form>
  </dialog>`
