export const renderWebhookSettings = () => `
<section class="settings-section" data-settings-section="webhooks" aria-labelledby="settings-webhooks-title">
 <header><h2 id="settings-webhooks-title">Webhooks</h2><p>Notify your own HTTPS endpoint when invoice, payment or administrator time events occur. Events carry IDs and links. Receivers must verify signatures and deduplicate event IDs.</p></header>
 <p data-webhooks-status class="form-result" role="status" aria-live="polite">Loading webhooks…</p>
 <div data-webhooks-content hidden>
  <div class="settings-form"><button type="button" data-webhooks-refresh>Refresh</button></div>
  <form class="settings-form" data-webhooks-create>
   <h3>Add an endpoint</h3>
   <label>HTTPS endpoint URL<input name="url" type="url" required maxlength="2048" autocomplete="off"></label>
   <fieldset><legend>Events to deliver</legend><div data-webhooks-events></div></fieldset>
   <button type="submit" class="primary-action">Create endpoint</button>
  </form>
  <div data-webhooks-subscriptions class="settings-table"></div>
  <h3>Delivery log</h3><p>Results are retained for 30 days. Settled deliveries from the last seven days can be replayed with the same event ID and body.</p>
  <form class="settings-form" data-webhooks-filter>
   <label>Endpoint<select name="subscription_id"><option value="">All endpoints</option></select></label>
   <label>Result<select name="status"><option value="">All results</option><option>pending</option><option>processing</option><option>delivered</option><option>failed</option></select></label>
   <button type="submit">Filter deliveries</button>
  </form>
  <div data-webhooks-log class="settings-table"></div><div class="settings-form"><button type="button" data-webhooks-more hidden>Load more deliveries</button></div>
 </div>
 <dialog class="settings-token-dialog" data-webhooks-action aria-labelledby="webhook-action-title">
  <form class="settings-form" data-webhooks-action-form>
   <h3 id="webhook-action-title" data-webhooks-action-title></h3><p data-webhooks-action-description></p>
   <label data-webhooks-overlap>Old secret overlap in seconds<input name="overlap_seconds" type="number" min="0" max="86400" step="1" value="900" required></label>
   <p data-webhooks-overlap-note>Zero invalidates the old signing key immediately. The default overlap is 15 minutes.</p>
   <div class="dialog-actions"><button type="button" data-webhooks-cancel>Cancel</button><button type="submit" class="primary-action">Confirm</button></div>
  </form>
 </dialog>
 <dialog class="settings-token-dialog" data-webhooks-secret aria-labelledby="webhook-secret-title">
  <div class="settings-form"><h3 id="webhook-secret-title">Copy this signing secret now</h3><p>It will not be shown again. Save it securely at your receiver before closing this window.</p>
  <label>Signing secret<input data-webhooks-secret-value readonly autocomplete="off" spellcheck="false"></label>
  <p data-webhooks-secret-status role="status" aria-live="polite"></p>
  <div class="dialog-actions"><button type="button" data-webhooks-copy>Copy secret</button><button type="button" data-webhooks-secret-close>I saved the secret</button></div></div>
 </dialog>
</section>`
