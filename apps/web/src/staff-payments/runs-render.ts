export const renderPaymentRuns = (): string => `
<section data-payment-runs hidden class="payment-runs">
  <p data-run-status role="status" aria-live="polite"></p>
  <section id="payment-panel-send" role="tabpanel" aria-labelledby="payment-tab-send" data-payment-panel="send" hidden>
  <h2>Send or schedule payments</h2>
  <p>Choose outstanding amounts, review Wise recipients and costs, then approve a payment run. Processing starts within the next minute. Scheduled and processing payments reserve their balances.</p>
  <form data-run-form>
    <div class="staff-payment-toolbar">
      <label>Run name<input name="run_name" required maxlength="100" placeholder="September payments"></label>
      <label>Pay from Wise balance<input name="source_currency" value="USD" pattern="[A-Z]{3}" maxlength="3" required></label>
      <label>When<select name="timing" aria-label="When"><option value="now">Send now</option><option value="scheduled">Schedule</option></select></label>
      <label data-run-schedule hidden>Start at<input type="datetime-local" name="scheduled_at"></label>
      <span data-run-timezone></span>
    </div>
    <div data-run-selection></div>
    <button type="submit" class="primary-action">Review selected payments</button>
  </form>
  <section data-run-review hidden aria-label="Confirm payment run">
    <h3>Confirm payment run</h3><p data-run-review-summary></p>
    <form data-run-approval><div data-run-review-items></div>
      <p>Each recipient receives the selected amount. Fees are added to the company’s cost. Scheduled runs refresh quotes before sending and pause if a cost exceeds its approved maximum.</p>
      <button type="submit" class="primary-action" data-run-confirm>Approve payments</button>
      <button type="button" data-run-back>Back to selection</button>
    </form>
  </section>
  </section>
  <section id="payment-panel-history" role="tabpanel" aria-labelledby="payment-tab-history" data-payment-panel="history" hidden>
    <h2>Payment history</h2>
    <p>Runs for the selected work month. Track scheduled payments, check their status, or cancel unsent payments.</p>
    <div data-run-history></div>
  </section>
</section>
<section data-payments-report hidden>
  <header class="context-row"><h2>Payments report</h2><a href="/payments">Manage payments</a></header>
  <p>Obligations are grouped by work month. Manual receipts show the actual payment date. Automatic receipts use Wise’s event date when available, otherwise the date its outgoing payment was confirmed. Scheduled amounts remain outstanding until Wise confirms the outgoing payment.</p>
  <form data-run-report-form class="staff-payment-toolbar">
    <label>From month<input type="month" name="from" required></label><label>To month<input type="month" name="to" required></label>
    <label>Person<input type="search" name="person" placeholder="Name"></label>
    <label>Currency<input name="currency" maxlength="3" placeholder="All"></label>
    <label>Status<select name="status"><option value="all">All</option><option value="outstanding">Outstanding</option><option value="paid">Paid</option><option value="queued">Scheduled / queued</option><option value="processing">Processing</option><option value="attention">Needs attention</option><option value="failed">Failed / refunded</option><option value="cancelled">Cancelled</option></select></label>
    <button type="submit">Update report</button><button type="button" data-run-report-export>Export filtered CSV</button>
  </form>
  <p data-run-report-status role="status" aria-live="polite"></p>
  <div data-run-report-totals></div><div data-run-report-balances></div><div data-run-report-transfers></div><div data-run-report-receipts></div>
</section>`;
