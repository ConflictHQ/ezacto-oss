export const renderScheduledRunPage = (view?: string): string => `
  <main class="app-content page--grid scheduled-run" data-scheduled-run-page${view === 'scheduled-run' ? '' : ' hidden'}>
    <header class="context-row"><div><p class="eyebrow">Scheduled work</p><h1>Review month-end pack</h1></div></header>
    <p>Review every recipient, item and saved PDF before answering. Opening this page does not confirm or send anything. A complete run has queued every item; delivery status shows the provider result.</p>
    <p data-scheduled-run-status class="form-result" role="status" aria-live="polite">Sign in to review this proposal.</p>
    <div data-scheduled-run-content hidden>
      <dl data-scheduled-run-summary class="my-payments-summary"></dl>
      <div data-scheduled-run-items></div>
      <div data-scheduled-run-warnings hidden></div>
      <label data-scheduled-run-ack-label hidden><input type="checkbox" data-scheduled-run-ack> I reviewed the report warnings and the exact saved PDFs that will be sent.</label>
      <div class="staff-payment-toolbar" data-scheduled-run-actions hidden>
        <button type="button" class="primary-action" data-scheduled-run-confirm>Confirm this manifest</button>
        <button type="button" data-scheduled-run-cancel>Cancel proposal</button>
      </div>
      <button type="button" data-scheduled-run-retry hidden>Retry failed items</button>
    </div>
    <button type="button" data-scheduled-run-refresh>Refresh proposal</button>
  </main>`
