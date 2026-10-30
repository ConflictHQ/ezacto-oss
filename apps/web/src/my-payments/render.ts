/**
 * The own payments screen (issue 100). Read-only: no control here changes a
 * record, and nothing on it names anyone but the signed-in person.
 */
export const renderMyPaymentsPage = (view?: string): string => `
  <main class="app-content page--grid my-payments" data-my-payments-page${view === 'my-payments' ? '' : ' hidden'}>
    <header class="context-row">
      <div><p class="eyebrow">Account</p><h1>My payments</h1></div>
    </header>
    <p class="my-payments-intro">Your tracked hours, the amount your organization has recorded as owed to you, what has been paid, and what is scheduled. An amount appears only after an administrator records it.</p>
    <div class="staff-payment-toolbar">
      <label>Work month<input type="month" data-my-payments-month required></label>
      <button type="button" data-my-payments-refresh>Refresh</button>
    </div>
    <p class="form-result" data-my-payments-status role="status" aria-live="polite">Loading your payments…</p>
    <div data-my-payments-content hidden>
      <dl class="my-payments-summary" data-my-payments-summary></dl>
      <div data-my-payments-receipts></div>
      <div data-my-payments-upcoming></div>
      <div data-my-staff-invoices></div>
    </div>
  </main>
`
