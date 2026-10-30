export const renderBankDepositPage = (view?: string): string => `
<main class="app-content invoice-workspace bank-deposit-workspace page--grid" data-bank-deposits-page${view === "invoice-bank-deposits" ? "" : " hidden"}>
  <header class="context-row"><div><p class="eyebrow">Money</p><h1>Bank deposits</h1></div></header>
  <p>Review incoming credits and choose the invoice they pay. Matching suggestions never record a payment automatically.</p>
  <p data-bank-provider-status role="status" aria-live="polite"></p>
  <div class="bank-deposit-toolbar"><label>Show <select data-bank-filter><option value="">All deposits</option><option value="unmatched">Unmatched</option><option value="suggested">Suggested</option><option value="confirmed">Confirmed</option><option value="rejected">Rejected</option></select></label><button type="button" data-bank-refresh>Refresh</button><button type="button" data-bank-sync hidden>Sync now</button></div>
  <p data-bank-status role="status" aria-live="polite"></p>
  <ul class="bank-deposit-list" data-bank-list></ul>
  <button type="button" data-bank-more hidden>Load more deposits</button>
  <section data-bank-detail hidden aria-labelledby="bank-deposit-heading">
    <h2 id="bank-deposit-heading">Review deposit</h2>
    <dl class="bank-deposit-facts" data-bank-facts></dl>
    <p data-bank-source-note></p>
    <form data-bank-verify hidden>
      <h3>Verify the source</h3>
      <p>The provider has not verified this as a settled customer payment. Check the transaction in your bank before recording this verification.</p>
      <label><input type="checkbox" name="posted" required> I verified that the funds are posted and available.</label>
      <label><input type="checkbox" name="external" required> I verified this is a customer payment, not our own transfer or a refund.</label>
      <label>Verification reference <input name="verification-reference" required maxlength="200" autocomplete="off" placeholder="Bank statement or transaction evidence reference"></label>
      <button class="primary-action" type="submit">Record source verification</button>
    </form>
    <form data-bank-assign hidden><label>Invoice <select name="invoice" required></select></label><button type="submit">Assign invoice</button></form>
    <form data-bank-confirm hidden>
      <p data-bank-confirm-summary></p>
      <label data-bank-overpayment-label hidden><input type="checkbox" name="overpayment"> I reviewed and accept this payment exceeding the invoice balance.</label>
      <button class="primary-action" type="submit">Confirm payment</button>
    </form>
    <div class="bank-deposit-toolbar"><button type="button" data-bank-reject hidden>Reject deposit</button><button type="button" data-bank-reopen hidden>Reopen for review</button></div>
    <p data-bank-action-status role="status" aria-live="polite"></p>
  </section>
</main>`;
