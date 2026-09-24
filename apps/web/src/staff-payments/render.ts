export const renderStaffPayments = (view?: string): string =>
  view === 'staff-payments'
    ? `
  <main class="app-content page--grid staff-payments" data-staff-payments-page${view === 'staff-payments' ? '' : ' hidden'}>
    <header class="context-row"><div><p class="eyebrow">Team</p><h1>Staff payments</h1></div><a href="/team">Back to team</a></header>
    <p>Track monthly amounts, Wise and Deel payments, and historical settlement. Record payments here after confirming them with the provider.</p>
    <p data-staff-payment-status class="form-result" role="status" aria-live="polite"></p>
    <div data-staff-payment-content hidden>
      <div class="staff-payment-toolbar">
        <label>Month<input type="month" data-payment-month required></label>
        <label>Show<select data-payment-filter><option value="all">Everyone</option><option value="outstanding">Outstanding</option><option value="overdue">Overdue</option><option value="paid">Paid / settled</option><option value="unready">Preferred destination missing</option></select></label>
        <label>Find a person<input type="search" data-payment-search></label>
        <button type="button" data-payment-refresh>Refresh</button>
        <a data-payment-costs href="/reports?report=contractor-cost">Review payroll costs</a>
        <button type="button" data-payment-export>Export monthly report</button>
        <button type="button" data-payment-audit-export>Export audit log</button>
      </div>
      <details data-payment-provider-settings hidden class="staff-payment-opening">
        <summary>Payment provider settings</summary>
        <p>Choose the organization default. Each person can inherit it or use another provider. Payment receipts keep the provider actually used.</p>
        <form data-payment-provider-form="organization">
          <label>Organization default<select name="provider"><option value="wise">Wise</option><option value="deel">Deel</option></select></label>
          <label>Reason for change<textarea name="note" required maxlength="2000"></textarea></label>
          <button type="submit">Save organization default</button>
        </form>
        <h3>Provider settings history</h3><div data-payment-provider-history></div>
      </details>
      <section data-payment-summary aria-label="Monthly totals" class="staff-payment-summary"></section>
      <div data-payment-list></div>
      <details class="staff-payment-opening">
        <summary>Record historical settlement through this month</summary>
        <p>Choose the people whose earlier periods are confirmed settled. Amounts and payment dates remain unspecified until exact historical records are entered. Existing amount and payment records keep their own balances.</p>
        <form data-payment-opening-form>
          <fieldset><legend>People confirmed settled</legend><div data-payment-opening-people></div></fieldset>
          <label>Source and explanation<textarea name="note" required maxlength="2000" placeholder="For example: payments through this month confirmed in Deel"></textarea></label>
          <button type="submit">Record settlement for selected people</button>
        </form>
      </details>
      <section data-payment-person hidden class="staff-payment-person" aria-labelledby="staff-payment-person-title">
        <header><h2 id="staff-payment-person-title" data-payment-person-title></h2><a data-payment-destination href="/team">Manage Wise destination</a></header>
        <p data-payment-person-summary></p>
        <form data-payment-provider-form="person" hidden>
          <label>Preferred payment provider<select name="provider"><option value="">Use organization default</option><option value="wise">Wise</option><option value="deel">Deel</option></select></label>
          <label>Reason for change<textarea name="note" required maxlength="2000"></textarea></label>
          <button type="submit">Save person preference</button>
        </form>
        <form data-payment-entry-form>
          <label>Action<select name="kind"><option value="amount">Set amount owed</option><option value="payment">Record confirmed payment</option><option value="void">Void an incorrect payment record</option><option value="reopen">Reopen historical settlement</option><option value="note">Add a note</option></select></label>
          <label data-payment-field="amount">Amount<input name="amount" inputmode="decimal" placeholder="0.00"></label>
          <label data-payment-field="currency">Currency<input name="currency" maxlength="3" pattern="[A-Za-z]{3}" placeholder="USD"></label>
          <label data-payment-field="due">Due date (optional)<input type="date" name="due_on"></label>
          <label data-payment-field="paid">Actual payment date<input type="date" name="paid_on"></label>
          <label data-payment-field="reference">Provider transfer or receipt reference<input name="reference" maxlength="255"></label>
          <label data-payment-field="source">Source<select name="source"><option value="wise">Wise</option><option value="deel">Deel</option><option value="historical">Other historical payment</option></select></label>
          <label data-payment-field="void">Payment to void<select name="payment_id"></select></label>
          <label>Note<textarea name="note" required maxlength="2000"></textarea></label>
          <p>Voiding corrects this register; it does not reverse a bank transfer. Recording a payment does not send money.</p>
          <button type="submit" class="primary-action">Save record</button>
          <p data-payment-entry-result class="form-result" role="status" aria-live="polite"></p>
        </form>
        <h3>Payment history and audit log</h3><div data-payment-history></div>
      </section>
    </div>
  </main>`
    : ''
