import { demoUnavailable } from '../demo.js'
import { renderPaymentRuns } from './runs-render.js'
export const renderStaffPayments = (view?: string): string =>
  view === 'staff-payments'
    ? `
  <main class="app-content page--grid staff-payments" data-staff-payments-page${view === 'staff-payments' ? '' : ' hidden'}>
    <header class="context-row"><div><p class="eyebrow">Team</p><h1>Payments</h1></div><a href="/team">Back to team</a></header>
    <p data-payment-intro>Choose the month the work was done. Pay it after that month ends; the actual payment date is recorded separately.</p>
    <p data-staff-payment-status class="form-result" role="status" aria-live="polite"></p>
    <div data-staff-payment-content hidden>
      <div data-payment-ledger-toolbar>
        <div class="staff-payment-toolbar">
          <label>Work month<input type="month" data-payment-month required></label>
          <button type="button" data-payment-refresh>Refresh</button>
          <button type="button" class="primary-action" data-payment-pay-now>Pay now</button>
          <a href="/payments/report">Payments report</a>
        </div>
        <div class="payment-tabs" role="tablist" aria-label="Payments sections" data-payment-tabs>
          ${[
            ['balances', 'Balances'],
            ['actuals', 'Review actuals'],
            ['send', 'Send or schedule'],
            ['history', 'History'],
            ['settings', 'Settings'],
          ]
            .map(
              ([key, label]) =>
                `<button type="button" role="tab" id="payment-tab-${key}" aria-controls="payment-panel-${key}" aria-selected="${key === 'balances'}" tabindex="${key === 'balances' ? '0' : '-1'}" data-payment-tab="${key}">${label}</button>`,
            )
            .join('')}
        </div>
      </div>
      <section id="payment-panel-balances" role="tabpanel" aria-labelledby="payment-tab-balances" data-payment-panel="balances">
      <div class="staff-payment-toolbar">
        <label>Show<select data-payment-filter><option value="all">Everyone</option><option value="outstanding">Outstanding</option><option value="overdue">Overdue</option><option value="paid">Paid / settled</option><option value="unready">Preferred destination missing</option></select></label>
        <label class="payment-check"><input type="checkbox" data-payment-show-empty>Show people with no hours or payments</label>
        <label>Find a person<input type="search" data-payment-search></label>
        <a data-payment-costs href="/reports?report=contractor-cost">Review payroll costs</a>
        <button type="button" data-payment-export>Export monthly report</button>
        <button type="button" data-payment-audit-export>Export audit log</button>
      </div>
      <section data-payment-summary aria-label="Monthly totals" class="staff-payment-summary"></section>
      <div data-payment-ledger>
      <h2>Payment ledger</h2>
      <div data-payment-list></div>
      <section data-payment-person hidden class="staff-payment-person" aria-labelledby="staff-payment-person-title">
        <header><h2 id="staff-payment-person-title" data-payment-person-title></h2><a data-payment-destination href="/team">Manage Wise destination</a></header>
        <p data-payment-person-summary></p>
        <form data-payment-provider-form="person" hidden>
          <label>Preferred payment provider<select name="provider"><option value="">Use organization default</option><option value="wise">Wise</option><option value="deel">Deel</option></select></label>
          <label>Reason for change<textarea name="note" required maxlength="2000"></textarea></label>
          <button type="submit">Save person preference</button>
        </form>
        <p class="hint" data-payment-provider-demo hidden>${demoUnavailable('Choosing a payment provider')}</p>
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
      </section>
      <section id="payment-panel-actuals" role="tabpanel" aria-labelledby="payment-tab-actuals" data-payment-panel="actuals" data-payment-actuals hidden>
        <h2>Review contractor actuals</h2>
        <p>Captured time and cost rates from the contractor report. Includes tracked hours regardless of timesheet approval; review before confirming.</p>
        <button type="button" data-actuals-load>Load actuals for work month</button>
        <p role="status" aria-live="polite" data-actuals-status></p>
        <div data-actuals-review></div>
      </section>
      ${renderPaymentRuns()}
      <section id="payment-panel-settings" role="tabpanel" aria-labelledby="payment-tab-settings" data-payment-panel="settings" hidden>
        <h2>Payment settings</h2>
      <p class="hint" data-payment-provider-demo hidden>${demoUnavailable('Choosing a payment provider')}</p>
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
      <details class="staff-payment-opening">
        <summary>Record historical settlement through this month</summary>
        <p>Choose the people whose earlier periods are confirmed settled. Amounts and payment dates remain unspecified until exact historical records are entered. Existing amount and payment records keep their own balances.</p>
        <form data-payment-opening-form>
          <fieldset><legend>People confirmed settled</legend><div data-payment-opening-people></div></fieldset>
          <label>Source and explanation<textarea name="note" required maxlength="2000" placeholder="For example: payments through this month confirmed in Deel"></textarea></label>
          <button type="submit">Record settlement for selected people</button>
        </form>
      </details>
      </section>
    </div>
  </main>`
    : ''
