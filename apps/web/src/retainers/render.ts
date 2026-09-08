/**
 * The retainers pane behind the Invoices strip's third tab.
 *
 * It replaces the labelled empty state that shipped with the strip. The empty
 * state was right while there was nothing behind the tab; it is not right now
 * that the cutover carries retainers, and it said so itself.
 *
 * List and detail live in one route, `/invoices/retainers`, with `?retainer=`
 * naming the open one — the same shape the expense-category filter already
 * uses for `?status=`. Every number is filled in by the controller, so the
 * markup states nothing it has not yet read.
 */

export const renderRetainerPage = (view?: string): string => `
  <main class="app-content invoice-workspace retainer-workspace" data-invoice-retainers-page${view === 'invoice-retainers' ? '' : ' hidden'}>
    <header class="context-row">
      <div><p class="eyebrow">Money</p><h1>Retainers</h1></div>
    </header>
    <section data-retainer-list-view aria-labelledby="retainer-list-heading">
      <h2 class="visually-hidden" id="retainer-list-heading">Retainers</h2>
      <p class="invoice-intro">What is on retainer, and what remains of it. A balance is the sum of that retainer's ledger; open one to see the movements that produced it.</p>
      <div class="retainer-toolbar" role="group" aria-label="Retainer status">
        <button type="button" data-retainer-filter="ongoing" aria-pressed="true">Ongoing</button>
        <button type="button" data-retainer-filter="all" aria-pressed="false">All</button>
      </div>
      <p class="form-result invoice-page-status" data-retainer-list-status role="status" aria-live="polite">Loading retainers…</p>
      <div data-retainer-list></div>
      <div class="retainer-actions">
        <button class="invoice-load-more" type="button" data-retainer-load-more hidden>Load more retainers</button>
        <button class="invoice-load-more" type="button" data-retainer-list-retry hidden>Retry loading retainers</button>
      </div>
    </section>
    <section class="retainer-detail" data-retainer-detail-view hidden aria-labelledby="retainer-detail-heading">
      <div class="retainer-detail-heading">
        <div>
          <p class="eyebrow" data-retainer-detail-client>Retainer</p>
          <h2 id="retainer-detail-heading" data-retainer-detail-title>Retainer</h2>
        </div>
        <a class="retainer-detail-back" href="/invoices/retainers" data-retainer-back>Back to retainers</a>
      </div>
      <p class="form-result invoice-page-status" data-retainer-detail-status role="status" aria-live="polite">Loading retainer…</p>
      <div class="retainer-actions">
        <button class="invoice-load-more" type="button" data-retainer-detail-retry hidden>Retry loading this retainer</button>
      </div>
      <div data-retainer-detail-body hidden>
        <dl class="retainer-facts" data-retainer-money>
          <div><dt>On retainer</dt><dd data-retainer-commitment>—</dd></div>
          <div><dt>Deposited</dt><dd data-retainer-deposited>—</dd></div>
          <div><dt>Drawn down</dt><dd data-retainer-drawn>—</dd></div>
          <div><dt>Expired</dt><dd data-retainer-expired>—</dd></div>
          <div><dt>Adjustments</dt><dd data-retainer-adjusted>—</dd></div>
          <div><dt>Remaining</dt><dd data-retainer-remaining>—</dd></div>
          <div data-retainer-share-row hidden><dt>Remaining share</dt><dd data-retainer-share>—</dd></div>
          <div data-retainer-locked-value-row hidden><dt>Remaining at the locked rate</dt><dd data-retainer-locked-value>—</dd></div>
        </dl>
        <ul class="retainer-notes" data-retainer-notes hidden></ul>
        <dl class="retainer-facts retainer-policy" data-retainer-policy>
          <div><dt>Scope</dt><dd data-retainer-scope>—</dd></div>
          <div><dt>Basis</dt><dd data-retainer-basis>—</dd></div>
          <div><dt>State</dt><dd data-retainer-state>—</dd></div>
          <div><dt>Period</dt><dd data-retainer-period>—</dd></div>
          <div><dt>Rollover</dt><dd data-retainer-rollover>—</dd></div>
          <div><dt>Expires</dt><dd data-retainer-expires>—</dd></div>
          <div><dt>On exhaustion</dt><dd data-retainer-exhaustion>—</dd></div>
        </dl>
        <section class="retainer-ledger" aria-labelledby="retainer-ledger-heading">
          <h3 id="retainer-ledger-heading">Ledger</h3>
          <p class="hint">Every movement, oldest first, with the balance after it. The last balance is the retainer's balance.</p>
          <div data-retainer-ledger></div>
        </section>
      </div>
    </section>
  </main>`
