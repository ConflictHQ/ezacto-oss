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

export const renderInvoiceComposerDialog = (): string => `
  <dialog class="invoice-composer-dialog" data-invoice-composer-dialog aria-labelledby="invoice-composer-title">
    <form data-invoice-composer-form novalidate>
      <header><div><p class="eyebrow">Invoice message</p><h2 id="invoice-composer-title" data-invoice-composer-title>Send invoice</h2></div><button type="button" data-dialog-close aria-label="Close invoice message composer">×</button></header>
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
          <label class="invoice-composer-check"><input name="attachPdf" data-invoice-composer-attach-pdf type="checkbox" checked> Attach invoice PDF</label>
          <label class="invoice-composer-check"><input name="sendCopy" data-invoice-composer-send-copy type="checkbox"> Send me a copy</label>
          <label class="invoice-composer-check"><input name="scheduleReminder" data-invoice-composer-reminder-toggle type="checkbox"> Schedule a payment reminder</label>
          <label for="ez-invoice-reminder-date" data-invoice-composer-reminder-date-label hidden>Reminder date
            <input id="ez-invoice-reminder-date" name="reminderDate" data-invoice-composer-reminder-date type="date">
          </label>
        </section>
        <aside class="invoice-variable-reference" aria-labelledby="invoice-variable-title">
          <h3 id="invoice-variable-title">Template variables</h3>
          <p>Use these anywhere in the subject or message. They are replaced before sending.</p>
          <dl>
            <div><dt><code>%invoice_id%</code></dt><dd>Invoice record ID</dd></div>
            <div><dt><code>%invoice_number%</code></dt><dd>Display number</dd></div>
            <div><dt><code>%invoice_amount%</code></dt><dd>Formatted total</dd></div>
            <div><dt><code>%invoice_due_date%</code></dt><dd>Due date</dd></div>
          </dl>
        </aside>
      </div>
      <p class="form-result" data-invoice-composer-result role="status" aria-live="polite"></p>
      <div class="invoice-payment-dialog-actions"><button type="button" data-dialog-close>Cancel</button><button class="primary-action" type="submit" data-invoice-composer-submit>Send invoice</button></div>
    </form>
  </dialog>`
