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
