export const renderScheduledRunPage = (view?: string): string => `
  <main class="app-content page--grid scheduled-run" data-scheduled-run-page${view === 'scheduled-run' ? '' : ' hidden'}>
    <header class="context-row"><div><p class="eyebrow">Scheduled work</p><h1>Review month-end pack</h1></div></header>
    <p>Review every recipient and item before answering. Opening this page does not confirm or send anything.</p>
    <p data-scheduled-run-status class="form-result" role="status" aria-live="polite">Sign in to review this proposal.</p>
    <div data-scheduled-run-content hidden>
      <dl data-scheduled-run-summary class="my-payments-summary"></dl>
      <div data-scheduled-run-items></div>
      <div class="staff-payment-toolbar" data-scheduled-run-actions hidden>
        <button type="button" class="primary-action" data-scheduled-run-confirm>Confirm this manifest</button>
        <button type="button" data-scheduled-run-cancel>Cancel proposal</button>
      </div>
    </div>
    <button type="button" data-scheduled-run-refresh>Refresh proposal</button>
  </main>`
